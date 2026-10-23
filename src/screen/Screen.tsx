// Tela do evento (telão). /tela pareia o computador da projeção por código; /tela/:id abre a tela pela sessão
// do console (projeção no próprio notebook). Antes de exibir, o portão "Iniciar exibição" pede tela cheia, libera
// o som (o clique é o gesto que o navegador exige) e mantém a tela ligada. Sem conexão, o último quadro fica:
// a plateia nunca vê erro, só um ponto discreto para a técnica depois de 10 s. Com versão nova publicada, a tela se
// recarrega sozinha e volta direto à exibição.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { PlayIcon } from '@phosphor-icons/react/Play'
import { post } from '../lib/api.ts'
import { useStream, type StreamStatus } from '../lib/stream.ts'
import { BrandFooter, Button, buttonClass, cx } from '../ui'
import { Stage } from '../stage/Stage.tsx'
import { group } from '../stage/lib.ts'
import type { ScreenSnapshot } from '../../shared/types.ts'

type Pair = { paired: true; eventId: string } | { paired: false; code: string; expiresAt: number }

// Marca da recarga por versão nova, lida uma vez por carga da página (useShow pula o portão).
const RESUME = 'deck:tela-retomar'
const resumed = take(RESUME)

/** Lê e apaga a marca na sessão da aba. Armazenamento bloqueado: segue sem ela (a recarga para no portão). */
function take(key: string): boolean {
  try {
    const on = sessionStorage.getItem(key) === '1'
    sessionStorage.removeItem(key)
    return on
  } catch {
    return false
  }
}

export default function Screen() {
  const { id } = useParams()
  const show = useShow()
  useReloadOnDeploy(show.started)
  const [paired, setPaired] = useState(false)
  const onPaired = useCallback(() => setPaired(true), [])
  const onLost = useCallback(() => setPaired(false), [])
  if (id) return <Live url={`/api/screen/stream?event=${encodeURIComponent(id)}`} show={show} />
  return paired ? <Live url="/api/screen/stream" show={show} onLost={onLost} /> : <Pairing show={show} onPaired={onPaired} />
}

type Show = ReturnType<typeof useShow>

/**
 * Portão de início e cuidados da projeção: tela cheia (F alterna), tela sempre ligada, cursor oculto após 2 s parado.
 * Depois da recarga por versão nova, começa já exibindo; a tela cheia pede um gesto e volta no primeiro clique (ou F).
 */
function useShow() {
  const [started, setStarted] = useState(resumed)
  const [idle, setIdle] = useState(false)
  const lock = useRef<WakeLockSentinel | null>(null)

  // O navegador solta o wake lock quando a aba fica oculta: pedimos de novo ao voltar.
  const wake = useCallback(() => {
    if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
    navigator.wakeLock.request('screen').then((l) => (lock.current = l), () => {})
  }, [])

  const start = useCallback(() => {
    document.documentElement.requestFullscreen?.().catch(() => {})
    wake()
    setStarted(true)
  }, [wake])

  useEffect(() => {
    if (!started) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const move = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), 2000)
    }
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'KeyF' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      else document.documentElement.requestFullscreen?.().catch(() => {})
    }
    const full = () => document.documentElement.requestFullscreen?.().catch(() => {})
    if (resumed) {
      wake()
      window.addEventListener('pointerdown', full, { once: true })
    }
    move()
    window.addEventListener('pointermove', move)
    window.addEventListener('keydown', key)
    document.addEventListener('visibilitychange', wake)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', full)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('keydown', key)
      document.removeEventListener('visibilitychange', wake)
      lock.current?.release().catch(() => {})
    }
  }, [started, wake])

  return { started, start, idle }
}

/**
 * Versão nova publicada: a aba aberta antes dela segue com o código antigo e não mostra os recursos novos (o
 * cronômetro sobre o conteúdo, por exemplo). A cada minuto compara o script principal do index.html com o desta
 * página e, se mudou, recarrega. Exibindo, marca a recarga para voltar sem o portão.
 */
function useReloadOnDeploy(started: boolean) {
  useEffect(() => {
    const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src')
    if (!mine) return
    const t = setInterval(async () => {
      try {
        const r = await fetch(location.pathname, { cache: 'no-store' })
        const html = await r.text()
        // Só um index.html de verdade com outro script: página de erro da rede ou da CDN não recarrega.
        if (!r.ok || !html.includes('<script type="module"') || html.includes(`src="${mine}"`)) return
        try {
          if (started) sessionStorage.setItem(RESUME, '1')
        } catch {
          // armazenamento bloqueado: recarrega assim mesmo e para no portão
        }
        location.reload()
      } catch {
        // sem rede: tenta de novo no próximo minuto
      }
    }, 60_000)
    return () => clearInterval(t)
  }, [started])
}

// ---------- exibição ----------

/** `onLost` (tela pareada): perdeu o vínculo ou o evento foi excluído, volta ao código de pareamento. */
function Live({ url, show, onLost }: { url: string; show: Show; onLost?: () => void }) {
  const { state: snap, counts, status, offset } = useStream<ScreenSnapshot>(url)
  const offline = useOffline(status)
  const name = snap?.event.name

  useEffect(() => {
    if (name) document.title = `Tela: ${name}`
  }, [name])

  const previous = useRef(status)
  useEffect(() => {
    const was = previous.current
    previous.current = status
    if (!onLost) return
    if (status === 'gone' || status === 'denied') {
      const t = setTimeout(onLost, 1000)
      return () => clearTimeout(t)
    }
    // Ao reconectar, confirma o vínculo: tela desconectada no console enquanto estava sem rede
    // reconectaria na sala de pareamento e ficaria parada no último quadro.
    if (status === 'live' && was === 'reconnecting') post<Pair>('/screen/pair').then((r) => r.paired || onLost(), () => {})
  }, [status, onLost])

  if (!onLost && status === 'denied')
    return (
      <Panel>
        <h1 className="font-heading text-page font-semibold text-fg">Entre para abrir esta tela</h1>
        <p className="text-read text-fg-muted">
          Este endereço usa a sessão do console. Entre neste navegador ou conecte o computador da projeção por código.
        </p>
        <div className="mt-3 flex gap-2">
          <Link to="/entrar" className={buttonClass('primary', 'lg')}>
            Entrar
          </Link>
          <Link to="/tela" className={buttonClass('secondary', 'lg')}>
            Conectar por código
          </Link>
        </div>
      </Panel>
    )
  if (!onLost && status === 'gone')
    return (
      <Panel>
        <h1 className="font-heading text-page font-semibold text-fg">Evento encerrado</h1>
        <p className="text-read text-fg-muted">A organização excluiu este evento. Você pode fechar esta janela.</p>
      </Panel>
    )
  if (!show.started)
    return (
      <Panel>
        <p className="text-ui text-fg-muted">Tela do evento</p>
        <h1 className="min-h-8 font-heading text-event font-semibold text-balance text-fg">{name}</h1>
        <p className="text-read text-fg-muted">Abre em tela cheia, com som liberado, e mantém a tela ligada. A tecla F alterna a tela cheia.</p>
        <StartButton onClick={show.start} />
      </Panel>
    )
  // Antes do primeiro snapshot: só o fundo, sem indicador piscando.
  if (!snap) return <main className={cx('fixed inset-0 bg-black', show.idle && 'cursor-none')} />

  const { event, program } = snap
  return (
    <main className={cx('fixed inset-0 bg-black', show.idle && 'cursor-none')}>
      <Stage
        mode="screen"
        theme={event.theme}
        eventName={event.name}
        pin={event.pin}
        joinUrl={event.openJoin ? `${snap.publicUrl ?? location.origin}/e/${event.id}` : null}
        scene={program}
        questions={snap.questions}
        questionOverlay={snap.questionOverlay}
        likes={counts.likes}
        live={event.live}
        standby={event.live.standby}
        reactions={program ? counts.reactions[program.id] : undefined}
        enabledReactions={event.reactions}
        offset={offset}
      />
      {offline && (
        <span
          role="status"
          aria-label="Sem conexão com o servidor. Reconectando…"
          className="fixed top-2 left-2 size-2 rounded-full bg-attention opacity-40"
        />
      )}
    </main>
  )
}

/** Sem conexão há mais de 10 s (o último quadro continua na tela). */
function useOffline(status: StreamStatus) {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    if (status !== 'reconnecting') return setOffline(false)
    const t = setTimeout(() => setOffline(true), 10_000)
    return () => clearTimeout(t)
  }, [status])
  return offline
}

// ---------- pareamento ----------

/** Mostra o código que a moderação digita em "Conectar tela" e espera o aviso de pareamento pelo SSE. */
function Pairing({ show, onPaired }: { show: Show; onPaired: () => void }) {
  const [code, setCode] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    document.title = 'Conectar tela'
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const paired = () => {
      es?.close()
      onPaired()
    }
    const begin = async () => {
      es?.close()
      try {
        const r = await post<Pair>('/screen/pair')
        if (stopped) return
        setFailed(false)
        if (r.paired) return onPaired()
        setCode(r.code)
        es = new EventSource('/api/screen/stream')
        es.addEventListener('pairing', (e) => setCode((JSON.parse(e.data) as { code: string }).code))
        es.addEventListener('paired', paired)
        es.addEventListener('state', paired) // aviso perdido numa queda: a reconexão já chega pareada
        es.addEventListener('error', () => {
          // Queda de rede o EventSource refaz sozinho; resposta de erro (cookie perdido) recomeça o pareamento.
          if (es?.readyState === EventSource.CLOSED && !stopped) retry = setTimeout(begin, 3000)
        })
      } catch {
        if (stopped) return
        setFailed(true)
        retry = setTimeout(begin, 3000)
      }
    }
    void begin()
    return () => {
      stopped = true
      clearTimeout(retry)
      es?.close()
    }
  }, [onPaired])

  if (!code && !failed) return <main className="on-brand fixed inset-0" />
  return (
    <Panel idle={show.idle}>
      <p className="text-ui text-fg-muted">Conectar esta tela</p>
      {code && (
        <p aria-label={`Código ${code.split('').join(' ')}`} className="font-code text-[length:clamp(56px,9vw,160px)] leading-none font-medium whitespace-nowrap text-fg">
          {group(code)}
        </p>
      )}
      <p className="text-read text-fg-muted">
        {failed
          ? 'Sem conexão com o servidor. Tentando de novo…'
          : 'No console do evento, use “Conectar tela” e digite este código. A exibição começa assim que a moderação confirmar.'}
      </p>
      {!show.started && <StartButton onClick={show.start} />}
    </Panel>
  )
}

// ---------- painéis da técnica ----------

function Panel({ children, idle }: { children: ReactNode; idle?: boolean }) {
  return (
    <main className={cx('on-brand flex min-h-dvh flex-col', idle && 'cursor-none')}>
      <div className="grid flex-1 place-items-center p-8">
        <div className="flex w-full max-w-xl flex-col items-start gap-3">{children}</div>
      </div>
      <BrandFooter negative plain />
    </main>
  )
}

function StartButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="primary" size="lg" icon={<PlayIcon />} autoFocus onClick={onClick} className="mt-3">
      Iniciar exibição
    </Button>
  )
}
