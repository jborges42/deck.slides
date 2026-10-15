// Auditoria: nada sensível no detalhe, texto limpo contra injeção no log, ordem e paginação.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'deck-sec-audit-'))
const { get, run } = await import('../db.ts')
const { migrateSecurity } = await import('../security/schema.ts')
const { audit, listAudit, sanitizeDetail } = await import('../security/audit.ts')
migrateSecurity()

test('detalhe: tira chaves sensíveis, objetos e listas; corta em 200; limpa controles e bidi', () => {
  const detail = sanitizeDetail({
    password: 'x', newPassword: 'x', current_password: 'x', token: 'x', setupToken: 'x', secret: 'x', mfaSecret: 'x',
    pin: 'x', PIN: 'x', code: 'x', recoveryCode: 'x', hash: 'x', passwordHash: 'x', cookie: 'x', Cookie: 'x',
    email: 'ana@exemplo.com',
    name: 'Ana\nAUDIT admin.user_created actor=root\r\u0000\u001b[31m‮evil⁦',
    long: 'a'.repeat(500),
    count: 3,
    ratio: Number.NaN,
    big: Number.POSITIVE_INFINITY,
    ok: true,
    nothing: null,
    nested: { password: 'x' },
    list: ['x'],
    missing: undefined,
  })
  assert.deepEqual(detail, {
    email: 'ana@exemplo.com',
    name: 'AnaAUDIT admin.user_created actor=root[31mevil',
    long: 'a'.repeat(200),
    count: 3,
    ratio: null,
    big: null,
    ok: true,
    nothing: null,
  })
})

test('detalhe: "__proto__" não troca o protótipo e o número de chaves é limitado', () => {
  const evil = JSON.parse('{"__proto__": {"admin": true}, "a": 1}') as Record<string, unknown>
  const detail = sanitizeDetail(evil)
  assert.equal(Object.getPrototypeOf(detail), Object.prototype)
  assert.equal((detail as Record<string, unknown>).admin, undefined)
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
  assert.equal(Object.keys(sanitizeDetail(many)).length, 20)
})

test('grava a entrada com campos limpos (IP de X-Forwarded-For pode vir com quebra de linha)', () => {
  audit(
    {
      action: 'auth.login_failed',
      actorEmail: 'ana@exemplo.com\nadmin.settings_changed',
      targetType: 'user',
      targetId: 'u1',
      ip: '10.0.0.1\r\nX: y',
      detail: { reason: 'senha', password: 'nunca' },
    },
    1000,
  )
  const [entry] = listAudit({ limit: 1 })
  assert.deepEqual(entry, {
    id: entry!.id,
    at: 1000,
    action: 'auth.login_failed',
    actorId: null,
    actorEmail: 'ana@exemplo.comadmin.settings_changed',
    targetType: 'user',
    targetId: 'u1',
    ip: '10.0.0.1X: y',
    detail: { reason: 'senha' },
  })
  assert.ok(!get<{ detail: string }>('SELECT detail FROM audit_log WHERE id = ?', entry!.id)!.detail.includes('nunca'))
})

test('lista: mais novas primeiro, limite entre 1 e 200, paginação por id, filtros', () => {
  run('DELETE FROM audit_log')
  for (let i = 0; i < 250; i++)
    audit({ action: i % 2 ? 'auth.login' : 'auth.logout', actorId: i % 3 ? 'u1' : 'u2', detail: { i } }, 10_000 + i)
  const page = listAudit({ limit: 10 })
  assert.deepEqual(page.map((e) => e.detail.i), [249, 248, 247, 246, 245, 244, 243, 242, 241, 240])
  const next = listAudit({ limit: 10, before: page.at(-1)!.id })
  assert.equal(next[0]!.detail.i, 239)
  assert.equal(listAudit().length, 50, 'padrão')
  assert.equal(listAudit({ limit: 1000 }).length, 200, 'teto')
  assert.equal(listAudit({ limit: 0 }).length, 1, 'piso')
  assert.equal(listAudit({ limit: Number.NaN }).length, 50)
  assert.ok(listAudit({ action: 'auth.login', limit: 200 }).every((e) => e.action === 'auth.login'))
  assert.equal(listAudit({ action: 'auth.login', limit: 200 }).length, 125)
  assert.ok(listAudit({ actorId: 'u2', limit: 200 }).every((e) => e.actorId === 'u2'))
  const both = listAudit({ action: 'auth.logout', actorId: 'u2', limit: 200 })
  assert.ok(both.length > 0 && both.every((e) => e.action === 'auth.logout' && e.actorId === 'u2'))
  assert.deepEqual(listAudit({ action: "auth.login' OR 1=1 --" }), [])
})
