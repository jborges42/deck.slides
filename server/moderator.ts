import { Hono } from 'hono'
import { z } from 'zod'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'
import { del, head } from '@vercel/blob'
import { all, batch, get, newCode, newId, newPin, run, tx, UPLOADS_DIR } from './db.ts'
import { checkEmbed } from './embed.ts'
import { claimPairing, kick, kickModerator, kickScreen, publish, publishCounts, stream } from './hub.ts'
import { eventRow, mediaRow, nextPosition, question, scene, scenes, toEventInfo, toMedia, updateLive, type EventRow } from './model.ts'
import { hashPassword, overLimit, requireModerator, verifyPassword, startModeratorSession, type Env } from './auth.ts'
import { TOKEN_NAMES } from '../shared/screen-theme.ts'
import {
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  REACTIONS,
  hasFlagWord,
  defaultLive,
  playbackPosition,
  slideIndex,
  timerElapsed,
  type EventSummary,
  type LiveState,
  type Scene,
  type SceneBody,
} from '../shared/types.ts'

export const moderator = new Hono<Env>()
moderator.use('/events', requireModerator)
moderator.use('/events/:id/*', requireModerator)
moderator.use('/events/:id', requireModerator)

// ---------- validação ----------

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB.')
// Mídia: arquivo do próprio evento (/media/<evento>/<arquivo>) ou URL https sem caracteres que escapem de url()/atributos.
// Só https: a CSP de produção não carrega http (conteúdo misto), então aceitar http criaria cena que não aparece.
const mediaRef = z
  .string()
  .max(2000)
  .regex(/^(\/media\/[\w-]+\/[\w-]+\.[a-z0-9]+|https:\/\/[^\s"'()<>\\]+)$/, 'Use um arquivo da biblioteca ou um endereço https.')
const libraryFile = z.string().max(300).regex(/^\/media\/[\w-]+\/[\w-]+\.(woff2|woff|ttf|otf)$/, 'Use uma fonte enviada para a biblioteca do evento.')
const optionalMedia = mediaRef.or(z.literal(''))
const font = z.object({
  family: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ._-]+$/u, 'Nome de fonte inválido.'),
  url: libraryFile.optional(), // fonte própria vem da biblioteca; a CSP só aceita fontes do app e do Google Fonts
})

const tokenOverrides = z.partialRecord(z.enum(TOKEN_NAMES), color)

const themeSchema = z.object({
  preset: z.string().max(40),
  brand: color,
  background: color.nullable(),
  mode: z.enum(['auto', 'dark', 'light']),
  contrast: z.enum(['standard', 'high']),
  overrides: tokenOverrides,
  fonts: z.object({ heading: font, body: font, numbers: font, headingWeight: z.number().int().min(100).max(900) }),
  logo: mediaRef.nullable(),
  logoPosition: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none']),
  logoSize: z.number().min(16).max(320),
  backgroundImage: mediaRef.nullable(),
  backgroundDim: z.number().min(0).max(0.95),
  aspect: z.enum(['16:9', '16:10', '4:3', '21:9', '32:9']),
  align: z.enum(['left', 'center']),
  safe: z.number().min(0).max(10),
  scale: z.number().min(0.8).max(1.6),
  radius: z.number().min(0).max(64),
  cardStyle: z.enum(['solid', 'outline', 'plain']),
  transition: z.enum(['cut', 'fade']),
  transitionMs: z.number().int().min(100).max(2000),
  standby: z.enum(['brand', 'black']),
  reactionsStyle: z.enum(['animated', 'counter']),
  footer: z.string().max(120),
})

const settingsSchema = z.object({
  questionsOpen: z.boolean(),
  reactionsOpen: z.boolean(),
  openJoin: z.boolean(),
  identity: z.enum(['name', 'choice', 'anonymous']),
  screenName: z.enum(['first-initial', 'full', 'first']),
  maxLength: z.number().int().min(100).max(500),
  reactions: z
    .array(z.enum(REACTIONS))
    .max(REACTIONS.length)
    .transform((list) => [...new Set(list)]),
  autoAnswer: z.boolean(),
  flagWords: z.array(z.string().trim().min(1).max(60)).max(200),
})

const text = (max: number) => z.string().max(max)
const sceneBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('title'), content: z.object({ kicker: text(120), title: text(300), body: text(2000) }) }),
  z.object({
    type: z.literal('image'),
    content: z.object({ src: optionalMedia, fit: z.enum(['contain', 'cover']), caption: text(300) }),
  }),
  z.object({
    type: z.literal('video'),
    content: z.object({ src: optionalMedia, fit: z.enum(['contain', 'cover']), loop: z.boolean(), autoplay: z.boolean() }),
  }),
  z.object({
    type: z.literal('embed'),
    content: z.object({
      url: z.url({ protocol: /^https$/, error: 'Use um endereço https.' }).or(z.literal('')),
      display: z.enum(['page', 'link']).optional(),
    }),
  }),
  z.object({
    type: z.literal('questions'),
    content: z.object({
      title: text(200),
      layout: z.enum(['spotlight', 'list', 'grid']),
      max: z.number().int().min(1).max(12),
      showAuthor: z.boolean(),
      showLikes: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('timer'),
    content: z.object({
      title: text(200),
      mode: z.enum(['countdown', 'stopwatch']),
      durationSec: z.number().int().min(1).max(24 * 3600),
      warnSec: z.number().int().min(0).max(24 * 3600),
      criticalSec: z.number().int().min(0).max(24 * 3600),
      onEnd: z.enum(['overtime', 'stop', 'message']),
      endText: text(120),
    }),
  }),
  z.object({ type: z.literal('slides'), content: z.object({ slides: z.array(mediaRef).max(500, 'Uma apresentação tem no máximo 500 slides.') }) }),
  z.object({ type: z.literal('join'), content: z.object({ title: text(120) }) }),
  z.object({ type: z.literal('section'), content: z.object({}) }),
])

const liveCommand = z.discriminatedUnion('op', [
  z.object({ op: z.literal('preview'), sceneId: z.string().nullable() }),
  z.object({ op: z.literal('take'), transition: z.enum(['cut', 'fade']).optional() }),
  z.object({ op: z.literal('standby'), on: z.boolean() }),
  z.object({ op: z.literal('overlays'), reactions: z.boolean().optional(), join: z.boolean().optional() }),
  z.object({
    op: z.literal('timer'),
    action: z.enum(['start', 'pause', 'reset', 'add', 'set']),
    ms: z.number().int().min(-86_400_000).max(86_400_000).optional(),
    mode: z.enum(['countdown', 'stopwatch']).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    label: text(200).optional(),
    // Só no "set"; omitidos, ficam os do cronômetro anterior.
    warnMs: z.number().int().min(0).max(86_400_000).optional(),
    criticalMs: z.number().int().min(0).max(86_400_000).optional(),
    onEnd: z.enum(['overtime', 'stop', 'message']).optional(),
    endText: text(120).optional(),
  })
    .refine((t) => t.action !== 'add' || t.ms !== undefined, 'Informe quanto tempo somar ao cronômetro.')
    .refine((t) => t.action !== 'set' || (t.mode !== undefined && t.durationMs !== undefined), 'Informe o modo e a duração do cronômetro.'),
  z.object({ op: z.literal('playback'), action: z.enum(['play', 'pause', 'restart']) }),
  z.object({ op: z.literal('slide'), sceneId: z.string().optional(), to: z.enum(['next', 'prev']).or(z.number().int().min(0).max(499)) }),
  z.object({ op: z.literal('timerOverlay'), on: z.boolean().optional(), corner: z.enum(['top-left', 'top-right']).optional() }),
  z.object({ op: z.literal('questionOverlay'), questionId: z.string().max(100).nullable() }),
])

z.config(z.locales.ptBR())

export class BadRequest extends Error {}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new BadRequest(parsed.error.issues[0]?.message ?? 'Dados inválidos.')
  return parsed.data
}

export const body = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T) =>
  parse(schema, await c.req.json().catch(() => null))

/** E-mail aparado e em minúsculas antes de validar (z.email().trim() recusava " ana@ex.com "). */
export const emailField = z.string('Informe um e-mail válido.').trim().toLowerCase().pipe(z.email('Informe um e-mail válido.'))

// ---------- eventos ----------

function defaultScenes(name: string): SceneBody[] {
  return [
    { type: 'title', content: { kicker: '', title: name, body: '' } },
    { type: 'questions', content: { title: 'Perguntas', layout: 'spotlight', max: 1, showAuthor: true, showLikes: true } },
    {
      type: 'timer',
      content: { title: 'Intervalo', mode: 'countdown', durationSec: 600, warnSec: 120, criticalSec: 30, onEnd: 'message', endText: 'Retomando' },
    },
  ]
}

const SCENE_NAMES: Record<Scene['type'], string> = {
  title: 'Título',
  image: 'Imagem',
  video: 'Vídeo',
  embed: 'Página web',
  questions: 'Perguntas',
  timer: 'Cronômetro',
  slides: 'Apresentação',
  join: 'Entrada',
  section: 'Pasta',
}

moderator.get('/events', async (c) => {
  const rows = await all<{ id: string; name: string; created_at: number; live: string; participants: number; questions: number }>(
    `SELECT e.id, e.name, e.created_at, e.live,
       (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id) AS participants,
       (SELECT COUNT(*) FROM questions q WHERE q.event_id = e.id) AS questions
     FROM events e ORDER BY e.created_at DESC`,
  )
  return c.json(
    rows.map(
      (r): EventSummary => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        participants: r.participants,
        questions: r.questions,
        live: !!(JSON.parse(r.live) as LiveState).program,
      }),
    ),
  )
})

moderator.post('/events', async (c) => {
  const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(120) }))
  let id: string
  do id = newCode()
  while (await get('SELECT 1 FROM events WHERE id = ?', id))
  const now = Date.now()
  await batch([
    {
      sql: 'INSERT INTO events (id, name, pin, settings, theme, live, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [id, name, newPin(), JSON.stringify(DEFAULT_SETTINGS), JSON.stringify(DEFAULT_THEME), JSON.stringify(defaultLive()), now],
    },
    ...defaultScenes(name).map((s, i) => ({
      sql: 'INSERT INTO scenes (id, event_id, position, type, name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [
        newId(),
        id,
        i,
        s.type,
        s.type === 'title' ? 'Abertura' : s.type === 'timer' ? 'Intervalo' : SCENE_NAMES[s.type],
        JSON.stringify(s.content),
        now,
      ],
    })),
  ])
  return c.json({ id }, 201)
})

moderator.patch('/events/:id', async (c) => {
  const ev = c.get('event')
  const patch = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      pin: z.string().regex(/^\d{4,8}$/, 'O PIN deve ter de 4 a 8 dígitos.').optional(),
      settings: settingsSchema.partial().optional(),
      theme: themeSchema.optional(),
    }),
  )
  // Relê depois do corpo: outro PATCH pode ter gravado enquanto este chegava (senão desfaria aquela alteração).
  const info = toEventInfo((await eventRow(ev.id)) ?? ev)
  await run(
    'UPDATE events SET name = ?, pin = ?, settings = ?, theme = ? WHERE id = ?',
    patch.name ?? info.name,
    patch.pin ?? info.pin,
    JSON.stringify({ ...info.settings, ...patch.settings }),
    JSON.stringify(patch.theme ?? info.theme),
    ev.id,
  )
  await publish(ev.id)
  return c.json({ ok: true })
})

// ---------- telas pareadas ----------

/** Conecta a tela que está exibindo `code` (página /tela no computador da projeção). */
moderator.post('/events/:id/screens', async (c) => {
  const ev = c.get('event')
  const input = await body(c, z.object({ code: z.string().trim().min(4).max(20), name: z.string().trim().max(60).optional() }))
  if (await overLimit(`claim:${c.get('moderator').id}`, 20, 10 * 60_000))
    return c.json({ error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' }, 429)
  const n = (await get<{ n: number }>('SELECT COUNT(*) AS n FROM screens WHERE event_id = ?', ev.id))?.n ?? 0
  const id = await claimPairing(input.code, ev.id, input.name || `Tela ${n + 1}`)
  if (!id) return c.json({ error: 'Código não encontrado ou expirado. Confira o código exibido na tela.' }, 404)
  await publish(ev.id, 'moderator')
  return c.json({ id }, 201)
})

moderator.patch('/events/:id/screens/:sid', async (c) => {
  const ev = c.get('event')
  const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(60) }))
  const res = await run('UPDATE screens SET name = ? WHERE event_id = ? AND id = ?', name, ev.id, c.req.param('sid'))
  if (!res.changes) return c.json({ error: 'Tela não encontrada.' }, 404)
  await publish(ev.id, 'moderator')
  return c.json({ ok: true })
})

/** Desconecta a tela: o computador da projeção volta a mostrar um código de pareamento. */
moderator.delete('/events/:id/screens/:sid', async (c) => {
  const ev = c.get('event')
  const sid = c.req.param('sid')
  await run('DELETE FROM screens WHERE event_id = ? AND id = ?', ev.id, sid)
  await kickScreen(ev.id, sid)
  await publish(ev.id, 'moderator')
  return c.json({ ok: true })
})

moderator.delete('/events/:id', async (c) => {
  const ev = c.get('event')
  const files = await all<{ file: string; blob_url: string | null }>('SELECT file, blob_url FROM media WHERE event_id = ?', ev.id)
  // Filhos antes do evento, numa ida só: o Turso não aplica ON DELETE CASCADE.
  await batch(
    [
      'DELETE FROM likes WHERE question_id IN (SELECT id FROM questions WHERE event_id = ?)',
      'DELETE FROM questions WHERE event_id = ?',
      'DELETE FROM participants WHERE event_id = ?',
      'DELETE FROM screens WHERE event_id = ?',
      'DELETE FROM scenes WHERE event_id = ?',
      'DELETE FROM reactions WHERE event_id = ?',
      'DELETE FROM media WHERE event_id = ?',
      'DELETE FROM events WHERE id = ?',
    ].map((sql) => ({ sql, args: [ev.id] })),
  )
  await removeFiles(ev.id, files)
  await rm(join(UPLOADS_DIR, ev.id), { recursive: true, force: true })
  await publish(ev.id)
  return c.json({ ok: true })
})

moderator.get('/events/:id/stream', (c) =>
  stream(c, { eventId: c.get('event').id, audience: 'moderator', moderatorId: c.get('moderator').id }),
)

// ---------- cenas ----------

moderator.post('/events/:id/scenes', async (c) => {
  const ev = c.get('event')
  const input = await body(
    c,
    z.intersection(z.object({ name: z.string().trim().max(80).optional(), after: z.string().optional() }), sceneBody),
  )
  const id = newId()
  // `after`: entra logo depois dessa cena (o "+" de uma pasta); sem ela, ou se ela não existe mais, no fim.
  const prev = input.after ? await scene(ev.id, input.after) : null
  const position = prev ? prev.position + 1 : await nextPosition(ev.id)
  await batch([
    ...(prev ? [{ sql: 'UPDATE scenes SET position = position + 1 WHERE event_id = ? AND position > ?', args: [ev.id, prev.position] }] : []),
    {
      sql: 'INSERT INTO scenes (id, event_id, position, type, name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [id, ev.id, position, input.type, input.name || SCENE_NAMES[input.type], JSON.stringify(input.content), Date.now()],
    },
  ])
  await publish(ev.id, 'moderator')
  return c.json({ id }, 201)
})

moderator.patch('/events/:id/scenes/:sid', async (c) => {
  const ev = c.get('event')
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(80).optional(), content: z.unknown().optional() }))
  // Cena e estado ao vivo lidos depois do corpo: outra requisição pode ter mudado os dois enquanto ele chegava.
  const current = await scene(ev.id, c.req.param('sid'))
  if (!current) return c.json({ error: 'Cena não encontrada.' }, 404)
  const content =
    input.content === undefined ? current.content : parse(sceneBody, { type: current.type, content: input.content }).content
  await run('UPDATE scenes SET name = ?, content = ? WHERE id = ?', input.name ?? current.name, JSON.stringify(content), current.id)
  // Cronômetro desta cena em uso: ajustes (duração, limiares, mensagem) valem para o relógio que está correndo.
  const updated = { ...current, content } as Scene
  const ev2 =
    updated.type === 'timer'
      ? await updateLive(ev.id, (live) => {
          if (live.timer.sceneId !== current.id) return
          Object.assign(live.timer, {
            mode: updated.content.mode,
            durationMs: updated.content.durationSec * 1000,
            label: updated.content.title,
            warnMs: updated.content.warnSec * 1000,
            criticalMs: updated.content.criticalSec * 1000,
            onEnd: updated.content.onEnd,
            endText: updated.content.endText,
          })
        })
      : null
  const live = (ev2 ?? toEventInfo((await eventRow(ev.id)) ?? ev)).live
  await publish(ev.id, ...(live.program === current.id || live.timer.sceneId === current.id ? [] : (['moderator'] as const)))
  return c.json({ ok: true })
})

moderator.post('/events/:id/scenes/:sid/duplicate', async (c) => {
  const ev = c.get('event')
  const src = await scene(ev.id, c.req.param('sid'))
  if (!src) return c.json({ error: 'Cena não encontrada.' }, 404)
  const id = newId()
  await batch([
    { sql: 'UPDATE scenes SET position = position + 1 WHERE event_id = ? AND position > ?', args: [ev.id, src.position] },
    {
      sql: 'INSERT INTO scenes (id, event_id, position, type, name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [id, ev.id, src.position + 1, src.type, `${src.name} (cópia)`.slice(0, 80), JSON.stringify(src.content), Date.now()],
    },
  ])
  await publish(ev.id, 'moderator')
  return c.json({ id }, 201)
})

moderator.delete('/events/:id/scenes/:sid', async (c) => {
  const ev = c.get('event')
  const sid = c.req.param('sid')
  if (!(await run('DELETE FROM scenes WHERE event_id = ? AND id = ?', ev.id, sid)).changes) return c.json({ error: 'Cena não encontrada.' }, 404)
  await updateLive(ev.id, (live) => {
    if (live.program === sid) live.program = null
    if (live.preview === sid) live.preview = null
    if (live.playback.sceneId === sid) live.playback = defaultLive().playback // vídeo apagado sai do ar como num corte
    delete live.slides[sid]
  })
  await publish(ev.id)
  return c.json({ ok: true })
})

moderator.post('/events/:id/scenes/order', async (c) => {
  const ev = c.get('event')
  const { ids } = await body(c, z.object({ ids: z.array(z.string()).max(1000) }))
  // Lista desatualizada ou parcial não repete posições: as listadas na ordem pedida; as demais depois, na ordem atual.
  const current = (await scenes(ev.id)).map((s) => s.id)
  const order = [...new Set(ids.filter((id) => current.includes(id))), ...current.filter((id) => !ids.includes(id))]
  await batch(order.map((id, i) => ({ sql: 'UPDATE scenes SET position = ? WHERE event_id = ? AND id = ?', args: [i, ev.id, id] })))
  await publish(ev.id, 'moderator')
  return c.json({ ok: true })
})

// ---------- ao vivo ----------

/** Ao entrar no ar, cronômetro e vídeo da cena começam do zero. */
function onAir(live: LiveState, s: Scene | null, now: number) {
  if (s?.type === 'timer' && live.timer.sceneId !== s.id) {
    live.timer = {
      sceneId: s.id,
      mode: s.content.mode,
      durationMs: s.content.durationSec * 1000,
      running: false,
      startedAt: 0,
      elapsedMs: 0,
      label: s.content.title,
      warnMs: s.content.warnSec * 1000,
      criticalMs: s.content.criticalSec * 1000,
      onEnd: s.content.onEnd,
      endText: s.content.endText,
    }
  }
  if (s?.type === 'video') live.playback = { sceneId: s.id, playing: s.content.autoplay, startedAt: now, positionMs: 0 }
  else if (live.playback.sceneId !== s?.id) live.playback = { sceneId: null, playing: false, startedAt: 0, positionMs: 0 }
}

moderator.post('/events/:id/live', async (c) => {
  const ev = c.get('event')
  const cmd = await body(c, liveCommand)
  const now = Date.now()
  let programChanged = false
  let error: string | null = null
  let status: 400 | 404 = 404
  await updateLive(ev.id, async (live) => {
    // A transação pode ser refeita (conflito no Postgres): cada tentativa começa do zero.
    programChanged = false
    error = null
    status = 404
    switch (cmd.op) {
      case 'preview': {
        const s = cmd.sceneId === null ? null : await scene(ev.id, cmd.sceneId)
        if (cmd.sceneId !== null && !s) error = 'Cena não encontrada.' // "" também não é cena
        else if (s?.type === 'section') [error, status] = ['Pastas só organizam o roteiro e não vão para a tela. Escolha uma cena.', 400]
        else live.preview = cmd.sceneId
        break
      }
      case 'take': {
        // Convenção de switcher: prévia e no ar trocam de lugar, então um segundo corte desfaz o primeiro.
        if (!live.preview) {
          error = 'Nada na prévia. Escolha uma cena no roteiro.'
          break
        }
        if (now - live.takenAt < 400) break // toque duplo acidental
        const s = await scene(ev.id, live.preview)
        if (!s) {
          error = 'Cena não encontrada.'
          break
        }
        live.preview = live.program
        live.program = s.id
        live.standby = false
        live.transition = cmd.transition ?? 'cut'
        live.takenAt = now
        onAir(live, s, now)
        programChanged = true
        break
      }
      case 'standby':
        live.standby = cmd.on
        programChanged = true
        break
      case 'overlays':
        live.overlays = { reactions: cmd.reactions ?? live.overlays.reactions, join: cmd.join ?? live.overlays.join }
        break
      case 'timer': {
        const t = live.timer
        if (cmd.action === 'start' && !t.running) Object.assign(t, { running: true, startedAt: now })
        if (cmd.action === 'pause' && t.running) Object.assign(t, { running: false, elapsedMs: timerElapsed(t, now) })
        if (cmd.action === 'reset') Object.assign(t, { running: false, elapsedMs: 0, startedAt: 0 })
        // Somar tempo em contagem regressiva estende a duração; no cronômetro, avança o decorrido.
        if (cmd.action === 'add' && cmd.ms) {
          if (t.mode === 'countdown') t.durationMs = Math.max(0, t.durationMs + cmd.ms)
          // Correndo, o ajuste vale sobre o total (acumulado + desde startedAt), que passa a contar de agora.
          else Object.assign(t, { elapsedMs: Math.max(0, timerElapsed(t, now) + cmd.ms), startedAt: t.running ? now : t.startedAt })
        }
        if (cmd.action === 'set')
          live.timer = {
            ...t,
            sceneId: null,
            mode: cmd.mode ?? t.mode,
            durationMs: cmd.durationMs ?? t.durationMs,
            label: cmd.label ?? t.label,
            warnMs: cmd.warnMs ?? t.warnMs,
            criticalMs: cmd.criticalMs ?? t.criticalMs,
            onEnd: cmd.onEnd ?? t.onEnd,
            endText: cmd.endText ?? t.endText,
            running: false,
            startedAt: 0,
            elapsedMs: 0,
          }
        break
      }
      case 'playback': {
        const p = live.playback
        if (!p.sceneId) break
        if (cmd.action === 'play' && !p.playing) Object.assign(p, { playing: true, startedAt: now })
        if (cmd.action === 'pause' && p.playing) Object.assign(p, { playing: false, positionMs: playbackPosition(p, now) })
        if (cmd.action === 'restart') Object.assign(p, { positionMs: 0, startedAt: now })
        break
      }
      case 'slide': {
        // Sem sceneId, passa o slide da apresentação no ar; com ele, escolhe o slide de qualquer apresentação
        // (na prévia, define de onde ela começa). Cada apresentação guarda o próprio slide.
        const s = await scene(ev.id, cmd.sceneId ?? live.program)
        if (!s && cmd.sceneId) error = 'Apresentação não encontrada.'
        else if (s?.type !== 'slides') [error, status] = [cmd.sceneId ? 'A cena não é uma apresentação.' : 'Nenhuma apresentação no ar.', 400]
        else {
          const at = slideIndex(live, s)
          const to = cmd.to === 'next' ? at + 1 : cmd.to === 'prev' ? at - 1 : cmd.to
          live.slides[s.id] = Math.max(0, Math.min(to, s.content.slides.length - 1))
        }
        break
      }
      case 'timerOverlay':
        live.timerOverlay = cmd.on ?? live.timerOverlay
        live.timerCorner = cmd.corner ?? live.timerCorner
        break
      case 'questionOverlay': {
        // Mesma regra da cena de perguntas: só aprovada ou respondida vai para a tela.
        const q = cmd.questionId === null ? null : await question(ev.id, cmd.questionId)
        if (cmd.questionId !== null && !q) error = 'Pergunta não encontrada.'
        else if (q?.status === 'pending') [error, status] = ['A pergunta ainda não foi aprovada. Aprove antes de mostrar sobre o conteúdo.', 400]
        else if (q?.status === 'rejected') [error, status] = ['A pergunta foi rejeitada. Aprove antes de mostrar sobre o conteúdo.', 400]
        else live.questionOverlay = cmd.questionId
        break
      }
    }
  })
  if (error) return c.json({ error }, status)
  // No Postgres, rejeitar a pergunta enquanto esta transação a lia não conflita (o lote roda fora dela): confere de
  // novo depois de gravar, para um id rejeitado não ficar guardado e voltar à tela se ela for aprovada outra vez.
  if (cmd.op === 'questionOverlay' && cmd.questionId !== null) {
    const q = await question(ev.id, cmd.questionId)
    if (q?.status !== 'approved' && q?.status !== 'answered') await dropOverlay(ev.id, [cmd.questionId])
  }
  await publish(ev.id, ...(programChanged ? [] : (['moderator', 'screen'] as const)))
  return c.json({ ok: true })
})

// ---------- página web ----------

// O site aceita aparecer dentro da tela? O console avisa antes de ir ao ar (e sugere o endereço com QR code).
moderator.post('/events/:id/embed-check', async (c) => {
  const { url } = await body(c, z.object({ url: z.url({ protocol: /^https$/, error: 'Use um endereço https.' }).max(2000) }))
  if (await overLimit(`embed:${c.get('moderator').id}`, 60, 10 * 60_000))
    return c.json({ error: 'Muitas verificações seguidas. Aguarde alguns minutos e tente de novo.' }, 429)
  return c.json(await checkEmbed(url))
})

// ---------- perguntas ----------

moderator.post('/events/:id/questions', async (c) => {
  const ev = c.get('event')
  const input = await body(c, z.object({ text: z.string().trim().min(1).max(1000), author: z.string().trim().max(80) }))
  await run(
    `INSERT INTO questions (id, event_id, participant_id, author, anonymous, original, text, status, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'approved', ?)`,
    newId(),
    ev.id,
    input.author,
    input.author ? 0 : 1,
    input.text,
    input.text,
    Date.now(),
  )
  await publish(ev.id, 'moderator')
  return c.json({ ok: true }, 201)
})

moderator.patch('/events/:id/questions/:qid', async (c) => {
  const ev = c.get('event')
  const input = await body(
    c,
    z.object({
      text: z.string().trim().min(1).max(1000).optional(),
      status: z.enum(['pending', 'approved', 'rejected', 'answered']).optional(),
      anonymous: z.boolean().optional(),
    }),
  )
  // Lida depois do corpo: uma edição lenta não desfaz rejeição ou saída da tela feitas enquanto ela chegava.
  const q = await question(ev.id, c.req.param('qid'))
  if (!q) return c.json({ error: 'Pergunta não encontrada.' }, 404)
  const status = input.status ?? q.status
  const text = input.text?.replace(/\s+/g, ' ') ?? q.text
  // Pergunta que deixa de estar aprovada sai da tela.
  const showable = status === 'approved' || status === 'answered'
  const screen = showable ? q.screen : null
  await run(
    'UPDATE questions SET text = ?, status = ?, anonymous = ?, screen = ?, flagged = ? WHERE id = ?',
    text,
    status,
    (input.anonymous ?? q.anonymous) ? 1 : 0,
    screen,
    hasFlagWord(text, toEventInfo(ev).settings.flagWords) ? 1 : 0,
    q.id,
  )
  // Sobre o conteúdo (lido depois da gravação): sai se deixou de estar aprovada; editada, a tela recebe o texto novo.
  const overlay = showable ? toEventInfo((await eventRow(ev.id)) ?? ev).live.questionOverlay === q.id : await dropOverlay(ev.id, [q.id])
  await publish(
    ev.id,
    'moderator',
    ...(q.participantId ? ([`p:${q.participantId}`] as const) : []),
    ...(q.screen !== null ? (['screen', 'participants'] as const) : overlay ? (['screen'] as const) : []),
  )
  return c.json({ ok: true })
})

/** Tira de cima do conteúdo a pergunta que não pode mais aparecer (pendente, rejeitada ou excluída). Diz se ela estava lá. */
async function dropOverlay(eventId: string, ids: string[]): Promise<boolean> {
  const r = await eventRow(eventId)
  const id = r && toEventInfo(r).live.questionOverlay
  if (!id || !ids.includes(id)) return false // caso comum: nada a gravar
  await updateLive(eventId, (live) => {
    if (live.questionOverlay === id) live.questionOverlay = null
  })
  return true
}

/** Coloca ou tira uma pergunta da tela. `solo` limpa as demais antes. */
moderator.post('/events/:id/questions/:qid/screen', async (c) => {
  const ev = c.get('event')
  const q = await question(ev.id, c.req.param('qid'))
  if (!q) return c.json({ error: 'Pergunta não encontrada.' }, 404)
  const { on, solo } = await body(c, z.object({ on: z.boolean(), solo: z.boolean().optional() }))
  const { autoAnswer } = toEventInfo(ev).settings
  await tx(async () => {
    if (solo) {
      // Destacar outra pergunta: a que estava na tela pode virar "respondida" automaticamente.
      if (autoAnswer)
        await run(
          `UPDATE questions SET status = 'answered' WHERE event_id = ? AND screen IS NOT NULL AND id != ? AND status = 'approved'`,
          ev.id,
          q.id,
        )
      await run('UPDATE questions SET screen = NULL WHERE event_id = ?', ev.id)
    }
    if (on) {
      const max = (await get<{ m: number | null }>('SELECT MAX(screen) AS m FROM questions WHERE event_id = ?', ev.id))?.m ?? -1
      // Aprovar ao exibir: o moderador já está escolhendo a pergunta.
      await run(
        `UPDATE questions SET screen = ?, status = CASE WHEN status = 'answered' THEN status ELSE 'approved' END WHERE id = ?`,
        max + 1,
        q.id,
      )
    } else await run('UPDATE questions SET screen = NULL WHERE id = ?', q.id)
  })
  await publish(ev.id)
  return c.json({ ok: true })
})

moderator.post('/events/:id/questions/bulk', async (c) => {
  const ev = c.get('event')
  const { ids, status } = await body(
    c,
    z.object({ ids: z.array(z.string()).min(1).max(1000), status: z.enum(['pending', 'approved', 'rejected', 'answered']) }),
  )
  const keepScreen = status === 'approved' || status === 'answered'
  await batch(
    ids.map((id) => ({
      sql: `UPDATE questions SET status = ?, screen = CASE WHEN ? = 1 THEN screen ELSE NULL END WHERE event_id = ? AND id = ?`,
      args: [status, keepScreen ? 1 : 0, ev.id, id],
    })),
  )
  if (!keepScreen) await dropOverlay(ev.id, ids)
  await publish(ev.id)
  return c.json({ ok: true })
})

moderator.post('/events/:id/questions/screen/clear', async (c) => {
  const ev = c.get('event')
  await run('UPDATE questions SET screen = NULL WHERE event_id = ?', ev.id)
  await publish(ev.id)
  return c.json({ ok: true })
})

moderator.delete('/events/:id/questions/:qid', async (c) => {
  const ev = c.get('event')
  const qid = c.req.param('qid')
  await batch([
    { sql: 'DELETE FROM likes WHERE question_id IN (SELECT id FROM questions WHERE event_id = ? AND id = ?)', args: [ev.id, qid] },
    { sql: 'DELETE FROM questions WHERE event_id = ? AND id = ?', args: [ev.id, qid] },
  ])
  await dropOverlay(ev.id, [qid])
  await publish(ev.id)
  return c.json({ ok: true })
})

moderator.post('/events/:id/reactions/reset', async (c) => {
  const ev = c.get('event')
  await run('DELETE FROM reactions WHERE event_id = ?', ev.id)
  await publishCounts(ev.id) // totais só viajam em `counts`; o snapshot não os carrega
  return c.json({ ok: true })
})

// ---------- participantes ----------

const person = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(200).default(''),
  group: z.string().trim().max(120).default(''),
})

moderator.post('/events/:id/participants', async (c) => {
  const ev = c.get('event')
  const { people } = await body(c, z.object({ people: z.array(person).min(1).max(5000) }))
  const now = Date.now()
  await batch(
    people.map((p) => ({
      sql: 'INSERT INTO participants (id, event_id, name, email, grp, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [newId(), ev.id, p.name, p.email, p.group, newId(18), now],
    })),
  )
  await publish(ev.id, 'moderator')
  return c.json({ created: people.length }, 201)
})

moderator.patch('/events/:id/participants/:pid', async (c) => {
  const ev = c.get('event')
  const pid = c.req.param('pid')
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      email: z.string().trim().max(200).optional(),
      group: z.string().trim().max(120).optional(),
      blocked: z.boolean().optional(),
    }),
  )
  // Lido depois do corpo: uma edição lenta não desfaz um bloqueio feito enquanto ela chegava.
  const p = await get<{ name: string; email: string; grp: string; blocked: number }>(
    'SELECT name, email, grp, blocked FROM participants WHERE event_id = ? AND id = ?',
    ev.id,
    pid,
  )
  if (!p) return c.json({ error: 'Participante não encontrado.' }, 404)
  await run(
    'UPDATE participants SET name = ?, email = ?, grp = ?, blocked = ? WHERE id = ?',
    input.name ?? p.name,
    input.email ?? p.email,
    input.group ?? p.grp,
    (input.blocked ?? !!p.blocked) ? 1 : 0,
    pid,
  )
  if (input.blocked) await kick(ev.id, pid)
  await publish(ev.id, 'moderator', `p:${pid}`)
  return c.json({ ok: true })
})

/** Gera um novo link de convite; o anterior deixa de funcionar e a sessão atual cai. */
moderator.post('/events/:id/participants/:pid/link', async (c) => {
  const ev = c.get('event')
  const pid = c.req.param('pid')
  const res = await run(
    'UPDATE participants SET token = ?, joined_at = NULL, session_epoch = ? WHERE event_id = ? AND id = ?',
    newId(18),
    Date.now(), // sessões abertas com o link antigo deixam de valer
    ev.id,
    pid,
  )
  if (!res.changes) return c.json({ error: 'Participante não encontrado.' }, 404)
  await kick(ev.id, pid)
  await publish(ev.id, 'moderator')
  return c.json({ ok: true })
})

moderator.delete('/events/:id/participants/:pid', async (c) => {
  const ev = c.get('event')
  const pid = c.req.param('pid')
  // Só mexe em curtidas e perguntas se a pessoa for deste evento; as perguntas ficam, sem autor vinculado.
  const mine = 'SELECT id FROM participants WHERE event_id = ? AND id = ?'
  await batch([
    { sql: `DELETE FROM likes WHERE participant_id IN (${mine})`, args: [ev.id, pid] },
    { sql: `UPDATE questions SET participant_id = NULL WHERE participant_id IN (${mine})`, args: [ev.id, pid] },
    { sql: 'DELETE FROM participants WHERE event_id = ? AND id = ?', args: [ev.id, pid] },
  ])
  await kick(ev.id, pid)
  await publish(ev.id, 'moderator')
  await publishCounts(ev.id) // as curtidas da pessoa saem junto
  return c.json({ ok: true })
})

// ---------- mídia ----------
// Com BLOB_READ_WRITE_TOKEN (Vercel), os arquivos vão para o Vercel Blob: a função só aceita corpos de até 4,5 MB,
// então o navegador envia direto ao Blob com um token preso a caminho, tipo e tamanho (ticket) e depois confirma
// (complete). Sem ele, o arquivo vem no corpo da requisição e fica em DATA_DIR/uploads.

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024
const FONT_MIME: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' }
// A extensão gravada vem do tipo validado, nunca do nome enviado: "foto.html" com image/png vira .png.
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
}
const UNSUPPORTED = 'Formato não suportado. Envie imagem (PNG, JPG, WebP, GIF, AVIF, SVG), vídeo (MP4, WebM) ou fonte (WOFF2, WOFF, TTF, OTF).'
const TOO_LARGE = 'Arquivo acima do limite de envio.'

function mediaKind(mime: string, nameExt: string): { kind: 'image' | 'video' | 'font'; ext: string } | null {
  if (FONT_MIME[nameExt]) return { kind: 'font', ext: nameExt }
  const ext = MIME_EXT[mime]
  if (!ext) return null
  return { kind: mime.startsWith('image/') ? 'image' : 'video', ext }
}

const decodeName = (raw: string) => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return 'arquivo'
  }
}
const cleanName = (raw: string) => raw.replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'arquivo'

/** Apaga os arquivos de mídia, no Blob ou em disco. */
async function removeFiles(eventId: string, files: { file: string; blob_url: string | null }[]) {
  const urls = files.flatMap((f) => (f.blob_url ? [f.blob_url] : []))
  if (urls.length) await del(urls, { token: BLOB_TOKEN })
  await Promise.all(files.filter((f) => !f.blob_url).map((f) => rm(join(UPLOADS_DIR, eventId, f.file), { force: true })))
}

/** Envio direto ao Blob: valida o arquivo declarado e devolve um token só para ele. Sem Blob, token null. */
moderator.post('/events/:id/media/ticket', async (c) => {
  const ev = c.get('event')
  const input = await body(c, z.object({ name: z.string().max(1000), type: z.string().max(200), size: z.number().int().min(0) }))
  const mime = input.type.trim().toLowerCase()
  const detected = mediaKind(mime, extname(cleanName(input.name)).toLowerCase())
  if (!detected) return c.json({ error: UNSUPPORTED }, 415)
  if (input.size > MAX_UPLOAD) return c.json({ error: TOO_LARGE }, 413)
  if (!input.size) return c.json({ error: 'Arquivo vazio.' }, 400)
  if (!BLOB_TOKEN) return c.json({ token: null })
  const pathname = `media/${ev.id}/${newId()}${detected.ext}`
  const contentType = detected.kind === 'font' ? FONT_MIME[detected.ext]! : mime
  const token = await generateClientTokenFromReadWriteToken({
    token: BLOB_TOKEN,
    pathname,
    allowedContentTypes: [contentType],
    maximumSizeInBytes: MAX_UPLOAD,
    validUntil: Date.now() + 60 * 60_000,
  })
  return c.json({ token, pathname, contentType })
})

/** Confirma um envio direto: confere no Blob o tipo e o tamanho reais antes de registrar na biblioteca. */
moderator.post('/events/:id/media/complete', async (c) => {
  const ev: EventRow = c.get('event')
  if (!BLOB_TOKEN) return c.json({ error: 'Envio direto desativado neste servidor.' }, 404)
  const input = await body(c, z.object({ pathname: z.string().max(300), name: z.string().max(1000) }))
  const match = /^media\/([0-9A-Z]+)\/([\w-]+)(\.[a-z0-9]+)$/.exec(input.pathname)
  if (!match || match[1] !== ev.id) return c.json({ error: 'Arquivo inválido.' }, 400)
  const [, , id, ext] = match as unknown as [string, string, string, string]
  const expected = FONT_MIME[ext] ?? Object.keys(MIME_EXT).find((t) => MIME_EXT[t] === ext)
  const info = await head(input.pathname, { token: BLOB_TOKEN }).catch(() => null)
  if (!info) return c.json({ error: 'Arquivo não encontrado. Envie de novo.' }, 404)
  // O token já restringe tipo e tamanho; conferir aqui também barra um envio feito por fora dele.
  const problem = info.contentType !== expected ? ([UNSUPPORTED, 415] as const) : info.size > MAX_UPLOAD ? ([TOO_LARGE, 413] as const) : !info.size ? (['Arquivo vazio.', 400] as const) : null
  if (problem) {
    await del(info.url, { token: BLOB_TOKEN })
    return c.json({ error: problem[0] }, problem[1])
  }
  const row = {
    id,
    event_id: ev.id,
    kind: FONT_MIME[ext] ? ('font' as const) : expected!.startsWith('image/') ? ('image' as const) : ('video' as const),
    name: cleanName(input.name),
    file: `${id}${ext}`,
    mime: info.contentType,
    size: info.size,
    created_at: Date.now(),
  }
  await run(
    'INSERT INTO media (id, event_id, kind, name, file, mime, size, created_at, blob_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    row.id,
    row.event_id,
    row.kind,
    row.name,
    row.file,
    row.mime,
    row.size,
    row.created_at,
    info.url,
  )
  await publish(ev.id, 'moderator')
  return c.json(toMedia(row), 201)
})

/** Upload em corpo bruto (sem multipart), gravado em disco por streaming. Nome em X-Filename. */
moderator.post('/events/:id/media', async (c) => {
  const ev: EventRow = c.get('event')
  if (BLOB_TOKEN) return c.json({ error: 'Este servidor recebe arquivos pelo envio direto. Recarregue a página e tente de novo.' }, 409)
  const name = cleanName(decodeName(c.req.header('x-filename') ?? 'arquivo'))
  const mime = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream'
  const detected = mediaKind(mime, extname(name).toLowerCase())
  if (!detected) return c.json({ error: UNSUPPORTED }, 415)
  const { kind, ext } = detected
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > MAX_UPLOAD) return c.json({ error: TOO_LARGE }, 413)
  if (!c.req.raw.body) return c.json({ error: 'Arquivo vazio.' }, 400)

  const id = newId()
  const file = `${id}${ext}`
  const dir = join(UPLOADS_DIR, ev.id)
  await mkdir(dir, { recursive: true })
  let size = 0
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      cb(size > MAX_UPLOAD ? new Error('too large') : null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(c.req.raw.body as import('node:stream/web').ReadableStream), limit, createWriteStream(join(dir, file)))
  } catch {
    await rm(join(dir, file), { force: true })
    if (size > MAX_UPLOAD) return c.json({ error: TOO_LARGE }, 413)
    return c.json({ error: 'Falha no envio do arquivo.' }, 400)
  }
  // Corpo presente mas sem bytes (Content-Length: 0) também é envio vazio.
  if (!size) {
    await rm(join(dir, file), { force: true })
    return c.json({ error: 'Arquivo vazio.' }, 400)
  }
  const now = Date.now()
  await run(
    'INSERT INTO media (id, event_id, kind, name, file, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    ev.id,
    kind,
    name,
    file,
    mime,
    size,
    now,
  )
  await publish(ev.id, 'moderator')
  return c.json(toMedia({ id, event_id: ev.id, kind, name, file, mime, size, created_at: now }), 201)
})

moderator.delete('/events/:id/media/:mid', async (c) => {
  const ev = c.get('event')
  const m = await mediaRow(ev.id, c.req.param('mid'))
  if (!m) return c.json({ error: 'Arquivo não encontrado.' }, 404)
  await run('DELETE FROM media WHERE id = ?', m.id)
  await removeFiles(ev.id, [m])
  await publish(ev.id, 'moderator')
  return c.json({ ok: true })
})

// ---------- equipe ----------

moderator.use('/moderators', requireModerator)
moderator.use('/moderators/*', requireModerator)

moderator.get('/moderators', async (c) =>
  c.json(await all('SELECT id, name, email, created_at AS "createdAt" FROM moderators ORDER BY lower(name)')),
)

moderator.post('/moderators', async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string('Informe o nome.').trim().min(1, 'Informe o nome.').max(120),
      email: emailField,
      password: z.string().min(8, 'A senha precisa de ao menos 8 caracteres.').max(200),
    }),
  )
  const password = await hashPassword(input.password)
  // Conferir e inserir num comando só: dois envios simultâneos com o mesmo e-mail viram uma conta e um 409, não um 500.
  const { changes } = await run(
    'INSERT INTO moderators (id, name, email, password, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    newId(),
    input.name,
    input.email,
    password,
    Date.now(),
  )
  if (!changes) return c.json({ error: 'Já existe uma conta com este e-mail.' }, 409)
  return c.json({ ok: true }, 201)
})

moderator.delete('/moderators/:mid', async (c) => {
  const mid = c.req.param('mid')
  const me = c.get('moderator').id
  if (mid === me) return c.json({ error: 'Você não pode remover a própria conta.' }, 400)
  // Conferir quem remove e remover na mesma transação: em remoções cruzadas simultâneas, quem já foi
  // removido não remove mais ninguém (no Postgres, uma das duas é refeita e encontra a conta apagada).
  const allowed = await tx(async () => {
    if (!(await get('SELECT 1 FROM moderators WHERE id = ?', me))) return false
    await run('DELETE FROM moderators WHERE id = ?', mid)
    return true
  })
  if (!allowed) return c.json({ error: 'Sua sessão expirou. Entre de novo para continuar.' }, 401)
  await kickModerator(mid) // console aberto deixa de receber dados do evento
  return c.json({ ok: true })
})

// ---------- conta ----------

moderator.use('/auth/password', requireModerator)

/** Troca a senha e encerra as outras sessões (a atual recebe um cookie novo). */
moderator.post('/auth/password', async (c) => {
  const me = c.get('moderator')
  const input = await body(
    c,
    z.object({ current: z.string().max(200), next: z.string().min(8, 'A nova senha precisa de ao menos 8 caracteres.').max(200) }),
  )
  if (await overLimit(`pw:${me.id}`, 10, 10 * 60_000)) return c.json({ error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' }, 429)
  const row = await get<{ password: string }>('SELECT password FROM moderators WHERE id = ?', me.id)
  if (!row || !(await verifyPassword(input.current, row.password))) return c.json({ error: 'Senha atual incorreta.' }, 400)
  await run('UPDATE moderators SET password = ?, session_epoch = ? WHERE id = ?', await hashPassword(input.next), Date.now(), me.id)
  await kickModerator(me.id) // consoles reconectam: só os da sessão atual voltam (cookie novo)
  await startModeratorSession(c, me.id)
  return c.json({ ok: true })
})
