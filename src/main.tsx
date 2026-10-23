import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router'
import { IconContext } from '@phosphor-icons/react/dist/lib/context'
// Títulos e logo em Poppins (alternativa gratuita a Futura/Century Gothic, do manual da marca); texto na fonte do sistema.
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import '@fontsource/poppins/800.css'
import '@fontsource-variable/spline-sans-mono'
import './styles.css'
import { BrandFooter, ConfirmHost, ToastProvider, Toaster, TooltipProvider, buttonClass, toastManager } from './ui'

// Cada superfície é carregada sob demanda: o celular e a tela não baixam o código do console.
const Auth = lazy(() => import('./moderator/Auth.tsx'))
const Events = lazy(() => import('./moderator/Events.tsx'))
const EventLayout = lazy(() => import('./moderator/EventLayout.tsx'))
const Live = lazy(() => import('./moderator/Live.tsx'))
const Participants = lazy(() => import('./moderator/Participants.tsx'))
const Appearance = lazy(() => import('./moderator/Appearance.tsx'))
const Media = lazy(() => import('./moderator/Media.tsx'))
const Settings = lazy(() => import('./moderator/Settings.tsx'))
const Join = lazy(() => import('./participant/Join.tsx'))
const ParticipantEvent = lazy(() => import('./participant/Event.tsx'))
const Screen = lazy(() => import('./screen/Screen.tsx'))
// Administração geral, "Minha conta" e definição de senha por link (src/admin, src/account, src/moderator/auth)
// entram nas rotas quando a API da equipe (server/security + rotas de /api/admin e /api/account) for ligada.

// Depois de um deploy, os arquivos da versão anterior somem do servidor: uma página ainda não aberta não carregaria
// (o console ficaria em branco). Com versão nova publicada, recarrega nela; sem rede, o erro segue. O telão tem a
// própria atualização, que não o tira da exibição (src/screen/Screen.tsx).
window.addEventListener('vite:preloadError', () => {
  const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src')
  if (!mine || location.pathname.startsWith('/tela')) return
  fetch('/', { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => html.includes('<script type="module"') && !html.includes(`src="${mine}"`) && location.reload())
    .catch(() => {})
})

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="grid flex-1 place-items-center p-6">
        <div className="flex max-w-sm flex-col items-start gap-3">
          <h1 className="font-heading text-page font-semibold">Página não encontrada</h1>
          <p className="text-read text-fg-muted">Confira o endereço. Se você recebeu um convite, abra o link exatamente como ele chegou.</p>
          <Link to="/eventos" className={buttonClass('secondary', 'md')}>
            Ir para os eventos
          </Link>
        </div>
      </main>
      <BrandFooter />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IconContext.Provider value={{ size: 16, weight: 'regular' }}>
      <ToastProvider toastManager={toastManager} limit={3}>
        <TooltipProvider delay={400}>
          <BrowserRouter>
            <Suspense fallback={null}>
              <Routes>
                <Route index element={<Navigate to="/eventos" replace />} />
                <Route path="entrar" element={<Auth />} />
                <Route path="eventos" element={<Events />} />
                <Route path="eventos/:id" element={<EventLayout />}>
                  <Route index element={<Live />} />
                  <Route path="participantes" element={<Participants />} />
                  <Route path="aparencia" element={<Appearance />} />
                  <Route path="midia" element={<Media />} />
                  <Route path="ajustes" element={<Settings />} />
                </Route>
                <Route path="convite/:token" element={<Join />} />
                <Route path="e/:id" element={<ParticipantEvent />} />
                <Route path="tela" element={<Screen />} />
                <Route path="tela/:id" element={<Screen />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
          <Toaster />
          <ConfirmHost />
        </TooltipProvider>
      </ToastProvider>
    </IconContext.Provider>
  </StrictMode>,
)
