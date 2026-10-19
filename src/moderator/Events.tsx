// Lista de eventos (/eventos): abrir, criar, equipe e conta.
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Popover as BasePopover } from '@base-ui/react/popover'
import { CaretDownIcon } from '@phosphor-icons/react/CaretDown'
import { KeyIcon } from '@phosphor-icons/react/Key'
import { PlusIcon } from '@phosphor-icons/react/Plus'
import { SignOutIcon } from '@phosphor-icons/react/SignOut'
import { TrashIcon } from '@phosphor-icons/react/Trash'
import { UsersThreeIcon } from '@phosphor-icons/react/UsersThree'
import { ApiError, api, del, post } from '../lib/api.ts'
import { BrandFooter, Button, Chip, Dialog, Empty, Field, IconButton, Input, Popover, Spinner, Tooltip, confirm, notify } from '../ui'
import { run, useModerator, type Moderator } from './context.ts'
import { Mark, count, focusInvalid, iconOnly, longDate, message } from './setup/kit.tsx'
import type { EventSummary } from '../../shared/types.ts'

export default function Events() {
  const me = useModerator()
  const navigate = useNavigate()
  const [events, setEvents] = useState<EventSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [team, setTeam] = useState(false)

  const load = useCallback(
    () =>
      api<EventSummary[]>('/events').then(
        (list) => {
          setEvents(list)
          setError(null)
        },
        (e) => (e instanceof ApiError && e.status === 401 ? navigate('/entrar', { replace: true }) : setError(message(e))),
      ),
    [navigate],
  )
  useEffect(() => {
    if (!me) return
    void load()
    // Volta para a aba: contagens e "No ar" podem ter mudado em outro console.
    const onVisible = () => document.visibilityState === 'visible' && void load()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [me, load])

  if (!me) {
    return (
      <main className="grid min-h-dvh place-items-center text-fg-subtle">
        <Spinner size={18} />
      </main>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="on-brand flex h-12 shrink-0 items-center gap-4 px-4">
        <Mark />
        <span className="h-5 w-px bg-line" aria-hidden />
        <h1 className="text-ui font-semibold">Eventos</h1>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" icon={<UsersThreeIcon />} onClick={() => setTeam(true)}>
            Equipe
          </Button>
          <Account me={me} />
        </div>
      </header>

      <main className="max-w-[1120px] px-10 pt-7 pb-24">
        {events === null ? (
          error ? (
            <Empty title="Não foi possível carregar os eventos." action={<Button onClick={() => void load()}>Tentar novamente</Button>}>
              {error}
            </Empty>
          ) : (
            <div className="px-4 py-6 text-fg-subtle">
              <Spinner />
            </div>
          )
        ) : events.length ? (
          <>
            <div className="mb-3 flex min-h-8 items-center">
              <p className="text-ui text-fg-muted tabular-nums">{count(events.length, 'Nenhum evento', 'evento', 'eventos')}</p>
              <Button variant="primary" icon={<PlusIcon />} className="ml-auto" onClick={() => setCreating(true)}>
                Novo evento
              </Button>
            </div>
            <ul className="divide-y divide-line border-y border-line">
              {events.map((e) => (
                <li key={e.id}>
                  <Link
                    to={`/eventos/${e.id}`}
                    className="state-layer grid h-12 grid-cols-[minmax(0,1fr)_10rem_10rem_13rem] items-center gap-6 px-3 text-ui focus-visible:-outline-offset-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-fg">{e.name}</span>
                      {e.live && <Chip tone="program">No ar</Chip>}
                    </span>
                    <span className="text-fg-muted tabular-nums">{count(e.participants, 'Nenhum participante', 'participante', 'participantes')}</span>
                    <span className="text-fg-muted tabular-nums">{count(e.questions, 'Nenhuma pergunta', 'pergunta', 'perguntas')}</span>
                    <span className="text-fg-subtle">Criado em {longDate.format(e.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty
            title="Nenhum evento criado."
            action={
              <Button variant="primary" icon={<PlusIcon />} onClick={() => setCreating(true)}>
                Criar evento
              </Button>
            }
          >
            Crie o primeiro evento para montar o roteiro e convidar participantes.
          </Empty>
        )}
      </main>
      <BrandFooter />

      <NewEvent open={creating} onOpenChange={setCreating} />
      <Team me={me} open={team} onOpenChange={setTeam} />
    </div>
  )
}

function NewEvent({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const form = useId()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const name = String(new FormData(el).get('name') ?? '').trim()
    if (!name) {
      setError('Informe o nome do evento.')
      return focusInvalid(el)
    }
    setBusy(true)
    try {
      const { id } = await post<{ id: string }>('/events', { name })
      navigate(`/eventos/${id}`)
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }
  const change = (o: boolean) => {
    onOpenChange(o)
    if (!o) setError(null)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title="Novo evento"
      description="O evento começa com um roteiro básico: abertura, perguntas e intervalo."
      footer={
        <>
          <Button onClick={() => change(false)}>Cancelar</Button>
          <Button type="submit" form={form} variant="primary" loading={busy}>
            Criar evento
          </Button>
        </>
      }
    >
      <form id={form} onSubmit={submit} noValidate>
        <Field label="Nome do evento" error={error}>
          <Input name="name" maxLength={120} autoComplete="off" autoFocus onChange={() => error && setError(null)} />
        </Field>
      </form>
    </Dialog>
  )
}

// ---------- conta ----------

function Account({ me }: { me: Moderator }) {
  const navigate = useNavigate()
  const [password, setPassword] = useState(false)
  const logout = async () => {
    await post('/auth/logout').catch(() => {})
    navigate('/entrar', { replace: true })
  }
  return (
    <>
      <Popover
        className="w-64"
        trigger={
          <Button variant="ghost" size="sm" aria-label={`Conta de ${me.name}`}>
            <span className="max-w-40 truncate">{me.name}</span>
            <CaretDownIcon size={12} />
          </Button>
        }
      >
        {/* -m-2 desconta o respiro do popover: as ações ocupam a largura toda, como num menu */}
        <div className="-m-2">
          <div className="px-2 pt-1.5 pb-2">
            <p className="truncate font-medium text-fg">{me.name}</p>
            <p className="truncate text-meta text-fg-subtle">{me.email}</p>
          </div>
          <div className="mx-1 mb-1 h-px bg-line" />
          <BasePopover.Close
            render={
              <Button variant="ghost" icon={<KeyIcon />} className="w-full" onClick={() => setPassword(true)}>
                <span className="flex-1 text-left">Trocar senha</span>
              </Button>
            }
          />
          <BasePopover.Close
            render={
              <Button variant="ghost" icon={<SignOutIcon />} className="w-full" onClick={logout}>
                <span className="flex-1 text-left">Sair</span>
              </Button>
            }
          />
        </div>
      </Popover>
      <PasswordDialog open={password} onOpenChange={setPassword} />
    </>
  )
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const form = useId()
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({})
  const [busy, setBusy] = useState(false)
  const change = (o: boolean) => {
    onOpenChange(o)
    if (!o) setErrors({})
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const current = String(new FormData(el).get('current') ?? '')
    const next = String(new FormData(el).get('next') ?? '')
    const found = {
      current: current ? undefined : 'Informe a senha atual.',
      next: next.length >= 8 ? undefined : 'Use pelo menos 8 caracteres.',
    }
    setErrors(found)
    if (found.current || found.next) return focusInvalid(el)
    setBusy(true)
    try {
      await post('/auth/password', { current, next })
      notify('Senha alterada.', { description: 'As outras sessões desta conta foram encerradas.' })
      change(false)
    } catch (err) {
      setErrors({ current: message(err) })
    }
    setBusy(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title="Trocar senha"
      width={400}
      footer={
        <>
          <Button onClick={() => change(false)}>Cancelar</Button>
          <Button type="submit" form={form} variant="primary" loading={busy}>
            Trocar senha
          </Button>
        </>
      }
    >
      <form id={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Senha atual" error={errors.current}>
          <Input name="current" type="password" autoComplete="current-password" maxLength={200} autoFocus />
        </Field>
        <Field label="Nova senha" error={errors.next} hint="Pelo menos 8 caracteres. As outras sessões desta conta são encerradas.">
          <Input name="next" type="password" autoComplete="new-password" maxLength={200} />
        </Field>
      </form>
    </Dialog>
  )
}

// ---------- equipe ----------

interface Member {
  id: string
  name: string
  email: string
}

function Team({ me, open, onOpenChange }: { me: Moderator; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () =>
      api<Member[]>('/moderators').then(
        (list) => {
          setMembers(list)
          setError(null)
        },
        (e) => setError(message(e)),
      ),
    [],
  )
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const remove = async (m: Member) => {
    const ok = await confirm({
      title: `Remover ${m.name} da equipe?`,
      body: 'A conta é excluída e deixa de entrar no console. Os eventos não são afetados.',
      confirm: 'Remover da equipe',
    })
    if (ok && (await run(() => del(`/moderators/${m.id}`)))) {
      notify('Conta removida da equipe.', { description: m.email })
      void load()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Equipe"
      description="Todas as pessoas da equipe acessam todos os eventos deste servidor."
      width={560}
    >
      {members === null ? (
        error ? (
          <p className="text-ui text-critical">{error}</p>
        ) : (
          <div className="py-3 text-fg-subtle">
            <Spinner />
          </div>
        )
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {members.map((m) => (
            <li key={m.id} className="flex min-h-12 items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-ui text-fg">
                  <span className="truncate">{m.name}</span>
                  {m.id === me.id && <Chip>Você</Chip>}
                </p>
                <p className="truncate text-meta text-fg-subtle">{m.email}</p>
              </div>
              {m.id !== me.id && (
                <Tooltip label="Remover da equipe">
                  <IconButton size="sm" className={iconOnly} label={`Remover ${m.name} da equipe`} icon={<TrashIcon />} onClick={() => remove(m)} />
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      <AddMember onAdded={load} />
    </Dialog>
  )
}

function AddMember({ onAdded }: { onAdded: () => void }) {
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const data = Object.fromEntries(new FormData(el)) as { name: string; email: string; password: string }
    const found = {
      name: data.name.trim() ? undefined : 'Informe o nome.',
      email: data.email.trim() ? undefined : 'Informe o e-mail.',
      password: data.password.length >= 8 ? undefined : 'Use pelo menos 8 caracteres.',
    }
    setErrors(found)
    setError(null)
    if (found.name || found.email || found.password) return focusInvalid(el)
    setBusy(true)
    try {
      await post('/moderators', data)
      el.reset()
      notify(`Conta criada para ${data.name.trim()}.`, { description: 'Envie o e-mail e a senha para a pessoa por um canal seguro.' })
      onAdded()
    } catch (err) {
      setError(message(err))
    }
    setBusy(false)
  }
  return (
    <form onSubmit={submit} noValidate className="mt-5">
      <h3 className="text-ui font-semibold">Adicionar pessoa</h3>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4">
        <Field label="Nome" error={errors.name} className="col-span-2">
          <Input name="name" autoComplete="off" maxLength={120} />
        </Field>
        <Field label="E-mail" error={errors.email}>
          <Input name="email" type="email" autoComplete="off" maxLength={200} />
        </Field>
        <Field label="Senha" error={errors.password} hint="Pelo menos 8 caracteres.">
          <Input name="password" type="password" autoComplete="new-password" maxLength={200} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-ui text-critical">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <Button type="submit" loading={busy}>
          Adicionar à equipe
        </Button>
      </div>
    </form>
  )
}
