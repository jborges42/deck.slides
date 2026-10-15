// Administração › Pessoas: contas da equipe, papel, situação, links de senha e duas etapas.
import { useEffect, useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { DevicesIcon } from '@phosphor-icons/react/Devices'
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree'
import { KeyIcon } from '@phosphor-icons/react/Key'
import { LockSimpleOpenIcon } from '@phosphor-icons/react/LockSimpleOpen'
import { ProhibitIcon } from '@phosphor-icons/react/Prohibit'
import { ShieldSlashIcon } from '@phosphor-icons/react/ShieldSlash'
import { UserGearIcon } from '@phosphor-icons/react/UserGear'
import { UserPlusIcon } from '@phosphor-icons/react/UserPlus'
import { del, patch, post } from '../lib/api.ts'
import { ago } from '../lib/format.ts'
import { Button, Chip, Dialog, Field, IconButton, Input, Menu, Segmented, confirm, notify, type MenuItem } from '../ui'
import { count, iconOnly, message } from '../moderator/setup/kit.tsx'
import { SudoCancelled, act, expired, withSudo } from '../moderator/auth/sudo.tsx'
import { LinkDialog, Loading, Problem, exact, useLoad } from './kit.tsx'
import { useStaff } from './StaffShell.tsx'
import { ROLE_LABEL } from './text.ts'
import type { Role, StaffUser } from '../../shared/admin.ts'

// Prazos de server/security/passwords.ts: conta nova 72 h, redefinição 24 h. Um link novo invalida o anterior.
const once = (hours: number) => `O link funciona uma vez e expira em ${hours}\u00a0h.`
const ROLE_HINT: Record<Role, string> = {
  moderator: 'Vê só os eventos em que for incluída.',
  admin: 'Vê todos os eventos e esta administração. Precisa ativar a verificação em duas etapas.',
}

type Shown = { title: string; text: string; link: string }

export default function People() {
  const { me } = useStaff()
  const { data, error, reload } = useLoad<StaffUser[]>('/admin/users')
  const [adding, setAdding] = useState(false)
  const [shown, setShown] = useState<Shown | null>(null)

  if (error) return <Problem error={error} retry={reload} />
  if (!data) return <Loading />
  const people = [...data].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))

  return (
    <>
      <div className="mb-3 flex min-h-8 items-center">
        <p className="text-ui text-fg-muted tabular-nums">{count(people.length, 'Nenhuma pessoa', 'pessoa', 'pessoas')}</p>
        <Button variant="primary" icon={<UserPlusIcon />} className="ml-auto" onClick={() => setAdding(true)}>
          Adicionar pessoa
        </Button>
      </div>
      <table className="w-full table-fixed border-separate border-spacing-0 text-ui">
        <colgroup>
          <col />
          <col className="w-[24%]" />
          <col className="w-40" />
          <col className="w-28" />
          <col className="w-36" />
          <col className="w-32" />
          <col className="w-10" />
        </colgroup>
        <thead>
          <tr className="text-left text-meta text-fg-subtle">
            {['Nome', 'E-mail', 'Papel', 'Duas etapas', 'Situação', 'Último acesso'].map((h) => (
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
          {people.map((u) => (
            <Row key={u.id} u={u} self={u.id === me.id} onChanged={reload} onLink={setShown} />
          ))}
        </tbody>
      </table>

      <AddPerson
        open={adding}
        onOpenChange={setAdding}
        onCreated={(name, link) => {
          reload()
          setShown({ title: 'Conta criada', text: `Envie este link para ${name} por um canal privado. Com ele, ${name} define a própria senha. ${once(72)}`, link })
        }}
      />
      <LinkDialog link={shown?.link ?? null} title={shown?.title ?? ''} onClose={() => setShown(null)}>
        {shown?.text}
      </LinkDialog>
    </>
  )
}

function Row({ u, self, onChanged, onLink }: { u: StaffUser; self: boolean; onChanged: () => void; onLink: (s: Shown) => void }) {
  const navigate = useNavigate()
  const other: Role = u.role === 'admin' ? 'moderator' : 'admin'

  const update = async (body: { role: Role } | { disabled: boolean }, done: string) => {
    if (await act(() => patch(`/admin/users/${u.id}`, body))) {
      notify(done, { description: u.name })
      onChanged()
    }
  }

  const changeRole = async () => {
    const ok = await confirm({
      title: `Alterar o papel de ${u.name}?`,
      body:
        other === 'admin'
          ? `${u.name} passa para Administração geral: vê todos os eventos e esta administração. Para usar a administração, precisa ativar a verificação em duas etapas.`
          : `${u.name} passa para Moderação: deixa de acessar esta administração e vê só os eventos em que foi incluída.`,
      confirm: 'Alterar papel',
      tone: 'primary',
    })
    if (ok) await update({ role: other }, 'Papel alterado.')
  }

  const setDisabled = async (disabled: boolean) => {
    const ok = await confirm(
      disabled
        ? {
            title: `Desativar a conta de ${u.name}?`,
            body: `${u.name} sai de todas as sessões e não consegue mais entrar. Eventos e histórico continuam. Dá para reativar depois.`,
            confirm: 'Desativar conta',
          }
        : { title: `Reativar a conta de ${u.name}?`, body: `${u.name} volta a conseguir entrar no console.`, confirm: 'Reativar conta', tone: 'primary' },
    )
    if (ok) await update({ disabled }, disabled ? 'Conta desativada.' : 'Conta reativada.')
  }

  const resetLink = async () => {
    const ok = await confirm(
      u.pendingSetup
        ? {
            title: `Gerar um novo link de acesso para ${u.name}?`,
            body: `O link anterior deixa de funcionar. Envie o novo para ${u.name} por um canal privado. ${once(72)}`,
            confirm: 'Gerar link',
            tone: 'primary',
          }
        : {
            title: `Gerar um link de nova senha para ${u.name}?`,
            body: `As sessões abertas de ${u.name} são encerradas. Com o link, ${u.name} define uma nova senha. ${once(24)}`,
            confirm: 'Gerar link',
          },
    )
    const r = ok && (await act(() => post<{ setupLink: string }>(`/admin/users/${u.id}/reset`)))
    if (!r) return
    onChanged()
    onLink({
      title: u.pendingSetup ? 'Novo link de acesso' : 'Link de nova senha',
      text: `Envie este link para ${u.name} por um canal privado. ${once(u.pendingSetup ? 72 : 24)}`,
      link: r.setupLink,
    })
  }

  const resetMfa = async () => {
    const ok = await confirm({
      title: `Remover a verificação em duas etapas de ${u.name}?`,
      body: `Use quando a pessoa perdeu o aparelho. No próximo acesso, ${u.name} entra só com a senha${
        u.role === 'admin' ? ' e precisa ativar a verificação de novo para usar a administração' : ''
      }.`,
      confirm: 'Remover verificação',
    })
    if (ok && (await act(() => del(`/admin/users/${u.id}/mfa`)))) {
      notify('Verificação em duas etapas removida.', { description: u.name })
      onChanged()
    }
  }

  // Na própria linha, papel e situação ficam com outra pessoa da administração (o servidor também recusa).
  const selfHint = self ? 'Outra pessoa da administração precisa fazer esta alteração.' : undefined
  const items: MenuItem[] = [
    { label: `Alterar papel para ${ROLE_LABEL[other]}`, icon: <UserGearIcon />, onSelect: changeRole, disabled: self, hint: selfHint },
    u.disabled
      ? { label: 'Reativar conta', icon: <LockSimpleOpenIcon />, onSelect: () => setDisabled(false) }
      : { label: 'Desativar conta', icon: <ProhibitIcon />, danger: true, onSelect: () => setDisabled(true), disabled: self, hint: selfHint },
    'separator',
    {
      label: u.pendingSetup ? 'Gerar novo link de acesso' : 'Gerar link de nova senha',
      icon: <KeyIcon />,
      onSelect: resetLink,
      disabled: self,
      hint: self ? 'Para trocar a sua senha, use Minha conta.' : undefined,
    },
    ...(u.mfaEnabled
      ? [
          {
            label: 'Remover verificação em duas etapas',
            icon: <ShieldSlashIcon />,
            danger: true,
            onSelect: resetMfa,
            disabled: self,
            hint: self ? 'A administração exige a verificação em duas etapas.' : undefined,
          },
        ]
      : []),
    'separator',
    { label: 'Ver sessões', icon: <DevicesIcon />, onSelect: () => navigate(`/admin/sessoes?${new URLSearchParams({ pessoa: u.id })}`) },
  ]

  return (
    <tr className="h-10 *:border-b *:border-line">
      <td className="pr-4">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-fg" title={u.name}>
            {u.name}
          </span>
          {self && <Chip tone="outline">Você</Chip>}
        </span>
      </td>
      <td className="truncate pr-4 text-fg-muted" title={u.email}>
        {u.email}
      </td>
      <td className="truncate pr-4 text-fg-muted">{ROLE_LABEL[u.role]}</td>
      <td className={u.mfaEnabled ? 'pr-4 text-fg-muted' : 'pr-4 text-fg-subtle'}>{u.mfaEnabled ? 'Ativa' : 'Inativa'}</td>
      <td className="pr-4">
        {u.disabled ? (
          <Chip tone="outline">Desativada</Chip>
        ) : u.pendingSetup ? (
          <Chip tone="attention">Aguardando senha</Chip>
        ) : (
          <span className="text-fg-muted">Ativa</span>
        )}
      </td>
      <td className="pr-4 text-fg-muted" title={u.lastLoginAt ? exact(u.lastLoginAt) : undefined}>
        {u.lastLoginAt ? ago(u.lastLoginAt) : 'Nunca entrou'}
      </td>
      <td className="text-right">
        <Menu trigger={<IconButton size="sm" className={iconOnly} label={`Ações para ${u.name}`} icon={<DotsThreeIcon />} />} items={items} />
      </td>
    </tr>
  )
}

function AddPerson({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (name: string, link: string) => void
}) {
  const form = useId()
  const [role, setRole] = useState<Role>('moderator')
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setRole('moderator'), setErrors({}), setError(null)
  }, [open])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const name = String(data.get('name') ?? '').trim()
    const email = String(data.get('email') ?? '').trim()
    const found = {
      name: name ? undefined : 'Informe o nome.',
      email: /^[^\s@]+@[^\s@]+$/.test(email) ? undefined : 'Informe um e-mail válido, como nome@empresa.com.',
    }
    setErrors(found)
    setError(null)
    if (found.name || found.email) return
    setBusy(true)
    try {
      const r = await withSudo(() => post<{ user: StaffUser; setupLink: string }>('/admin/users', { name, email, role }))
      onOpenChange(false)
      onCreated(r.user.name, r.setupLink)
    } catch (err) {
      if (!(err instanceof SudoCancelled) && !expired(err)) setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adicionar pessoa"
      description="A pessoa recebe um link para definir a própria senha."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="submit" form={form} variant="primary" loading={busy}>
            Adicionar pessoa
          </Button>
        </>
      }
    >
      <form id={form} className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <Field label="Nome" error={errors.name}>
          <Input name="name" autoFocus maxLength={120} autoComplete="off" />
        </Field>
        <Field label="E-mail" error={errors.email}>
          <Input name="email" type="email" maxLength={200} autoComplete="off" spellCheck={false} />
        </Field>
        <div className="flex flex-col items-start gap-1.5">
          <span className="text-meta font-medium text-fg-muted">Papel</span>
          <Segmented
            label="Papel"
            value={role}
            onChange={setRole}
            options={[
              { value: 'moderator', label: ROLE_LABEL.moderator },
              { value: 'admin', label: ROLE_LABEL.admin },
            ]}
          />
          <p className="text-meta text-fg-subtle">{ROLE_HINT[role]}</p>
        </div>
        {error && (
          <p role="alert" className="text-ui text-critical">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
