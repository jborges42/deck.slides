// Minha conta (/conta): perfil, senha, verificação em duas etapas e sessões abertas.
// É para cá que vai quem precisa ativar as duas etapas (o servidor responde mfa_setup_required).
import { useEffect, useState, type FormEvent } from 'react'
import { del, post } from '../lib/api.ts'
import { Button, Dot, Empty, Field, Input, confirm, notify } from '../ui'
import { Page, message } from '../moderator/setup/kit.tsx'
import { SudoCancelled, act, expired, withSudo } from '../moderator/auth/sudo.tsx'
import { PASSWORD_HINT, passwordProblem } from '../moderator/auth/SetPassword.tsx'
import { Loading, Problem, Section, SessionTable, useLoad } from '../admin/kit.tsx'
import { useStaff } from '../admin/StaffShell.tsx'
import { ROLE_LABEL, device } from '../admin/text.ts'
import { TwoStep } from './TwoStep.tsx'
import type { SessionInfo } from '../../shared/admin.ts'

export default function Account() {
  const { me, reload } = useStaff()
  const sessions = useLoad<SessionInfo[]>('/account/sessions')
  // /conta#duas-etapas (vindo da administração): a rolagem fica no Page, então rola até a seção.
  useEffect(() => {
    document.getElementById(location.hash.slice(1))?.scrollIntoView() // em bloco: no Chrome novo devolve uma Promise
  }, [])

  return (
    <Page title="Minha conta" description="Seus dados, senha, verificação em duas etapas e aparelhos com acesso à conta.">
      {me.mfaRequired && (
        <div role="status" className="mb-6 flex items-start gap-3 rounded-control border border-line bg-surface px-4 py-3">
          <Dot tone="attention" className="mt-1.5" />
          <p className="text-ui text-fg">
            {me.role === 'admin'
              ? 'A administração exige a verificação em duas etapas. Ative abaixo para usar a administração.'
              : 'A organização exige a verificação em duas etapas. Ative abaixo para continuar usando o console.'}{' '}
            <a href="#duas-etapas" className="underline underline-offset-2">
              Ir para a verificação
            </a>
          </p>
        </div>
      )}

      <Section title="Perfil" description={me.role === 'admin' ? undefined : 'Para mudar nome ou e-mail, fale com a administração.'}>
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-y-2 text-ui">
          <dt className="text-fg-muted">Nome</dt>
          <dd className="text-fg">{me.name}</dd>
          <dt className="text-fg-muted">E-mail</dt>
          <dd className="break-all text-fg">{me.email}</dd>
          <dt className="text-fg-muted">Papel</dt>
          <dd className="text-fg">{ROLE_LABEL[me.role]}</dd>
        </dl>
      </Section>

      <Section title="Senha" description="Ao trocar a senha, as outras sessões são encerradas.">
        <PasswordForm email={me.email} onChanged={sessions.reload} />
      </Section>

      <Section id="duas-etapas" title="Verificação em duas etapas" description="Além da senha, um código do aplicativo autenticador do celular a cada entrada.">
        <TwoStep me={me} onChange={reload} />
      </Section>

      <Section title="Sessões ativas" description="Aparelhos com acesso à sua conta agora.">
        <MySessions {...sessions} />
      </Section>
    </Page>
  )
}

function PasswordForm({ email, onChanged }: { email: string; onChanged: () => void }) {
  const [errors, setErrors] = useState<{ current?: string; next?: string; again?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const current = String(data.get('current') ?? '')
    const next = String(data.get('next') ?? '')
    const found = { ...(current ? {} : { current: 'Digite a senha atual.' }), ...passwordProblem(next, String(data.get('again') ?? '')) }
    setErrors(found)
    setError(null)
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      await withSudo(() => post('/account/password', { current, next }))
      form.reset()
      notify('Senha alterada. As outras sessões foram encerradas.')
      onChanged()
    } catch (err) {
      if (!(err instanceof SudoCancelled) && !expired(err)) setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex max-w-[360px] flex-col gap-4" onSubmit={submit} noValidate>
      {/* Gerenciadores de senha atualizam a senha desta conta. */}
      <input hidden readOnly name="username" autoComplete="username" value={email} />
      <Field label="Senha atual" error={errors.current}>
        <Input name="current" type="password" autoComplete="current-password" maxLength={200} />
      </Field>
      <Field label="Nova senha" error={errors.next} hint={PASSWORD_HINT}>
        <Input name="next" type="password" autoComplete="new-password" maxLength={200} />
      </Field>
      <Field label="Confirme a nova senha" error={errors.again}>
        <Input name="again" type="password" autoComplete="new-password" maxLength={200} />
      </Field>
      {error && (
        <p role="alert" className="text-ui text-critical">
          {error}
        </p>
      )}
      <Button type="submit" loading={busy} className="self-start">
        Alterar senha
      </Button>
    </form>
  )
}

function MySessions({ data, error, reload }: { data?: SessionInfo[]; error?: unknown; reload: () => void }) {
  if (error) return <Problem error={error} retry={reload} />
  if (!data) return <Loading />
  if (!data.length) return <Empty title="Nenhuma sessão aberta." className="px-0" />
  const list = [...data].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)

  const end = async (s: SessionInfo) => {
    const ok = await confirm({
      title: 'Encerrar a sessão?',
      body: `Esse aparelho perde o acesso e precisa entrar de novo (${device(s.userAgent)}, IP ${s.ip}).`,
      confirm: 'Encerrar sessão',
    })
    if (ok && (await act(() => del(`/account/sessions/${s.id}`)))) {
      notify('Sessão encerrada.')
      reload()
    }
  }

  const endOthers = async () => {
    const ok = await confirm({
      title: 'Encerrar as outras sessões?',
      body: 'Todos os outros aparelhos perdem o acesso e precisam entrar de novo. Esta sessão continua aberta.',
      confirm: 'Encerrar sessões',
    })
    if (ok && (await act(() => post('/account/sessions/revoke-others')))) {
      notify('Outras sessões encerradas.')
      reload()
    }
  }

  return (
    <div className="flex flex-col items-start gap-4">
      <SessionTable sessions={list} onEnd={(s) => void end(s)} />
      <Button disabled={!list.some((s) => !s.current)} onClick={() => void endOthers()}>
        Encerrar as outras sessões
      </Button>
    </div>
  )
}
