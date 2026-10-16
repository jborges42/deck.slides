// Segunda etapa: TOTP (RFC 6238 sobre HOTP, RFC 4226) e códigos de recuperação de uso único.
// O relógio é sempre o do servidor (ASVS 6.5.8); cada código vale uma vez só (6.5.1).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { get, newCode, normalizeCode, run, tx } from '../sqlite.ts'
import { decrypt, encrypt, hmac } from './secrets.ts'

const STEP_MS = 30_000
const DIGITS = 6
const ISSUER = 'deck.slides'

// ---------- base32 (RFC 4648, sem "=") ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) out += B32[(value >>> (bits -= 5)) & 31]
    value &= (1 << bits) - 1
  }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out
}

/** Aceita minúsculas, espaços, hífens e "=" (como os aplicativos exibem). Caractere inválido lança erro. */
export function base32Decode(text: string): Buffer {
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('Texto base32 inválido.')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) out.push((value >>> (bits -= 8)) & 255)
    value &= (1 << bits) - 1
  }
  return Buffer.from(out)
}

// ---------- TOTP ----------

/** Semente nova: 20 bytes aleatórios (160 bits, RFC 4226), em base32. */
export const generateSecret = () => base32Encode(randomBytes(20))

/** URI para o QR code (formato "Key Uri" do Google Authenticator, aceito pelos aplicativos comuns). */
export function otpauthUri({ secret, account, issuer = ISSUER }: { secret: string; account: string; issuer?: string }): string {
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_MS / 1000) })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${query}`
}

/** Código do passo `step` (contador de 30 s desde a época Unix). `secret` em bytes ou base32. */
export function totp(secret: Uint8Array | string, step: number, digits = DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac(algorithm, typeof secret === 'string' ? base32Decode(secret) : secret).update(counter).digest()
  const offset = mac[mac.length - 1]! & 0xf
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0')
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * Confere um código de 6 dígitos aceitando um passo de folga para cada lado (relógio do celular adiantado ou
 * atrasado em até 30 s). Recusa passos <= `lastStep` (o mesmo código não entra duas vezes). Devolve o passo
 * aceito, que deve ser gravado como o novo lastStep, ou null.
 */
export function verifyTotp(secret: Uint8Array | string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const typed = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(typed)) return null
  const current = Math.floor(now / STEP_MS)
  let accepted: number | null = null
  // Confere as três janelas sempre, sem parar no primeiro acerto: o tempo não revela qual delas bateu.
  for (const step of [current - 1, current, current + 1]) {
    const match = safeEqual(totp(secret, step), typed)
    if (match && accepted === null && (lastStep === null || step > lastStep)) accepted = step
  }
  return accepted
}

// ---------- códigos de recuperação ----------

// 12 caracteres do alfabeto Crockford (32 símbolos, 5 bits cada) = 60 bits, exibidos como "K7QX-2MPA-9TRE".
const RECOVERY_LENGTH = 12
const RECOVERY = /^[0-9A-HJKMNP-TV-Z]{12}$/

/** Forma canônica do que a pessoa digitou: maiúsculas, sem espaços e hífens, O->0, I/L->1. */
export const normalizeRecoveryCode = (code: string) => normalizeCode(code.slice(0, 64))

const recoveryHash = (normalized: string) => hmac('recovery-code', normalized)

/** Códigos novos (texto para exibir uma vez) e os hashes que vão para o banco. */
export function generateRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const raw = new Set<string>()
  while (raw.size < n) raw.add(newCode(RECOVERY_LENGTH))
  return { codes: [...raw].map((c) => c.match(/.{4}/g)!.join('-')), hashes: [...raw].map(recoveryHash) }
}

// ---------- estado da conta (moderators.mfa_* e recovery_codes) ----------

// Dado associado da cifra: a semente de uma conta não abre em outra, mesmo copiada no banco.
const context = (userId: string) => `mfa:${userId}`

function storeRecoveryCodes(userId: string): string[] {
  const { codes, hashes } = generateRecoveryCodes()
  run('DELETE FROM recovery_codes WHERE user_id = ?', userId)
  for (const hash of hashes) run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, hash)
  return codes
}

/** Gera códigos novos e invalida todos os anteriores. Exiba uma vez; o servidor não guarda o texto. */
export const replaceRecoveryCodes = (userId: string): string[] => tx(() => storeRecoveryCodes(userId))

/**
 * Começa (ou recomeça) a ativação: a semente nova fica cifrada em mfa_pending. Se a conta já tem duas etapas, a
 * semente ativa continua valendo até a confirmação. Devolva `secret` e `otpauthUri` só para a própria pessoa.
 */
export function beginMfaSetup(userId: string, account: string): { secret: string; otpauthUri: string } {
  const secret = generateSecret()
  run('UPDATE moderators SET mfa_pending = ? WHERE id = ?', encrypt(secret, context(userId)), userId)
  return { secret, otpauthUri: otpauthUri({ secret, account }) }
}

/**
 * Confirma a ativação com um código do aplicativo: a semente pendente vira a ativa e saem códigos de recuperação
 * novos (os antigos deixam de valer). null = código errado ou nenhuma ativação pendente.
 */
export function confirmMfaSetup(userId: string, code: string, now = Date.now()): string[] | null {
  const pending = get<{ mfa_pending: string | null }>('SELECT mfa_pending FROM moderators WHERE id = ?', userId)?.mfa_pending
  const secret = pending ? decrypt(pending, context(userId)) : null
  const step = secret ? verifyTotp(secret, code, null, now) : null
  if (step === null) return null
  return tx(() => {
    // Confere que a semente pendente ainda é a mesma (outra ativação pode ter começado no meio).
    const done = run(
      'UPDATE moderators SET mfa_secret = mfa_pending, mfa_pending = NULL, mfa_last_step = ?, mfa_enabled_at = ? WHERE id = ? AND mfa_pending = ?',
      step,
      now,
      userId,
      pending!,
    )
    return Number(done.changes) === 1 ? storeRecoveryCodes(userId) : null
  })
}

/** Segunda etapa com o aplicativo: confere o código e grava o passo, de forma que ele não valha de novo. */
export function verifyUserTotp(userId: string, code: string, now = Date.now()): boolean {
  const row = get<{ mfa_secret: string | null; mfa_last_step: number | null }>('SELECT mfa_secret, mfa_last_step FROM moderators WHERE id = ?', userId)
  const secret = row?.mfa_secret ? decrypt(row.mfa_secret, context(userId)) : null
  const step = secret ? verifyTotp(secret, code, row!.mfa_last_step, now) : null
  if (step === null) return false
  // Condicional: entre duas requisições com o mesmo código, só a primeira grava o passo.
  return Number(run('UPDATE moderators SET mfa_last_step = ? WHERE id = ? AND (mfa_last_step IS NULL OR mfa_last_step < ?)', step, userId, step).changes) === 1
}

/** Segunda etapa com um código de recuperação: cada código vale uma vez (marcado como usado na mesma instrução). */
export function useRecoveryCode(userId: string, code: string, now = Date.now()): boolean {
  const normalized = normalizeRecoveryCode(code)
  if (!RECOVERY.test(normalized)) return false
  const used = run(
    'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    now,
    userId,
    recoveryHash(normalized),
  )
  return Number(used.changes) === 1
}

/** Remove as duas etapas da conta: semente, ativação pendente e códigos de recuperação. */
export function disableMfa(userId: string): void {
  tx(() => {
    run('UPDATE moderators SET mfa_secret = NULL, mfa_pending = NULL, mfa_last_step = NULL, mfa_enabled_at = NULL WHERE id = ?', userId)
    run('DELETE FROM recovery_codes WHERE user_id = ?', userId)
  })
}
