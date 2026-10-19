// Administração geral (/admin): pessoas, sessões, auditoria e configurações. O servidor confere papel e duas etapas
// em cada rota; aqui só evitamos mostrar telas que ele vai recusar.
import { NavLink, Outlet } from 'react-router'
import { cx } from '../ui'
import { Page } from '../moderator/setup/kit.tsx'
import { Forbidden, MfaGate } from './kit.tsx'
import { useStaff } from './StaffShell.tsx'

const SECTIONS = [
  { to: 'pessoas', label: 'Pessoas' },
  { to: 'sessoes', label: 'Sessões' },
  { to: 'auditoria', label: 'Auditoria' },
  { to: 'configuracoes', label: 'Configurações' },
]

export default function Admin() {
  const staff = useStaff()
  const { me } = staff
  return (
    <Page title="Administração" description="Quem tem acesso ao console, sessões abertas, registro de auditoria e regras de segurança.">
      {me.role !== 'admin' ? (
        <Forbidden />
      ) : me.mfaRequired ? (
        <MfaGate />
      ) : (
        <>
          <nav className="flex gap-4 border-b border-line" aria-label="Seções da administração">
            {SECTIONS.map((s) => (
              <NavLink
                key={s.to}
                to={s.to}
                className={({ isActive }) =>
                  cx(
                    'relative flex h-9 items-center text-ui font-medium transition-colors duration-100',
                    isActive ? 'text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent' : 'text-fg-subtle hover:text-fg-muted',
                  )
                }
              >
                {s.label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-5">
            <Outlet context={staff} />
          </div>
        </>
      )}
    </Page>
  )
}
