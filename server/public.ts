// Rotas sem sessão de moderador: login, convites, ações do participante e tela.
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { all, batch, get, newId, run, sha256, tx } from './db.ts'
import { connections, pairingFor, pairingStream, publish, publishCounts, stream } from './hub.ts'
import { eventRow, question, toEventInfo, type EventRow } from './model.ts'
import { body, emailField } from './moderator.ts'
import {
  burnPasswordCheck,
  clientIp,
  currentModerator,
  isLimited,
  endModeratorSession,
  endParticipantSession,
  hashPassword,
  overLimit,
  pairedScreen,
  participantFromCookie,
  requireParticipant,
  resetLimit,
  safeEqual,
  screenSecret,
  setScreenSecret,
  setupTokenRequired,
  setupTokenValid,
  startModeratorSession,
  startParticipantSession,
  verifyPassword,
  type Env,
} from './auth.ts'
import { REACTIONS, hasFlagWord, normalize } from '../shared/types.ts'

export const pub = new Hono<Env>()

const TEN_MIN = 10 * 60_000
// Uma sala inteira costuma sair pelo mesmo IP (roteador do local). Tokens de convite têm 144 bits e códigos de
// evento ~30 bits: mesmo 1000 consultas por minuto não permitem varredura útil.
const LOOKUPS_PER_MIN = 1000

/** Dados de marca mostrados antes da confirmação do PIN. */
function brand(r: EventRow) {
  const { theme } = toEventInfo(r)
  return { id: r.id, name: r.name, logo: theme.logo, brand: theme.brand, contrast: theme.contrast, fonts: theme.fonts, pinLength: r.pin.length }
}

// ---------- moderador: conta ----------

pub.get('/auth/me', async (c) => {
  const needsSetup = !(await get('SELECT 1 FROM moderators LIMIT 1'))
  return c.json({ moderator: await currentModerator(c), needsSetup, setupToken: needsSetup && setupTokenRequired() })
})

const credentials = z.object({
  email: emailField,
  password: z.string().min(8, 'A senha precisa de ao menos 8 caracteres.').max(200),
})

pub.post('/auth/setup', async (c) => {
  if (await overLimit(`setup:${clientIp(c)}`, 10, TEN_MIN)) return c.json({ error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' }, 429)
  const name = z.string('Informe seu nome.').trim().min(1, 'Informe seu nome.').max(120)
  const input = await body(c, credentials.extend({ name, token: z.string().max(200).optional() }))
  if (!setupTokenValid(input.token))
    return c.json({ error: 'Código de instalação incorreto. Use o valor de SETUP_TOKEN configurado no servidor.' }, 403)
  const password = await hashPassword(input.password)
  const id = newId()
  // Verificação e criação na mesma transação: duas requisições simultâneas não criam duas contas iniciais.
  const created = await tx(async () => {
    if (await get('SELECT 1 FROM moderators LIMIT 1')) return false
    await run('INSERT INTO moderators (id, name, email, password, created_at) VALUES (?, ?, ?, ?, ?)', id, input.name, input.email, password, Date.now())
    return true
  })
  if (!created) return c.json({ error: 'A conta inicial já foi criada. Entre com seu e-mail e senha.' }, 409)
  await startModeratorSession(c, id)
  return c.json({ ok: true }, 201)
})

pub.post('/auth/login', async (c) => {
  const key = `login:${clientIp(c)}`
  if (await overLimit(key, 10, TEN_MIN)) return c.json({ error: 'Muitas tentativas seguidas. Tente de novo em alguns minutos.' }, 429)
  const { email, password } = await body(c, z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }))
  const m = await get<{ id: string; password: string }>('SELECT id, password FROM moderators WHERE email = ?', email)
  const ok = m ? await verifyPassword(password, m.password) : await burnPasswordCheck(password)
  if (!m || !ok) return c.json({ error: 'E-mail ou senha incorretos.' }, 401)
  await resetLimit(key)
  await startModeratorSession(c, m.id)
  return c.json({ ok: true })
})

pub.post('/auth/logout', (c) => {
  endModeratorSession(c)
  return c.json({ ok: true })
})

// ---------- entrada do participante ----------

const byToken = (token: string) =>
  get<{ id: string; event_id: string; name: string; blocked: number }>(
    'SELECT id, event_id, name, blocked FROM participants WHERE token = ?',
    token,
  )

pub.get('/invite/:token', async (c) => {
  if (await overLimit(`lookup:${clientIp(c)}`, LOOKUPS_PER_MIN, 60_000)) return c.json({ error: 'Muitas tentativas seguidas. Aguarde um minuto.' }, 429)
  const p = await byToken(c.req.param('token'))
  const r = p && (await eventRow(p.event_id))
  if (!p || !r || p.blocked) return c.json({ error: 'Convite inválido ou desativado.' }, 404)
  const current = await participantFromCookie(c, r.id)
  return c.json({ event: brand(r), participant: { name: p.name }, joined: current?.id === p.id })
})

pub.post('/invite/:token', async (c) => {
  const token = c.req.param('token')
  const key = `pin:${token}:${clientIp(c)}`
  if (await overLimit(key, 10, TEN_MIN)) return c.json({ error: 'Muitas tentativas. Aguarde alguns minutos.' }, 429)
  const p = await byToken(token)
  const r = p && (await eventRow(p.event_id))
  if (!p || !r || p.blocked) return c.json({ error: 'Convite inválido ou desativado.' }, 404)
  const { pin } = await body(c, z.object({ pin: z.string().trim().max(12) }))
  if (!safeEqual(pin, r.pin)) return c.json({ error: 'PIN incorreto. Confira os números com a organização do evento.' }, 401)
  await resetLimit(key)
  await run('UPDATE participants SET joined_at = COALESCE(joined_at, ?) WHERE id = ?', Date.now(), p.id)
  await startParticipantSession(c, r.id, p.id)
  await publish(r.id, 'moderator')
  return c.json({ eventId: r.id })
})

pub.get('/open/:id', async (c) => {
  if (await overLimit(`lookup:${clientIp(c)}`, LOOKUPS_PER_MIN, 60_000)) return c.json({ error: 'Muitas tentativas seguidas. Aguarde um minuto.' }, 429)
  const r = await eventRow(c.req.param('id'))
  if (!r) return c.json({ error: 'Evento não encontrado. Confira o código do evento.' }, 404)
  const current = await participantFromCookie(c, r.id)
  const { openJoin } = toEventInfo(r).settings
  // Evento só com convidados não revela nome nem marca a quem ainda não entrou.
  if (!openJoin && !current) return c.json({ event: null, openJoin, joined: false })
  return c.json({ event: brand(r), openJoin, joined: !!current })
})

pub.post('/open/:id', async (c) => {
  const r = await eventRow(c.req.param('id'))
  if (!r) return c.json({ error: 'Evento não encontrado.' }, 404)
  if (!toEventInfo(r).settings.openJoin) return c.json({ error: 'Este evento aceita apenas convidados.' }, 403)
  // Este aparelho já entrou: devolve a mesma participação em vez de criar outra a cada envio.
  if (await participantFromCookie(c, r.id)) return c.json({ eventId: r.id })
  // Conta só PIN errado: uma sala inteira atrás do mesmo roteador entra sem esbarrar no limite.
  const key = `pin:${r.id}:${clientIp(c)}`
  if (await isLimited(key, 30)) return c.json({ error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' }, 429)
  const input = await body(c, z.object({ name: z.string().trim().min(2, 'Informe seu nome.').max(80), pin: z.string().trim().max(12) }))
  if (!safeEqual(input.pin, r.pin)) {
    await overLimit(key, 30, TEN_MIN)
    return c.json({ error: 'PIN incorreto. Confira os números com a organização do evento.' }, 401)
  }
  const id = newId()
  const now = Date.now()
  await run(
    `INSERT INTO participants (id, event_id, name, token, source, joined_at, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    id,
    r.id,
    input.name,
    newId(18),
    now,
    now,
  )
  await startParticipantSession(c, r.id, id)
  await publish(r.id, 'moderator')
  return c.json({ eventId: r.id }, 201)
})

// ---------- participante confirmado ----------

pub.use('/p/:id/*', requireParticipant)

pub.get('/p/:id/stream', async (c) => {
  const eventId = c.get('event').id
  const participantId = c.get('participant').id
  if ((await connections(eventId, participantId)) >= 4)
    return c.json({ error: 'Este evento já está aberto em várias abas. Feche as outras e tente de novo.' }, 429)
  return stream(c, { eventId, audience: 'participant', participantId })
})

pub.post('/p/:id/leave', (c) => {
  endParticipantSession(c, c.get('event').id)
  return c.json({ ok: true })
})

pub.post('/p/:id/questions', async (c) => {
  const r = c.get('event')
  const p = c.get('participant')
  const { settings } = toEventInfo(r)
  if (!settings.questionsOpen) return c.json({ error: 'O envio de perguntas está fechado.' }, 403)
  const input = await body(
    c,
    z.object({
      text: z.string().trim().min(3, 'Escreva a pergunta.').max(settings.maxLength, `Limite de ${settings.maxLength} caracteres.`),
      anonymous: z.boolean().default(false),
    }),
  )
  const text = input.text.replace(/\s+/g, ' ')
  const mine = await all<{ text: string; status: string }>('SELECT text, status FROM questions WHERE participant_id = ?', p.id)
  if (mine.filter((q) => q.status === 'pending').length >= 5)
    return c.json({ error: 'Você tem 5 perguntas aguardando aprovação. Aguarde a moderação analisar.' }, 429)
  if (mine.some((q) => normalize(q.text) === normalize(text))) return c.json({ error: 'Você já enviou esta pergunta.' }, 409)
  if (await overLimit(`q:${p.id}`, 1, 15_000)) return c.json({ error: 'Aguarde 15 segundos para enviar outra pergunta.' }, 429)
  const anonymous = settings.identity === 'anonymous' || (settings.identity === 'choice' && input.anonymous)
  await run(
    `INSERT INTO questions (id, event_id, participant_id, author, anonymous, original, text, status, flagged, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    newId(),
    r.id,
    p.id,
    p.name,
    anonymous ? 1 : 0,
    text,
    text,
    hasFlagWord(text, settings.flagWords) ? 1 : 0,
    Date.now(),
  )
  await publish(r.id, 'moderator', `p:${p.id}`)
  return c.json({ ok: true }, 201)
})

pub.post('/p/:id/questions/:qid/like', async (c) => {
  const r = c.get('event')
  const p = c.get('participant')
  if (!toEventInfo(r).settings.reactionsOpen) return c.json({ error: 'Reações pausadas pela moderação.' }, 403)
  if (await overLimit(`like:${p.id}`, 60, 60_000)) return c.json({ ok: true })
  const q = await question(r.id, c.req.param('qid'))
  if (!q || (q.status !== 'approved' && q.status !== 'answered')) return c.json({ error: 'Pergunta indisponível.' }, 404)
  const { on } = await body(c, z.object({ on: z.boolean() }))
  if (on) await run('INSERT INTO likes (question_id, participant_id) VALUES (?, ?) ON CONFLICT DO NOTHING', q.id, p.id)
  else await run('DELETE FROM likes WHERE question_id = ? AND participant_id = ?', q.id, p.id)
  await publishCounts(r.id)
  await publish(r.id, `p:${p.id}`)
  return c.json({ ok: true })
})

/** Reações em lote: o celular agrupa toques e envia no máximo algumas vezes por segundo. */
pub.post('/p/:id/reactions', async (c) => {
  const r = c.get('event')
  const p = c.get('participant')
  const ev = toEventInfo(r)
  if (!ev.settings.reactionsOpen) return c.json({ error: 'Reações pausadas pela moderação.' }, 403)
  const sceneId = ev.live.standby ? null : ev.live.program
  // O celular agrupa toques por segundo; aqui, no máximo 3 lotes a cada 2 s e 5 toques por tipo.
  if (!sceneId || (await overLimit(`r:${p.id}`, 3, 2000))) return c.json({ ok: true })
  const { kinds } = await body(c, z.object({ kinds: z.partialRecord(z.enum(REACTIONS), z.number().int().min(1).max(5)) }))
  await batch(
    Object.entries(kinds)
      .filter(([kind, n]) => n && ev.settings.reactions.includes(kind as (typeof REACTIONS)[number]))
      .map(([kind, n]) => ({
        sql: `INSERT INTO reactions (event_id, scene_id, kind, count) VALUES (?, ?, ?, ?)
              ON CONFLICT (event_id, scene_id, kind) DO UPDATE SET count = reactions.count + excluded.count`,
        args: [r.id, sceneId, kind, n!],
      })),
  )
  await publishCounts(r.id)
  return c.json({ ok: true })
})

// ---------- tela ----------
// Sem link secreto: /tela pede um código de pareamento e espera a moderação digitá-lo no console.
// Quem tem sessão de moderador pode abrir /tela/<código do evento> direto (ex.: projeção no próprio notebook).

pub.post('/screen/pair', async (c) => {
  const paired = await pairedScreen(c)
  if (paired) return c.json({ paired: true, eventId: paired.event_id })
  if (await overLimit(`pair:${clientIp(c)}`, 30, TEN_MIN)) return c.json({ error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' }, 429)
  let secret = await screenSecret(c)
  if (!secret) {
    secret = randomBytes(32).toString('base64url')
    await setScreenSecret(c, secret)
  }
  const p = await pairingFor(sha256(secret))
  return c.json({ paired: false, code: p.code, expiresAt: p.expires })
})

pub.get('/screen/stream', async (c) => {
  const eventCode = c.req.query('event')
  if (eventCode) {
    // Sessão primeiro: sem login, não revela se o evento existe.
    if (!(await currentModerator(c))) return c.json({ error: 'Entre no console para abrir a tela deste evento.' }, 401)
    const r = await eventRow(eventCode)
    if (!r) return c.json({ error: 'Evento não encontrado.' }, 404)
    return stream(c, { eventId: r.id, audience: 'screen', screenId: null })
  }
  const screen = await pairedScreen(c)
  if (screen) return stream(c, { eventId: screen.event_id, audience: 'screen', screenId: screen.id })
  const secret = await screenSecret(c)
  if (!secret) return c.json({ error: 'Tela não pareada.' }, 401)
  return pairingStream(c, sha256(secret))
})
