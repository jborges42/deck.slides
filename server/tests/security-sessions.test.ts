// Sessões da equipe no servidor: token só como hash, prazos, etapa pendente, troca de token, revogação e cookie.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'deck-sec-sessions-'))
const { all, get, run, sha256 } = await import('../sqlite.ts')
const { migrateSecurity } = await import('../security/schema.ts')
const { updateSettings } = await import('../security/settings.ts')
const s = await import('../security/sessions.ts')
migrateSecurity()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = 1_800_000_000_000

run("INSERT INTO moderators (id, name, email, password, created_at, failed_logins, locked_until) VALUES ('u1', 'Ana', 'ana@exemplo.com', 'x', 1, 3, 5)")
run("INSERT INTO moderators (id, name, email, password, created_at, role) VALUES ('u2', 'Bia', 'bia@exemplo.com', 'x', 2, 'admin')")

test('cria e valida: token aleatório, id público diferente, dados da conta e da sessão', () => {
  const { token, id } = s.createSession('u1', { ip: '10.0.0.1', userAgent: 'Firefox\n\u001b[31m', now: T0 })
  assert.match(token, /^[\w-]{43}$/)
  assert.match(id, /^[\w-]{16}$/)
  assert.notEqual(id, token)
  const v = s.validateSession(token, T0 + 1)!
  assert.deepEqual(v.user, {
    id: 'u1', name: 'Ana', email: 'ana@exemplo.com', role: 'moderator', disabled: false, mfaEnabled: false,
    pendingSetup: false, createdAt: 1, lastLoginAt: T0,
  })
  assert.deepEqual(v.session, {
    id, userId: 'u1', createdAt: T0, lastSeenAt: T0, expiresAt: T0 + 14 * DAY, pendingMfa: false, mfaAt: null,
    sudoUntil: null, ip: '10.0.0.1', userAgent: 'Firefox[31m',
  })
  assert.equal(s.validateSession(token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), T0), null)
  for (const junk of [undefined, null, '', 'curto', `${token}x`]) assert.equal(s.validateSession(junk, T0), null)
})

test('sessão completa = autenticação concluída: zera falhas e bloqueio e registra o último acesso', () => {
  const row = get<{ failed_logins: number; locked_until: number | null; last_login_at: number }>(
    "SELECT failed_logins, locked_until, last_login_at FROM moderators WHERE id = 'u1'",
  )!
  assert.deepEqual({ ...row }, { failed_logins: 0, locked_until: null, last_login_at: T0 })
})

test('o token nunca fica em claro no banco (linhas e arquivos)', () => {
  const { token } = s.createSession('u1', { now: T0 })
  for (const r of all<Record<string, unknown>>('SELECT * FROM staff_sessions'))
    for (const value of Object.values(r)) assert.notEqual(value, token)
  const dbFile = join(process.env.DATA_DIR!, 'deck.db')
  for (const file of [dbFile, `${dbFile}-wal`]) if (existsSync(file)) assert.ok(!readFileSync(file).includes(token), file)
  assert.ok(get('SELECT 1 FROM staff_sessions WHERE token_hash = ?', sha256(token)), 'guardado como SHA-256')
})

test('inatividade: vence após sessionIdleHours sem uso; o uso renova (no máximo uma escrita por minuto)', () => {
  const { token, id } = s.createSession('u1', { now: T0 })
  const lastSeen = () => get<{ last_seen_at: number }>('SELECT last_seen_at FROM staff_sessions WHERE id = ?', id)!.last_seen_at
  assert.ok(s.validateSession(token, T0 + 30_000))
  assert.equal(lastSeen(), T0, 'menos de 1 minuto: não grava')
  assert.ok(s.validateSession(token, T0 + 11 * HOUR))
  assert.equal(lastSeen(), T0 + 11 * HOUR)
  assert.ok(s.validateSession(token, T0 + 22 * HOUR), 'renovada pelo uso')
  assert.equal(s.validateSession(token, T0 + 34 * HOUR), null, '12 h sem uso')
  assert.equal(get('SELECT 1 FROM staff_sessions WHERE id = ?', id), undefined, 'removida')
})

test('prazo absoluto: vence em sessionMaxDays mesmo em uso; encurtar o prazo vale para sessões abertas', () => {
  const { token } = s.createSession('u1', { now: T0 })
  for (let at = T0; at < T0 + 14 * DAY; at += 10 * HOUR) assert.ok(s.validateSession(token, at), `em uso: ${(at - T0) / HOUR} h`)
  assert.equal(s.validateSession(token, T0 + 14 * DAY), null)

  const other = s.createSession('u1', { now: T0 })
  updateSettings({ sessionMaxDays: 2, sessionIdleHours: 72 })
  assert.ok(s.validateSession(other.token, T0 + 2 * DAY - 1))
  assert.equal(s.validateSession(other.token, T0 + 2 * DAY), null)
  updateSettings({ sessionMaxDays: 14, sessionIdleHours: 12 })
})

test('etapa pendente: não serve como sessão completa e vence em 5 minutos', () => {
  const pending = s.createSession('u2', { pendingMfa: true, now: T0 })
  assert.equal(s.validateSession(pending.token, T0 + 1), null, 'sessão pendente não é completa')
  const v = s.validatePendingSession(pending.token, T0 + 1)!
  assert.equal(v.session.pendingMfa, true)
  assert.equal(v.session.expiresAt, T0 + 5 * MINUTE)
  assert.equal(get<{ last_login_at: number | null }>("SELECT last_login_at FROM moderators WHERE id = 'u2'")!.last_login_at, null)
  assert.equal(s.validatePendingSession(pending.token, T0 + 5 * MINUTE), null, 'vencida')
  assert.equal(s.completeMfa(pending.id, T0 + 5 * MINUTE), null, 'não completa depois de vencer')

  const full = s.createSession('u2', { now: T0 })
  assert.equal(s.validatePendingSession(full.token, T0 + 1), null, 'completa não passa pela rota da segunda etapa')
})

test('completeMfa: troca o token, a sessão vira completa com prazo novo e a conta registra o acesso', () => {
  run("UPDATE moderators SET failed_logins = 4 WHERE id = 'u2'")
  const pending = s.createSession('u2', { pendingMfa: true, now: T0 })
  const token = s.completeMfa(pending.id, T0 + MINUTE)!
  assert.match(token, /^[\w-]{43}$/)
  assert.notEqual(token, pending.token)
  assert.equal(s.validatePendingSession(pending.token, T0 + MINUTE), null, 'token antigo')
  assert.equal(s.validateSession(pending.token, T0 + MINUTE), null, 'token antigo')
  const v = s.validateSession(token, T0 + MINUTE)!
  assert.equal(v.session.pendingMfa, false)
  assert.equal(v.session.mfaAt, T0 + MINUTE)
  assert.equal(v.session.expiresAt, T0 + MINUTE + 14 * DAY)
  const row = get<{ failed_logins: number; last_login_at: number }>("SELECT failed_logins, last_login_at FROM moderators WHERE id = 'u2'")!
  assert.deepEqual({ ...row }, { failed_logins: 0, last_login_at: T0 + MINUTE })

  // Numa sessão já completa (ativação confirmada): marca a etapa e troca o token, sem mexer no prazo.
  const full = s.createSession('u2', { now: T0 })
  const next = s.completeMfa(full.id, T0 + 2 * MINUTE)!
  assert.equal(s.validateSession(full.token, T0 + 2 * MINUTE), null)
  const w = s.validateSession(next, T0 + 2 * MINUTE)!
  assert.equal(w.session.mfaAt, T0 + 2 * MINUTE)
  assert.equal(w.session.expiresAt, T0 + 14 * DAY)
  assert.equal(s.completeMfa('nao-existe', T0), null)
})

test('rotateSession: token novo, o antigo deixa de valer', () => {
  const { token, id } = s.createSession('u1', { now: T0 })
  const next = s.rotateSession(id)!
  assert.notEqual(next, token)
  assert.equal(s.validateSession(token, T0 + 1), null)
  assert.equal(s.validateSession(next, T0 + 1)!.session.id, id)
  assert.equal(s.rotateSession('nao-existe'), null)
})

test('revogar uma sessão, todas da conta ou todas menos a atual', () => {
  const a = s.createSession('u1', { now: T0 })
  const b = s.createSession('u1', { now: T0 })
  const c = s.createSession('u1', { now: T0 })
  const other = s.createSession('u2', { now: T0 })
  assert.equal(s.revokeSession(a.id), true)
  assert.equal(s.revokeSession(a.id), false)
  assert.equal(s.validateSession(a.token, T0 + 1), null)
  assert.ok(s.revokeUserSessions('u1', b.id) >= 1)
  assert.ok(s.validateSession(b.token, T0 + 1), 'a atual continua')
  assert.equal(s.validateSession(c.token, T0 + 1), null)
  assert.equal(s.revokeUserSessions('u1'), 1)
  assert.equal(s.validateSession(b.token, T0 + 1), null)
  assert.ok(s.validateSession(other.token, T0 + 1), 'outra conta não é afetada')
  // Rota de conta: com userId, ninguém encerra a sessão de outra pessoa sabendo só o id público.
  assert.equal(s.revokeSession(other.id, 'u1'), false)
  assert.ok(s.validateSession(other.token, T0 + 1))
  assert.equal(s.revokeSession(other.id, 'u2'), true)
  assert.equal(s.validateSession(other.token, T0 + 1), null)
})

test('conta desativada derruba a sessão; conta excluída leva as sessões junto', () => {
  const { token, id } = s.createSession('u1', { now: T0 })
  run("UPDATE moderators SET disabled = 1 WHERE id = 'u1'")
  assert.equal(s.validateSession(token, T0 + 1), null)
  run("UPDATE moderators SET disabled = 0 WHERE id = 'u1'")
  assert.equal(s.validateSession(token, T0 + 2), null, 'reativar não ressuscita a sessão')
  assert.equal(get('SELECT 1 FROM staff_sessions WHERE id = ?', id), undefined)

  run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('u3', 'Caio', 'caio@exemplo.com', 'x', 3)")
  const gone = s.createSession('u3', { now: T0 })
  run("DELETE FROM moderators WHERE id = 'u3'")
  assert.equal(s.validateSession(gone.token, T0 + 1), null)
})

test('sudo: janela de 10 minutos, só em sessão completa', () => {
  const { token, id } = s.createSession('u2', { now: T0 })
  assert.equal(s.grantSudo(id, undefined, T0), T0 + 10 * MINUTE)
  assert.equal(s.validateSession(token, T0 + 1)!.session.sudoUntil, T0 + 10 * MINUTE)
  assert.equal(s.grantSudo(id, 5 * MINUTE, T0 + MINUTE), T0 + 6 * MINUTE)
  const pending = s.createSession('u2', { pendingMfa: true, now: T0 })
  assert.equal(s.grantSudo(pending.id, undefined, T0), null)
  assert.equal(s.grantSudo('nao-existe'), null)
})

test('listSessions: só completas e válidas, mais recentes primeiro, marcando a atual', () => {
  run('DELETE FROM staff_sessions')
  const now = Date.now()
  const old = s.createSession('u1', { ip: '10.0.0.1', userAgent: 'Safari', now: now - 2 * HOUR })
  const current = s.createSession('u1', { ip: '10.0.0.2', userAgent: 'Chrome', now: now - HOUR })
  s.completeMfa(current.id, now - HOUR)
  s.createSession('u1', { pendingMfa: true, now })
  s.createSession('u1', { now: now - 13 * HOUR }) // vencida por inatividade
  s.createSession('u2', { now })
  const mine = s.listSessions('u1', current.id, now)
  assert.deepEqual(
    mine.map((x) => [x.id, x.current, x.mfa, x.ip, x.userAgent]),
    [
      [current.id, true, true, '10.0.0.2', 'Chrome'],
      [old.id, false, false, '10.0.0.1', 'Safari'],
    ],
  )
  assert.ok(mine.every((x) => !('token' in x) && !('token_hash' in x)))
  assert.equal(s.listSessions(undefined, undefined, now).length, 3, 'todas as contas')
})

// ---------- cookie ----------

const app = new Hono()
app.post('/login', (c) => {
  s.setSessionCookie(c, 'A'.repeat(43), 3600)
  return c.text('ok')
})
app.get('/token', (c) => c.json({ token: s.readSessionToken(c) }))
app.post('/logout', (c) => {
  s.clearSessionCookie(c)
  return c.text('ok')
})
const TOKEN = 'A'.repeat(43)
const OTHER = 'B'.repeat(43)

test('cookie em HTTP (rede local): deck_session, HttpOnly, SameSite=Lax, Path=/, sem Secure nem Domain', async () => {
  const res = await app.request('http://192.168.0.10/login', { method: 'POST' })
  const cookie = res.headers.get('set-cookie')!
  assert.match(cookie, /^deck_session=A{43};/)
  assert.match(cookie, /; Max-Age=3600/)
  assert.match(cookie, /; Path=\//)
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /; SameSite=Lax/)
  assert.doesNotMatch(cookie, /Secure|Domain/i)
  const read = await app.request('http://192.168.0.10/token', { headers: { cookie: `deck_session=${TOKEN}` } })
  assert.deepEqual(await read.json(), { token: TOKEN })
  const junk = await app.request('http://192.168.0.10/token', { headers: { cookie: 'deck_session=../../etc' } })
  assert.deepEqual(await junk.json(), { token: null })
  const out = await app.request('http://192.168.0.10/logout', { method: 'POST' })
  assert.match(out.headers.get('set-cookie')!, /^deck_session=; Max-Age=0/)
})

test('cookie em HTTPS: __Host-deck_session com Secure; ignora o cookie sem prefixo (plantado via HTTP)', async () => {
  const res = await app.request('https://deck.exemplo.com/login', { method: 'POST' })
  const cookie = res.headers.get('set-cookie')!
  assert.match(cookie, /^__Host-deck_session=A{43};/)
  assert.match(cookie, /; Secure/)
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /; SameSite=Lax/)
  assert.match(cookie, /; Path=\//)
  assert.doesNotMatch(cookie, /Domain/i)
  const read = await app.request('https://deck.exemplo.com/token', { headers: { cookie: `deck_session=${OTHER}; __Host-deck_session=${TOKEN}` } })
  assert.deepEqual(await read.json(), { token: TOKEN })
  const tossed = await app.request('https://deck.exemplo.com/token', { headers: { cookie: `deck_session=${OTHER}` } })
  assert.deepEqual(await tossed.json(), { token: null })
  const out = await app.request('https://deck.exemplo.com/logout', { method: 'POST' })
  assert.match(out.headers.get('set-cookie')!, /^__Host-deck_session=; Max-Age=0.*Secure/)
})

test('atrás de proxy: X-Forwarded-Proto só vale com TRUST_PROXY=1', async () => {
  const headers = { 'x-forwarded-proto': 'https' }
  delete process.env.TRUST_PROXY
  const untrusted = await app.request('http://127.0.0.1/login', { method: 'POST', headers })
  assert.match(untrusted.headers.get('set-cookie')!, /^deck_session=/)
  process.env.TRUST_PROXY = '1'
  const trusted = await app.request('http://127.0.0.1/login', { method: 'POST', headers })
  assert.match(trusted.headers.get('set-cookie')!, /^__Host-deck_session=.*; Secure/)
  const read = await app.request('http://127.0.0.1/token', { headers: { ...headers, cookie: `__Host-deck_session=${TOKEN}` } })
  assert.deepEqual(await read.json(), { token: TOKEN })
  delete process.env.TRUST_PROXY
})
