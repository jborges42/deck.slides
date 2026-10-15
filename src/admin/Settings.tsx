// Administração › Configurações: regras de segurança do sistema (SystemSettings). Salvar pede confirmação de identidade.
import { useState, type FormEvent } from 'react'
import { patch } from '../lib/api.ts'
import { Button, Field, Input, Switch, notify } from '../ui'
import { message } from '../moderator/setup/kit.tsx'
import { SudoCancelled, expired, withSudo } from '../moderator/auth/sudo.tsx'
import { Loading, Problem, Section, useLoad } from './kit.tsx'
import type { SystemSettings } from '../../shared/admin.ts'

type NumberKey = 'sessionIdleHours' | 'sessionMaxDays' | 'maxUploadMb'

const NUMBERS: { key: NumberKey; label: string; hint: string }[] = [
  { key: 'sessionIdleHours', label: 'Sessão expira sem uso após (horas)', hint: 'Depois desse tempo sem atividade, é preciso entrar de novo.' },
  { key: 'sessionMaxDays', label: 'Duração máxima da sessão (dias)', hint: 'Mesmo em uso, a sessão termina depois desse prazo.' },
  { key: 'maxUploadMb', label: 'Limite por arquivo enviado (MB)', hint: 'Vale para imagens e vídeos enviados em Mídia.' },
]

export default function SettingsPage() {
  const { data, error, reload } = useLoad<SystemSettings>('/admin/settings')
  if (error) return <Problem error={error} retry={reload} />
  if (!data) return <Loading />
  // key: depois de salvar, o formulário recomeça a partir do que o servidor confirmou.
  return <SettingsForm key={JSON.stringify(data)} saved={data} onSaved={reload} />
}

function SettingsForm({ saved, onSaved }: { saved: SystemSettings; onSaved: () => void }) {
  const [mfa, setMfa] = useState(saved.requireMfaForModerators)
  const [values, setValues] = useState(() => Object.fromEntries(NUMBERS.map((n) => [n.key, String(saved[n.key])])) as Record<NumberKey, string>)
  const [errors, setErrors] = useState<Partial<Record<NumberKey, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const changes: Partial<SystemSettings> = {}
  if (mfa !== saved.requireMfaForModerators) changes.requireMfaForModerators = mfa
  for (const { key } of NUMBERS) if (Number(values[key]) !== saved[key]) changes[key] = Number(values[key])
  const dirty = Object.keys(changes).length > 0

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const found: Partial<Record<NumberKey, string>> = {}
    for (const { key } of NUMBERS) if (!/^\d+$/.test(values[key]) || Number(values[key]) < 1) found[key] = 'Use um número inteiro a partir de 1.'
    setErrors(found)
    setError(null)
    if (Object.keys(found).length || !dirty) return
    setBusy(true)
    try {
      await withSudo(() => patch('/admin/settings', changes))
      notify('Configurações salvas.')
      onSaved()
    } catch (err) {
      if (!(err instanceof SudoCancelled) && !expired(err)) setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <Section title="Verificação em duas etapas" description="Para a administração geral, ela é sempre obrigatória.">
        <Switch
          className="max-w-[480px]"
          label="Exigir duas etapas também da moderação"
          description="Ligado, quem modera precisa ativar a verificação para continuar usando o console."
          checked={mfa}
          onChange={setMfa}
        />
      </Section>
      <Section title="Sessões e envios" description="Valem para toda a equipe.">
        <div className="flex max-w-[480px] flex-col gap-4">
          {NUMBERS.map((n) => (
            <Field key={n.key} label={n.label} hint={n.hint} error={errors[n.key]}>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                className="w-32 tabular-nums"
                value={values[n.key]}
                onChange={(e) => setValues((v) => ({ ...v, [n.key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      </Section>
      <div className="flex items-center gap-3 border-t border-line pt-5">
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
          Salvar alterações
        </Button>
        {error && (
          <p role="alert" className="text-ui text-critical">
            {error}
          </p>
        )}
      </div>
    </form>
  )
}
