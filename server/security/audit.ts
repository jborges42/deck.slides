// Trilha de auditoria: quem fez o quê, quando e de onde. Nunca guarda segredo, e todo texto vem limpo
// (sem quebra de linha, controle ou inversão bidi), para que nada injetado finja ser outra entrada.
import { all, run } from '../sqlite.ts'
import type { AuditAction, AuditEntry } from '../../shared/admin.ts'

type Detail = AuditEntry['detail']

const SENSITIVE_KEY = /pass|token|secret|pin|code|hash|cookie/i
// C0/C1 (inclui \n, \r, ESC), marcas de direção e isolamentos bidi (U+202A–U+202E, U+2066–U+2069).
const CONTROL = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu
const MAX_KEYS = 20

const clean = (s: string, max = 200) => s.replace(CONTROL, '').slice(0, max)
const optional = (s: string | null | undefined, max = 200) => (s == null ? null : clean(String(s), max))

/** Detalhe plano e seguro: tira chaves sensíveis, objetos e listas; corta textos em 200 caracteres. */
export function sanitizeDetail(detail: Record<string, unknown> = {}): Detail {
  const out: [string, string | number | boolean | null][] = []
  for (const [k, v] of Object.entries(detail)) {
    if (out.length === MAX_KEYS) break
    if (SENSITIVE_KEY.test(k)) continue
    const key = clean(k, 40)
    if (typeof v === 'string') out.push([key, clean(v)])
    else if (typeof v === 'number') out.push([key, Number.isFinite(v) ? v : null])
    else if (typeof v === 'boolean' || v === null) out.push([key, v])
  }
  return Object.fromEntries(out) // fromEntries cria propriedades próprias: "__proto__" não troca o protótipo
}

export interface AuditInput {
  action: AuditAction
  actorId?: string | null
  actorEmail?: string | null
  targetType?: string | null
  targetId?: string | null
  ip?: string | null
  detail?: Record<string, unknown>
}

/** Registra uma ação. Chame na mesma transação da mudança quando houver uma (falha aqui desfaz a ação). */
export function audit(entry: AuditInput, now = Date.now()): void {
  run(
    'INSERT INTO audit_log (at, action, actor_id, actor_email, target_type, target_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    now,
    entry.action,
    optional(entry.actorId, 64),
    optional(entry.actorEmail),
    optional(entry.targetType, 40),
    optional(entry.targetId, 64),
    optional(entry.ip, 64) ?? '',
    JSON.stringify(sanitizeDetail(entry.detail)),
  )
}

interface AuditRow {
  id: number
  at: number
  action: AuditAction
  actor_id: string | null
  actor_email: string | null
  target_type: string | null
  target_id: string | null
  ip: string
  detail: string
}

/** Entradas mais novas primeiro. `before` é um id (paginação: passe o id da última entrada recebida). */
export function listAudit(query: { limit?: number; before?: number; action?: string; actorId?: string } = {}): AuditEntry[] {
  const limit = Number.isFinite(query.limit) ? Math.min(200, Math.max(1, Math.trunc(query.limit!))) : 50
  const before = Number.isFinite(query.before) ? Math.trunc(query.before!) : null
  const action = query.action ?? null
  const actorId = query.actorId ?? null
  const rows = all<AuditRow>(
    `SELECT * FROM audit_log
     WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR action = ?2) AND (?3 IS NULL OR actor_id = ?3)
     ORDER BY id DESC LIMIT ?4`,
    before,
    action,
    actorId,
    limit,
  )
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    targetType: r.target_type,
    targetId: r.target_id,
    ip: r.ip,
    detail: JSON.parse(r.detail) as Detail,
  }))
}
