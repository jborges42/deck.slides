// Administração › Auditoria: registro de ações sensíveis, do mais novo para o mais antigo, em páginas de 50.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import { Button, Empty, Select, notify } from '../ui'
import { message } from '../moderator/setup/kit.tsx'
import { expired } from '../moderator/auth/sudo.tsx'
import { Loading, Problem, useLoad } from './kit.tsx'
import { auditText, detailPairs } from './text.ts'
import type { AuditEntry, StaffUser } from '../../shared/admin.ts'

const PAGE = 50

// `action` vai como o grupo (o prefixo antes do ponto): "auth" pega auth.login, auth.logout…
const GROUPS = [
  { value: 'all', label: 'Todas as ações' },
  { value: 'auth', label: 'Entrada e conta' },
  { value: 'session', label: 'Sessões' },
  { value: 'admin', label: 'Administração' },
  { value: 'event', label: 'Eventos' },
  { value: 'screen', label: 'Telas' },
  { value: 'participant', label: 'Participantes' },
]

const TARGET: Record<string, string> = { event: 'Evento', session: 'Sessão', screen: 'Tela', participant: 'Participante', settings: 'Configurações' }

const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
const hour = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export default function Audit() {
  const users = useLoad<StaffUser[]>('/admin/users')
  const [group, setGroup] = useState('all')
  const [actor, setActor] = useState('all')
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  const path = (before?: number) => {
    const q = new URLSearchParams({ limit: String(PAGE) })
    if (before !== undefined) q.set('before', String(before)) // cursor: id da última linha mostrada
    if (group !== 'all') q.set('action', group)
    if (actor !== 'all') q.set('actorId', actor)
    return `/admin/audit?${q}`
  }

  useEffect(() => {
    let live = true
    setEntries(null)
    setError(null)
    api<AuditEntry[]>(path()).then(
      (list) => live && (setEntries(list), setMore(list.length === PAGE)),
      (e) => live && !expired(e) && setError(e),
    )
    return () => {
      live = false
    }
  }, [group, actor, tick]) // path() só depende de group e actor

  const loadMore = async () => {
    const last = entries?.at(-1)
    if (!last) return
    setBusy(true)
    try {
      const list = await api<AuditEntry[]>(path(last.id))
      setEntries((all) => [...(all ?? []), ...list])
      setMore(list.length === PAGE)
    } catch (e) {
      if (!expired(e)) notify(message(e), { tone: 'critical' })
    } finally {
      setBusy(false)
    }
  }

  const failure = error ?? users.error
  if (failure) return <Problem error={failure} retry={() => (users.reload(), setTick((t) => t + 1))} />
  if (!users.data) return <Loading />

  const byId = new Map(users.data.map((u) => [u.id, u.name]))
  const who = (e: AuditEntry) => (e.actorId && byId.get(e.actorId)) || e.actorEmail || 'Sem conta'
  const target = (e: AuditEntry) =>
    !e.targetType
      ? ''
      : e.targetType === 'user'
        ? (e.targetId && byId.get(e.targetId)) || e.targetId || 'Conta'
        : `${TARGET[e.targetType] ?? e.targetType}${e.targetType === 'event' && e.targetId ? ` ${e.targetId}` : ''}`

  return (
    <>
      <div className="mb-3 flex min-h-8 items-center gap-3">
        <Select className="w-56" label="Filtrar por tipo de ação" value={group} onChange={setGroup} options={GROUPS} disabled={busy} />
        <Select
          className="w-64"
          label="Filtrar por pessoa"
          value={actor}
          onChange={setActor}
          disabled={busy}
          options={[{ value: 'all', label: 'Todas as pessoas' }, ...users.data.map((u) => ({ value: u.id, label: u.name }))]}
        />
      </div>
      {entries === null ? (
        <Loading />
      ) : entries.length ? (
        <>
          <table className="w-full table-fixed border-separate border-spacing-0 text-ui">
            <colgroup>
              <col className="w-44" />
              <col className="w-[20%]" />
              <col />
              <col className="w-[16%]" />
              <col className="w-36" />
            </colgroup>
            <thead>
              <tr className="text-left text-meta text-fg-subtle">
                {['Quando', 'Quem', 'O que', 'Alvo', 'IP'].map((h) => (
                  <th key={h} className="h-8 border-b border-line pr-4 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const pairs = detailPairs(e)
                return (
                  <tr key={e.id} className="align-top *:border-b *:border-line *:py-2">
                    <td className="pr-4 whitespace-nowrap tabular-nums">
                      <time dateTime={new Date(e.at).toISOString()}>
                        {day.format(e.at)} <span className="text-fg-muted">{hour.format(e.at)}</span>
                      </time>
                    </td>
                    <td className="truncate pr-4 text-fg-muted" title={e.actorEmail ?? undefined}>
                      {who(e)}
                    </td>
                    <td className="pr-4">
                      <span className="text-fg">{auditText(e)}</span>
                      {pairs.length > 0 && (
                        <dl className="mt-0.5 flex flex-wrap gap-x-3 text-meta text-fg-subtle">
                          {pairs.map(([k, v]) => (
                            <div key={k} className="flex gap-1">
                              <dt>{k}:</dt>
                              <dd className="break-all text-fg-muted">{v}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </td>
                    <td className="truncate pr-4 text-fg-muted">{target(e)}</td>
                    <td className="truncate pr-4 text-fg-muted tabular-nums">{e.ip}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {more && (
            <Button className="mt-4" loading={busy} onClick={() => void loadMore()}>
              Carregar mais
            </Button>
          )}
        </>
      ) : (
        <Empty title="Nenhum registro.">
          {group === 'all' && actor === 'all'
            ? 'As ações de segurança e de administração aparecem aqui assim que acontecem.'
            : 'Nenhum registro com estes filtros. Mude o tipo de ação ou a pessoa.'}
        </Empty>
      )}
    </>
  )
}
