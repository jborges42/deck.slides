// Participantes (/eventos/:id/participantes): convites, situação de cada pessoa, importação e exportação da lista.
import { memo, useCallback, useId, useMemo, useState, type FormEvent } from 'react'
import { ArrowsClockwiseIcon } from '@phosphor-icons/react/ArrowsClockwise'
import { CopyIcon } from '@phosphor-icons/react/Copy'
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree'
import { DownloadSimpleIcon } from '@phosphor-icons/react/DownloadSimple'
import { LockSimpleOpenIcon } from '@phosphor-icons/react/LockSimpleOpen'
import { MagnifyingGlassIcon } from '@phosphor-icons/react/MagnifyingGlass'
import { PencilSimpleIcon } from '@phosphor-icons/react/PencilSimple'
import { ProhibitIcon } from '@phosphor-icons/react/Prohibit'
import { TrashIcon } from '@phosphor-icons/react/Trash'
import { UploadSimpleIcon } from '@phosphor-icons/react/UploadSimple'
import { UserPlusIcon } from '@phosphor-icons/react/UserPlus'
import { del, patch, post } from '../lib/api.ts'
import { plural } from '../lib/format.ts'
import {
  Button,
  Chip,
  Dialog,
  Dot,
  Empty,
  Field,
  IconButton,
  Input,
  Menu,
  Tooltip,
  confirm,
  cx,
  inputClass,
  notify,
  undoable,
  type MenuItem,
} from '../ui'
import { run, useEvent } from './context.ts'
import { ImportDialog } from './setup/ImportDialog.tsx'
import { EMAIL, toCSV, toTSV } from './setup/csv.ts'
import { Page, Stat, copy, download, focusInvalid, iconOnly, when } from './setup/kit.tsx'
import { normalize, type Participant } from '../../shared/types.ts'

const situation = (p: Participant) => (p.blocked ? 'Bloqueado' : p.online ? 'Online' : p.joinedAt ? 'Entrou' : 'Convidado')

export default function Participants() {
  const { id, snap, links } = useEvent()
  const people = snap.participants
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState<{ open: boolean; person: Participant | null; n: number }>({ open: false, person: null, n: 0 })
  const openForm = useCallback((person: Participant | null) => setForm((f) => ({ open: true, person, n: f.n + 1 })), [])

  // Prefixo estável entre snapshots (links.invite muda a cada um): mantém as linhas memorizadas.
  const inviteBase = links.invite('')
  const haystack = useMemo(() => people.map((p) => normalize(`${p.name} ${p.email} ${p.group}`)), [people])
  const q = normalize(query)
  const shown = q ? people.filter((_, i) => haystack[i].includes(q)) : people
  const usable = people.filter((p) => !p.blocked)

  const exportCsv = () => {
    const rows = people.map((p) => [p.name, p.email, p.group, inviteBase + p.token, situation(p)])
    const slug = normalize(snap.event.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    download(`participantes-${slug || id}.csv`, toCSV([['Nome', 'E-mail', 'Grupo', 'Link do convite', 'Situação'], ...rows]))
  }
  const copyAll = () =>
    copy(toTSV([['Nome', 'Link'], ...usable.map((p) => [p.name, inviteBase + p.token])]), `${plural(usable.length, 'link copiado', 'links copiados')}.`)

  const add = (
    <Button icon={<UserPlusIcon />} onClick={() => openForm(null)}>
      Adicionar participante
    </Button>
  )
  const importButton = (primary?: boolean) => (
    <Button variant={primary ? 'primary' : 'secondary'} icon={<UploadSimpleIcon />} onClick={() => setImporting(true)}>
      Importar lista
    </Button>
  )

  return (
    <Page
      title="Participantes"
      meta={
        people.length > 0 && (
          <dl className="flex items-center gap-5 text-ui">
            <Stat label="Convidados" value={people.filter((p) => p.source === 'invite').length} />
            <Stat label="Entraram" value={people.filter((p) => p.joinedAt).length} />
            <Stat label="Online agora" value={people.filter((p) => p.online).length} />
          </dl>
        )
      }
    >
      {snap.event.settings.openJoin && (
        <div className="mb-5 flex items-center gap-3 border-y border-line py-2.5 text-ui">
          <span className="font-medium text-fg">Entrada aberta</span>
          <span className="min-w-0 truncate text-fg-muted">{links.join}</span>
          <Button size="sm" variant="ghost" icon={<CopyIcon />} onClick={() => copy(links.join)}>
            Copiar link
          </Button>
          <span className="ml-auto shrink-0 text-meta text-fg-subtle">Quem usa este link informa o nome e o PIN do evento.</span>
        </div>
      )}

      {people.length === 0 ? (
        <Empty
          title="Nenhum participante cadastrado."
          action={
            <div className="flex gap-2">
              {importButton(true)}
              {add}
            </div>
          }
        >
          Importe uma lista ou adicione participantes um a um.
        </Empty>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            <div className="relative w-80">
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle" />
              <input
                type="search"
                aria-label="Buscar participantes"
                placeholder="Buscar por nome, e-mail ou grupo"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={cx(inputClass, 'h-8 pl-8 text-ui [&::-webkit-search-cancel-button]:appearance-none')}
              />
            </div>
            {q && (
              <span className="text-ui text-fg-subtle tabular-nums">
                {shown.length.toLocaleString('pt-BR')} de {people.length.toLocaleString('pt-BR')}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" icon={<CopyIcon />} disabled={!usable.length} onClick={copyAll}>
                Copiar todos os links
              </Button>
              <Button variant="ghost" icon={<DownloadSimpleIcon />} onClick={exportCsv}>
                Exportar CSV
              </Button>
              {importButton()}
              {add}
            </div>
          </div>

          {shown.length ? (
            <table className="w-full table-fixed border-separate border-spacing-0 text-ui">
              <colgroup>
                <col />
                <col className="w-[26%]" />
                <col className="w-36" />
                <col className="w-40" />
                <col className="w-12" />
                <col className="w-10" />
              </colgroup>
              <thead>
                <tr className="text-left text-meta text-fg-subtle">
                  {['Nome', 'E-mail', 'Grupo', 'Situação', 'Link'].map((h) => (
                    <th key={h} className="sticky top-0 z-10 h-8 border-b border-line bg-canvas pr-4 font-medium">
                      {h}
                    </th>
                  ))}
                  <th className="sticky top-0 z-10 border-b border-line bg-canvas">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <Row key={p.id} p={p} eventId={id} inviteBase={inviteBase} onEdit={openForm} />
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              title="Nenhum participante encontrado."
              action={
                <Button variant="ghost" onClick={() => setQuery('')}>
                  Limpar busca
                </Button>
              }
            >
              Nada corresponde a “{query.trim()}”. A busca procura no nome, no e-mail e no grupo.
            </Empty>
          )}
        </>
      )}

      <PersonDialog
        key={form.n}
        open={form.open}
        onOpenChange={(open) => setForm((f) => ({ ...f, open }))}
        person={form.person}
        eventId={id}
        people={people}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} eventId={id} participants={people} />
    </Page>
  )
}

interface RowProps {
  p: Participant
  eventId: string
  inviteBase: string
  onEdit: (p: Participant) => void
}

// Memorizada: o snapshot chega a cada mudança do evento e a lista pode ter centenas de linhas.
const Row = memo(
  function Row({ p, eventId, inviteBase, onEdit }: RowProps) {
    const link = inviteBase + p.token
    const path = `/events/${eventId}/participants/${p.id}`

    const setBlocked = async (blocked: boolean) => {
      if (!(await run(() => patch(path, { blocked })))) return
      undoable(blocked ? 'Acesso bloqueado' : 'Acesso liberado', () => run(() => patch(path, { blocked: !blocked })))
    }
    const renew = async () => {
      const ok = await confirm({
        title: 'Gerar um novo link?',
        body: 'O link atual deixa de funcionar e a sessão aberta é encerrada.',
        confirm: 'Gerar novo link',
      })
      if (ok && (await run(() => post(`${path}/link`)))) notify('Novo link gerado.', { description: `Envie o link novo para ${p.name}.` })
    }
    const remove = async () => {
      const ok = await confirm({
        title: `Remover ${p.name}?`,
        body: 'O link do convite deixa de funcionar e a sessão aberta é encerrada. As perguntas enviadas continuam na moderação.',
        confirm: 'Remover participante',
      })
      if (ok && (await run(() => del(path)))) notify('Cadastro removido.', { description: p.name })
    }

    const items: MenuItem[] = [
      { label: 'Copiar link', icon: <CopyIcon />, disabled: p.blocked, onSelect: () => copy(link) },
      { label: 'Editar', icon: <PencilSimpleIcon />, onSelect: () => onEdit(p) },
      p.blocked
        ? { label: 'Liberar acesso', icon: <LockSimpleOpenIcon />, onSelect: () => setBlocked(false) }
        : { label: 'Bloquear acesso', icon: <ProhibitIcon />, onSelect: () => setBlocked(true) },
      { label: 'Gerar novo link', icon: <ArrowsClockwiseIcon />, onSelect: renew },
      'separator',
      { label: 'Remover', icon: <TrashIcon />, danger: true, onSelect: remove },
    ]

    return (
      <tr className="h-10 *:border-b *:border-line">
        <td className="pr-4">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-fg" title={p.name}>
              {p.name}
            </span>
            {p.source === 'open' && <Chip tone="outline">Entrada aberta</Chip>}
          </span>
        </td>
        <td className="truncate pr-4 text-fg-muted" title={p.email || undefined}>
          {p.email}
        </td>
        <td className="truncate pr-4 text-fg-muted" title={p.group || undefined}>
          {p.group}
        </td>
        <td className="pr-4">
          <Situation p={p} />
        </td>
        <td>
          <Tooltip label="Copiar link do convite">
            <IconButton size="sm" className={iconOnly} label={`Copiar link do convite de ${p.name}`} icon={<CopyIcon />} disabled={p.blocked} onClick={() => copy(link)} />
          </Tooltip>
        </td>
        <td className="text-right">
          <Menu trigger={<IconButton size="sm" className={iconOnly} label={`Ações para ${p.name}`} icon={<DotsThreeIcon />} />} items={items} />
        </td>
      </tr>
    )
  },
  (a, b) => a.eventId === b.eventId && a.inviteBase === b.inviteBase && a.onEdit === b.onEdit && JSON.stringify(a.p) === JSON.stringify(b.p),
)

function Situation({ p }: { p: Participant }) {
  if (p.blocked)
    return (
      <span className="flex items-center gap-1.5 text-fg-muted">
        <ProhibitIcon size={14} />
        Bloqueado
      </span>
    )
  if (p.online)
    return (
      <span className="flex items-center gap-2 text-fg">
        <Dot tone="neutral" />
        Online
      </span>
    )
  if (p.joinedAt) return <span className="text-fg-muted">Entrou {when(p.joinedAt)}</span>
  return <span className="text-fg-subtle">Convidado</span>
}

function PersonDialog({
  open,
  onOpenChange,
  person,
  eventId,
  people,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  person: Participant | null
  eventId: string
  people: Participant[]
}) {
  const form = useId()
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const f = new FormData(el)
    const value = (k: string) => String(f.get(k) ?? '').replace(/\s+/g, ' ').trim()
    const data = { name: value('name'), email: value('email'), group: value('group') }
    const taken = data.email && people.some((p) => p.id !== person?.id && p.email.toLowerCase() === data.email.toLowerCase())
    const found = {
      name: data.name ? undefined : 'Informe o nome.',
      email:
        data.email && !EMAIL.test(data.email)
          ? 'E-mail inválido. Confira o endereço.'
          : taken
            ? 'Já existe um participante com este e-mail.'
            : undefined,
    }
    setErrors(found)
    if (found.name || found.email) return focusInvalid(el)
    setBusy(true)
    const ok = await run(() =>
      person ? patch(`/events/${eventId}/participants/${person.id}`, data) : post(`/events/${eventId}/participants`, { people: [data] }),
    )
    setBusy(false)
    if (!ok) return
    notify(person ? 'Cadastro atualizado.' : `Convite criado para ${data.name}.`)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={person ? 'Editar participante' : 'Adicionar participante'}
      description={person ? undefined : 'O convite pessoal fica pronto na hora. Copie o link na lista para enviar.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="submit" form={form} variant="primary" loading={busy}>
            {person ? 'Salvar alterações' : 'Adicionar participante'}
          </Button>
        </>
      }
    >
      <form id={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Nome" error={errors.name}>
          <Input name="name" defaultValue={person?.name} maxLength={120} autoComplete="off" autoFocus />
        </Field>
        <Field label="E-mail" error={errors.email} hint="Opcional. Evita cadastros repetidos na importação.">
          <Input name="email" type="email" defaultValue={person?.email} maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Grupo" hint="Opcional. Turma, equipe ou empresa.">
          <Input name="group" defaultValue={person?.group} maxLength={120} autoComplete="off" />
        </Field>
      </form>
    </Dialog>
  )
}
