// Migração de segurança: idempotente, e um banco antigo (antes de papéis) ganha administrador e owners.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Banco no formato antigo, criado antes de a aplicação abrir o arquivo: como um deck.db de produção atual.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'deck-sec-schema-'))
const legacy = new DatabaseSync(join(process.env.DATA_DIR, 'deck.db'))
legacy.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE moderators (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL,
    session_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL, settings TEXT NOT NULL, theme TEXT NOT NULL,
    live TEXT NOT NULL, created_at INTEGER NOT NULL);
  INSERT INTO moderators (id, name, email, password, created_at) VALUES
    ('m-new', 'Bia', 'bia@exemplo.com', 'sal.hash', 300),
    ('m-old', 'Ana', 'ana@exemplo.com', 'sal.hash', 100),
    ('m-mid', 'Caio', 'caio@exemplo.com', 'sal.hash', 200);
  INSERT INTO events (id, name, pin, settings, theme, live, created_at) VALUES
    ('EVT001', 'Aula magna', '123456', '{}', '{}', '{}', 1), ('EVT002', 'Semana acadêmica', '654321', '{}', '{}', '{}', 2);
`)
legacy.close()

const { all, get, run } = await import('../sqlite.ts')
const { migrateSecurity, toStaffUser } = await import('../security/schema.ts')
type Row = Parameters<typeof toStaffUser>[0]

const roles = () => all<{ id: string; role: string }>('SELECT id, role FROM moderators ORDER BY created_at')
const members = () => all<{ event_id: string; user_id: string; role: string }>('SELECT event_id, user_id, role FROM event_members ORDER BY event_id, user_id')
const auditCount = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n

test('banco antigo: colunas e tabelas novas, conta mais antiga vira admin e cada evento ganha owner', () => {
  migrateSecurity()
  const columns = all<{ name: string }>('PRAGMA table_info(moderators)').map((c) => c.name)
  for (const c of ['role', 'disabled', 'mfa_secret', 'mfa_pending', 'mfa_last_step', 'mfa_enabled_at', 'failed_logins', 'locked_until', 'last_login_at'])
    assert.ok(columns.includes(c), c)
  const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name)
  for (const t of ['staff_sessions', 'recovery_codes', 'password_links', 'audit_log', 'event_members']) assert.ok(tables.includes(t), t)

  assert.deepEqual(roles().map((r) => ({ ...r })), [
    { id: 'm-old', role: 'admin' },
    { id: 'm-mid', role: 'moderator' },
    { id: 'm-new', role: 'moderator' },
  ])
  assert.deepEqual(members().map((m) => ({ ...m })), [
    { event_id: 'EVT001', user_id: 'm-old', role: 'owner' },
    { event_id: 'EVT002', user_id: 'm-old', role: 'owner' },
  ])
  const promoted = get<{ action: string; target_id: string; detail: string }>('SELECT action, target_id, detail FROM audit_log')!
  assert.equal(promoted.action, 'admin.role_changed')
  assert.equal(promoted.target_id, 'm-old')
  assert.deepEqual(JSON.parse(promoted.detail), { role: 'admin', reason: 'migration' })
  // Contas antigas continuam ativas, sem duas etapas e sem falhas registradas.
  const ana = toStaffUser(get<Row>("SELECT * FROM moderators WHERE id = 'm-old'")!)
  assert.deepEqual(ana, {
    id: 'm-old', name: 'Ana', email: 'ana@exemplo.com', role: 'admin', disabled: false, mfaEnabled: false,
    pendingSetup: false, createdAt: 100, lastLoginAt: null,
  })
})

test('rodar de novo não muda nada', () => {
  const before = { roles: roles(), members: members(), audit: auditCount() }
  migrateSecurity()
  migrateSecurity()
  assert.deepEqual({ roles: roles(), members: members(), audit: auditCount() }, before)
})

test('invariantes reparadas a cada início: evento sem owner e sistema sem admin ativo', () => {
  // Evento novo sem equipe e evento cujo owner saiu, restando só um moderador.
  run("INSERT INTO events (id, name, pin, settings, theme, live, created_at) VALUES ('EVT003', 'Novo', '1', '{}', '{}', '{}', 3)")
  run("UPDATE event_members SET role = 'moderator' WHERE event_id = 'EVT002'")
  migrateSecurity()
  assert.deepEqual(
    members().map((m) => ({ ...m })).filter((m) => m.event_id !== 'EVT001'),
    [
      { event_id: 'EVT002', user_id: 'm-old', role: 'owner' },
      { event_id: 'EVT003', user_id: 'm-old', role: 'owner' },
    ],
  )

  // Admin desativado (fora da API) e conta aguardando senha: promove a ativa mais antiga que já tem senha.
  run("UPDATE moderators SET disabled = 1 WHERE id = 'm-old'")
  run("UPDATE moderators SET password = '' WHERE id = 'm-mid'")
  migrateSecurity()
  assert.equal(get<{ role: string }>("SELECT role FROM moderators WHERE id = 'm-new'")!.role, 'admin')
  assert.equal(get<{ role: string }>("SELECT role FROM moderators WHERE id = 'm-mid'")!.role, 'moderator')
  // Owners existentes não mudam (o desativado segue owner; a administração decide o que fazer com ele).
  assert.equal(members().filter((m) => m.role === 'owner').length, 3)
})

test('restrições do banco: papel válido, propósito de link válido e exclusão em cascata', () => {
  assert.throws(() => run("UPDATE moderators SET role = 'root' WHERE id = 'm-new'"), /CHECK constraint failed/)
  assert.throws(
    () => run("INSERT INTO password_links (token_hash, user_id, purpose, created_at, expires_at) VALUES ('h', 'm-new', 'login', 1, 2)"),
    /CHECK constraint failed/,
  )
  assert.throws(() => run("INSERT INTO event_members (event_id, user_id, role, created_at) VALUES ('EVT001', 'm-new', 'admin', 1)"), /CHECK constraint failed/)

  run("INSERT INTO staff_sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('s1', 'h1', 'm-mid', 1, 1, 2)")
  run("INSERT INTO recovery_codes (user_id, code_hash) VALUES ('m-mid', 'c1')")
  run("INSERT INTO password_links (token_hash, user_id, purpose, created_by, created_at, expires_at) VALUES ('l1', 'm-mid', 'setup', 'm-new', 1, 2)")
  run("INSERT INTO event_members (event_id, user_id, role, created_at) VALUES ('EVT001', 'm-mid', 'moderator', 1)")
  run("DELETE FROM moderators WHERE id = 'm-mid'")
  for (const table of ['staff_sessions', 'recovery_codes', 'password_links', 'event_members'])
    assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 'm-mid'`)!.n, 0, table)

  // Link criado por um admin que depois é excluído continua existindo, sem autor.
  run("INSERT INTO moderators (id, name, email, password, created_at) VALUES ('m-tmp', 'Tmp', 'tmp@exemplo.com', 'x', 400)")
  run("INSERT INTO password_links (token_hash, user_id, purpose, created_by, created_at, expires_at) VALUES ('l2', 'm-new', 'reset', 'm-tmp', 1, 2)")
  run("DELETE FROM moderators WHERE id = 'm-tmp'")
  assert.equal(get<{ created_by: string | null }>("SELECT created_by FROM password_links WHERE token_hash = 'l2'")!.created_by, null)
})
