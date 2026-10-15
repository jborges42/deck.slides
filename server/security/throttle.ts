// Limite de tentativas por conta (o limite por IP fica em server/auth.ts, overLimit). Vale para a senha e para
// a segunda etapa: depois de 5 falhas seguidas a conta espera 1, 2, 4, 8 e então 15 minutos a cada nova falha.
// O bloqueio é temporário de propósito: um atacante consegue, no máximo, atrasar o dono da conta, nunca trancá-la.
import { get, run } from '../db.ts'

export const LOCK_AFTER = 5
const MINUTE = 60_000
const MAX_LOCK_MINUTES = 15

/** Conta uma falha (senha ou código errado) e, a partir da 5ª seguida, bloqueia a conta por um tempo crescente. */
export function recordFailure(userId: string, now = Date.now()): { failures: number; lockedUntil: number | null } {
  const row = get<{ failed_logins: number }>('UPDATE moderators SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins', userId)
  if (!row) return { failures: 0, lockedUntil: null }
  const failures = row.failed_logins
  if (failures < LOCK_AFTER) return { failures, lockedUntil: null }
  const lockedUntil = now + Math.min(MAX_LOCK_MINUTES, 2 ** (failures - LOCK_AFTER)) * MINUTE
  run('UPDATE moderators SET locked_until = ? WHERE id = ?', lockedUntil, userId)
  return { failures, lockedUntil }
}

/**
 * Autenticação completa (senha e, se houver, segunda etapa): zera as falhas e registra o último acesso.
 * sessions.ts chama isto quando uma sessão fica completa. Zerar já na senha deixaria quem sabe a senha
 * tentar códigos TOTP sem limite.
 */
export function recordSuccess(userId: string, now = Date.now()): void {
  run('UPDATE moderators SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now, userId)
}

/** Conta bloqueada agora? Durante o bloqueio, recuse sem conferir a senha (e sem contar nova falha). */
export const isLocked = (user: { locked_until: number | null }, now = Date.now()) => user.locked_until !== null && user.locked_until > now
