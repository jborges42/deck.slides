// Contrato de contas da equipe, papéis, sessões, auditoria e administração do sistema.
// Servidor e cliente usam estes tipos; os endpoints estão listados no fim do arquivo.

/** admin = administrador geral (todo o sistema). moderator = só os eventos de que participa. */
export type Role = 'admin' | 'moderator'

/** Papel dentro de um evento: owner pode excluir o evento e gerenciar a equipe dele. */
export type EventRole = 'owner' | 'moderator'

export interface StaffUser {
  id: string
  name: string
  email: string
  role: Role
  disabled: boolean
  mfaEnabled: boolean
  /** Conta criada pelo administrador que ainda não definiu senha (link pendente). */
  pendingSetup: boolean
  createdAt: number
  lastLoginAt: number | null
}

/** Usuário da sessão atual, com o estado de segurança da própria sessão. */
export interface Me extends StaffUser {
  session: {
    id: string
    /** A sessão passou pela segunda etapa (TOTP ou código de recuperação). */
    mfa: boolean
    /** Até quando ações sensíveis dispensam nova confirmação (sudo). null = sem confirmação recente. */
    sudoUntil: number | null
  }
  /** O administrador precisa ativar as duas etapas antes de usar a administração. */
  mfaRequired: boolean
}

export interface SessionInfo {
  id: string
  userId: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  ip: string
  userAgent: string
  mfa: boolean
  current: boolean
}

export type AuditAction =
  | 'auth.setup'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.login_locked'
  | 'auth.mfa_failed'
  | 'auth.logout'
  | 'auth.sudo'
  | 'auth.password_changed'
  | 'auth.password_set'
  | 'auth.mfa_enabled'
  | 'auth.mfa_disabled'
  | 'auth.recovery_codes_regenerated'
  | 'auth.recovery_code_used'
  | 'session.revoked'
  | 'admin.user_created'
  | 'admin.user_updated'
  | 'admin.role_changed'
  | 'admin.user_disabled'
  | 'admin.user_enabled'
  | 'admin.password_reset_link'
  | 'admin.mfa_reset'
  | 'admin.settings_changed'
  | 'event.created'
  | 'event.deleted'
  | 'event.member_added'
  | 'event.member_removed'
  | 'event.pin_changed'
  | 'screen.paired'
  | 'screen.unpaired'
  | 'participant.link_reset'

export interface AuditEntry {
  id: number
  at: number
  action: AuditAction
  actorId: string | null
  actorEmail: string | null
  targetType: string | null
  targetId: string | null
  ip: string
  /** Dados extras não sensíveis (nunca senha, token, PIN ou segredo). */
  detail: Record<string, string | number | boolean | null>
}

export interface SystemSettings {
  /** Exige duas etapas também dos moderadores (para administradores é sempre obrigatório). */
  requireMfaForModerators: boolean
  /** Sessão expira após este tempo sem uso. */
  sessionIdleHours: number
  /** Sessão expira após este tempo, mesmo em uso. */
  sessionMaxDays: number
  /** Limite por arquivo enviado. */
  maxUploadMb: number
}

export interface EventMember {
  userId: string
  name: string
  email: string
  role: EventRole
}

/** Erros da API trazem `code` quando o cliente precisa reagir (ex.: abrir a confirmação de senha). */
export type ApiErrorCode = 'session_expired' | 'mfa_required' | 'mfa_setup_required' | 'sudo_required' | 'forbidden'

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  requireMfaForModerators: false,
  sessionIdleHours: 12,
  sessionMaxDays: 14,
  maxUploadMb: 1024,
}

/*
ENDPOINTS (todos JSON; erros = { error: string pt-BR, code?: ApiErrorCode })

Autenticação (públicos, com limite de tentativas por IP e por conta):
  GET  /api/auth/me                      -> { user: Me | null, needsSetup, setupToken }
  POST /api/auth/setup                   { name, email, password, token? } -> cria o primeiro ADMIN e entra
  POST /api/auth/login                   { email, password } -> { mfa: false } com sessão completa
                                          | { mfa: true } com sessão "pendente" que só serve para /auth/mfa
  POST /api/auth/mfa                     { code } | { recoveryCode } -> conclui o login
  POST /api/auth/logout                  -> revoga a sessão atual
  GET  /api/auth/password-link/:token    -> { email, name } se o link é válido (para a tela de definir senha)
  POST /api/auth/password-link/:token    { password } -> define a senha (link de uso único) e entra

Conta (qualquer membro da equipe com sessão completa):
  GET    /api/account                    -> Me
  POST   /api/account/sudo               { password } | { code } -> confirma identidade por 10 min
  POST   /api/account/password           { current, next } -> troca e encerra as outras sessões
  POST   /api/account/mfa/setup          [sudo] -> { secret, otpauthUri, qrSvg } (ainda inativo)
  POST   /api/account/mfa/confirm        { code } -> ativa; -> { recoveryCodes: string[] } (exibidos uma vez)
  POST   /api/account/mfa/recovery-codes [sudo] -> { recoveryCodes }
  DELETE /api/account/mfa                [sudo] -> desativa (proibido quando a política exige)
  GET    /api/account/sessions           -> SessionInfo[]
  DELETE /api/account/sessions/:sid      -> encerra uma sessão própria
  POST   /api/account/sessions/revoke-others

Administração (papel admin + sessão com duas etapas; [sudo] = confirmação recente):
  GET    /api/admin/users                -> StaffUser[]
  POST   /api/admin/users                [sudo] { name, email, role } -> { user, setupLink }
  PATCH  /api/admin/users/:uid           [sudo para role/disabled] { name?, role?, disabled? }
  POST   /api/admin/users/:uid/reset     [sudo] -> { setupLink } (encerra as sessões da conta)
  DELETE /api/admin/users/:uid/mfa       [sudo] -> remove as duas etapas (aparelho perdido)
  GET    /api/admin/sessions?userId=     -> SessionInfo[]
  DELETE /api/admin/sessions/:sid        [sudo]
  GET    /api/admin/audit?limit=&before=&action=&actorId= -> AuditEntry[]
  GET    /api/admin/settings             -> SystemSettings
  PATCH  /api/admin/settings             [sudo] Partial<SystemSettings>

Equipe do evento (owner do evento ou admin):
  GET    /api/events/:id/members         -> EventMember[]
  POST   /api/events/:id/members         { email, role } (a conta precisa existir)
  PATCH  /api/events/:id/members/:uid    { role }
  DELETE /api/events/:id/members/:uid    (o evento nunca fica sem owner)

Regras invioláveis: ninguém altera o próprio papel nem desativa a própria conta; o sistema nunca fica sem
um administrador ativo; papel e situação só mudam por /api/admin; toda rota de evento confere a participação
no evento (admin vê todos); toda mudança sensível gera auditoria; segredos nunca saem do servidor.
*/
