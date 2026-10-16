// Segredos em repouso (sementes TOTP) com AES-256-GCM e hashes com "pepper" (códigos de recuperação).
// As chaves saem do segredo raiz por HKDF-SHA256, uma por finalidade: vazar uma não compromete as outras.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { metaValue } from '../sqlite.ts'

// Mesmo segredo raiz de server/auth.ts: SESSION_SECRET ou, sem ele, um valor gerado e guardado no banco.
// Com SESSION_SECRET no ambiente (obrigatório em produção), um vazamento só do banco não revela as sementes TOTP.
// Trocar SESSION_SECRET torna ilegíveis as sementes TOTP e invalida os códigos de recuperação: quem usa duas
// etapas precisaria de redefinição pelo administrador (DELETE /api/admin/users/:uid/mfa).
const ROOT = process.env.SESSION_SECRET || metaValue('session_secret', () => randomBytes(32).toString('base64url'))

const key = (secret: string, info: string) => Buffer.from(hkdfSync('sha256', secret, 'deck.slides', info, 32))

/**
 * Cifra `plaintext`. `context` entra como dado associado (AAD): o texto cifrado de uma conta não abre em outra,
 * mesmo copiado no banco. Saída versionada: "v1.<iv>.<cifrado>.<tag>" (base64url).
 */
export function encrypt(plaintext: string, context = '', secret = ROOT): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret, 'aes-256-gcm/v1'), iv)
  cipher.setAAD(Buffer.from(context))
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv, data, cipher.getAuthTag()].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

/** Decifra o que `encrypt` gerou. Qualquer falha (adulteração, chave ou contexto errados, formato) = null. */
export function decrypt(payload: string, context = '', secret = ROOT): string | null {
  const [version, iv, data, tag, ...rest] = payload.split('.')
  if (version !== 'v1' || !iv || data === undefined || !tag || rest.length) return null
  try {
    const nonce = Buffer.from(iv, 'base64url')
    if (nonce.length !== 12) return null
    const decipher = createDecipheriv('aes-256-gcm', key(secret, 'aes-256-gcm/v1'), nonce, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * HMAC-SHA256 com chave própria por finalidade (base64url). Para segredos de baixa entropia guardados como hash
 * (códigos de recuperação): sem a chave, que não está no banco quando SESSION_SECRET vem do ambiente, o hash
 * não pode ser atacado por força bruta. Tokens aleatórios de 256 bits (sessão, links) usam sha256 simples.
 */
export const hmac = (purpose: string, value: string, secret = ROOT) =>
  createHmac('sha256', key(secret, `hmac/${purpose}`)).update(value).digest('base64url')
