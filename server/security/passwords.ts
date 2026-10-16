// Senhas da equipe: Argon2id (node:crypto), leitura do formato antigo (scrypt), política NIST SP 800-63B-4
// e links de uso único para definir a senha (conta nova ou redefinição pelo administrador).
import { argon2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { get, run, sha256 } from '../sqlite.ts'
import { COMMON_PASSWORDS } from './common-passwords.ts'

const argon2Async = promisify(argon2)
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

// OWASP Password Storage Cheat Sheet pede no mínimo m=19 MiB, t=2, p=1. Usamos a memória da 2ª opção do
// RFC 9106 (64 MiB) com t=3: ~75 ms num Apple M4 (medido em 2026-10; m=19 MiB/t=2 levava 13 ms), algo entre
// 150 e 300 ms numa VPS comum. O cálculo roda no threadpool do libuv (4 threads por padrão), então no pior
// caso ficam ~256 MiB em uso ao mesmo tempo; o limite de tentativas por IP e por conta segura a fila.
const ARGON2 = { memory: 65536, passes: 3, parallelism: 1 }
const SALT_BYTES = 16
const TAG_BYTES = 32

// Mínimo de 12 para toda a equipe. NIST SP 800-63B-4 pede 15 quando a senha é o único fator e aceita 8 quando
// ela faz parte de autenticação multifator; ASVS 5.0 (6.2.1) exige 8 e recomenda 15. Administradores sempre
// usam duas etapas, então 12 fica acima do exigido para eles. Moderadores podem entrar só com senha (política
// requireMfaForModerators desligada): para eles 12 fica abaixo dos 15 do NIST, compensado por Argon2id, lista
// de bloqueio, limite por conta e por IP e acesso restrito aos próprios eventos. Um número só para todos evita
// que a senha deixe de valer quando alguém vira administrador. Para seguir o NIST à risca, mude para 15.
export const PASSWORD_MIN = 12
// Limite antes de qualquer hash (DoS); acima dos 64 que o NIST pede para aceitar.
export const PASSWORD_MAX = 128
// Senhas antigas (scrypt) foram aceitas com até 200 caracteres: continuam entrando até a troca de hash.
const LEGACY_MAX = 200

/** NFKC (NIST 800-63B-4): a mesma senha digitada em teclados diferentes vira os mesmos bytes. null = longa demais. */
function normalized(password: string): string | null {
  if (password.length > PASSWORD_MAX * 4) return null // corta antes de normalizar um texto enorme
  const pw = password.normalize('NFKC')
  return [...pw].length > PASSWORD_MAX ? null : pw
}

const derive = (pw: string, salt: Buffer, p: typeof ARGON2, tagLength: number) =>
  argon2Async('argon2id', { message: Buffer.from(pw, 'utf8'), nonce: salt, tagLength, ...p })

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '')

/** Hash no formato PHC: "$argon2id$v=19$m=65536,t=3,p=1$<sal>$<hash>" (base64 sem "="), legível por outras bibliotecas. */
export async function hashPassword(password: string): Promise<string> {
  const pw = normalized(password)
  if (pw === null) throw new RangeError(`Senha com mais de ${PASSWORD_MAX} caracteres.`)
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(pw, salt, ARGON2, TAG_BYTES)
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(hash)}`
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,6}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,64})\$([A-Za-z0-9+/]{22,88})$/

function parsePhc(stored: string) {
  const m = PHC.exec(stored)
  if (!m) return null
  const params = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) }
  // Teto de sanidade: um hash adulterado no banco não faz o servidor alocar gigabytes.
  if (params.memory > 262144 || params.passes < 1 || params.parallelism < 1) return null
  return { params, salt: Buffer.from(m[4]!, 'base64'), hash: Buffer.from(m[5]!, 'base64') }
}

// Sal descartável: conta inexistente ou sem senha paga o mesmo Argon2 que uma conta real.
const DUMMY_SALT = randomBytes(SALT_BYTES)

/** Mesmo custo de uma verificação real, para o tempo de resposta não revelar quem tem conta. Sempre false. */
export async function burnPasswordCheck(password: string): Promise<false> {
  const pw = normalized(password)
  if (pw !== null) await derive(pw, DUMMY_SALT, ARGON2, TAG_BYTES)
  return false
}

/**
 * Confere a senha contra o hash guardado: Argon2id (PHC) ou o formato antigo "sal.hash" (scrypt, de server/auth.ts).
 * Comparação em tempo constante. Hash vazio (conta aguardando o link de definição) ou desconhecido: false, com o
 * mesmo custo. Depois de um acerto, chame upgradeHash para trocar hashes antigos.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const phc = parsePhc(stored)
  if (phc) {
    const pw = normalized(password)
    if (pw === null) return false
    try {
      const actual = await derive(pw, phc.salt, phc.params, phc.hash.length)
      return timingSafeEqual(actual, phc.hash)
    } catch {
      return false // parâmetros que o Argon2 recusa
    }
  }
  const legacy = /^([\w-]{22})\.([\w-]{86})$/.exec(stored)
  if (legacy && password.length <= LEGACY_MAX) {
    // O formato antigo guardava a senha como digitada, sem NFKC: confere do mesmo jeito.
    const actual = await scryptAsync(password, Buffer.from(legacy[1]!, 'base64url'), 64)
    return timingSafeEqual(actual, Buffer.from(legacy[2]!, 'base64url'))
  }
  return burnPasswordCheck(password)
}

/** true para scrypt, formato desconhecido ou parâmetros diferentes dos atuais (upgradeHash regrava após o login). */
export function needsRehash(stored: string): boolean {
  const phc = parsePhc(stored)
  if (!phc) return true
  const { params: p, salt, hash } = phc
  return (
    p.memory !== ARGON2.memory ||
    p.passes !== ARGON2.passes ||
    p.parallelism !== ARGON2.parallelism ||
    salt.length !== SALT_BYTES ||
    hash.length !== TAG_BYTES
  )
}

/**
 * Depois de um login certo: regrava hash antigo (scrypt ou parâmetros velhos) com os parâmetros atuais.
 * Não faz nada se a senha antiga passa do limite atual, nem se a senha mudou enquanto o hash era calculado.
 */
export async function upgradeHash(userId: string, password: string, stored: string): Promise<void> {
  if (!needsRehash(stored) || normalized(password) === null) return
  run('UPDATE moderators SET password = ? WHERE id = ? AND password = ?', await hashPassword(password), userId, stored)
}

// ---------- política (NIST SP 800-63B-4: tamanho + lista de bloqueio, sem regras de composição) ----------

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
/** Tira números, símbolos e espaços das pontas: "flamengo2024!" -> "flamengo". */
const core = (s: string) => s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' }
const unleet = (s: string) => s.replace(/[013457@$]/g, (ch) => LEET[ch]!)
// Dígitos em 4 voltas: cobre "123456789012" e "098765432109" (a sequência que dá a volta no teclado).
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789'.repeat(4), 'qwertyuiopasdfghjklzxcvbnm', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p', '!@#$%^&*()_+'].flatMap(
  (s) => [s, [...s].reverse().join('')],
)

/** Repetição de um trecho menor que o mínimo ("senha123senha123"): vale o que vale o trecho. */
function repeated(s: string): boolean {
  const m = /^(.+?)\1+$/su.exec(s)
  return !!m && [...m[1]!].length < PASSWORD_MIN
}

function predictable(lower: string): boolean {
  const compact = lower.replace(/[^\p{L}\p{N}]/gu, '')
  const candidates = new Set([lower, core(lower), core(compact), unleet(core(lower)), core(unleet(lower))])
  return [...candidates].some(
    (s) => s.length >= 4 && (COMMON_PASSWORDS.has(s) || repeated(s) || SEQUENCES.some((q) => q.includes(s))),
  )
}

/** Partes de nome ou e-mail com 4+ letras ("João Silva" -> joao, silva, joaosilva); curtas demais dão falso positivo. */
function personalWords(text: string | undefined): string[] {
  if (!text) return []
  const parts = fold(text).split(/[^\p{L}\p{N}]+/u)
  return [...parts, parts.join('')].filter((w) => w.length >= 4)
}

/**
 * Problema da senha nova, em pt-BR, ou null se ela serve. Use no cadastro, na troca e no link de definição.
 * Regras: 12 a 128 caracteres (cada ponto de código Unicode conta um), sem nome, e-mail ou nome do sistema,
 * fora da lista de senhas comuns, sem sequências ou repetições. Nada de exigir maiúscula, número ou símbolo.
 */
export function passwordProblem(password: string, user: { email?: string; name?: string } = {}): string | null {
  const pw = normalized(password)
  if (pw === null) return `A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`
  if ([...pw].length < PASSWORD_MIN) return `A senha precisa de ao menos ${PASSWORD_MIN} caracteres.`
  const lower = fold(pw)
  const compact = lower.replace(/[^\p{L}\p{N}]/gu, '')
  const personal = [...personalWords(user.name), ...personalWords(user.email?.split('@')[0]), 'deckslides']
  if (personal.some((w) => compact.includes(w)))
    return 'A senha não pode conter seu nome, seu e-mail ou o nome do sistema. Escolha outra.'
  if (predictable(lower))
    return 'Essa senha é comum ou previsível demais. Escolha outra; uma frase com três ou quatro palavras é fácil de lembrar e difícil de adivinhar.'
  return null
}

// ---------- links de definição de senha ----------

export type PasswordLinkPurpose = 'setup' | 'reset'
const HOUR = 60 * 60 * 1000
// Conta nova: a pessoa pode abrir o link no dia seguinte. Redefinição: quem pediu está esperando.
export const PASSWORD_LINK_TTL: Record<PasswordLinkPurpose, number> = { setup: 72 * HOUR, reset: 24 * HOUR }

/**
 * Cria um link de uso único e invalida os anteriores da conta. Devolve o token (256 bits, vai na URL);
 * o banco guarda só o SHA-256 dele.
 */
export function createPasswordLink(userId: string, purpose: PasswordLinkPurpose, createdBy: string | null, now = Date.now()): string {
  const token = randomBytes(32).toString('base64url')
  run('DELETE FROM password_links WHERE user_id = ?', userId)
  run(
    'INSERT INTO password_links (token_hash, user_id, purpose, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    purpose,
    createdBy,
    now,
    now + PASSWORD_LINK_TTL[purpose],
  )
  return token
}

export interface PasswordLink {
  userId: string
  purpose: PasswordLinkPurpose
  email: string
  name: string
}

/** Link válido: existe, não foi usado, não expirou e a conta está ativa. Não consome. */
export function findPasswordLink(token: string, now = Date.now()): PasswordLink | null {
  if (!/^[\w-]{43}$/.test(token)) return null
  const row = get<PasswordLink>(
    `SELECT l.user_id AS userId, l.purpose, m.email, m.name FROM password_links l JOIN moderators m ON m.id = l.user_id
     WHERE l.token_hash = ? AND l.used_at IS NULL AND l.expires_at > ? AND m.disabled = 0`,
    sha256(token),
    now,
  )
  return row ? { ...row } : null
}

/**
 * Consome o link (só uma requisição vence) e devolve o id da conta, ou null. Chame logo antes de gravar a
 * senha nova, sem await entre os dois, e encerre as sessões da conta em seguida.
 */
export function consumePasswordLink(token: string, now = Date.now()): string | null {
  if (!/^[\w-]{43}$/.test(token)) return null
  const row = get<{ user_id: string }>(
    `UPDATE password_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       AND user_id IN (SELECT id FROM moderators WHERE disabled = 0)
     RETURNING user_id`,
    now,
    sha256(token),
    now,
  )
  return row?.user_id ?? null
}
