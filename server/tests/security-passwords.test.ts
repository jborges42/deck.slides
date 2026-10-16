// Senhas: Argon2id em formato PHC, formato antigo (scrypt), NFKC, limites, política NIST e links de definição.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { argon2Sync, randomBytes, scryptSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'deck-sec-passwords-'))
const { get, run } = await import('../sqlite.ts')
const { migrateSecurity } = await import('../security/schema.ts')
const pw = await import('../security/passwords.ts')
migrateSecurity()

const GOOD = 'cavalo correto bateria grampo'
const PHC = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/

/** Hash no formato antigo de server/auth.ts: scrypt(senha, sal 16 bytes, 64) em "sal.hash" base64url. */
const legacyHash = (password: string) => {
  const salt = randomBytes(16)
  return `${salt.toString('base64url')}.${scryptSync(password, salt, 64).toString('base64url')}`
}

test('node:crypto argon2id confere com o vetor do RFC 9106 §5.3 (variante e versão certas)', () => {
  const tag = argon2Sync('argon2id', {
    message: Buffer.alloc(32, 1),
    nonce: Buffer.alloc(16, 2),
    secret: Buffer.alloc(8, 3),
    associatedData: Buffer.alloc(12, 4),
    parallelism: 4,
    tagLength: 32,
    memory: 32,
    passes: 3,
  })
  assert.equal(tag.toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
})

test('Argon2id: PHC com os parâmetros atuais, sal novo a cada hash, confere a certa e recusa a errada', async () => {
  const a = await pw.hashPassword(GOOD)
  const b = await pw.hashPassword(GOOD)
  assert.match(a, PHC)
  assert.notEqual(a, b)
  assert.equal(await pw.verifyPassword(GOOD, a), true)
  assert.equal(await pw.verifyPassword(GOOD, b), true)
  assert.equal(await pw.verifyPassword(`${GOOD} `, a), false)
  assert.equal(await pw.verifyPassword('Cavalo correto bateria grampo', a), false) // sem mudar maiúsculas
  assert.equal(await pw.verifyPassword('', a), false)
  assert.equal(pw.needsRehash(a), false)
})

test('hash com parâmetros antigos ainda confere e pede regravação', async () => {
  const salt = randomBytes(16)
  const tag = argon2Sync('argon2id', { message: GOOD, nonce: salt, parallelism: 1, tagLength: 32, memory: 19456, passes: 2 })
  const old = `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64').replace(/=+$/, '')}$${tag.toString('base64').replace(/=+$/, '')}`
  assert.equal(await pw.verifyPassword(GOOD, old), true)
  assert.equal(await pw.verifyPassword('outra senha qualquer', old), false)
  assert.equal(pw.needsRehash(old), true)
})

test('formato antigo (scrypt "sal.hash"): confere como antes, sem NFKC, e pede regravação', async () => {
  const stored = legacyHash('senha-segura-123')
  assert.equal(await pw.verifyPassword('senha-segura-123', stored), true)
  assert.equal(await pw.verifyPassword('senha-segura-124', stored), false)
  assert.equal(pw.needsRehash(stored), true)
  // O formato antigo guardava a senha como digitada: a forma decomposta continua sendo outra senha.
  const composed = legacyHash('café com leite!')
  assert.equal(await pw.verifyPassword('café com leite!', composed), true)
  assert.equal(await pw.verifyPassword('café com leite!', composed), false)
  // Senhas antigas de até 200 caracteres (limite do cadastro anterior) continuam entrando.
  const long = 'x'.repeat(150)
  assert.equal(await pw.verifyPassword(long, legacyHash(long)), true)
})

test('upgradeHash: regrava scrypt com Argon2id, sem atropelar troca de senha nem estourar o limite', async () => {
  run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('legacy', 'Leo', 'leo@exemplo.com', '', 0)")
  const setStored = (v: string) => run("UPDATE moderators SET password = ? WHERE id = 'legacy'", v)
  const stored = () => get<{ password: string }>("SELECT password FROM moderators WHERE id = 'legacy'")!.password

  const old = legacyHash('senha-segura-123')
  setStored(old)
  await pw.upgradeHash('legacy', 'senha-segura-123', old)
  assert.match(stored(), PHC)
  assert.equal(await pw.verifyPassword('senha-segura-123', stored()), true)
  const current = stored()
  await pw.upgradeHash('legacy', 'senha-segura-123', current)
  assert.equal(stored(), current, 'hash atual não é regravado')

  // A senha mudou entre o login e a regravação: não volta para a antiga.
  const changed = await pw.hashPassword('outra senha bem nova')
  setStored(changed)
  await pw.upgradeHash('legacy', 'senha-segura-123', old)
  assert.equal(stored(), changed)

  // Senha antiga com mais de 128 caracteres: continua no formato antigo, sem erro.
  const long = 'y'.repeat(150)
  const longHash = legacyHash(long)
  setStored(longHash)
  await pw.upgradeHash('legacy', long, longHash)
  assert.equal(stored(), longHash)
})

test('NFKC: formas equivalentes da mesma senha conferem', async () => {
  const stored = await pw.hashPassword('café com leite no telão')
  assert.equal(await pw.verifyPassword('café com leite no telão', stored), true) // acentos decompostos
  const wide = await pw.hashPassword('ｃｏｒｒｅｃｔ ｈｏｒｓｅ ４２') // largura total
  assert.equal(await pw.verifyPassword('correct horse 42', wide), true)
  assert.equal(await pw.verifyPassword('correct horse 43', wide), false)
})

test('mais de 128 caracteres: recusada antes de qualquer hash', async () => {
  const max = 'a'.repeat(127) + 'ç'
  assert.match(await pw.hashPassword(max), PHC)
  await assert.rejects(pw.hashPassword(max + 'b'), RangeError)
  await assert.rejects(pw.hashPassword('x'.repeat(1_000_000)), RangeError)
  const stored = await pw.hashPassword(GOOD)
  assert.equal(await pw.verifyPassword('x'.repeat(1_000_000), stored), false)
  assert.equal(await pw.burnPasswordCheck('x'.repeat(1_000_000)), false)
  // Conta um ponto de código por caractere (NIST): 128 emojis cabem.
  assert.match(await pw.hashPassword('🔐'.repeat(128)), PHC)
})

test('hash vazio (conta aguardando o link), formato desconhecido ou adulterado: false', async () => {
  for (const stored of ['', 'texto', '$argon2id$v=19$m=999999,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '$argon2i$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$AAAA'])
    assert.equal(await pw.verifyPassword(GOOD, stored), false, stored)
  assert.equal(pw.needsRehash(''), true)
})

test('conta inexistente ou sem senha custa o mesmo que uma conta real', async () => {
  const stored = await pw.hashPassword(GOOD)
  const time = async (fn: () => Promise<unknown>) => {
    const samples: number[] = []
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      await fn()
      samples.push(performance.now() - t)
    }
    return samples.sort((a, b) => a - b)[1]!
  }
  const real = await time(() => pw.verifyPassword('senha errada aqui', stored))
  const burn = await time(() => pw.burnPasswordCheck('senha errada aqui'))
  const empty = await time(() => pw.verifyPassword('senha errada aqui', ''))
  assert.equal(await pw.burnPasswordCheck('qualquer coisa'), false)
  // Folga larga: só pega a regressão de "conta inexistente responde na hora".
  assert.ok(burn > real / 3 && empty > real / 3, `real ${real} ms, burn ${burn} ms, vazio ${empty} ms`)
})

test('política: tamanho mínimo e máximo, sem regras de composição', () => {
  assert.equal(pw.passwordProblem('a1b2c3d4e5f'), 'A senha precisa de ao menos 12 caracteres.')
  assert.equal(pw.passwordProblem('x'.repeat(129)), 'A senha pode ter no máximo 128 caracteres.')
  // Só minúsculas, só palavras, com espaços, com acentos: tudo vale se não for previsível.
  for (const ok of [GOOD, 'girafa azul toca violino', 'ação rápida no telão 7', 'Xk4!vB9#qL2@', 'mesa-lápis-chuva-1987', '🔐 sete chaves guardadas'])
    assert.equal(pw.passwordProblem(ok), null, ok)
})

test('política: senhas comuns, com enfeites, leet, sequências e repetições', () => {
  const common = 'Essa senha é comum ou previsível demais. Escolha outra; uma frase com três ou quatro palavras é fácil de lembrar e difícil de adivinhar.'
  for (const bad of [
    'senha1234567', 'Senha@123456', 'mudar1234567', 'Flamengo2024!', 'flamengo 1981', 'corinthians1910', 'brasil123456', '123mudar1234',
    'P@ssw0rd2024', 'S3nh4S3gur4!!', 'iloveyou1234', 'qwertyuiop12', '123456789012', '098765432109', 'abcdefghijkl', 'asdfghjkl123',
    'aaaaaaaaaaaa', '            ', 'abcabcabcabc', 'senha123senha123', 'senhasenha12', '1q2w3e4r5t6y', '102030405060', 'Mariana2010!!',
    'jesuscristo777', 'deusefiel2024', 'teamo1234567', 'Administrador1',
  ])
    assert.equal(pw.passwordProblem(bad), common, bad)
})

test('política: nome, e-mail e nome do sistema', () => {
  const personal = 'A senha não pode conter seu nome, seu e-mail ou o nome do sistema. Escolha outra.'
  const user = { name: 'João Silva', email: 'maria.souza@exemplo.com' }
  for (const bad of ['joaosilva2024!!', 'JOAO-feliz-no-evento', 'silva e a vida boa', 'souza nunca esquece', 'mariasouza#2026', 'deck.slides 2026', 'Deck Slides é ótimo'])
    assert.equal(pw.passwordProblem(bad, user), personal, bad)
  // Partes curtas (< 4 letras) não contam: "Ana" não bloqueia "banana".
  assert.equal(pw.passwordProblem('banana prata madura', { name: 'Ana', email: 'ana@exemplo.com' }), null)
  assert.equal(pw.passwordProblem('joaosilva2024!!'), null) // sem dados da pessoa, a regra não se aplica
})

// ---------- links de definição de senha ----------

const HOUR = 3_600_000
run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('u1', 'Ana Lima', 'ana@exemplo.com', '', 1)")
run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('admin', 'Admin', 'admin@exemplo.com', 'x', 0)")

test('link de definição: token só na URL, uso único, dados da conta para a tela', () => {
  const now = 1_000_000
  const token = pw.createPasswordLink('u1', 'setup', 'admin', now)
  assert.match(token, /^[\w-]{43}$/)
  assert.deepEqual(pw.findPasswordLink(token, now + 1), { userId: 'u1', purpose: 'setup', email: 'ana@exemplo.com', name: 'Ana Lima' })
  assert.equal(pw.findPasswordLink(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), now), null)
  assert.equal(pw.consumePasswordLink(token, now + 2), 'u1')
  assert.equal(pw.consumePasswordLink(token, now + 3), null, 'segunda vez')
  assert.equal(pw.findPasswordLink(token, now + 3), null)
  for (const junk of ['', 'curto', 'x'.repeat(5000), "' OR 1=1 --"]) {
    assert.equal(pw.findPasswordLink(junk), null)
    assert.equal(pw.consumePasswordLink(junk), null)
  }
})

test('link de definição: expira (72 h conta nova, 24 h redefinição) e o novo invalida o anterior', () => {
  const now = 5_000_000
  const setup = pw.createPasswordLink('u1', 'setup', 'admin', now)
  assert.ok(pw.findPasswordLink(setup, now + 72 * HOUR - 1))
  assert.equal(pw.findPasswordLink(setup, now + 72 * HOUR), null)
  assert.equal(pw.consumePasswordLink(setup, now + 72 * HOUR), null)

  const first = pw.createPasswordLink('u1', 'reset', 'admin', now)
  const second = pw.createPasswordLink('u1', 'reset', 'admin', now + 1)
  assert.equal(pw.findPasswordLink(first, now + 2), null, 'link anterior')
  assert.equal(pw.findPasswordLink(second, now + 1 + 24 * HOUR), null, 'redefinição vence em 24 h')
  assert.equal(pw.consumePasswordLink(second, now + 24 * HOUR), 'u1')
})

test('link de definição: conta desativada não usa o link', () => {
  const token = pw.createPasswordLink('u1', 'reset', null)
  run("UPDATE moderators SET disabled = 1 WHERE id = 'u1'")
  assert.equal(pw.findPasswordLink(token), null)
  assert.equal(pw.consumePasswordLink(token), null)
  run("UPDATE moderators SET disabled = 0 WHERE id = 'u1'")
  assert.equal(pw.consumePasswordLink(token), 'u1')
})
