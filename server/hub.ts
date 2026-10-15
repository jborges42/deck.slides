// Tempo real: cada conexão SSE recebe o snapshot completo da sua audiência
// (`state`), totais de reações/curtidas (`counts`) e um `ping` com o relógio do servidor.
// ponytail: snapshot completo a cada mudança; trocar por diffs se um evento passar de ~1k perguntas.
import type { Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { all, newCode, newId, normalizeCode, run } from './db.ts'
import {
  eventRow,
  media,
  participantRow,
  participants,
  questions,
  scene,
  scenes,
  screenQuestions,
  toEventInfo,
  type EventRow,
} from './model.ts'
import type {
  Counts,
  ModeratorSnapshot,
  ParticipantSnapshot,
  QuestionStatus,
  ReactionKind,
  ScreenInfo,
  ScreenSnapshot,
} from '../shared/types.ts'

type Audience = 'moderator' | 'screen' | 'participant'
type Target = 'moderator' | 'screen' | 'participants' | `p:${string}`

interface Client {
  eventId: string
  audience: Audience
  participantId?: string
  moderatorId?: string // console: fecha quando a conta é removida ou troca a senha
  screenId?: string | null // tela pareada; null = tela aberta pelo próprio console
  stream: SSEStreamingApi
}

const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, '') || null
const clients = new Map<string, Set<Client>>()

/** Espera do batimento que termina na hora se a conexão cair (e não segura o processo aberto). */
function heartbeat(aborted: Promise<void>, ms = 15_000) {
  return Promise.race([aborted, new Promise<void>((r) => setTimeout(r, ms).unref())])
}

function send(c: Client, event: string, data: string) {
  if (!c.stream.aborted && !c.stream.closed) c.stream.writeSSE({ event, data }).catch(() => {})
}

/** Último aviso e fecha. O abort espera a escrita: abortar logo em seguida descartava a mensagem. */
function end(s: SSEStreamingApi, event: string, data = '{}') {
  const stop = () => s.abort()
  // Espera o aviso sair (até 1 s): cliente que não lê o socket não fica registrado nem conta como online.
  Promise.race([s.writeSSE({ event, data }), new Promise<void>((r) => setTimeout(r, 1000).unref())]).then(stop, stop)
}

export function onlineIds(eventId: string): Set<string> {
  const ids = new Set<string>()
  for (const c of clients.get(eventId) ?? []) if (c.participantId) ids.add(c.participantId)
  return ids
}

/** Conexões abertas de um participante (limita abas para não esgotar o servidor). */
export function connections(eventId: string, participantId: string): number {
  let n = 0
  for (const c of clients.get(eventId) ?? []) if (c.participantId === participantId) n++
  return n
}

function screensOf(eventId: string): ScreenInfo[] {
  const online = new Set<string>()
  for (const c of clients.get(eventId) ?? []) if (c.screenId) online.add(c.screenId)
  return all<{ id: string; name: string; created_at: number; last_seen: number | null }>(
    'SELECT id, name, created_at, last_seen FROM screens WHERE event_id = ? ORDER BY created_at',
    eventId,
  ).map((s) => ({ id: s.id, name: s.name, online: online.has(s.id), createdAt: s.created_at, lastSeen: s.last_seen }))
}

function presence(eventId: string) {
  let screens = 0
  let moderators = 0
  for (const c of clients.get(eventId) ?? []) {
    if (c.audience === 'screen') screens++
    if (c.audience === 'moderator') moderators++
  }
  return { participants: onlineIds(eventId).size, screens, moderators }
}

// ---------- snapshots ----------

function moderatorSnapshot(r: EventRow): ModeratorSnapshot {
  return {
    serverNow: Date.now(),
    publicUrl: PUBLIC_URL,
    event: toEventInfo(r),
    scenes: scenes(r.id),
    questions: questions(r.id),
    participants: participants(r.id, onlineIds(r.id)),
    media: media(r.id),
    screens: screensOf(r.id),
    presence: presence(r.id),
  }
}

function screenSnapshot(r: EventRow): ScreenSnapshot {
  const ev = toEventInfo(r)
  const program = scene(r.id, ev.live.program)
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
    questions: program?.type === 'questions' ? screenQuestions(r.id, program.content.max, ev.settings.screenName) : [],
  }
}

type Common = Omit<ParticipantSnapshot, 'me' | 'mine' | 'now'> & {
  now: null | (Omit<NonNullable<ParticipantSnapshot['now']>, 'questions'> & { questions: ScreenSnapshot['questions'] })
}

function participantCommon(r: EventRow): Common {
  const snap = screenSnapshot(r)
  const { questions: qs, event, serverNow } = snap
  const ev = toEventInfo(r)
  const program = ev.live.standby ? null : snap.program
  const label = !program
    ? ''
    : program.type === 'title' || program.type === 'questions' || program.type === 'timer'
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

function participantSnapshot(r: EventRow, pid: string, common: Common): ParticipantSnapshot | null {
  const p = participantRow(r.id, pid)
  if (!p || p.blocked) return null
  const liked = new Set(
    all<{ question_id: string }>('SELECT question_id FROM likes WHERE participant_id = ?', pid).map((l) => l.question_id),
  )
  const mine = all<{ id: string; text: string; original: string; status: QuestionStatus; screen: number | null; created_at: number }>(
    'SELECT id, text, original, status, screen, created_at FROM questions WHERE participant_id = ? ORDER BY created_at DESC',
    pid,
  )
  return {
    ...common,
    now: common.now && { ...common.now, questions: common.now.questions.map((q) => ({ ...q, liked: liked.has(q.id) })) },
    me: { id: p.id, name: p.name },
    mine: mine.map((q) => ({
      id: q.id,
      text: q.text,
      status: q.status,
      onScreen: q.screen !== null && q.status !== 'rejected' && q.status !== 'pending',
      edited: q.text !== q.original,
      createdAt: q.created_at,
    })),
  }
}

export function counts(eventId: string): Counts {
  const out: Counts = { reactions: {}, likes: {} }
  for (const r of all<{ scene_id: string; kind: ReactionKind; count: number }>(
    'SELECT scene_id, kind, count FROM reactions WHERE event_id = ?',
    eventId,
  )) {
    ;(out.reactions[r.scene_id] ??= {})[r.kind] = r.count
  }
  for (const r of all<{ question_id: string; n: number }>(
    `SELECT l.question_id, COUNT(*) AS n FROM likes l JOIN questions q ON q.id = l.question_id
     WHERE q.event_id = ? GROUP BY l.question_id`,
    eventId,
  )) {
    out.likes[r.question_id] = r.n
  }
  return out
}

// ---------- publicação ----------

// Moderação e tela recebem em até 40 ms; celulares em até 500 ms (podem ser milhares).
const fast = new Map<string, Set<Target>>()
const slow = new Map<string, Set<Target>>()
const ALL: Target[] = ['moderator', 'screen', 'participants']

/** Agenda o envio de snapshots novos. Sem alvos = todas as audiências. */
export function publish(eventId: string, ...targets: Target[]) {
  for (const t of targets.length ? targets : ALL) {
    const [queue, delay] = t === 'moderator' || t === 'screen' ? [fast, 40] : [slow, 500]
    let set = queue.get(eventId)
    if (!set) {
      queue.set(eventId, (set = new Set()))
      setTimeout(() => {
        queue.delete(eventId)
        flush(eventId, set!)
      }, delay)
    }
    set.add(t)
  }
}

function flush(eventId: string, targets: Set<Target>) {
  const subs = clients.get(eventId)
  if (!subs?.size) return
  const r = eventRow(eventId)
  if (!r) {
    for (const c of subs) end(c.stream, 'gone')
    return
  }
  let mod: string | undefined
  let scr: string | undefined
  let common: Common | undefined
  for (const c of subs) {
    if (c.audience === 'moderator' && targets.has('moderator')) send(c, 'state', (mod ??= JSON.stringify(moderatorSnapshot(r))))
    else if (c.audience === 'screen' && targets.has('screen')) send(c, 'state', (scr ??= JSON.stringify(screenSnapshot(r))))
    else if (c.audience === 'participant' && (targets.has('participants') || targets.has(`p:${c.participantId}`))) {
      const snap = participantSnapshot(r, c.participantId!, (common ??= participantCommon(r)))
      if (snap) send(c, 'state', JSON.stringify(snap))
      else end(c.stream, 'gone')
    }
  }
}

const countsPending = new Set<string>()

/** Totais de reações e curtidas: no máximo 4 envios por segundo por evento. */
export function publishCounts(eventId: string) {
  if (countsPending.has(eventId)) return
  countsPending.add(eventId)
  setTimeout(() => {
    countsPending.delete(eventId)
    const subs = clients.get(eventId)
    if (!subs?.size) return
    const data = JSON.stringify(counts(eventId))
    for (const c of subs) send(c, 'counts', data)
  }, 250)
}

/** Desconecta uma tela despareada: ela volta a mostrar um código de pareamento. */
export function kickScreen(eventId: string, screenId: string) {
  for (const c of clients.get(eventId) ?? []) {
    if (c.screenId === screenId) end(c.stream, 'gone', '{"reason":"unpaired"}')
  }
}

/** Encerra as conexões de um participante (bloqueado ou removido). */
export function kick(eventId: string, participantId: string) {
  for (const c of clients.get(eventId) ?? []) {
    if (c.participantId === participantId) end(c.stream, 'gone')
  }
}

/** Fecha os consoles de um moderador (conta removida ou senha trocada). Sem `gone`: quem ainda tem sessão válida reconecta. */
export function kickModerator(moderatorId: string) {
  for (const set of clients.values()) for (const c of set) if (c.moderatorId === moderatorId) c.stream.abort()
}

// ---------- conexão ----------

export function stream(c: Context, client: Omit<Client, 'stream'>) {
  return streamSSE(c, async (stream) => {
    const cl: Client = { ...client, stream }
    const r = eventRow(cl.eventId)
    const first =
      r &&
      (cl.audience === 'moderator'
        ? moderatorSnapshot(r)
        : cl.audience === 'screen'
          ? screenSnapshot(r)
          : participantSnapshot(r, cl.participantId!, participantCommon(r)))
    if (!first) {
      await stream.writeSSE({ event: 'gone', data: '{}' })
      return
    }
    let set = clients.get(cl.eventId)
    if (!set) clients.set(cl.eventId, (set = new Set()))
    set.add(cl)
    const seen = () => cl.screenId && run('UPDATE screens SET last_seen = ? WHERE id = ?', Date.now(), cl.screenId)
    seen()
    stream.onAbort(() => {
      set.delete(cl)
      if (!set.size) clients.delete(cl.eventId)
      seen()
      publish(cl.eventId, 'moderator')
    })
    // Presença: toda conexão, inclusive de console, atualiza os consoles (o snapshot inicial ainda não conta esta).
    publish(cl.eventId, 'moderator')
    const aborted = new Promise<void>((r) => stream.onAbort(r))
    await stream.writeSSE({ event: 'state', data: JSON.stringify(first), retry: 2000 })
    await stream.writeSSE({ event: 'counts', data: JSON.stringify(counts(cl.eventId)) })
    while (!stream.aborted && !stream.closed) {
      await heartbeat(aborted)
      send(cl, 'ping', String(Date.now()))
    }
  })
}


// ---------- pareamento de telas ----------
// A tela abre /tela, recebe um código curto e espera nesta "sala". Quando a moderação digita o código
// no console, a tela é vinculada ao evento (tabela screens) e reconecta já recebendo o snapshot.

interface Pairing {
  code: string
  expires: number
  streams: Set<SSEStreamingApi>
}

const PAIRING_MS = 15 * 60_000
const pairings = new Map<string, Pairing>() // chave: hash do segredo do cookie da tela

setInterval(() => {
  const now = Date.now()
  for (const [hash, p] of pairings) if (p.expires < now && !p.streams.size) pairings.delete(hash)
}, 60_000).unref()

/** Código de pareamento vigente para esta tela; gera outro quando expira ou com `renew`. */
export function pairingFor(secretHash: string, renew = false): Pairing {
  const current = pairings.get(secretHash)
  if (current && !renew && current.expires > Date.now()) return current
  let code: string
  do code = newCode()
  while ([...pairings.values()].some((p) => p.code === code))
  const next = { code, expires: Date.now() + PAIRING_MS, streams: current?.streams ?? new Set<SSEStreamingApi>() }
  pairings.set(secretHash, next)
  return next
}

/** Vincula a tela que exibe `code` ao evento. Retorna o id da tela ou null (código inexistente ou expirado). */
export function claimPairing(code: string, eventId: string, name: string): string | null {
  const wanted = normalizeCode(code)
  for (const [hash, p] of pairings) {
    if (p.code !== wanted || p.expires < Date.now()) continue
    const id = newId()
    run('INSERT INTO screens (id, event_id, secret_hash, name, created_at) VALUES (?, ?, ?, ?, ?)', id, eventId, hash, name, Date.now())
    pairings.delete(hash)
    for (const s of p.streams) end(s, 'paired')
    return id
  }
  return null
}

/** Sala de espera da tela ainda não pareada: envia o código e renova quando expira. */
export function pairingStream(c: Context, secretHash: string) {
  return streamSSE(c, async (stream) => {
    let p = pairingFor(secretHash)
    p.streams.add(stream)
    stream.onAbort(() => {
      pairings.get(secretHash)?.streams.delete(stream)
    })
    const aborted = new Promise<void>((r) => stream.onAbort(r))
    const announce = (retry?: number) =>
      stream.writeSSE({ event: 'pairing', data: JSON.stringify({ code: p.code, expiresAt: p.expires }), retry }).catch(() => {})
    await announce(2000)
    while (!stream.aborted && !stream.closed) {
      await heartbeat(aborted)
      if (stream.aborted) break
      // Tela esperando muito tempo: troca o código antes de expirar.
      if (p.expires < Date.now() + 60_000) {
        p = pairingFor(secretHash, true)
        await announce()
      } else await stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {})
    }
  })
}
