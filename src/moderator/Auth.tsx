// Entrada do console (/entrar): cria a primeira conta da organização ou entra com e-mail e senha.
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, post } from '../lib/api.ts'
import { Button, Field, Input, Spinner } from '../ui'
import { Mark, focusInvalid, message } from './setup/kit.tsx'

interface Me {
  moderator: object | null
  needsSetup: boolean
  setupToken?: boolean // produção: a primeira conta exige o SETUP_TOKEN do servidor
}

type Errors = Partial<Record<'name' | 'email' | 'password' | 'token', string>>

export default function Auth() {
  const navigate = useNavigate()
  const [me, setMe] = useState<Me | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Me>('/auth/me').then(
      (r) => (r.moderator ? navigate('/eventos', { replace: true }) : setMe(r)),
      (e) => {
        setMe({ moderator: null, needsSetup: false })
        setError(message(e))
      },
    )
  }, [navigate])

  if (!me) {
    return (
      <main className="grid min-h-dvh place-items-center text-fg-subtle">
        <Spinner size={18} />
      </main>
    )
  }

  const setup = me.needsSetup
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>
    const found: Errors = {}
    if (setup && !data.name?.trim()) found.name = 'Informe seu nome.'
    if (!data.email?.trim()) found.email = 'Informe o e-mail.'
    if (!data.password) found.password = 'Informe a senha.'
    else if (setup && data.password.length < 8) found.password = 'Use pelo menos 8 caracteres.'
    if (setup && me.setupToken && !data.token?.trim()) found.token = 'Informe o código de instalação.'
    setErrors(found)
    setError(null)
    if (Object.keys(found).length) return focusInvalid(form)
    setBusy(true)
    try {
      await post(setup ? '/auth/setup' : '/auth/login', data)
      navigate('/eventos', { replace: true })
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }
  // Editar um campo apaga só o erro dele.
  const clear = (e: FormEvent<HTMLFormElement>) => {
    const name = (e.target as HTMLInputElement).name as keyof Errors
    if (errors[name])
      setErrors((all) => {
        const next = { ...all }
        delete next[name]
        return next
      })
  }

  return (
    <main className="flex min-h-dvh justify-center px-6">
      <div className="w-full max-w-[340px] pt-[16vh] pb-16">
        <Mark />
        <h1 className="mt-10 text-page font-semibold">{setup ? 'Criar a conta da organização' : 'Entrar'}</h1>
        {setup && (
          <p className="mt-1.5 text-ui text-fg-muted">Primeiro acesso a este servidor. Com esta conta você cria eventos e adiciona o resto da equipe.</p>
        )}
        <form className="mt-6 flex flex-col gap-4" onSubmit={submit} onChange={clear} noValidate>
          {setup && (
            <Field label="Nome" error={errors.name}>
              <Input name="name" autoComplete="name" maxLength={120} autoFocus />
            </Field>
          )}
          <Field label="E-mail" error={errors.email}>
            <Input name="email" type="email" autoComplete={setup ? 'email' : 'username'} maxLength={200} autoFocus={!setup} />
          </Field>
          <Field label="Senha" error={errors.password} hint={setup ? 'Pelo menos 8 caracteres.' : undefined}>
            <Input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} maxLength={200} />
          </Field>
          {setup && me.setupToken && (
            <Field label="Código de instalação" error={errors.token} hint="O valor de SETUP_TOKEN configurado no servidor.">
              <Input name="token" autoComplete="off" spellCheck={false} className="font-code" />
            </Field>
          )}
          {error && (
            <p role="alert" className="text-ui text-critical">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
            {setup ? 'Criar conta' : 'Entrar'}
          </Button>
        </form>
        {!setup && <p className="mt-6 text-meta text-fg-subtle">Para ter acesso, peça a alguém da equipe para criar sua conta.</p>}
      </div>
    </main>
  )
}
