// TOTP (RFC 6238), base32 (RFC 4648), códigos de recuperação e o estado de duas etapas da conta.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'deck-sec-totp-'))
const { all, get, run } = await import('../db.ts')
const { migrateSecurity } = await import('../security/schema.ts')
const t = await import('../security/totp.ts')
migrateSecurity()

const STEP = 30_000

test('RFC 6238 Apêndice B: vetores SHA-1, SHA-256 e SHA-512 com 8 dígitos', () => {
  const keys = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  }
  const vectors: [seconds: number, sha1: string, sha256: string, sha512: string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ]
  for (const [seconds, sha1, sha256, sha512] of vectors) {
    const step = Math.floor(seconds / 30)
    assert.equal(t.totp(keys.sha1, step, 8), sha1, `sha1 T=${seconds}`)
    assert.equal(t.totp(keys.sha256, step, 8, 'sha256'), sha256, `sha256 T=${seconds}`)
    assert.equal(t.totp(keys.sha512, step, 8, 'sha512'), sha512, `sha512 T=${seconds}`)
  }
  // Semente em base32 dá o mesmo resultado que em bytes; o padrão é 6 dígitos.
  assert.equal(t.totp(t.base32Encode(keys.sha1), 1), '287082')
})

test('base32 RFC 4648 (sem "="), ida e volta, tolerância e recusa', () => {
  const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]
  for (const [plain, encoded] of vectors) {
    assert.equal(t.base32Encode(Buffer.from(plain)), encoded)
    assert.equal(t.base32Decode(encoded).toString(), plain)
  }
  for (let n = 0; n < 40; n++) {
    const bytes = randomBytes(n)
    assert.deepEqual(t.base32Decode(t.base32Encode(bytes)), bytes)
  }
  assert.equal(t.base32Decode('mzxw 6ytb-oi======').toString(), 'foobar') // como os aplicativos exibem
  assert.throws(() => t.base32Decode('MZXW1'), /base32/) // "1" não existe no alfabeto
})

test('semente nova: 160 bits em base32, sempre diferente; URI para o QR code', () => {
  const secret = t.generateSecret()
  assert.match(secret, /^[A-Z2-7]{32}$/)
  assert.equal(t.base32Decode(secret).length, 20)
  assert.notEqual(t.generateSecret(), secret)
  const uri = new URL(t.otpauthUri({ secret, account: 'ana@exemplo.com' }))
  assert.equal(uri.protocol, 'otpauth:')
  assert.equal(uri.host, 'totp')
  assert.equal(decodeURIComponent(uri.pathname), '/deck.slides:ana@exemplo.com')
  assert.deepEqual(Object.fromEntries(uri.searchParams), { secret, issuer: 'deck.slides', algorithm: 'SHA1', digits: '6', period: '30' })
})

test('verifyTotp: aceita um passo de folga para cada lado e devolve o passo', () => {
  const secret = t.generateSecret()
  const step = 57_000_000
  const now = step * STEP + 10_000
  const code = t.totp(secret, step)
  assert.equal(t.verifyTotp(secret, code, null, now), step)
  assert.equal(t.verifyTotp(secret, code, null, now + STEP), step, 'celular atrasado 30 s')
  assert.equal(t.verifyTotp(secret, code, null, now - STEP), step, 'celular adiantado 30 s')
  assert.equal(t.verifyTotp(secret, code, null, now + 2 * STEP), null, 'fora da janela')
  assert.equal(t.verifyTotp(secret, code, null, now - 2 * STEP), null, 'fora da janela')
  assert.equal(t.verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, null, now), step, 'com espaços')
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
  if (![step - 1, step + 1].some((s) => t.totp(secret, s) === wrong)) assert.equal(t.verifyTotp(secret, wrong, null, now), null)
  for (const junk of ['', '12345', '1234567', 'abcdef', '12345a', '１２３４５６'])
    assert.equal(t.verifyTotp(secret, junk, null, now), null, junk)
})

test('verifyTotp: código já usado (passo <= último aceito) é recusado', () => {
  const secret = t.generateSecret()
  const step = 57_000_100
  const now = step * STEP
  const code = t.totp(secret, step)
  assert.equal(t.verifyTotp(secret, code, step, now), null, 'mesmo passo')
  assert.equal(t.verifyTotp(secret, code, step + 1, now), null, 'passo anterior ao último')
  assert.equal(t.verifyTotp(secret, code, step - 1, now), step)
  // Depois de aceitar o passo seguinte (relógio adiantado), o código do passo atual também não vale mais.
  assert.equal(t.verifyTotp(secret, t.totp(secret, step + 1), step, now), step + 1)
  assert.equal(t.verifyTotp(secret, code, step + 1, now), null)
})

test('códigos de recuperação: formato legível, únicos, 60 bits, só o hash vai para o banco', () => {
  const { codes, hashes } = t.generateRecoveryCodes()
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10)
  assert.equal(new Set(hashes).size, 10)
  for (const code of codes) assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  for (const [i, hash] of hashes.entries()) {
    assert.match(hash, /^[\w-]{43}$/)
    assert.ok(!hash.includes(codes[i]!.replace(/-/g, '')))
  }
  // Entropia: 12 símbolos de um alfabeto de 32 (5 bits) = 60 bits; todos os símbolos aparecem.
  const symbols = new Set(t.generateRecoveryCodes(200).codes.join('').replace(/-/g, ''))
  assert.equal(symbols.size, 32)
  assert.ok(12 * Math.log2(symbols.size) >= 60)
})

test('normalizeRecoveryCode: minúsculas, espaços, hífens e letras confundíveis', () => {
  assert.equal(t.normalizeRecoveryCode(' k7qx-2mpa 9tre '), 'K7QX2MPA9TRE')
  assert.equal(t.normalizeRecoveryCode('O1IL-oiil-0000'), '01110111' + '0000')
})

// ---------- estado da conta ----------

run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('u1', 'Ana', 'ana@exemplo.com', 'x', 1)")
run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('u2', 'Bia', 'bia@exemplo.com', 'x', 2)")
const mfaRow = (id = 'u1') =>
  get<{ mfa_secret: string | null; mfa_pending: string | null; mfa_last_step: number | null; mfa_enabled_at: number | null }>(
    'SELECT mfa_secret, mfa_pending, mfa_last_step, mfa_enabled_at FROM moderators WHERE id = ?',
    id,
  )!

let secret = ''
let recovery: string[] = []
const base = 58_000_000 * STEP

test('ativação: semente cifrada em mfa_pending; só um código válido confirma', () => {
  const setup = t.beginMfaSetup('u1', 'ana@exemplo.com')
  secret = setup.secret
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\/deck\.slides:ana%40exemplo\.com\?secret=/)
  const row = mfaRow()
  assert.equal(row.mfa_secret, null, 'ainda inativo')
  assert.match(row.mfa_pending!, /^v1\./)
  assert.ok(!row.mfa_pending!.includes(secret), 'semente nunca em claro no banco')

  assert.equal(t.confirmMfaSetup('u1', '000000', base), null)
  assert.equal(t.confirmMfaSetup('u2', t.totp(secret, base / STEP), base), null, 'outra conta sem ativação pendente')
  recovery = t.confirmMfaSetup('u1', t.totp(secret, base / STEP), base)!
  assert.equal(recovery.length, 10)
  const active = mfaRow()
  assert.equal(active.mfa_pending, null)
  assert.match(active.mfa_secret!, /^v1\./)
  assert.equal(active.mfa_last_step, base / STEP)
  assert.equal(active.mfa_enabled_at, base)
  const stored = all<{ code_hash: string }>("SELECT code_hash FROM recovery_codes WHERE user_id = 'u1'").map((r) => r.code_hash)
  assert.equal(stored.length, 10)
  for (const code of recovery) assert.ok(!stored.some((h) => h.includes(code.replace(/-/g, ''))))
})

test('semente copiada para outra conta no banco não abre (dado associado da cifra)', () => {
  run("UPDATE moderators SET mfa_secret = (SELECT mfa_secret FROM moderators WHERE id = 'u1') WHERE id = 'u2'")
  assert.equal(t.verifyUserTotp('u2', t.totp(secret, base / STEP + 5), base + 5 * STEP), false)
  run("UPDATE moderators SET mfa_secret = NULL WHERE id = 'u2'")
})

test('login com TOTP: o código usado na ativação não vale de novo; cada código, uma vez', () => {
  assert.equal(t.verifyUserTotp('u1', t.totp(secret, base / STEP), base), false, 'código da ativação')
  const now = base + 3 * STEP
  const code = t.totp(secret, now / STEP)
  assert.equal(t.verifyUserTotp('u1', code, now), true)
  assert.equal(t.verifyUserTotp('u1', code, now), false, 'reuso')
  assert.equal(t.verifyUserTotp('u1', code, now + STEP), false, 'reuso no passo seguinte')
  const lucky = [9, 10, 11].some((d) => t.totp(secret, now / STEP + d) === '123456')
  assert.equal(t.verifyUserTotp('u1', '123456', now + 10 * STEP), lucky)
  assert.equal(t.verifyUserTotp('nao-existe', code, now), false)
  assert.equal(t.verifyUserTotp('u2', code, now), false, 'conta sem duas etapas')
})

test('códigos de recuperação: cada um vale uma vez, digitado de qualquer jeito', () => {
  const [first, second] = recovery as [string, string]
  assert.equal(t.useRecoveryCode('u2', first), false, 'código de outra conta')
  assert.equal(t.useRecoveryCode('u1', first.toLowerCase().replace(/-/g, ' ')), true)
  assert.equal(t.useRecoveryCode('u1', first), false, 'segunda vez')
  assert.equal(t.useRecoveryCode('u1', 'AAAA-BBBB-CCCC'), false)
  assert.equal(t.useRecoveryCode('u1', ''), false)
  assert.equal(t.useRecoveryCode('u1', 'x'.repeat(10_000)), false)
  assert.ok(get("SELECT 1 FROM recovery_codes WHERE user_id = 'u1' AND used_at IS NOT NULL"))

  const fresh = t.replaceRecoveryCodes('u1')
  assert.equal(t.useRecoveryCode('u1', second), false, 'lote anterior invalidado')
  assert.equal(t.useRecoveryCode('u1', fresh[0]!), true)
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = 'u1'")!.n, 10)
})

test('reativação troca a semente só na confirmação; desativar limpa tudo', () => {
  const again = t.beginMfaSetup('u1', 'ana@exemplo.com')
  const now = base + 20 * STEP
  // Até confirmar, a semente antiga continua valendo.
  assert.equal(t.verifyUserTotp('u1', t.totp(secret, now / STEP), now), true)
  assert.ok(t.confirmMfaSetup('u1', t.totp(again.secret, now / STEP + 1), now + STEP))
  assert.equal(t.verifyUserTotp('u1', t.totp(secret, now / STEP + 3), now + 3 * STEP), false, 'semente antiga')
  assert.equal(t.verifyUserTotp('u1', t.totp(again.secret, now / STEP + 3), now + 3 * STEP), true)

  t.disableMfa('u1')
  assert.deepEqual({ ...mfaRow() }, { mfa_secret: null, mfa_pending: null, mfa_last_step: null, mfa_enabled_at: null })
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = 'u1'")!.n, 0)
  assert.equal(t.verifyUserTotp('u1', t.totp(again.secret, now / STEP + 5), now + 5 * STEP), false)
})
