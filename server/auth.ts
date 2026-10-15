import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import { get, metaValue, sha256 } from './db.ts'
import { eventRow, participantRow, type EventRow, type ParticipantRow } from './model.ts'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const SECRET = process.env.SESSION_SECRET || metaValue('session_secret', () => randomBytes(32).toString('base64url'))
const MONTH_S = 60 * 60 * 24 * 30
const YEAR_S = MONTH_S * 12

export interface Moderator {
  id: string
  name: string
  email: string
}

export interface ScreenRow {
  id: string
  event_id: string
  name: string
}

export type Env = {
  Variables: { moderator: Moderator; event: EventRow; participant: ParticipantRow }
}

/** Comparação em tempo constante para segredos curtos (PIN, códigos). */
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ---------- senhas ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  return `${salt.toString('base64url')}.${(await scryptAsync(password, salt, 64)).toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split('.')
  const actual = await scryptAsync(password, Buffer.from(salt ?? '', 'base64url'), 64)
  const expected = Buffer.from(hash ?? '', 'base64url')
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}

// E-mail inexistente também paga o custo do scrypt: o tempo de resposta não revela quem tem conta.
const DUMMY_HASH = await hashPassword(randomBytes(12).toString('hex'))
export const burnPasswordCheck = (password: string) => verifyPassword(password, DUMMY_HASH)

// ---------- cookies ----------

function cookieOptions(c: Context, maxAge = MONTH_S) {
  const https = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'
  return { httpOnly: true, sameSite: 'Lax', secure: https, path: '/', maxAge } as const
}

const MOD_COOKIE = 'deck_mod'
const SCREEN_COOKIE = 'deck_screen'
const participantCookie = (eventId: string) => `deck_p_${eventId}`
/** Valor assinado "id.emitidoEm(ms)": a validade é conferida no servidor, não só pelo Max-Age do navegador. */
async function readSession(c: Context, name: string, maxAgeS: number): Promise<{ id: string; issued: number } | null> {
  const value = await getSignedCookie(c, SECRET, name)
  if (!value) return null
  const [id, issued] = value.split('.')
  const at = Number(issued)
  if (!id || !Number.isFinite(at) || Date.now() - at > maxAgeS * 1000) return null
  return { id, issued: at }
}

export const startModeratorSession = (c: Context, id: string) =>
  setSignedCookie(c, MOD_COOKIE, `${id}.${Date.now()}`, SECRET, cookieOptions(c))
export const endModeratorSession = (c: Context) => deleteCookie(c, MOD_COOKIE, { path: '/' })

export const startParticipantSession = (c: Context, eventId: string, id: string) =>
  setSignedCookie(c, participantCookie(eventId), `${id}.${Date.now()}`, SECRET, cookieOptions(c))
export const endParticipantSession = (c: Context, eventId: string) => deleteCookie(c, participantCookie(eventId), { path: '/' })

/** Cookie da tela: segredo aleatório; o servidor guarda só o hash (tabela screens ou pareamento pendente). */
export const setScreenSecret = (c: Context, secret: string) => setSignedCookie(c, SCREEN_COOKIE, secret, SECRET, cookieOptions(c, YEAR_S))
export const screenSecret = async (c: Context) => (await getSignedCookie(c, SECRET, SCREEN_COOKIE)) || null

export async function currentModerator(c: Context): Promise<Moderator | null> {
  const s = await readSession(c, MOD_COOKIE, MONTH_S)
  if (!s) return null
  const m = get<Moderator & { session_epoch: number }>('SELECT id, name, email, session_epoch FROM moderators WHERE id = ?', s.id)
  if (!m || s.issued < m.session_epoch) return null
  return { id: m.id, name: m.name, email: m.email }
}

/** Exige moderador logado; com `:id` na rota, também carrega o evento. */
export const requireModerator: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('moderator')) return next() // já validado por outro middleware da mesma rota
  const moderator = await currentModerator(c)
  if (!moderator) return c.json({ error: 'Sua sessão expirou. Entre de novo para continuar.' }, 401)
  c.set('moderator', moderator)
  const eventId = c.req.param('id')
  if (eventId) {
    const event = eventRow(eventId)
    if (!event) return c.json({ error: 'Evento não encontrado.' }, 404)
    c.set('event', event)
  }
  await next()
}

export async function participantFromCookie(c: Context, eventId: string): Promise<ParticipantRow | null> {
  const s = await readSession(c, participantCookie(eventId), MONTH_S)
  const p = s ? participantRow(eventId, s.id) : undefined
  return p && !p.blocked && s!.issued >= p.session_epoch ? p : null
}

/** Exige participante confirmado (cookie assinado do evento `:id`). */
export const requireParticipant: MiddlewareHandler<Env> = async (c, next) => {
  const event = eventRow(c.req.param('id') ?? '')
  if (!event) return c.json({ error: 'Evento não encontrado.' }, 404)
  const participant = await participantFromCookie(c, event.id)
  if (!participant) return c.json({ error: 'Seu acesso a este evento foi encerrado.' }, 401)
  c.set('event', event)
  c.set('participant', participant)
  await next()
}

/** Tela pareada a partir do cookie (ou null). */
export async function pairedScreen(c: Context): Promise<ScreenRow | null> {
  const secret = await screenSecret(c)
  if (!secret) return null
  return get<ScreenRow>('SELECT id, event_id, name FROM screens WHERE secret_hash = ?', sha256(secret)) ?? null
}

// ---------- conta inicial ----------

/**
 * Em produção, criar a primeira conta exige SETUP_TOKEN: quem chegar primeiro ao servidor
 * recém-publicado não toma a instância. Em desenvolvimento, não exige.
 */
export const setupTokenRequired = () => process.env.NODE_ENV === 'production'
export const setupTokenValid = (token: string | undefined) =>
  !setupTokenRequired() || (!!process.env.SETUP_TOKEN && !!token && safeEqual(token, process.env.SETUP_TOKEN))

// ---------- limite de tentativas ----------

const hits = new Map<string, { n: number; reset: number }>()
setInterval(() => {
  const now = Date.now()
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k)
}, 60_000).unref()

/** Conta uma ocorrência e diz se a chave passou do limite na janela. */
export function overLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  let h = hits.get(key)
  if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }))
  return ++h.n > max
}

export const resetLimit = (key: string) => hits.delete(key)

/** A chave já atingiu o limite na janela atual? (Só consulta; quem conta é overLimit.) */
export function isLimited(key: string, max: number): boolean {
  const h = hits.get(key)
  return !!h && h.reset >= Date.now() && h.n >= max
}

/** IP do cliente. Só confia em X-Forwarded-For com TRUST_PROXY=1 (atrás de proxy reverso). */
export function clientIp(c: Context): string {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown' // requisição sem socket (testes com app.request)
  }
}
