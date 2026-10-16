// Sessões da equipe guardadas no servidor (staff_sessions): revogáveis uma a uma, com expiração por inatividade
// e absoluta, etapa pendente de duas etapas e janela de confirmação recente (sudo).
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { all, get, newId, run, sha256 } from '../sqlite.ts'
import type { SessionInfo, StaffUser } from '../../shared/admin.ts'
import { toStaffUser, type StaffRow } from './schema.ts'
import { getSettings } from './settings.ts'
import { recordSuccess } from './throttle.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Entre a senha e o código da segunda etapa. */
export const PENDING_MFA_MS = 5 * MINUTE
/** Janela padrão de confirmação recente (GitHub "sudo mode"). */
export const SUDO_MS = 10 * MINUTE
// last_seen_at é atualizado no máximo uma vez por minuto: uma escrita por minuto, não uma por requisição.
const TOUCH_MS = MINUTE

const TOKEN = /^[\w-]{43}$/ // 32 bytes em base64url
const newToken = () => randomBytes(32).toString('base64url')
// Controles e quebras de linha fora: estes campos aparecem na lista de sessões e na administração.
const clean = (s: string | undefined, max: number) => (s ?? '').replace(/\p{Cc}/gu, '').slice(0, max)

export interface StaffSession {
  id: string
  userId: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  pendingMfa: boolean
  /** Quando a segunda etapa foi feita nesta sessão (null = só senha). */
  mfaAt: number | null
  sudoUntil: number | null
  ip: string
  userAgent: string
}

interface SessionRow {
  id: string
  token_hash: string
  user_id: string
  created_at: number
  last_seen_at: number
  expires_at: number
  pending_mfa: number
  mfa_at: number | null
  sudo_until: number | null
  ip: string
  user_agent: string
}

const toSession = (r: SessionRow): StaffSession => ({
  id: r.id,
  userId: r.user_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
  pendingMfa: !!r.pending_mfa,
  mfaAt: r.mfa_at,
  sudoUntil: r.sudo_until,
  ip: r.ip,
  userAgent: r.user_agent,
})

/** Prazo absoluto de uma sessão completa que começa agora. */
const fullDeadline = (now: number) => now + getSettings().sessionMaxDays * DAY

/**
 * Abre uma sessão. Com `pendingMfa`, ela só serve para a segunda etapa (validatePendingSession + completeMfa) e
 * expira em 5 minutos. Sem `pendingMfa`, a autenticação está completa: zera as falhas e marca o último acesso.
 * O token vai só para o cookie; o banco guarda o SHA-256. O `id` é público (lista de sessões).
 */
export function createSession(
  userId: string,
  opts: { ip?: string; userAgent?: string; pendingMfa?: boolean; now?: number } = {},
): { token: string; id: string } {
  const now = opts.now ?? Date.now()
  const pending = !!opts.pendingMfa
  const token = newToken()
  const id = newId(12)
  run('DELETE FROM staff_sessions WHERE expires_at <= ?', now) // limpeza oportunista das vencidas
  run(
    `INSERT INTO staff_sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, pending_mfa, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    sha256(token),
    userId,
    now,
    now,
    pending ? now + PENDING_MFA_MS : fullDeadline(now),
    pending ? 1 : 0,
    clean(opts.ip, 64),
    clean(opts.userAgent, 256),
  )
  if (!pending) recordSuccess(userId, now)
  return { token, id }
}

function load(token: string | null | undefined, pending: boolean, now: number): { session: StaffSession; user: StaffUser } | null {
  if (!token || !TOKEN.test(token)) return null
  const s = get<SessionRow>('SELECT * FROM staff_sessions WHERE token_hash = ?', sha256(token))
  if (!s || !!s.pending_mfa !== pending) return null
  const u = get<StaffRow>('SELECT * FROM moderators WHERE id = ?', s.user_id)
  // Configuração lida a cada validação: encurtar os prazos vale também para as sessões já abertas.
  const { sessionIdleHours, sessionMaxDays } = getSettings()
  const expired =
    now >= s.expires_at || (!pending && (now - s.last_seen_at >= sessionIdleHours * HOUR || now - s.created_at >= sessionMaxDays * DAY))
  if (!u || u.disabled || expired) {
    run('DELETE FROM staff_sessions WHERE id = ?', s.id)
    return null
  }
  if (now - s.last_seen_at >= TOUCH_MS) {
    run('UPDATE staff_sessions SET last_seen_at = ? WHERE id = ?', now, s.id)
    s.last_seen_at = now
  }
  return { session: toSession(s), user: toStaffUser(u) }
}

/**
 * Sessão completa do token, ou null (inexistente, vencida por inatividade ou prazo absoluto, conta desativada,
 * ou ainda pendente da segunda etapa: sessão pendente nunca passa por aqui).
 */
export const validateSession = (token: string | null | undefined, now = Date.now()) => load(token, false, now)

/** Só sessões pendentes da segunda etapa (rota POST /api/auth/mfa). */
export const validatePendingSession = (token: string | null | undefined, now = Date.now()) => load(token, true, now)

/**
 * Marca a segunda etapa como feita (login com TOTP ou código de recuperação, ou ativação confirmada) e troca o
 * token, que é devolvido para o cookie novo; o antigo deixa de valer. Sessão pendente vira completa, com prazo
 * absoluto novo, e a conta tem as falhas zeradas. null = sessão inexistente ou vencida.
 */
export function completeMfa(id: string, now = Date.now()): string | null {
  const s = get<{ user_id: string; pending_mfa: number }>('SELECT user_id, pending_mfa FROM staff_sessions WHERE id = ? AND expires_at > ?', id, now)
  if (!s) return null
  const token = newToken()
  run(
    `UPDATE staff_sessions SET token_hash = ?, mfa_at = ?, last_seen_at = ?, pending_mfa = 0,
       expires_at = CASE WHEN pending_mfa = 1 THEN ? ELSE expires_at END
     WHERE id = ?`,
    sha256(token),
    now,
    now,
    fullDeadline(now),
    id,
  )
  if (s.pending_mfa) recordSuccess(s.user_id, now)
  return token
}

/** Token novo para a mesma sessão (após mudança de privilégio); o antigo deixa de valer. null = sessão inexistente. */
export function rotateSession(id: string): string | null {
  const token = newToken()
  return Number(run('UPDATE staff_sessions SET token_hash = ? WHERE id = ?', sha256(token), id).changes) ? token : null
}

/** Confirmação recente de identidade (senha ou TOTP conferidos agora). Devolve até quando vale; null = sessão inválida. */
export function grantSudo(id: string, ms = SUDO_MS, now = Date.now()): number | null {
  const until = now + ms
  return Number(run('UPDATE staff_sessions SET sudo_until = ? WHERE id = ? AND pending_mfa = 0', until, id).changes) ? until : null
}

/** Encerra uma sessão. Nas rotas de conta, passe `userId`: assim só a própria pessoa encerra as próprias sessões. */
export const revokeSession = (id: string, userId?: string): boolean =>
  Number(run('DELETE FROM staff_sessions WHERE id = ?1 AND (?2 IS NULL OR user_id = ?2)', id, userId ?? null).changes) > 0

/** Encerra as sessões da conta, menos `exceptId` (a atual, na troca de senha). Devolve quantas encerrou. */
export const revokeUserSessions = (userId: string, exceptId?: string): number =>
  Number(run('DELETE FROM staff_sessions WHERE user_id = ? AND id != ?', userId, exceptId ?? '').changes)

/** Sessões completas e válidas, mais recentes primeiro; sem `userId`, de todas as contas (administração). */
export function listSessions(userId?: string, currentId?: string, now = Date.now()): SessionInfo[] {
  const { sessionIdleHours, sessionMaxDays } = getSettings()
  const rows = all<SessionRow>(
    `SELECT * FROM staff_sessions
     WHERE pending_mfa = 0 AND expires_at > ?1 AND last_seen_at > ?2 AND created_at > ?3 AND (?4 IS NULL OR user_id = ?4)
     ORDER BY last_seen_at DESC`,
    now,
    now - sessionIdleHours * HOUR,
    now - sessionMaxDays * DAY,
    userId ?? null,
  )
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: Math.min(r.expires_at, r.created_at + sessionMaxDays * DAY),
    ip: r.ip,
    userAgent: r.user_agent,
    mfa: r.mfa_at !== null,
    current: r.id === currentId,
  }))
}

// ---------- cookie ----------

const COOKIE = 'deck_session'

/** HTTPS direto ou, com TRUST_PROXY=1, informado pelo proxy reverso. */
function https(c: Context): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true
  return process.env.TRUST_PROXY === '1' && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
}

/**
 * Em HTTPS: "__Host-deck_session" (Secure, sem Domain, Path=/; nem subdomínio nem HTTP conseguem gravar por cima).
 * Em HTTP puro (evento em rede local): "deck_session" sem Secure. Sempre HttpOnly e SameSite=Lax.
 */
export function setSessionCookie(c: Context, token: string, maxAgeSeconds: number): void {
  const opts = { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: Math.max(0, Math.floor(maxAgeSeconds)) } as const
  if (https(c)) setCookie(c, COOKIE, token, { ...opts, secure: true, prefix: 'host' })
  else setCookie(c, COOKIE, token, opts)
}

/** Token do cookie certo para o protocolo (em HTTPS, ignora um "deck_session" plantado via HTTP). */
export function readSessionToken(c: Context): string | null {
  const value = https(c) ? getCookie(c, COOKIE, 'host') : getCookie(c, COOKIE)
  return value && TOKEN.test(value) ? value : null
}

export function clearSessionCookie(c: Context): void {
  if (https(c)) deleteCookie(c, COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', prefix: 'host' })
  else deleteCookie(c, COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax' })
}
