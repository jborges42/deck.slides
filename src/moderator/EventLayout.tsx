// Moldura do evento no console: barra superior (navegação, chaves de interação, presença, conexão).
import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router'
import { ArrowSquareOutIcon } from '@phosphor-icons/react/ArrowSquareOut'
import { CaretRightIcon } from '@phosphor-icons/react/CaretRight'
import { MonitorPlayIcon } from '@phosphor-icons/react/MonitorPlay'
import { del, patch, post } from '../lib/api.ts'
import { ago } from '../lib/format.ts'
import { useNow, useStream } from '../lib/stream.ts'
import { BrandFooter, BrandIcon, Button, Chip, Dialog, Dot, Field, Input, Popover, Spinner, Switch, Tooltip, buttonClass, confirm, cx, notify } from '../ui'
import { eventLinks, run, useModerator, type EventContext } from './context.ts'
import type { ModeratorSnapshot, ScreenInfo } from '../../shared/types.ts'

const NAV = [
  { to: '', label: 'Ao vivo', end: true },
  { to: 'participantes', label: 'Participantes' },
  { to: 'aparencia', label: 'Aparência' },
  { to: 'midia', label: 'Mídia' },
  { to: 'ajustes', label: 'Ajustes' },
]

export default function EventLayout() {
  const { id = '' } = useParams()
  const me = useModerator()
  const navigate = useNavigate()
  const stream = useStream<ModeratorSnapshot>(me ? `/api/events/${id}/stream` : null)
  const snap = stream.state

  useEffect(() => {
    if (stream.status === 'denied' || stream.status === 'gone') navigate('/eventos', { replace: true })
  }, [stream.status, navigate])

  const ctx = useMemo<EventContext | null>(
    () => snap && { id, snap, counts: stream.counts, offset: stream.offset, links: eventLinks(snap) },
    [id, snap, stream.counts, stream.offset],
  )

  if (!ctx) {
    return (
      <main className="grid min-h-dvh place-items-center text-fg-subtle">
        <Spinner size={18} />
      </main>
    )
  }

  const { event } = ctx.snap
  const setting = (key: 'questionsOpen' | 'reactionsOpen', value: boolean) =>
    run(() => patch(`/events/${id}`, { settings: { [key]: value } }))

  return (
    <div className="flex h-dvh min-w-[1100px] flex-col">
      <header className="on-brand flex h-12 shrink-0 items-center gap-5 px-4">
        <div className="flex min-w-0 items-center gap-1.5 text-ui">
          <Link to="/eventos" className="flex items-center gap-2 text-fg-subtle hover:text-fg">
            <BrandIcon size={22} negative />
            Eventos
          </Link>
          <CaretRightIcon size={12} className="text-fg-subtle" />
          <span className="truncate font-semibold text-fg">{event.name}</span>
        </div>

        <nav className="flex h-full items-stretch gap-4" aria-label="Seções do evento">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx(
                  'relative flex items-center text-ui font-medium whitespace-nowrap transition-colors duration-100',
                  isActive ? 'text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg' : 'text-fg-subtle hover:text-fg-muted',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-5">
          <div className="flex items-center gap-4">
            {/* Rótulos fixos e curtos (a barra cabe em 1440 px); o estado está no interruptor e na dica. */}
            <Tooltip label={event.settings.questionsOpen ? 'Envio de perguntas aberto' : 'Envio de perguntas fechado'}>
              <span>
                <Switch
                  label="Envio de perguntas"
                  checked={event.settings.questionsOpen}
                  onChange={(v) => setting('questionsOpen', v)}
                  className="items-center gap-2.5 whitespace-nowrap"
                />
              </span>
            </Tooltip>
            <Tooltip label={event.settings.reactionsOpen ? 'Reações liberadas' : 'Reações pausadas'}>
              <span>
                <Switch
                  label="Reações"
                  checked={event.settings.reactionsOpen}
                  onChange={(v) => setting('reactionsOpen', v)}
                  className="items-center gap-2.5 whitespace-nowrap"
                />
              </span>
            </Tooltip>
          </div>
          <span className="h-5 w-px bg-line" aria-hidden />
          <Presence ctx={ctx} />
          <Connection status={stream.status} />
          <Clock offset={stream.offset} />
          <Tooltip label="Abrir a tela do evento neste computador">
            <a href={ctx.links.screen} target="_blank" rel="noopener" className={buttonClass('secondary', 'sm')}>
              Abrir tela
              <ArrowSquareOutIcon size={14} />
            </a>
          </Tooltip>
        </div>
      </header>
      <OfficialAddress publicUrl={ctx.snap.publicUrl} />
      <main className="min-h-0 flex-1">
        <Outlet context={ctx} />
      </main>
      <BrandFooter />
    </div>
  )
}

/**
 * Console aberto fora do endereço público (PUBLIC_URL ou, na Vercel, o domínio de produção). Na Vercel, o endereço
 * de cada deploy fica preso àquela versão e pede login: o histórico do navegador leva a ele sem ninguém perceber.
 */
function OfficialAddress({ publicUrl }: { publicUrl: string | null }) {
  if (!publicUrl || publicUrl === location.origin) return null
  const host = publicUrl.replace(/^https?:\/\//, '')
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 bg-attention px-4 py-2 text-ui text-on-signal">
      <span>Este endereço não é o do evento e pode estar numa versão antiga. Use {host}.</span>
      <a href={publicUrl + location.pathname} className="font-semibold underline underline-offset-2">
        Abrir em {host}
      </a>
    </div>
  )
}

function Presence({ ctx }: { ctx: EventContext }) {
  const { presence, screens } = ctx.snap
  const [pairing, setPairing] = useState(false)
  const count = presence.screens
  return (
    <>
      <Popover
        trigger={
          <button className="state-layer flex h-7 items-center gap-2 rounded-control px-2 text-ui text-fg-muted">
            {count ? (
              <span className="flex items-center gap-1.5">
                <Dot tone="neutral" />
                {count === 1 ? 'Tela conectada' : `${count} telas`}
              </span>
            ) : (
              <Chip tone="attention">Nenhuma tela</Chip>
            )}
            <span className="tabular-nums">{presence.participants.toLocaleString('pt-BR')} online</span>
          </button>
        }
        className="w-80"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-ui font-semibold">Telas</h3>
          <Button size="sm" icon={<MonitorPlayIcon />} onClick={() => setPairing(true)}>
            Conectar tela
          </Button>
        </div>
        {screens.length ? (
          <ul className="mt-2 divide-y divide-line">
            {screens.map((s) => (
              <ScreenRow key={s.id} screen={s} eventId={ctx.id} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-meta text-fg-subtle">
            No computador da projeção, abra <span className="font-code text-fg-muted">{ctx.links.pair.replace(/^https?:\/\//, '')}</span> e
            digite aqui o código exibido.
          </p>
        )}
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-line pt-3 text-ui">
          <dt className="text-fg-muted">Telas abertas agora</dt>
          <dd className="text-right tabular-nums">{count}</dd>
          <dt className="text-fg-muted">Participantes online</dt>
          <dd className="text-right tabular-nums">{presence.participants}</dd>
          <dt className="text-fg-muted">Moderação conectada</dt>
          <dd className="text-right tabular-nums">{presence.moderators}</dd>
        </dl>
      </Popover>
      <PairDialog open={pairing} onOpenChange={setPairing} ctx={ctx} />
    </>
  )
}

function ScreenRow({ screen, eventId }: { screen: ScreenInfo; eventId: string }) {
  const disconnect = async () => {
    const ok = await confirm({
      title: `Desconectar “${screen.name}”?`,
      body: 'O computador da projeção deixa de exibir o evento e volta a mostrar um código de pareamento.',
      confirm: 'Desconectar tela',
    })
    if (ok) await run(() => del(`/events/${eventId}/screens/${screen.id}`))
  }
  return (
    <li className="flex items-center gap-2 py-2">
      <Dot tone={screen.online ? 'neutral' : 'off'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-fg">{screen.name}</span>
        <span className="block text-meta text-fg-subtle">
          {screen.online ? 'Conectada' : screen.lastSeen ? `Vista ${ago(screen.lastSeen)}` : 'Ainda não conectou'}
        </span>
      </span>
      <Button size="sm" variant="ghost" onClick={disconnect}>
        Desconectar
      </Button>
    </li>
  )
}

/** Pareamento: o computador da projeção mostra um código em /tela; aqui a moderação digita esse código. */
function PairDialog({ open, onOpenChange, ctx }: { open: boolean; onOpenChange: (o: boolean) => void; ctx: EventContext }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setCode(''), setName(''), setError(null)
  }, [open])
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await post(`/events/${ctx.id}/screens`, { code, name: name.trim() || undefined })
      notify('Tela conectada.')
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível conectar a tela.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Conectar tela"
      description={
        <>
          No computador da projeção, abra <span className="font-code text-fg">{ctx.links.pair.replace(/^https?:\/\//, '')}</span>. Digite o código
          que aparece nela.
        </>
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={code.replace(/[\s-]/g, '').length < 6} onClick={submit}>
            Conectar tela
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.replace(/[\s-]/g, '').length >= 6) void submit()
        }}
      >
        <Field label="Código da tela" error={error}>
          <Input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 9))}
            placeholder="K7Q X2M"
            autoComplete="off"
            spellCheck={false}
            className="font-code text-read tracking-[0.2em] uppercase"
          />
        </Field>
        <Field label="Nome da tela" hint="Opcional. Ajuda a identificar quando há mais de uma.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Telão principal" maxLength={60} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function Connection({ status }: { status: string }) {
  // Só aparece quando há problema: conexão saudável não disputa atenção.
  const [since, setSince] = useState<number | null>(null)
  const now = useNow(1000)
  useEffect(() => setSince(status === 'reconnecting' ? Date.now() : null), [status])
  if (status === 'live' || since === null || now - since < 3000) return null
  return <Chip tone="attention">Sem conexão há {Math.round((now - since) / 1000)} s. Reconectando…</Chip>
}

function Clock({ offset }: { offset: number }) {
  const now = useNow(1000)
  return (
    <span className="text-ui text-fg-muted tabular-nums" aria-label="Horário do servidor">
      {new Date(now + offset).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </span>
  )
}
