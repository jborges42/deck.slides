// Tela do evento (telão). /tela pareia o computador da projeção por código; /tela/:id abre a tela pela sessão
// do console (projeção no próprio notebook). A página é uma moldura: fica em tela cheia, mantém a tela ligada e mostra
// o conteúdo (portão "Iniciar exibição", pareamento e exibição) num iframe da mesma origem (?quadro). O portão pede a
// tela cheia para a moldura e libera o som (o clique é o gesto que o navegador exige). Com versão nova publicada, outro
// iframe carrega por trás e assume numa fusão quando está pronto: a página nunca recarrega, então tela cheia, som e tela
// ligada continuam e a plateia não percebe a troca. Sem conexão, o último quadro fica: a plateia nunca vê erro, só um
// ponto discreto para a técnica depois de 10 s.
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

// Modo do conteúdo (?quadro): '' abre com o portão; 'retomar' volta direto à exibição (a página inteira recarregou,
// como as versões sem moldura faziam a cada publicação); 'troca' é a versão nova carregando por trás da que está no ar.
// CONTRATO ESTÁVEL: a moldura aberta fica com o código da versão em que abriu e conversa com conteúdos de versões mais
// novas. Mantenha estes modos e a mensagem { deck: 'ready' }.
const QUADRO = new URLSearchParams(location.search).get('quadro')
// No iframe, tela cheia e título são da moldura (mesma origem): trocar o iframe não sai da tela cheia.
const page = QUADRO !== null && window.parent !== window ? window.parent.document : document
// Versões sem moldura recarregavam a página inteira a cada publicação e deixavam esta marca para pular o portão.
const resumed = QUADRO === null && take('deck:tela-retomar')

/** Lê e apaga a marca na sessão da aba. Armazenamento bloqueado: segue sem ela. */
function take(key: string): boolean {
  try {
    const on = sessionStorage.getItem(key) === '1'
    sessionStorage.removeItem(key)
    return on
  } catch {
    return false
  }
}

/** Tela cheia da página de cima. Só num clique ou tecla: o navegador exige o gesto. */
function fullscreen(on: boolean) {
  ;(on ? page.documentElement.requestFullscreen?.() : page.exitFullscreen?.())?.catch(() => {})
}

const isToggle = (e: KeyboardEvent) => e.code === 'KeyF' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey

/** Script principal de uma página do app: o nome tem hash, então muda a cada versão publicada. */
const entryOf = (doc: Document) => doc.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null

export default function Screen() {
  return QUADRO === null ? <Shell /> : <Content />
}

// ---------- moldura ----------

interface Frame {
  id: number
  src: string
  /** Script principal da versão que o iframe carregou (ou vai carregar). */
  entry: string | null
}

let frames = 0
const FADE = 500 // fusão padrão entre cenas
const frameSrc = (mode: '' | 'retomar' | 'troca') => `${location.pathname}?quadro${mode && `=${mode}`}`

/**
 * Moldura do telão: tela cheia, tela ligada e a versão publicada conferida a cada minuto. A versão nova carrega num
 * iframe por baixo do atual; quando avisa que está pronta, o atual some numa fusão por cima dela.
 */
function Shell() {
  const [active, setActive] = useState<Frame>(() => ({ id: ++frames, src: frameSrc(resumed ? 'retomar' : ''), entry: entryOf(document) }))
  const [next, setNext] = useState<Frame | null>(null)
  const [leaving, setLeaving] = useState<Frame | null>(null)
  const nextFrame = useRef<HTMLIFrameElement>(null)

  // Tela sempre ligada desde a abertura (o pedido não exige gesto); o navegador solta ao ocultar a aba: pedimos de novo.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    const wake = () => {
      if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
      navigator.wakeLock.request('screen').then((l) => (lock = l), () => {})
    }
    // Com o foco aqui (o iframe que tinha o foco saiu numa troca), F continua alternando a tela cheia.
    const key = (e: KeyboardEvent) => isToggle(e) && fullscreen(!document.fullscreenElement)
    wake()
    document.addEventListener('visibilitychange', wake)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      document.removeEventListener('keydown', key)
      lock?.release().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await fetch(location.pathname, { cache: 'no-store' })
        // Só um index.html de verdade: página de erro da rede ou da CDN não tem o script principal.
        const entry = r.ok ? entryOf(new DOMParser().parseFromString(await r.text(), 'text/html')) : null
        if (entry && entry !== active.entry && entry !== next?.entry) setNext({ id: ++frames, src: frameSrc('troca'), entry })
      } catch {
        // sem rede: confere de novo no próximo minuto
      }
    }, 60_000)
    return () => clearInterval(t)
  }, [active.entry, next?.entry])

  useEffect(() => {
    const ready = (e: MessageEvent<{ deck?: string; entry?: string | null }>) => {
      if (!next || e.origin !== location.origin || e.source !== nextFrame.current?.contentWindow || e.data?.deck !== 'ready') return
      setLeaving(active)
      setActive({ ...next, entry: e.data.entry ?? next.entry })
      setNext(null)
    }
    window.addEventListener('message', ready)
    return () => window.removeEventListener('message', ready)
  }, [active, next])

  // Versão nova que não fica pronta (rede caiu na carga, deploy com erro, vídeo longo no ar) sai depois de 3 min; a
  // conferência seguinte tenta de novo. A antiga continua no ar o tempo todo.
  useEffect(() => {
    if (!next) return
    const t = setTimeout(() => setNext(null), 3 * 60_000)
    return () => clearTimeout(t)
  }, [next])

  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLeaving(null), FADE)
    return () => clearTimeout(t)
  }, [leaving])

  return (
    <main className="fixed inset-0 bg-black">
      {[leaving, active, next].map(
        (f, i) =>
          f && (
            <iframe
              key={f.id}
              ref={f === next ? nextFrame : undefined}
              src={f.src}
              title="Tela do evento"
              data-quadro={f === active ? 'ativo' : f === next ? 'carregando' : 'saindo'}
              aria-hidden={f !== active || undefined}
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              className="absolute inset-0 size-full border-0"
              // Por cima, o que sai (some em fusão, sem receber cliques); por baixo, a versão nova carregando.
              style={{ zIndex: 2 - i, ...(f === leaving && { pointerEvents: 'none', animation: `fade-out ${FADE}ms linear both` }) }}
            />
          ),
      )}
    </main>
  )
}

// ---------- conteúdo ----------

function Content() {
  const { id } = useParams()
  const show = useShow()
  const [paired, setPaired] = useState(false)
  const onPaired = useCallback(() => setPaired(true), [])
  const onLost = useCallback(() => setPaired(false), [])
  if (id) return <Live url={`/api/screen/stream?event=${encodeURIComponent(id)}`} show={show} />
  return paired ? <Live url="/api/screen/stream" show={show} onLost={onLost} /> : <Pairing show={show} onPaired={onPaired} />
}

type Show = ReturnType<typeof useShow>

/**
 * Portão de início e cuidados da projeção: tela cheia da moldura (F alterna), cursor oculto após 2 s parado e, aberto
 * fora da moldura, tela sempre ligada. Por troca de versão ou depois de uma recarga, já começa exibindo; depois da
 * recarga, a tela cheia pede um gesto e volta no primeiro clique (ou F).
 */
function useShow() {
  const [started, setStarted] = useState(QUADRO === 'retomar' || QUADRO === 'troca')
  // Na troca de versão, o cursor continua oculto: a plateia não pode ver nada mudar.
  const [idle, setIdle] = useState(QUADRO === 'troca')
  const lock = useRef<WakeLockSentinel | null>(null)

  // Na moldura, ela mantém a tela ligada. O navegador solta o wake lock quando a aba fica oculta: pedimos de novo ao voltar.
  const wake = useCallback(() => {
    if (page !== document || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
    navigator.wakeLock.request('screen').then((l) => (lock.current = l), () => {})
  }, [])

  const start = useCallback(() => {
    fullscreen(true)
    setStarted(true)
  }, [])

  useEffect(() => {
    if (!started) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const move = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), 2000)
    }
    const key = (e: KeyboardEvent) => isToggle(e) && fullscreen(!page.fullscreenElement)
    const full = () => fullscreen(true)
    if (QUADRO === 'retomar') window.addEventListener('pointerdown', full, { once: true })
    wake()
    if (QUADRO !== 'troca') move()
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
 * Versão nova carregando por trás da moldura (?quadro=troca): espera uma cena sem som nem página externa (vídeo e
 * página web tocariam em dobro com a versão que está no ar), desenha, espera fontes e imagens e avisa a moldura, que
 * troca os iframes numa fusão. Devolve true enquanto a cena no ar não deixa desenhar.
 */
function useHandover(snap: ScreenSnapshot | null): boolean {
  const [waiting, setWaiting] = useState(QUADRO === 'troca')
  const program = snap && !snap.event.live.standby ? snap.program : null
  const loud = program?.type === 'video' || program?.type === 'embed'
  const has = !!snap
  useEffect(() => {
    if (!waiting || !has || loud) return
    let off = false
    const settled = Promise.all([document.fonts.ready, ...Array.from(document.images, (img) => img.decode().catch(() => {}))])
    void Promise.race([settled, new Promise((r) => setTimeout(r, 3000))]).then(() => {
      if (off) return
      setWaiting(false)
      window.parent.postMessage({ deck: 'ready', entry: entryOf(document) }, location.origin)
    })
    return () => {
      off = true
    }
  }, [waiting, has, loud])
  return waiting && loud
}

// ---------- exibição ----------

/** `onLost` (tela pareada): perdeu o vínculo ou o evento foi excluído, volta ao código de pareamento. */
function Live({ url, show, onLost }: { url: string; show: Show; onLost?: () => void }) {
  const { state: snap, counts, status, offset } = useStream<ScreenSnapshot>(url)
  const offline = useOffline(status)
  const holding = useHandover(snap)
  const name = snap?.event.name

  useEffect(() => {
    if (name) page.title = `Tela: ${name}`
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
        {/* Fora da moldura: entrar ou parear dentro do iframe deixaria o console preso nele. */}
        <div className="mt-3 flex gap-2">
          <Link to="/entrar" target="_top" className={buttonClass('primary', 'lg')}>
            Entrar
          </Link>
          <Link to="/tela" target="_top" className={buttonClass('secondary', 'lg')}>
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
  // Antes do primeiro snapshot (ou esperando a vez de assumir): só o fundo, sem indicador piscando.
  if (!snap || holding) return <main className={cx('fixed inset-0 bg-black', show.idle && 'cursor-none')} />

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
    page.title = 'Conectar tela'
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
