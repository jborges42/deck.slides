// Cifra de segredos em repouso (AES-256-GCM com chave por HKDF) e HMAC com chave por finalidade.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'deck-sec-secrets-'))
process.env.SESSION_SECRET = 'segredo-dos-testes-de-secrets-com-32-ou-mais-caracteres'
const { decrypt, encrypt, hmac } = await import('../security/secrets.ts')

const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

test('cifra e decifra; formato versionado; IV novo a cada vez', () => {
  const a = encrypt(SEED, 'mfa:u1')
  const b = encrypt(SEED, 'mfa:u1')
  assert.match(a, /^v1\.[\w-]{16}\.[\w-]+\.[\w-]{22}$/) // IV de 12 bytes, tag de 16
  assert.notEqual(a, b)
  assert.ok(!a.includes(SEED))
  assert.equal(decrypt(a, 'mfa:u1'), SEED)
  assert.equal(decrypt(b, 'mfa:u1'), SEED)
  for (const text of ['', 'ação 🔐 telão', 'x'.repeat(10_000)]) assert.equal(decrypt(encrypt(text)), text)
})

test('adulteração em qualquer parte é detectada (null, sem exceção)', () => {
  const sealed = encrypt(SEED, 'mfa:u1')
  const parts = sealed.split('.')
  const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
  for (const i of [1, 2, 3]) {
    const tampered = [...parts]
    tampered[i] = flip(parts[i]!, 2)
    assert.equal(decrypt(tampered.join('.'), 'mfa:u1'), null, `parte ${i}`)
  }
  assert.equal(decrypt(`v2.${parts.slice(1).join('.')}`, 'mfa:u1'), null, 'versão desconhecida')
  assert.equal(decrypt(`${parts.slice(0, 3).join('.')}.${parts[3]!.slice(0, 8)}`, 'mfa:u1'), null, 'tag truncada')
  assert.equal(decrypt(`${sealed}.extra`, 'mfa:u1'), null)
  for (const junk of ['', 'v1', 'v1...', 'v1.AAAA.AAAA.AAAA', 'texto qualquer']) assert.equal(decrypt(junk), null, junk)
})

test('chave errada ou contexto (conta) errado: null', () => {
  const sealed = encrypt(SEED, 'mfa:u1')
  assert.equal(decrypt(sealed, 'mfa:u2'), null, 'outra conta')
  assert.equal(decrypt(sealed, ''), null, 'sem contexto')
  assert.equal(decrypt(sealed, 'mfa:u1', 'outro-segredo-raiz'), null, 'outro segredo raiz')
  const other = encrypt(SEED, 'mfa:u1', 'outro-segredo-raiz')
  assert.equal(decrypt(other, 'mfa:u1', 'outro-segredo-raiz'), SEED)
  assert.equal(decrypt(other, 'mfa:u1'), null)
})

test('hmac: determinístico, separado por finalidade e por segredo raiz', () => {
  const h = hmac('recovery-code', 'K7QX2MPA9TRE')
  assert.match(h, /^[\w-]{43}$/)
  assert.equal(hmac('recovery-code', 'K7QX2MPA9TRE'), h)
  assert.notEqual(hmac('recovery-code', 'K7QX2MPA9TRF'), h)
  assert.notEqual(hmac('outra-coisa', 'K7QX2MPA9TRE'), h)
  assert.notEqual(hmac('recovery-code', 'K7QX2MPA9TRE', 'outro-segredo-raiz'), h)
})
