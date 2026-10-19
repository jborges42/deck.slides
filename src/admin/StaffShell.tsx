// Moldura das páginas da equipe fora de um evento (/admin, /conta): barra de 48 px na linguagem da barra do evento.
// Rota de layout: carrega a conta (GET /api/account) e entrega { me, reload } às páginas via useStaff().
import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useOutletContext } from 'react-router'
import { CaretDownIcon } from '@phosphor-icons/react/CaretDown'
import { SignOutIcon } from '@phosphor-icons/react/SignOut'
import { api, ApiError, post } from '../lib/api.ts'
import { BrandFooter, Button, Empty, Menu, Spinner, cx, notify } from '../ui'
import { Mark, message } from '../moderator/setup/kit.tsx'
import type { Me } from '../../shared/admin.ts'

export interface Staff {
  me: Me
  /** Relê a conta (ex.: depois de ativar as duas etapas). */
  reload: () => void
}

export const useStaff = () => useOutletContext<Staff>()

export default function StaffShell() {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    api<Me>('/account').then(
      (m) => {
        setMe(m)
        setError(null)
      },
      // Sem sessão completa (vencida, ou entrada sem a segunda etapa): volta para /entrar.
      (e) => (e instanceof ApiError && e.status === 401 ? location.replace('/entrar') : setError(message(e))),
    )
  }, [])
  useEffect(reload, [reload])

  if (!me) {
    return (
      <main className="grid min-h-dvh place-items-center text-fg-subtle">
        {error ? (
          <Empty title="Não foi possível carregar sua conta." action={<Button onClick={reload}>Tentar novamente</Button>}>
            {error}
          </Empty>
        ) : (
          <Spinner size={18} />
        )}
      </main>
    )
  }

  const logout = async () => {
    try {
      await post('/auth/logout')
    } catch (e) {
      // 401: a sessão já tinha acabado; qualquer outra falha mantém a pessoa aqui, com o aviso.
      if (!(e instanceof ApiError && e.status === 401)) return void notify(message(e), { tone: 'critical' })
    }
    location.replace('/entrar') // recarga completa: nada da conta fica na memória da página
  }

  // A administração só aparece para quem é admin; quem garante o acesso é o servidor.
  const nav = [
    { to: '/eventos', label: 'Eventos' },
    ...(me.role === 'admin' ? [{ to: '/admin', label: 'Administração' }] : []),
    { to: '/conta', label: 'Minha conta' },
  ]

  return (
    <div className="flex h-dvh flex-col">
      <header className="on-brand flex h-12 shrink-0 items-center gap-5 px-4">
        <Mark />
        <span className="h-5 w-px bg-line" aria-hidden />
        <nav className="flex h-full items-stretch gap-4" aria-label="Seções do console">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cx(
                  'relative flex items-center text-ui font-medium transition-colors duration-100',
                  isActive ? 'text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg' : 'text-fg-subtle hover:text-fg-muted',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto">
          <Menu
            trigger={
              <button className="state-layer flex h-7 max-w-64 items-center gap-1.5 rounded-control px-2 text-ui text-fg-muted" title={me.email}>
                <span className="truncate">{me.name}</span>
                <CaretDownIcon size={12} className="shrink-0" />
              </button>
            }
            items={[{ label: 'Sair', icon: <SignOutIcon />, onSelect: () => void logout() }]}
          />
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet context={{ me, reload } satisfies Staff} />
      </main>
      <BrandFooter />
    </div>
  )
}
