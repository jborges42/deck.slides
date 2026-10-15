// Definir senha pelo link de uso único (/definir-senha/:token): conta criada pela administração ou senha redefinida.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, ApiError, post } from '../../lib/api.ts'
import { Button, Field, Input, Spinner, buttonClass } from '../../ui'
import { Mark, message } from '../setup/kit.tsx'
import { MfaStep } from './MfaStep.tsx'
import type { Me } from '../../../shared/admin.ts'

/** Política mostrada nos formulários de senha. O servidor confere de novo (e pode recusar senhas vazadas). */
export const MIN_PASSWORD = 12
export const PASSWORD_HINT = 'Use pelo menos 12 caracteres. Frases longas são mais fáceis de lembrar e mais seguras.'

/** Erro da nova senha + confirmação, ou null. Conta caracteres (pontos de código), não bytes. */
export function passwordProblem(next: string, again: string): { next?: string; again?: string } | null {
  if (!next) return { next: 'Digite a nova senha.' }
  if ([...next].length < MIN_PASSWORD) return { next: `Use pelo menos ${MIN_PASSWORD} caracteres.` }
  if (next !== again) return { again: 'As senhas não coincidem. Digite a mesma senha nos dois campos.' }
  return null
}

type LinkInfo = { email: string; name: string }

export default function SetPassword() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [link, setLink] = useState<LinkInfo | 'invalid' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mfa, setMfa] = useState(false)
  const [errors, setErrors] = useState<{ next?: string; again?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // encodeURIComponent: o token vem da URL e não pode virar outro caminho da API ("../").
  const path = `/auth/password-link/${encodeURIComponent(token)}`

  const load = () => {
    setLoadError(null)
    api<LinkInfo>(path).then(setLink, (e) =>
      // Sem rede ou erro do servidor: dá para tentar de novo. O resto (404, 410…) é link inválido.
      e instanceof ApiError && (e.status === 0 || e.status >= 500) ? setLoadError(message(e)) : setLink('invalid'),
    )
  }
  useEffect(load, [path])

  // Admin sem as duas etapas (ou moderação, se a política exigir) vai direto ativar em Minha conta.
  const enter = async () => {
    const me = await api<Me>('/account').catch(() => null)
    navigate(me?.mfaRequired ? '/conta' : '/eventos', { replace: true })
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const next = String(data.get('next') ?? '')
    const problem = passwordProblem(next, String(data.get('again') ?? ''))
    setErrors(problem ?? {})
    setError(null)
    if (problem) return
    setBusy(true)
    try {
      // Conta que já tem as duas etapas conclui a entrada com o código, como no login.
      const r = await post<{ mfa?: boolean }>(path, { password: next })
      if (r.mfa) setMfa(true)
      else await enter()
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) setLink('invalid')
      else setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  let body: ReactNode
  if (link === null) {
    body = loadError ? (
      <>
        <h1 className="mt-10 text-page font-semibold">Não foi possível abrir o link.</h1>
        <p className="mt-1.5 text-ui text-fg-muted">{loadError}</p>
        <Button className="mt-6" onClick={load}>
          Tentar novamente
        </Button>
      </>
    ) : (
      <div className="mt-10 text-fg-subtle">
        <Spinner size={18} />
      </div>
    )
  } else if (link === 'invalid') {
    body = (
      <>
        <h1 className="mt-10 text-page font-semibold">Este link não é válido ou expirou.</h1>
        <p className="mt-1.5 text-ui text-fg-muted">Peça um novo link à administração.</p>
        <Link to="/entrar" className={buttonClass('secondary', 'md', 'mt-6')}>
          Ir para a entrada
        </Link>
      </>
    )
  } else if (mfa) {
    body = <MfaStep className="mt-10" onDone={() => void enter()} />
  } else {
    body = (
      <>
        <h1 className="mt-10 text-page font-semibold">Olá, {link.name}.</h1>
        <p className="mt-1.5 text-ui text-fg-muted">
          Defina a senha da conta <span className="text-fg">{link.email}</span>.
        </p>
        <form className="mt-6 flex flex-col gap-4" onSubmit={submit} noValidate>
          {/* Gerenciadores de senha guardam a nova senha junto deste e-mail. */}
          <input hidden readOnly name="username" autoComplete="username" value={link.email} />
          <Field label="Nova senha" error={errors.next} hint={PASSWORD_HINT}>
            <Input name="next" type="password" autoComplete="new-password" maxLength={200} autoFocus />
          </Field>
          <Field label="Confirme a nova senha" error={errors.again}>
            <Input name="again" type="password" autoComplete="new-password" maxLength={200} />
          </Field>
          {error && (
            <p role="alert" className="text-ui text-critical">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
            Definir senha
          </Button>
        </form>
      </>
    )
  }

  return (
    <main className="flex min-h-dvh justify-center px-6">
      <div className="w-full max-w-[340px] pt-[16vh] pb-16">
        <Mark />
        {body}
      </div>
    </main>
  )
}
