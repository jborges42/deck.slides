// Limite de tentativas por conta: bloqueio crescente a partir da 5ª falha seguida, até 15 minutos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'deck-sec-throttle-'))
const { get, run } = await import('../db.ts')
const { migrateSecurity } = await import('../security/schema.ts')
const { isLocked, recordFailure, recordSuccess } = await import('../security/throttle.ts')
migrateSecurity()

const MINUTE = 60_000
const T0 = 1_800_000_000_000
run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('u1', 'Ana', 'ana@exemplo.com', 'x', 1)")
run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('u2', 'Bia', 'bia@exemplo.com', 'x', 2)")
const row = (id = 'u1') => get<{ failed_logins: number; locked_until: number | null; last_login_at: number | null }>(
  'SELECT failed_logins, locked_until, last_login_at FROM moderators WHERE id = ?',
  id,
)!

test('4 falhas não bloqueiam; da 5ª em diante: 1, 2, 4, 8 e 15 minutos', () => {
  for (let i = 1; i <= 4; i++) assert.deepEqual(recordFailure('u1', T0), { failures: i, lockedUntil: null })
  assert.equal(isLocked(row(), T0), false)
  const expected = [1, 2, 4, 8, 15, 15, 15]
  for (const [i, minutes] of expected.entries()) {
    const r = recordFailure('u1', T0)
    assert.deepEqual(r, { failures: 5 + i, lockedUntil: T0 + minutes * MINUTE }, `falha ${5 + i}`)
    assert.equal(row().locked_until, T0 + minutes * MINUTE)
  }
  assert.equal(isLocked(row(), T0 + 15 * MINUTE - 1), true)
  assert.equal(isLocked(row(), T0 + 15 * MINUTE), false, 'bloqueio é temporário')
  assert.equal(row('u2').failed_logins, 0, 'outra conta não é afetada')
})

test('sucesso zera as falhas, tira o bloqueio e registra o último acesso', () => {
  recordSuccess('u1', T0 + MINUTE)
  assert.deepEqual({ ...row() }, { failed_logins: 0, locked_until: null, last_login_at: T0 + MINUTE })
  assert.equal(isLocked(row(), T0 + MINUTE), false)
  assert.deepEqual(recordFailure('u1', T0), { failures: 1, lockedUntil: null }, 'conta do zero de novo')
})

test('conta inexistente não quebra nem cria nada', () => {
  assert.deepEqual(recordFailure('nao-existe', T0), { failures: 0, lockedUntil: null })
  recordSuccess('nao-existe', T0)
  assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM moderators')!.n, 2)
  assert.equal(isLocked({ locked_until: null }, T0), false)
})
