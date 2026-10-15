// Peças das páginas da equipe (/admin, /conta): seção, carregamento, avisos de acesso, tabela de sessões
// e o link de uso único.
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { CopyIcon } from '@phosphor-icons/react/Copy'
import { api, ApiError } from '../lib/api.ts'
import { ago } from '../lib/format.ts'
import { Button, Chip, Dialog, Empty, Field, Input, Spinner, buttonClass } from '../ui'
import { copy, message } from '../moderator/setup/kit.tsx'
import { expired } from '../moderator/auth/sudo.tsx'
import { device } from './text.ts'
import type { SessionInfo } from '../../shared/admin.ts'

/** Bloco de configuração: título e explicação à esquerda, conteúdo à direita. */
export function Section({ title, description, id, children }: { title: string; description?: ReactNode; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="grid scroll-mt-6 gap-x-10 gap-y-3 border-t border-line py-6 first:border-t-0 first:pt-0 md:grid-cols-[240px_minmax(0,1fr)]">
      <div>
        <h2 className="text-ui font-semibold text-fg">{title}</h2>
        {description && <p className="mt-1 text-ui text-fg-subtle">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

/** GET com recarga; ignora respostas atrasadas quando `path` muda. Sessão vencida leva para /entrar. */
export function useLoad<T>(path: string) {
  const [state, setState] = useState<{ data?: T; error?: unknown }>({})
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    api<T>(path).then(
      (data) => live && setState({ data }),
      (error) => live && !expired(error) && setState((s) => ({ ...s, error })),
    )
    return () => {
      live = false
    }
  }, [path, tick])
  return { ...state, reload: () => setTick((t) => t + 1) }
}

export const Loading = () => (
  <div className="px-4 py-6 text-fg-subtle">
    <Spinner />
  </div>
)

/** Administração para quem ainda não ativou as duas etapas (o servidor responde mfa_setup_required). */
export function MfaGate() {
  return (
    <Empty
      title="A administração exige a verificação em duas etapas."
      action={
        <Link to="/conta#duas-etapas" className={buttonClass('primary', 'md')}>
          Ir para Minha conta
        </Link>
      }
    >
      Ative a verificação em Minha conta. Depois disso, a administração fica disponível aqui.
    </Empty>
  )
}

export function Forbidden() {
  return (
    <Empty title="Esta área é só para a administração geral." action={<Link to="/eventos" className={buttonClass('secondary', 'md')}>Ir para os eventos</Link>}>
      Se você precisa deste acesso, fale com quem administra o deck.slides.
    </Empty>
  )
}

/** Erro ao carregar: duas etapas pendentes, sem permissão ou falha comum (com nova tentativa). */
export function Problem({ error, retry }: { error: unknown; retry?: () => void }) {
  if (error instanceof ApiError && error.code === 'mfa_setup_required') return <MfaGate />
  if (error instanceof ApiError && error.status === 403) return <Forbidden />
  return (
    <Empty title="Não foi possível carregar." action={retry && <Button onClick={retry}>Tentar novamente</Button>}>
      {message(error)}
    </Empty>
  )
}

const fullDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' })
/** Data completa para a dica (title) de horários relativos. */
export const exact = (ts: number) => fullDate.format(ts)

/** Sessões abertas. Com `personName`, mostra a coluna Pessoa (visão da administração). */
export function SessionTable({
  sessions,
  personName,
  onEnd,
}: {
  sessions: SessionInfo[]
  personName?: (userId: string) => string
  onEnd: (s: SessionInfo) => void
}) {
  const head = [...(personName ? ['Pessoa'] : []), 'Aparelho', 'IP', 'Início', 'Último uso']
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-ui">
      <colgroup>
        {personName && <col className="w-[22%]" />}
        <col />
        <col className="w-36" />
        <col className="w-28" />
        <col className="w-28" />
        <col className="w-24" />
      </colgroup>
      <thead>
        <tr className="text-left text-meta text-fg-subtle">
          {head.map((h) => (
            <th key={h} className="h-8 border-b border-line pr-4 font-medium">
              {h}
            </th>
          ))}
          <th className="border-b border-line">
            <span className="sr-only">Ações</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id} className="h-10 *:border-b *:border-line">
            {personName && <td className="truncate pr-4 text-fg">{personName(s.userId)}</td>}
            <td className="pr-4">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-fg" title={s.userAgent}>
                  {device(s.userAgent)}
                </span>
                {s.current && <Chip tone="outline">Esta sessão</Chip>}
              </span>
            </td>
            <td className="truncate pr-4 text-fg-muted tabular-nums">{s.ip}</td>
            <td className="pr-4 text-fg-muted" title={exact(s.createdAt)}>
              {ago(s.createdAt)}
            </td>
            <td className="pr-4 text-fg-muted" title={exact(s.lastSeenAt)}>
              {ago(s.lastSeenAt)}
            </td>
            <td className="text-right">
              {/* A sessão atual termina por "Sair", no menu da conta. */}
              {!s.current && (
                <Button size="sm" variant="ghost" onClick={() => onEnd(s)}>
                  Encerrar
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Link de uso único (definir senha): exibido uma vez, com "Copiar link". */
export function LinkDialog({ link, title, children, onClose }: { link: string | null; title: string; children: ReactNode; onClose: () => void }) {
  // O servidor pode mandar o caminho ou a URL completa.
  const url = link && new URL(link, location.origin).href
  return (
    <Dialog
      open={!!url}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={children}
      footer={
        <Button variant="primary" onClick={onClose}>
          Concluir
        </Button>
      }
    >
      <Field label="Link de acesso">
        <div className="flex gap-2">
          <Input readOnly value={url ?? ''} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
          <Button icon={<CopyIcon />} onClick={() => url && void copy(url)}>
            Copiar link
          </Button>
        </div>
      </Field>
    </Dialog>
  )
}
