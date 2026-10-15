// Tabelas de segurança da equipe: papéis, duas etapas, bloqueio por conta, sessões no servidor, códigos de
// recuperação, links de senha, auditoria e equipe de cada evento. migrateSecurity roda a cada início.
import { all, db, get, run, tx } from '../db.ts'
import { audit } from './audit.ts'
import type { Role, StaffUser } from '../../shared/admin.ts'

// Colunas novas de `moderators` (a tabela das contas da equipe). ADD COLUMN só aceita NOT NULL com DEFAULT.
const STAFF_COLUMNS: [name: string, definition: string][] = [
  ['role', "TEXT NOT NULL DEFAULT 'moderator' CHECK (role IN ('admin', 'moderator'))"],
  ['disabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['mfa_secret', 'TEXT'], // semente TOTP cifrada (secrets.ts)
  ['mfa_pending', 'TEXT'], // semente cifrada durante a ativação, até o primeiro código confirmar
  ['mfa_last_step', 'INTEGER'], // último passo TOTP aceito: o mesmo código não vale duas vezes
  ['mfa_enabled_at', 'INTEGER'],
  ['failed_logins', 'INTEGER NOT NULL DEFAULT 0'],
  ['locked_until', 'INTEGER'],
  ['last_login_at', 'INTEGER'],
]

const TABLES = `
  -- Sessões da equipe. O cookie leva o token; aqui fica só o SHA-256. O id é público (lista de sessões).
  CREATE TABLE IF NOT EXISTS staff_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES moderators(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, -- absoluto; sessão pendente (falta a segunda etapa) vive 5 min
    pending_mfa INTEGER NOT NULL DEFAULT 0,
    mfa_at INTEGER, -- quando a segunda etapa foi feita nesta sessão
    sudo_until INTEGER, -- confirmação recente de identidade para ações sensíveis
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS staff_sessions_user ON staff_sessions(user_id);

  CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id TEXT NOT NULL REFERENCES moderators(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, -- HMAC com chave fora do banco (secrets.ts)
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );

  CREATE TABLE IF NOT EXISTS password_links (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES moderators(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'reset')),
    created_by TEXT REFERENCES moderators(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS password_links_user ON password_links(user_id);

  -- Sem chave estrangeira em actor_id: o registro continua depois que a conta é excluída.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT,
    actor_email TEXT,
    target_type TEXT,
    target_id TEXT,
    ip TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at DESC);

  CREATE TABLE IF NOT EXISTS event_members (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES moderators(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'moderator')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS event_members_user ON event_members(user_id);
`

/**
 * Idempotente: pode rodar a cada início, em banco novo ou antigo. Detecta colunas por PRAGMA table_info e cria
 * tabelas com IF NOT EXISTS (não usa PRAGMA user_version, para não disputar a numeração com outras migrações).
 * Também repara duas invariantes do contrato (shared/admin.ts), o que cobre a migração de bancos antigos:
 * havendo contas, existe um administrador ativo; todo evento tem um owner.
 */
export function migrateSecurity(): void {
  tx(() => {
    const have = new Set(all<{ name: string }>('PRAGMA table_info(moderators)').map((c) => c.name))
    for (const [name, definition] of STAFF_COLUMNS) if (!have.has(name)) db.exec(`ALTER TABLE moderators ADD COLUMN ${name} ${definition}`)
    db.exec(TABLES)
    const now = Date.now()

    // Banco antigo (ninguém tinha papel): a conta mais antiga, criada pela instalação, vira administradora.
    if (!get("SELECT 1 FROM moderators WHERE role = 'admin' AND disabled = 0")) {
      const oldest = get<{ id: string }>("SELECT id FROM moderators WHERE disabled = 0 AND password != '' ORDER BY created_at, rowid LIMIT 1")
      if (oldest) {
        run("UPDATE moderators SET role = 'admin' WHERE id = ?", oldest.id)
        audit({ action: 'admin.role_changed', targetType: 'user', targetId: oldest.id, detail: { role: 'admin', reason: 'migration' } }, now)
      }
    }

    // Evento sem owner (banco antigo, ou o owner foi excluído) fica com o administrador mais antigo.
    const admin = get<{ id: string }>("SELECT id FROM moderators WHERE role = 'admin' AND disabled = 0 ORDER BY created_at, rowid LIMIT 1")
    if (admin)
      run(
        `INSERT INTO event_members (event_id, user_id, role, created_at)
         SELECT e.id, ?, 'owner', ? FROM events e
         WHERE NOT EXISTS (SELECT 1 FROM event_members m WHERE m.event_id = e.id AND m.role = 'owner')
         ON CONFLICT (event_id, user_id) DO UPDATE SET role = 'owner'`,
        admin.id,
        now,
      )
  })
}

/** Linha de `moderators` depois da migração. */
export interface StaffRow {
  id: string
  name: string
  email: string
  password: string // '' = conta aguardando o link de definição de senha
  session_epoch: number
  created_at: number
  role: Role
  disabled: number
  mfa_secret: string | null
  mfa_pending: string | null
  mfa_last_step: number | null
  mfa_enabled_at: number | null
  failed_logins: number
  locked_until: number | null
  last_login_at: number | null
}

/** Conta como o cliente vê (sem hash, semente ou contadores). */
export const toStaffUser = (r: StaffRow): StaffUser => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  disabled: !!r.disabled,
  mfaEnabled: !!r.mfa_secret,
  pendingSetup: r.password === '',
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
})
