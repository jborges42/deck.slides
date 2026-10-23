// Tempo real: cada conexão SSE recebe o snapshot completo da sua audiência
// (`state`), totais de reações/curtidas (`counts`) e um `ping` com o relógio do servidor.
// Várias instâncias podem servir o mesmo evento (na Vercel, a função escala sozinha), então o que todas
// precisam ver fica no banco: cada publish grava um sinal (tabela signals) e cada instância com conexões
// abertas lê os sinais das outras a cada 250 ms e republica para as suas. Presença fica em `connections`.
// ponytail: snapshot completo a cada mudança; trocar por diffs se um evento passar de ~1k perguntas.
// ponytail: um sinal gravado por publish; agrupar em lote se o volume de escritas no Turso pesar.
import type { Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { publicBase } from './config.ts'
import { all, batch, get, newCode, newId, normalizeCode, run, tx } from './db.ts'
import {
  eventRow,
  media,
  participants,
  question,
  questions,
  scene,
  scenes,
  screenQuestions,
  toEventInfo,
  toParticipant,
  type EventRow,
  type ParticipantRow,
} from './model.ts'
import {
  overlayQuestion,
  type Counts,
  type ModeratorSnapshot,
  type ParticipantSnapshot,
  type QuestionStatus,
  type ReactionKind,
  type ScreenSnapshot,
} from '../shared/types.ts'

type Audience = 'moderator' | 'screen' | 'participant'
type Target = 'moderator' | 'screen' | 'participants' | `p:${string}`

interface Client {
  id: string // linha em `connections`
  eventId: string
  audience: Audience
  participantId?: string
  moderatorId?: string // console: fecha quando a conta é removida ou troca a senha
  screenId?: string | null // tela pareada; null = tela aberta pelo próprio console
  stream: SSEStreamingApi
}

const PUBLIC_URL = publicBase()
const INSTANCE = newId() // identifica os sinais e conexões deste processo
const POLL_MS = 250
const BEAT_MS = 15_000 // ping para o navegador e batimento das conexões no banco
const ONLINE_MS = 40_000 // conexão sem batimento há mais que isto (instância que caiu) conta como offline
// Na Vercel a função tem duração máxima: a conexão se despede antes (`reconnect`) e o navegador reabre na hora.
const STREAM_MAX_MS = Number(process.env.STREAM_MAX_S ?? 0) * 1000

const clients = new Map<string, Set<Client>>()
const waiting = new Map<string, Set<SSEStreamingApi>>() // telas esperando pareamento, por hash do segredo

/** Espera do batimento que termina na hora se a conexão cair (e não segura o processo aberto). */
function heartbeat(aborted: Promise<void>, ms: number) {
  return Promise.race([aborted, new Promise<void>((r) => setTimeout(r, ms).unref())])
}

function send(c: Client, event: string, data: string) {
  if (!c.stream.aborted && !c.stream.closed) c.stream.writeSSE({ event, data }).catch(() => {})
}

/** Último aviso e fecha. O abort espera a escrita: abortar logo em seguida descartava a mensagem. */
function end(s: SSEStreamingApi, event: string, data = '{}') {
  const stop = () => s.abort()
  // Espera o aviso sair (até 1 s): cliente que não lê o socket não fica registrado nem conta como online.
  return Promise.race([s.writeSSE({ event, data }), new Promise<void>((r) => setTimeout(r, 1000).unref())]).then(stop, stop)
}

/** Espera os batimentos até a conexão cair ou chegar ao tempo máximo. `beat` roda a cada batimento; false encerra. */
async function keepAlive(stream: SSEStreamingApi, beat: () => Promise<boolean>) {
  const aborted = new Promise<void>((r) => stream.onAbort(r))
  const deadline = STREAM_MAX_MS ? Date.now() + STREAM_MAX_MS : Infinity
  while (!stream.aborted && !stream.closed) {
    await heartbeat(aborted, Math.min(BEAT_MS, deadline - Date.now()))
    if (stream.aborted || stream.closed) return
    if (Date.now() >= deadline) return void (await stream.writeSSE({ event: 'reconnect', data: '{}' }).catch(() => {}))
    if (!(await beat())) return
  }
}

// ---------- presença ----------

interface ConnectionRow {
  audience: Audience
  participant_id: string | null
  screen_id: string | null
}

const openConnections = (eventId: string) =>
  all<ConnectionRow>('SELECT audience, participant_id, screen_id FROM connections WHERE event_id = ? AND seen > ?', eventId, Date.now() - ONLINE_MS)

/** Conexões abertas de um participante em todas as instâncias (limita abas para não esgotar o servidor). */
export async function connections(eventId: string, participantId: string): Promise<number> {
  const row = await get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM connections WHERE event_id = ? AND participant_id = ? AND seen > ?',
    eventId,
    participantId,
    Date.now() - ONLINE_MS,
  )
  return row?.n ?? 0
}

// ---------- snapshots ----------

async function moderatorSnapshot(r: EventRow): Promise<ModeratorSnapshot> {
  const [sc, qs, people, md, screens, open] = await Promise.all([
    scenes(r.id),
    questions(r.id),
    participants(r.id),
    media(r.id),
    all<{ id: string; name: string; created_at: number; last_seen: number | null }>(
      'SELECT id, name, created_at, last_seen FROM screens WHERE event_id = ? ORDER BY created_at',
      r.id,
    ),
    openConnections(r.id),
  ])
  const online = new Set(open.flatMap((c) => (c.participant_id ? [c.participant_id] : [])))
  const screensOnline = new Set(open.flatMap((c) => (c.screen_id ? [c.screen_id] : [])))
  return {
    serverNow: Date.now(),
    publicUrl: PUBLIC_URL,
    event: toEventInfo(r),
    scenes: sc,
    questions: qs,
    participants: people.map((p) => toParticipant(p, online)),
    media: md,
    screens: screens.map((s) => ({ id: s.id, name: s.name, online: screensOnline.has(s.id), createdAt: s.created_at, lastSeen: s.last_seen })),
    presence: {
      participants: online.size,
      screens: open.filter((c) => c.audience === 'screen').length,
      moderators: open.filter((c) => c.audience === 'moderator').length,
    },
  }
}

async function screenSnapshot(r: EventRow): Promise<ScreenSnapshot> {
  const ev = toEventInfo(r)
  const overlayId = ev.live.questionOverlay
  const [program, overlay] = await Promise.all([scene(r.id, ev.live.program), overlayId ? question(r.id, overlayId) : null])
  return {
    serverNow: Date.now(),
    publicUrl: PUBLIC_URL,
    event: {
      id: ev.id,
      name: ev.name,
      pin: ev.pin,
      theme: ev.theme,
      live: ev.live,
      reactions: ev.settings.reactions,
      openJoin: ev.settings.openJoin,
    },
    program,
    questions: program?.type === 'questions' ? await screenQuestions(r.id, program.content.max, ev.settings.screenName) : [],
    questionOverlay: overlayQuestion(overlay ? [overlay] : [], overlayId, ev.settings.screenName),
  }
}

type Common = Omit<ParticipantSnapshot, 'me' | 'mine' | 'now'> & {
  now: null | (Omit<NonNullable<ParticipantSnapshot['now']>, 'questions'> & { questions: ScreenSnapshot['questions'] })
}

function participantCommon(r: EventRow, snap: ScreenSnapshot): Common {
  const { questions: qs, event, serverNow } = snap
  const ev = toEventInfo(r)
  const program = ev.live.standby ? null : snap.program
  const label = !program
    ? ''
    : program.type === 'title' || program.type === 'questions' || program.type === 'timer' || program.type === 'join'
      ? program.content.title || program.name
      : program.type === 'image'
        ? program.content.caption || program.name
        : program.name
  return {
    serverNow,
    event: {
      id: event.id,
      name: event.name,
      theme: { brand: ev.theme.brand, contrast: ev.theme.contrast, logo: ev.theme.logo, fonts: ev.theme.fonts },
      settings: {
        questionsOpen: ev.settings.questionsOpen,
        reactionsOpen: ev.settings.reactionsOpen,
        identity: ev.settings.identity,
        maxLength: ev.settings.maxLength,
        reactions: ev.settings.reactions,
      },
    },
    now: program ? { sceneId: program.id, type: program.type, label, questions: qs } : null,
  }
}

interface MineRow {
  id: string
  participant_id: string
  text: string
  original: string
  status: QuestionStatus
  screen: number | null
  created_at: number
}

/**
 * Snapshots de vários participantes com três consultas no total (não três por pessoa: o banco pode estar
 * do outro lado da rede). null = participante removido ou bloqueado.
 */
async function participantSnapshots(r: EventRow, pids: string[], common: Common): Promise<Map<string, ParticipantSnapshot | null>> {
  const marks = pids.map(() => '?').join(', ')
  const [people, likes, mine] = await Promise.all([
    all<ParticipantRow>(`SELECT * FROM participants WHERE event_id = ? AND id IN (${marks})`, r.id, ...pids),
    all<{ question_id: string; participant_id: string }>(`SELECT question_id, participant_id FROM likes WHERE participant_id IN (${marks})`, ...pids),
    all<MineRow>(
      `SELECT id, participant_id, text, original, status, screen, created_at FROM questions
       WHERE participant_id IN (${marks}) ORDER BY created_at DESC`,
      ...pids,
    ),
  ])
  const byId = new Map(people.map((p) => [p.id, p]))
  const liked = new Map<string, Set<string>>()
  for (const l of likes) (liked.get(l.participant_id) ?? liked.set(l.participant_id, new Set()).get(l.participant_id)!).add(l.question_id)
  const mineOf = new Map<string, MineRow[]>()
  for (const q of mine) (mineOf.get(q.participant_id) ?? mineOf.set(q.participant_id, []).get(q.participant_id)!).push(q)

  const out = new Map<string, ParticipantSnapshot | null>()
  for (const pid of pids) {
    const p = byId.get(pid)
    if (!p || p.blocked) {
      out.set(pid, null)
      continue
    }
    const mineLiked = liked.get(pid)
    out.set(pid, {
      ...common,
      now: common.now && { ...common.now, questions: common.now.questions.map((q) => ({ ...q, liked: !!mineLiked?.has(q.id) })) },
      me: { id: p.id, name: p.name },
      mine: (mineOf.get(pid) ?? []).map((q) => ({
        id: q.id,
        text: q.text,
        status: q.status,
        onScreen: q.screen !== null && q.status !== 'rejected' && q.status !== 'pending',
        edited: q.text !== q.original,
        createdAt: q.created_at,
      })),
    })
  }
  return out
}

async function firstSnapshot(r: EventRow, cl: Client) {
  if (cl.audience === 'moderator') return moderatorSnapshot(r)
  const scr = await screenSnapshot(r)
  if (cl.audience === 'screen') return scr
  return (await participantSnapshots(r, [cl.participantId!], participantCommon(r, scr))).get(cl.participantId!) ?? null
}

export async function counts(eventId: string): Promise<Counts> {
  const out: Counts = { reactions: {}, likes: {} }
  const [reactions, likes] = await Promise.all([
    all<{ scene_id: string; kind: ReactionKind; count: number }>('SELECT scene_id, kind, count FROM reactions WHERE event_id = ?', eventId),
    all<{ question_id: string; n: number }>(
      `SELECT l.question_id, COUNT(*) AS n FROM likes l JOIN questions q ON q.id = l.question_id
       WHERE q.event_id = ? GROUP BY l.question_id`,
      eventId,
    ),
  ])
  for (const r of reactions) (out.reactions[r.scene_id] ??= {})[r.kind] = r.count
  for (const r of likes) out.likes[r.question_id] = r.n
  return out
}

// ---------- entrega nesta instância ----------

const chains = new Map<string, Promise<void>>()

/** Entregas de um evento em fila: um snapshot lido antes nunca chega depois de um lido mais tarde. */
function enqueue<T>(eventId: string, job: () => Promise<T>): Promise<T> {
  const result = (chains.get(eventId) ?? Promise.resolve()).then(job)
  const tail = result.then(
    () => {},
    (e) => console.error(`[${new Date().toISOString()}] tempo real, evento ${eventId}`, e),
  )
  chains.set(eventId, tail)
  void tail.then(() => chains.get(eventId) === tail && chains.delete(eventId))
  return result
}

// Moderação e tela recebem em até 40 ms; celulares em até 500 ms (podem ser milhares).
const fast = new Map<string, Set<Target>>()
const slow = new Map<string, Set<Target>>()
const ALL: Target[] = ['moderator', 'screen', 'participants']

function schedule(eventId: string, targets: Target[]) {
  if (!clients.has(eventId)) return
  for (const t of targets) {
    const [queue, delay] = t === 'moderator' || t === 'screen' ? [fast, 40] : [slow, 500]
    let set = queue.get(eventId)
    if (!set) {
      const pending = (set = new Set())
      queue.set(eventId, pending)
      setTimeout(() => {
        queue.delete(eventId)
        void enqueue(eventId, () => flush(eventId, pending))
      }, delay)
    }
    set.add(t)
  }
}

async function flush(eventId: string, targets: Set<Target>) {
  const subs = [...(clients.get(eventId) ?? [])]
  if (!subs.length) return
  const r = await eventRow(eventId)
  if (!r) {
    for (const c of subs) void end(c.stream, 'gone')
    return
  }
  const to = subs.filter((c) =>
    c.audience === 'participant' ? targets.has('participants') || targets.has(`p:${c.participantId}`) : targets.has(c.audience),
  )
  const pids = [...new Set(to.flatMap((c) => (c.audience === 'participant' ? [c.participantId!] : [])))]
  const [mod, scr] = await Promise.all([
    to.some((c) => c.audience === 'moderator') ? moderatorSnapshot(r) : null,
    pids.length || to.some((c) => c.audience === 'screen') ? screenSnapshot(r) : null,
  ])
  const people = pids.length ? await participantSnapshots(r, pids, participantCommon(r, scr!)) : new Map<string, null>()
  const modJson = mod && JSON.stringify(mod)
  const scrJson = scr && JSON.stringify(scr)
  for (const c of to) {
    if (c.audience === 'moderator') send(c, 'state', modJson!)
    else if (c.audience === 'screen') send(c, 'state', scrJson!)
    else {
      const snap = people.get(c.participantId!)
      if (snap) send(c, 'state', JSON.stringify(snap))
      else void end(c.stream, 'gone')
    }
  }
}

const countsPending = new Set<string>()

/** Totais de reações e curtidas: no máximo 4 envios por segundo por evento. */
function scheduleCounts(eventId: string) {
  if (!clients.has(eventId) || countsPending.has(eventId)) return
  countsPending.add(eventId)
  setTimeout(() => {
    countsPending.delete(eventId)
    void enqueue(eventId, async () => {
      if (!clients.get(eventId)?.size) return
      const data = JSON.stringify(await counts(eventId))
      for (const c of clients.get(eventId) ?? []) send(c, 'counts', data)
    })
  }, 250)
}

function eachClient(eventId: string | null, match: (c: Client) => boolean, act: (c: Client) => void) {
  for (const [id, set] of clients) if (eventId === null || id === eventId) for (const c of set) if (match(c)) act(c)
}

/** Aplica nesta instância um aviso (gerado aqui ou lido dos sinais de outra). */
function deliver(eventId: string, targets: string[]) {
  const regular: Target[] = []
  for (const t of targets) {
    const [kind, who, id] = t.split(':') as [string, string?, string?]
    if (t === 'counts') scheduleCounts(eventId)
    else if (kind === 'kick' && who === 'p') eachClient(eventId, (c) => c.participantId === id, (c) => void end(c.stream, 'gone'))
    else if (kind === 'kick' && who === 's')
      eachClient(eventId, (c) => c.screenId === id, (c) => void end(c.stream, 'gone', '{"reason":"unpaired"}'))
    // Sem `gone`: quem ainda tem sessão válida reconecta.
    else if (kind === 'kick' && who === 'm') eachClient(null, (c) => c.moderatorId === id, (c) => c.stream.abort())
    else if (kind === 'paired') for (const s of waiting.get(t.slice('paired:'.length)) ?? []) void end(s, 'paired')
    else regular.push(t as Target)
  }
  if (regular.length) schedule(eventId, regular)
}

// ---------- publicação (todas as instâncias) ----------

/** Entrega aqui e grava o sinal para as outras instâncias. Espera a gravação: na Vercel, nada roda depois da resposta. */
async function broadcast(eventId: string, targets: string[]) {
  deliver(eventId, targets)
  await run('INSERT INTO signals (instance, event_id, targets, created_at) VALUES (?, ?, ?, ?)', INSTANCE, eventId, JSON.stringify(targets), Date.now())
}

/** Agenda o envio de snapshots novos. Sem alvos = todas as audiências. */
export const publish = (eventId: string, ...targets: Target[]) => broadcast(eventId, targets.length ? targets : ALL)

/** Totais de reações e curtidas mudaram. */
export const publishCounts = (eventId: string) => broadcast(eventId, ['counts'])

/** Desconecta uma tela despareada: ela volta a mostrar um código de pareamento. */
export const kickScreen = (eventId: string, screenId: string) => broadcast(eventId, [`kick:s:${screenId}`])

/** Encerra as conexões de um participante (bloqueado ou removido). */
export const kick = (eventId: string, participantId: string) => broadcast(eventId, [`kick:p:${participantId}`])

/** Fecha os consoles de um moderador (conta removida ou senha trocada), em qualquer evento. */
export const kickModerator = (moderatorId: string) => broadcast('', [`kick:m:${moderatorId}`])

// ---------- leitura dos sinais das outras instâncias ----------

let started: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | undefined
let lastSignal = 0
let lastBeat = 0
let ticking = false

/** Liga a leitura dos sinais e espera o marco inicial: o que mudar depois dele chega a esta instância. */
function polling(): Promise<void> {
  started ??= get<{ m: number | null }>('SELECT MAX(id) AS m FROM signals').then(
    (row) => {
      lastSignal = row?.m ?? 0
      timer ??= setInterval(tick, POLL_MS)
      timer.unref()
    },
    (e) => {
      started = null
      throw e
    },
  )
  return started
}

/** Sem conexões abertas aqui, para de consultar o banco. */
function idle() {
  if (clients.size || waiting.size) return
  clearInterval(timer)
  timer = undefined
  started = null
}

async function tick() {
  if (ticking) return
  ticking = true
  try {
    // Lê também os próprios sinais (e pula): o marco avança e a mesma linha não é relida a cada volta.
    for (const s of await all<{ id: number; instance: string; event_id: string; targets: string }>(
      'SELECT id, instance, event_id, targets FROM signals WHERE id > ? ORDER BY id',
      lastSignal,
    )) {
      lastSignal = s.id
      if (s.instance !== INSTANCE) deliver(s.event_id, JSON.parse(s.targets))
    }
    if (Date.now() - lastBeat >= BEAT_MS) {
      const now = (lastBeat = Date.now())
      await batch([
        { sql: 'UPDATE connections SET seen = ? WHERE instance = ?', args: [now, INSTANCE] },
        { sql: 'DELETE FROM connections WHERE seen < ?', args: [now - 10 * 60_000] },
        { sql: 'DELETE FROM signals WHERE created_at < ?', args: [now - 60_000] },
        { sql: 'DELETE FROM pairings WHERE expires < ?', args: [now] },
        { sql: 'DELETE FROM hits WHERE reset < ?', args: [now] },
      ])
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] leitura de sinais`, e)
  } finally {
    ticking = false
  }
}

// ---------- conexão ----------

export function stream(c: Context, client: Omit<Client, 'id' | 'stream'>) {
  return streamSSE(c, async (stream) => {
    const cl: Client = { ...client, id: newId(), stream }
    // Registra antes de ler o snapshot: uma mudança no meio do caminho ainda chega a esta conexão.
    const set = clients.get(cl.eventId) ?? clients.set(cl.eventId, new Set()).get(cl.eventId)!
    set.add(cl)
    let connected = false
    try {
      await polling()
      const ok = await enqueue(cl.eventId, async () => {
        const r = await eventRow(cl.eventId)
        const first = r && (await firstSnapshot(r, cl))
        if (!first) return false
        stream.writeSSE({ event: 'state', data: JSON.stringify(first), retry: 2000 }).catch(() => {})
        stream.writeSSE({ event: 'counts', data: JSON.stringify(await counts(cl.eventId)) }).catch(() => {})
        return true
      })
      if (!ok) return void (await stream.writeSSE({ event: 'gone', data: '{}' }).catch(() => {}))
      const now = Date.now()
      await run(
        'INSERT INTO connections (id, instance, event_id, audience, participant_id, screen_id, seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
        cl.id,
        INSTANCE,
        cl.eventId,
        cl.audience,
        cl.participantId ?? null,
        cl.screenId ?? null,
        now,
      )
      connected = true
      if (cl.screenId) await run('UPDATE screens SET last_seen = ? WHERE id = ?', now, cl.screenId)
      // Presença: toda conexão, inclusive de console, atualiza os consoles (o snapshot inicial ainda não conta esta).
      await publish(cl.eventId, 'moderator')
      await keepAlive(stream, async () => {
        send(cl, 'ping', String(Date.now()))
        return true
      })
    } finally {
      set.delete(cl)
      if (!set.size && clients.get(cl.eventId) === set) clients.delete(cl.eventId)
      idle()
      if (connected) {
        await run('DELETE FROM connections WHERE id = ?', cl.id)
        if (cl.screenId) await run('UPDATE screens SET last_seen = ? WHERE id = ?', Date.now(), cl.screenId)
        await publish(cl.eventId, 'moderator')
      }
    }
  })
}

// ---------- pareamento de telas ----------
// A tela abre /tela, recebe um código curto e espera nesta "sala". Quando a moderação digita o código
// no console, a tela é vinculada ao evento (tabela screens) e reconecta já recebendo o snapshot.

const PAIRING_MS = 15 * 60_000

/** Código de pareamento vigente para esta tela; gera outro quando expira ou com `renew`. */
export async function pairingFor(secretHash: string, renew = false): Promise<{ code: string; expires: number }> {
  const current = await get<{ code: string; expires: number }>('SELECT code, expires FROM pairings WHERE secret_hash = ?', secretHash)
  if (current && !renew && current.expires > Date.now()) return { code: current.code, expires: current.expires }
  let code: string
  do code = newCode()
  while (await get('SELECT 1 FROM pairings WHERE code = ?', code))
  const expires = Date.now() + PAIRING_MS
  await run(
    `INSERT INTO pairings (secret_hash, code, expires) VALUES (?, ?, ?)
     ON CONFLICT (secret_hash) DO UPDATE SET code = excluded.code, expires = excluded.expires`,
    secretHash,
    code,
    expires,
  )
  return { code, expires }
}

/** Vincula a tela que exibe `code` ao evento. Retorna o id da tela ou null (código inexistente ou expirado). */
export async function claimPairing(code: string, eventId: string, name: string): Promise<string | null> {
  const wanted = normalizeCode(code)
  const p = await get<{ secret_hash: string }>('SELECT secret_hash FROM pairings WHERE code = ? AND expires >= ?', wanted, Date.now())
  if (!p) return null
  const id = newId()
  // Apagar o código e criar a tela juntos: dois consoles digitando o mesmo código não criam duas telas.
  const claimed = await tx(async () => {
    if (!(await run('DELETE FROM pairings WHERE secret_hash = ? AND code = ?', p.secret_hash, wanted)).changes) return false
    await run('INSERT INTO screens (id, event_id, secret_hash, name, created_at) VALUES (?, ?, ?, ?, ?)', id, eventId, p.secret_hash, name, Date.now())
    return true
  })
  if (!claimed) return null
  await broadcast('', [`paired:${p.secret_hash}`])
  return id
}

/** Sala de espera da tela ainda não pareada: envia o código e renova quando expira. */
export function pairingStream(c: Context, secretHash: string) {
  return streamSSE(c, async (stream) => {
    const set = waiting.get(secretHash) ?? waiting.set(secretHash, new Set()).get(secretHash)!
    set.add(stream)
    try {
      await polling()
      let p = await pairingFor(secretHash)
      const announce = (retry?: number) =>
        stream.writeSSE({ event: 'pairing', data: JSON.stringify({ code: p.code, expiresAt: p.expires }), retry }).catch(() => {})
      await announce(2000)
      await keepAlive(stream, async () => {
        // Aviso perdido (instância ocupada, banco lento): o batimento confere direto se a tela já foi vinculada.
        if (await get('SELECT 1 FROM screens WHERE secret_hash = ?', secretHash)) {
          await end(stream, 'paired')
          return false
        }
        // Tela esperando muito tempo: troca o código antes de expirar.
        if (p.expires < Date.now() + 60_000) {
          p = await pairingFor(secretHash, true)
          await announce()
        } else await stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {})
        return true
      })
    } finally {
      set.delete(stream)
      if (!set.size && waiting.get(secretHash) === set) waiting.delete(secretHash)
      idle()
    }
  })
}
