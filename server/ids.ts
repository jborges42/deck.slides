import { createHash, randomBytes } from 'node:crypto'

/** Identificador aleatório url-safe. 9 bytes = 12 chars; tokens de convite usam 18. */
export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url')

// Alfabeto Crockford sem I, L, O, U: legível em voz alta e na tela, sem confusão entre 0/O e 1/I.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Código curto e legível (ex.: "K7QX2M"). 6 caracteres = ~1 bilhão de combinações. */
export function newCode(length = 6): string {
  return Array.from(randomBytes(length), (b) => CODE_ALPHABET[b % 32]).join('')
}

/** Normaliza um código digitado: maiúsculas, sem espaços/hífens, O->0 e I/L->1 (como o Crockford prevê). */
export const normalizeCode = (s: string) =>
  s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')

/** PIN numérico de 6 dígitos. */
export const newPin = () => String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0')

/** Hash para guardar segredos de alta entropia (tokens de tela) sem guardar o segredo em si. */
export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')
