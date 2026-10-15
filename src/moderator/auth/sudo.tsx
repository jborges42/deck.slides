// Confirmação de identidade ("sudo", como no GitHub): ações sensíveis pedem a senha ou o código do aplicativo
// quando a última confirmação ficou para trás. Quem decide é o servidor; o cliente só reage a `sudo_required`.
import { useEffect, useId, useState, useSyncExternalStore, type InputHTMLAttributes } from 'react'
import { api, ApiError, post } from '../../lib/api.ts'
import { Button, Dialog, Field, Input, cx, notify } from '../../ui'
import type { Me } from '../../../shared/admin.ts'

// Igual a message() de setup/kit.tsx. Repetido porque este arquivo entra no pacote inicial (main.tsx):
// importar o kit levaria código do console para o celular e para a tela.
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente novamente.')

/** A pessoa fechou a confirmação: a ação não aconteceu e não há erro a mostrar. */
export class SudoCancelled extends Error {}

const hasCode = (e: unknown, code: string) => e instanceof ApiError && e.code === code

/** Sessão vencida: volta para /entrar. Retorna true se tratou o erro. */
export function expired(e: unknown): boolean {
  if (!hasCode(e, 'session_expired')) return false
  // Recarga completa: nada da sessão anterior (códigos, listas) fica na memória da página.
  location.replace('/entrar')
  return true
}

// Um pedido de confirmação por vez; chamadas simultâneas esperam o mesmo diálogo.
let pending: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

function ask(): Promise<boolean> {
  if (!pending) {
    let resolve!: (ok: boolean) => void
    const promise = new Promise<boolean>((r) => (resolve = r))
    pending = { promise, resolve }
    listeners.forEach((l) => l())
  }
  return pending.promise
}

function settle(ok: boolean) {
  pending?.resolve(ok)
  pending = null
  listeners.forEach((l) => l())
}

/**
 * Executa `fn`; se o servidor responder `sudo_required`, abre "Confirme sua identidade" e tenta de novo uma vez.
 * Fechar o diálogo rejeita com SudoCancelled. Precisa de <SudoHost /> montado (main.tsx).
 */
export async function withSudo<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!hasCode(e, 'sudo_required')) throw e
    if (!(await ask())) throw new SudoCancelled('Confirmação cancelada.')
    return fn()
  }
}

/** Ação da equipe: confirmação de identidade quando o servidor pedir; erro vira aviso. undefined = falhou ou foi cancelada. */
export async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withSudo(fn)
  } catch (e) {
    if (!(e instanceof SudoCancelled) && !expired(e)) notify(message(e), { tone: 'critical' })
    return undefined
  }
}

type CodeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> & {
  value: string
  onChange: (digits: string) => void
  /** Chamado ao completar 6 dígitos (envio automático). */
  onComplete?: (digits: string) => void
  size?: 'md' | 'lg'
}

/** Código de 6 dígitos num input só: o preenchimento automático do sistema (SMS/gerenciador) funciona. */
export function CodeInput({ onChange, onComplete, className, ...rest }: CodeInputProps) {
  return (
    <Input
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      spellCheck={false}
      // Sem maxLength: colar "123 456" seria cortado antes de limparmos o espaço.
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 6)
        onChange(digits)
        if (digits.length === 6) onComplete?.(digits)
      }}
      className={cx('font-code tracking-[0.3em] tabular-nums', className)}
      {...rest}
    />
  )
}

/** Diálogo "Confirme sua identidade". Monte uma vez, perto do <ConfirmHost />. */
export function SudoHost() {
  const open = useSyncExternalStore(subscribe, () => pending !== null)
  const form = useId()
  const [mode, setMode] = useState<'password' | 'code'>('password')
  const [value, setValue] = useState('')
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setMode('password')
    setValue('')
    setError(null)
    // O código do aplicativo só aparece para quem tem as duas etapas ativas.
    api<Me>('/account').then(setMe, () => setMe(null))
  }, [open])

  const switchMode = () => {
    setMode((m) => (m === 'password' ? 'code' : 'password'))
    setValue('')
    setError(null)
  }

  const submit = async (secret = value) => {
    if (busy) return
    if (!secret) return setError(mode === 'password' ? 'Digite sua senha.' : 'Digite o código de 6 dígitos.')
    if (mode === 'code' && secret.length !== 6) return setError('O código tem 6 dígitos. Confira no aplicativo.')
    setBusy(true)
    setError(null)
    try {
      await post('/account/sudo', mode === 'password' ? { password: secret } : { code: secret })
      setValue('') // a senha não fica na memória do diálogo fechado
      settle(true)
    } catch (e) {
      if (expired(e)) return
      setError(message(e))
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && settle(false)}
      title="Confirme sua identidade"
      description={
        mode === 'password'
          ? 'Esta ação exige uma confirmação recente. Digite sua senha para continuar.'
          : 'Digite o código de 6 dígitos que aparece no aplicativo autenticador.'
      }
      width={420}
      footer={
        <>
          <Button onClick={() => settle(false)}>Cancelar</Button>
          <Button type="submit" form={form} variant="primary" loading={busy}>
            Confirmar
          </Button>
        </>
      }
    >
      <form
        id={form}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {/* Associa a senha à conta nos gerenciadores de senha. */}
        {me && <input hidden readOnly name="username" autoComplete="username" value={me.email} />}
        {mode === 'password' ? (
          <Field label="Senha atual">
            <Input type="password" autoComplete="current-password" autoFocus maxLength={200} value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        ) : (
          <Field label="Código do aplicativo">
            <CodeInput autoFocus value={value} onChange={setValue} onComplete={(c) => void submit(c)} readOnly={busy} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-ui text-critical">
            {error}
          </p>
        )}
        {me?.mfaEnabled && (
          <Button variant="ghost" size="sm" className="-ml-2.5 self-start" onClick={switchMode}>
            {mode === 'password' ? 'Usar código do aplicativo' : 'Usar a senha'}
          </Button>
        )}
      </form>
    </Dialog>
  )
}
