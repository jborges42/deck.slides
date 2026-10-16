import { all, get, run, tx } from './db.ts'
import {
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  defaultLive,
  publicAuthor,
  type EventInfo,
  type EventSettings,
  type LiveState,
  type Media,
  type Participant,
  type PublicQuestion,
  type Question,
  type Scene,
} from '../shared/types.ts'

export interface EventRow {
  id: string
  name: string
  pin: string
  settings: string
  theme: string
  live: string
  created_at: number
}

export interface ParticipantRow {
  id: string
  event_id: string
  name: string
  email: string
  grp: string
  token: string
  source: 'invite' | 'open'
  blocked: number
  session_epoch: number
  joined_at: number | null
  created_at: number
}

interface SceneRow {
  id: string
  position: number
  type: string
  name: string
  content: string
}

interface QuestionRow {
  id: string
  participant_id: string | null
  author: string
  anonymous: number
  original: string
  text: string
  status: Question['status']
  screen: number | null
  flagged: number
  created_at: number
  likes: number
}

export interface MediaRow {
  id: string
  event_id: string
  kind: Media['kind']
  name: string
  file: string
  mime: string
  size: number
  created_at: number
  blob_url: string | null
}

/** Evento pelo código. Aceita o código digitado em minúsculas. */
export const eventRow = (id: string) => get<EventRow>('SELECT * FROM events WHERE id = ?', id.toUpperCase())

// Mescla com os padrões na leitura: campos novos ganham valor sem migração.
export function toEventInfo(r: EventRow): EventInfo {
  const theme = JSON.parse(r.theme)
  const live = JSON.parse(r.live)
  const base = defaultLive()
  return {
    id: r.id,
    name: r.name,
    pin: r.pin,
    settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings) },
    theme: { ...DEFAULT_THEME, ...theme, fonts: { ...DEFAULT_THEME.fonts, ...theme.fonts } },
    live: { ...base, ...live, timer: { ...base.timer, ...live.timer }, overlays: { ...base.overlays, ...live.overlays } },
    createdAt: r.created_at,
  }
}

export const toScene = (r: SceneRow) =>
  ({ id: r.id, name: r.name, position: r.position, type: r.type, content: JSON.parse(r.content) }) as Scene

export const scenes = async (eventId: string) =>
  (await all<SceneRow>('SELECT * FROM scenes WHERE event_id = ? ORDER BY position, created_at', eventId)).map(toScene)

export async function scene(eventId: string, id: string | null): Promise<Scene | null> {
  if (!id) return null
  const r = await get<SceneRow>('SELECT * FROM scenes WHERE event_id = ? AND id = ?', eventId, id)
  return r ? toScene(r) : null
}

const QUESTION_SELECT = `SELECT q.*, (SELECT COUNT(*) FROM likes l WHERE l.question_id = q.id) AS likes FROM questions q`

const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  participantId: r.participant_id,
  author: r.author,
  anonymous: !!r.anonymous,
  text: r.text,
  original: r.original,
  status: r.status,
  screen: r.screen,
  flagged: !!r.flagged,
  likes: r.likes,
  createdAt: r.created_at,
})

export const questions = async (eventId: string) =>
  (await all<QuestionRow>(`${QUESTION_SELECT} WHERE q.event_id = ? ORDER BY q.created_at`, eventId)).map(toQuestion)

export async function question(eventId: string, id: string): Promise<Question | null> {
  const r = await get<QuestionRow>(`${QUESTION_SELECT} WHERE q.event_id = ? AND q.id = ?`, eventId, id)
  return r ? toQuestion(r) : null
}

/** Perguntas marcadas para a tela, na ordem de exibição. */
export const screenQuestions = async (eventId: string, limit: number, format: EventSettings['screenName']): Promise<PublicQuestion[]> =>
  (
    await all<QuestionRow>(
      `${QUESTION_SELECT} WHERE q.event_id = ? AND q.screen IS NOT NULL AND q.status IN ('approved', 'answered')
       ORDER BY q.screen LIMIT ?`,
      eventId,
      limit,
    )
  ).map((r) => ({ id: r.id, text: r.text, author: publicAuthor(r.author, !!r.anonymous, format), likes: r.likes }))

export const toParticipant = (r: ParticipantRow, online: Set<string>): Participant => ({
  id: r.id,
  name: r.name,
  email: r.email,
  group: r.grp,
  token: r.token,
  source: r.source,
  blocked: !!r.blocked,
  joinedAt: r.joined_at,
  online: online.has(r.id),
  createdAt: r.created_at,
})

export const participantRow = (eventId: string, id: string) =>
  get<ParticipantRow>('SELECT * FROM participants WHERE event_id = ? AND id = ?', eventId, id)

export const participants = (eventId: string) =>
  all<ParticipantRow>('SELECT * FROM participants WHERE event_id = ? ORDER BY lower(name)', eventId)

export const mediaUrl = (r: Pick<MediaRow, 'event_id' | 'file'>) => `/media/${r.event_id}/${r.file}`

export const toMedia = (r: Omit<MediaRow, 'blob_url'>): Media => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  url: mediaUrl(r),
  mime: r.mime,
  size: r.size,
  createdAt: r.created_at,
})

export const mediaRow = (eventId: string, id: string) =>
  get<MediaRow>('SELECT * FROM media WHERE event_id = ? AND id = ?', eventId, id)

export const media = async (eventId: string) =>
  (await all<MediaRow>('SELECT * FROM media WHERE event_id = ? ORDER BY created_at DESC', eventId)).map(toMedia)

/** Leitura-modificação-escrita atômica do estado ao vivo. */
export function updateLive(eventId: string, fn: (live: LiveState, ev: EventInfo) => void | Promise<void>): Promise<EventInfo | null> {
  return tx(async () => {
    const r = await eventRow(eventId)
    if (!r) return null
    const ev = toEventInfo(r)
    await fn(ev.live, ev)
    await run('UPDATE events SET live = ? WHERE id = ?', JSON.stringify(ev.live), eventId)
    return ev
  })
}

export async function nextPosition(eventId: string): Promise<number> {
  return ((await get<{ p: number | null }>('SELECT MAX(position) AS p FROM scenes WHERE event_id = ?', eventId))?.p ?? -1) + 1
}
