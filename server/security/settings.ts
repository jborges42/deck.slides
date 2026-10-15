// Configurações do sistema (shared/admin.ts SystemSettings), guardadas na tabela meta como JSON.
import { z } from 'zod'
import { get, run } from '../db.ts'
import { DEFAULT_SYSTEM_SETTINGS, type SystemSettings } from '../../shared/admin.ts'

const between = (min: number, max: number, message: string) =>
  z.number(message).int(message).min(min, message).max(max, message)

export const systemSettingsSchema = z.object({
  requireMfaForModerators: z.boolean('Informe se as duas etapas são obrigatórias para moderadores.'),
  sessionIdleHours: between(1, 72, 'O tempo sem uso precisa ficar entre 1 e 72 horas.'),
  sessionMaxDays: between(1, 90, 'A duração máxima da sessão precisa ficar entre 1 e 90 dias.'),
  maxUploadMb: between(1, 4096, 'O limite de envio precisa ficar entre 1 e 4096 MB.'),
})

/** Corpo do PATCH /api/admin/settings: qualquer subconjunto; chaves desconhecidas são ignoradas. */
export const settingsPatchSchema = systemSettingsSchema.partial()

/** Configurações atuais. Valor guardado inválido (edição manual do banco) volta ao padrão. */
export function getSettings(): SystemSettings {
  const row = get<{ value: string }>("SELECT value FROM meta WHERE key = 'system_settings'")
  let stored: unknown = {}
  try {
    stored = row ? JSON.parse(row.value) : {}
  } catch {
    // JSON corrompido: usa o padrão
  }
  const parsed = settingsPatchSchema.safeParse(stored)
  return { ...DEFAULT_SYSTEM_SETTINGS, ...(parsed.success ? parsed.data : {}) }
}

/** Aplica e grava. Lança ZodError (mensagens em pt-BR) se o resultado sair das faixas. */
export function updateSettings(patch: Partial<SystemSettings>): SystemSettings {
  const next = systemSettingsSchema.parse({ ...getSettings(), ...patch })
  run(
    "INSERT INTO meta (key, value) VALUES ('system_settings', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    JSON.stringify(next),
  )
  return next
}
