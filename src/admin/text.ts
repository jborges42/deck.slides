// Textos das páginas da equipe: papéis, aparelho da sessão e frases da auditoria. Funções puras (text.test.ts).
import type { AuditAction, AuditEntry, Role } from '../../shared/admin.ts'

export const ROLE_LABEL: Record<Role, string> = { admin: 'Administração geral', moderator: 'Moderação' }

const roleName = (v: unknown) => (v === 'admin' || v === 'moderator' ? ROLE_LABEL[v] : null)

/** "Chrome no macOS" a partir do user agent. Só para leitura humana: nunca decide acesso. */
export function device(ua: string): string {
  // A ordem importa: Edge, Opera e Samsung também dizem "Chrome"; quase todos dizem "Safari".
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null
  // iPhone e iPad dizem "like Mac OS X"; Android diz "Linux".
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Macintosh|Mac OS X/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null
  if (browser && os) return `${browser} no ${os}`
  return browser ?? os ?? 'Aparelho desconhecido'
}

type Detail = AuditEntry['detail']

// O Record obriga a escrever a frase de toda AuditAction nova.
const ACTION: Record<AuditAction, string | ((d: Detail) => string)> = {
  'auth.setup': 'Conta inicial criada',
  'auth.login': 'Entrou no console',
  'auth.login_failed': 'Tentativa de entrada recusada',
  'auth.login_locked': 'Entrada bloqueada por excesso de tentativas',
  'auth.mfa_failed': 'Código da verificação em duas etapas recusado',
  'auth.logout': 'Saiu do console',
  'auth.sudo': 'Identidade confirmada para uma ação sensível',
  'auth.password_changed': 'Senha alterada',
  'auth.password_set': 'Senha definida pelo link',
  'auth.mfa_enabled': 'Verificação em duas etapas ativada',
  'auth.mfa_disabled': 'Verificação em duas etapas desativada',
  'auth.recovery_codes_regenerated': 'Novos códigos de recuperação gerados',
  'auth.recovery_code_used': 'Código de recuperação usado para entrar',
  'session.revoked': 'Sessão encerrada',
  'admin.user_created': 'Conta criada',
  'admin.user_updated': 'Dados da conta alterados',
  'admin.role_changed': (d) => (roleName(d.role) ? `Papel alterado para ${roleName(d.role)}` : 'Papel alterado'),
  'admin.user_disabled': 'Conta desativada',
  'admin.user_enabled': 'Conta reativada',
  'admin.password_reset_link': 'Link de nova senha gerado',
  'admin.mfa_reset': 'Verificação em duas etapas removida pela administração',
  'admin.settings_changed': 'Configurações do sistema alteradas',
  'event.created': 'Evento criado',
  'event.deleted': 'Evento excluído',
  'event.member_added': 'Pessoa incluída na equipe do evento',
  'event.member_removed': 'Pessoa removida da equipe do evento',
  'event.pin_changed': 'Novo PIN do evento gerado',
  'screen.paired': 'Tela conectada',
  'screen.unpaired': 'Tela desconectada',
  'participant.link_reset': 'Novo link de convite gerado',
}

/** A ação em uma frase. Ação desconhecida (servidor mais novo) aparece como veio. */
export function auditText(e: Pick<AuditEntry, 'action' | 'detail'>): string {
  const text = ACTION[e.action] ?? e.action
  return typeof text === 'function' ? text(e.detail) : text
}

const KEY: Record<string, string> = {
  email: 'E-mail',
  name: 'Nome',
  role: 'Papel',
  reason: 'Motivo',
  from: 'Antes',
  to: 'Depois',
  userAgent: 'Aparelho',
  requireMfaForModerators: 'Duas etapas na moderação',
  sessionIdleHours: 'Sessão sem uso (horas)',
  sessionMaxDays: 'Duração máxima da sessão (dias)',
  maxUploadMb: 'Limite por arquivo (MB)',
}

/** Detalhes como pares rótulo/valor legíveis (nunca o JSON cru). */
export function detailPairs(e: Pick<AuditEntry, 'action' | 'detail'>): [string, string][] {
  return Object.entries(e.detail)
    .filter(([k]) => !(k === 'role' && e.action === 'admin.role_changed')) // já está na frase
    .map(([k, v]) => [
      KEY[k] ?? k,
      k === 'userAgent' && typeof v === 'string'
        ? device(v)
        : (roleName(v) ?? (typeof v === 'boolean' ? (v ? 'sim' : 'não') : v === null ? 'vazio' : String(v))),
    ])
}
