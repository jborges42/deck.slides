// Administração › Sessões: todas as sessões abertas, ou só as de uma pessoa (?pessoa=<id>).
import { useSearchParams } from 'react-router'
import { del } from '../lib/api.ts'
import { Empty, Select, confirm, notify } from '../ui'
import { count } from '../moderator/setup/kit.tsx'
import { act } from '../moderator/auth/sudo.tsx'
import { Loading, Problem, SessionTable, useLoad } from './kit.tsx'
import { device } from './text.ts'
import type { SessionInfo, StaffUser } from '../../shared/admin.ts'

export default function Sessions() {
  const [params, setParams] = useSearchParams()
  const person = params.get('pessoa') ?? 'all'
  const users = useLoad<StaffUser[]>('/admin/users')
  const sessions = useLoad<SessionInfo[]>(`/admin/sessions${person === 'all' ? '' : `?${new URLSearchParams({ userId: person })}`}`)

  const error = sessions.error ?? users.error
  if (error)
    return (
      <Problem
        error={error}
        retry={() => {
          users.reload()
          sessions.reload()
        }}
      />
    )
  if (!sessions.data || !users.data) return <Loading />

  const byId = new Map(users.data.map((u) => [u.id, u.name]))
  const name = (id: string) => byId.get(id) ?? 'Conta não encontrada'
  const list = [...sessions.data].sort((a, b) => b.lastSeenAt - a.lastSeenAt)

  const end = async (s: SessionInfo) => {
    const ok = await confirm({
      title: 'Encerrar a sessão?',
      body: `${name(s.userId)} sai desta sessão (${device(s.userAgent)}, IP ${s.ip}) e precisa entrar de novo nesse aparelho.`,
      confirm: 'Encerrar sessão',
    })
    if (ok && (await act(() => del(`/admin/sessions/${s.id}`)))) {
      notify('Sessão encerrada.', { description: name(s.userId) })
      sessions.reload()
    }
  }

  return (
    <>
      <div className="mb-3 flex min-h-8 items-center gap-4">
        <p className="text-ui text-fg-muted tabular-nums">{count(list.length, 'Nenhuma sessão aberta', 'sessão aberta', 'sessões abertas')}</p>
        <Select
          className="ml-auto w-64"
          label="Filtrar por pessoa"
          value={person}
          onChange={(v) => setParams(v === 'all' ? {} : { pessoa: v })}
          options={[{ value: 'all', label: 'Todas as pessoas' }, ...users.data.map((u) => ({ value: u.id, label: u.name }))]}
        />
      </div>
      {list.length ? (
        <SessionTable sessions={list} personName={name} onEnd={end} />
      ) : (
        <Empty title="Nenhuma sessão aberta.">
          {person === 'all'
            ? 'As sessões aparecem aqui quando alguém entra no console.'
            : `${name(person)} não está com o console aberto em nenhum aparelho.`}
        </Empty>
      )}
    </>
  )
}
