// Segunda etapa da entrada: código do aplicativo autenticador ou um código de recuperação.
// Uso em /entrar: quando POST /api/auth/login responder { mfa: true }, troque o formulário por
// <MfaStep onDone={() => navigate('/eventos', { replace: true })} onCancel={() => setStep('password')} className="mt-10" />.
import { useState } from 'react'
import { post } from '../../lib/api.ts'
import { Button, Field, Input } from '../../ui'
import { message } from '../setup/kit.tsx'
import { CodeInput } from './sudo.tsx'

export interface MfaStepProps {
  /** O servidor aceitou o código: a sessão está completa. */
  onDone: () => void
  /** Volta para e-mail e senha. Sem esta prop, o botão "Voltar" não aparece. */
  onCancel?: () => void
  className?: string
}

export function MfaStep({ onDone, onCancel, className }: MfaStepProps) {
  const [recovery, setRecovery] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (input = value) => {
    if (busy) return
    const code = input.trim()
    if (!code) return setError(recovery ? 'Digite um dos seus códigos de recuperação.' : 'Digite o código de 6 dígitos.')
    if (!recovery && code.length !== 6) return setError('O código tem 6 dígitos. Confira no aplicativo.')
    setBusy(true)
    setError(null)
    try {
      await post('/auth/mfa', recovery ? { recoveryCode: code } : { code })
      onDone()
    } catch (e) {
      setError(message(e))
      if (!recovery) setValue('') // o código seguinte começa do zero
    } finally {
      setBusy(false)
    }
  }

  const toggle = () => {
    setRecovery((r) => !r)
    setValue('')
    setError(null)
  }

  return (
    <div className={className}>
      <h1 className="text-page font-semibold">Verificação em duas etapas</h1>
      <p className="mt-1.5 text-ui text-fg-muted">
        {recovery
          ? 'Digite um dos códigos de recuperação que você guardou. Cada código funciona uma vez.'
          : 'Digite o código de 6 dígitos que aparece no aplicativo autenticador.'}
      </p>
      <form
        className="mt-6 flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {recovery ? (
          <Field label="Código de recuperação">
            <Input
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={64}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-code"
            />
          </Field>
        ) : (
          <Field label="Código do aplicativo">
            <CodeInput autoFocus size="lg" value={value} onChange={setValue} onComplete={(c) => void submit(c)} readOnly={busy} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-ui text-critical">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
          Confirmar
        </Button>
      </form>
      <div className="mt-4 flex flex-col items-start gap-1">
        <Button variant="ghost" size="sm" className="-ml-2.5" onClick={toggle}>
          {recovery ? 'Usar o código do aplicativo' : 'Usar um código de recuperação'}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" className="-ml-2.5" onClick={onCancel}>
            Voltar
          </Button>
        )}
      </div>
    </div>
  )
}
