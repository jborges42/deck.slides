// Cenas do palco. Mídia (imagem, vídeo, página web) sangra até a borda do canvas; texto fica em `box`
// (área segura menos logo e rodapé). Medidas em unidades do canvas de 1080 de altura, via u().
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { FilmStripIcon } from '@phosphor-icons/react/FilmStrip'
import { GlobeIcon } from '@phosphor-icons/react/Globe'
import { ImageIcon } from '@phosphor-icons/react/Image'
import { PresentationIcon } from '@phosphor-icons/react/Presentation'
import { ThumbsUpIcon } from '@phosphor-icons/react/ThumbsUp'
import { useNow } from '../lib/stream.ts'
import { CANVAS } from '../lib/theme.ts'
import { cx } from '../ui'
import { card, group, timerFace, u, youtubeId, type TimerFace, type TimerSpec } from './lib.ts'
import { Address, QrTile } from './overlays.tsx'
import { playbackPosition, slideIndex, timerElapsed, type PublicQuestion, type Scene, type SceneContent, type Theme } from '../../shared/types.ts'
import type { StageProps } from './Stage.tsx'

/** Área do texto, em unidades do canvas. */
export interface Box {
  top: number
  bottom: number
  side: number
  /** Topo da apresentação, que fica inteira: abaixo da faixa de entrada quando ela está em cima. */
  slidesTop?: number
}

export interface SceneProps {
  scene: Scene
  theme: Theme
  mode: StageProps['mode']
  live: StageProps['live']
  offset: number
  questions: PublicQuestion[]
  likes?: Record<string, number>
  box: Box
  /** Âmbar do aviso do cronômetro, com contraste garantido sobre o fundo (amberOn). */
  amber: string
  /** Cena de entrada: link do QR (null = só convidados) e PIN do evento. */
  joinUrl: string | null
  pin: string
  report?: (overflow: boolean) => void
}

type With<T extends Scene['type']> = SceneProps & { content: SceneContent<T> }

const area = (b: Box): CSSProperties => ({ top: u(b.top), bottom: u(b.bottom), left: u(b.side), right: u(b.side) })

// ---------- fusão ----------

interface Layer {
  id: string
  node: ReactNode
}

/**
 * Fusão entre camadas: ao trocar `id`, a anterior continua montada (mesmo DOM: o vídeo segue tocando, a imagem
 * não recarrega) e some em `ms` enquanto a nova aparece. ms = 0 é corte.
 */
export function Crossfade({ id, ms, children }: { id: string; ms: number; children: ReactNode }) {
  const last = useRef<Layer>({ id, node: children })
  const [current, setCurrent] = useState(id)
  const [out, setOut] = useState<Layer | null>(null)
  if (current !== id) {
    // Ajuste de estado durante a renderização: a camada que sai entra nesta mesma passada, sem remontar.
    setCurrent(id)
    setOut(ms > 0 ? last.current : null)
  }
  useLayoutEffect(() => {
    last.current = { id, node: children }
  })
  useEffect(() => {
    if (!out) return
    const t = setTimeout(() => setOut(null), ms)
    return () => clearTimeout(t)
  }, [out, ms])
  return (
    <>
      {out && (
        <div key={out.id} aria-hidden className="absolute inset-0" style={{ animation: `fade-out ${ms}ms linear both` }}>
          {out.node}
        </div>
      )}
      <div key={id} className="absolute inset-0" style={out ? { animation: `fade-in ${ms}ms linear both` } : undefined}>
        {children}
      </div>
    </>
  )
}

// ---------- cena ----------

/** Perguntas que o layout mostra: destaque, uma; mural e grade, até `max` (no máximo 6). */
const visible = (c: SceneContent<'questions'>, qs: PublicQuestion[]) =>
  qs.slice(0, c.layout === 'spotlight' ? 1 : Math.min(Math.max(c.max, 1), 6))

/** O que, ao mudar dentro da mesma cena, troca em fusão. Curtidas e algarismos do cronômetro mudam no lugar. */
function contentKey(p: SceneProps): string {
  const { scene, questions } = p
  switch (scene.type) {
    case 'questions':
      return JSON.stringify([scene.content.layout, scene.content.title, visible(scene.content, questions).map((q) => [q.id, q.text, q.author])])
    case 'timer':
      return 'timer'
    case 'video':
      return scene.content.src
    case 'embed':
      return scene.content.url
    case 'slides':
      return scene.content.slides[slideIndex(p.live, scene)] ?? '' // cada slide entra em fusão
    case 'join':
      return JSON.stringify([scene.content, p.joinUrl, p.pin]) // ligar a entrada aberta ou trocar o PIN também
    default:
      return JSON.stringify(scene.content)
  }
}

/**
 * Uma cena. No telão, mudanças de conteúdo (outra pergunta, texto atualizado) entram em fusão de 300 ms, e a área do
 * texto também (faixa de entrada ligada, desligada ou trocando de borda): o texto não salta. Vídeo, página web e
 * imagem sangram até a borda e ficam fora: remontar recarregaria a mídia.
 */
export function SceneView(p: SceneProps) {
  const { scene } = p
  const place = scene.type === 'video' || scene.type === 'embed' || scene.type === 'image' ? '' : JSON.stringify(p.box)
  return (
    <Crossfade id={contentKey(p) + place} ms={p.mode === 'screen' ? 300 : 0}>
      {scene.type === 'title' ? (
        <TitleScene {...p} content={scene.content} />
      ) : scene.type === 'image' ? (
        <ImageScene {...p} content={scene.content} />
      ) : scene.type === 'video' ? (
        <VideoScene {...p} content={scene.content} />
      ) : scene.type === 'embed' ? (
        <EmbedScene {...p} content={scene.content} />
      ) : scene.type === 'questions' ? (
        <QuestionsScene {...p} content={scene.content} />
      ) : scene.type === 'slides' ? (
        <SlidesScene {...p} content={scene.content} />
      ) : scene.type === 'timer' ? (
        <TimerScene {...p} content={scene.content} />
      ) : scene.type === 'join' ? (
        <JoinScene {...p} content={scene.content} />
      ) : null /* pasta: nunca vai para a tela */}
    </Crossfade>
  )
}

// ---------- medida ----------

/**
 * Confere se `content` cabe em `box` (altura, largura e, opcionalmente, linhas do texto marcado com data-lines).
 * Com `range`, reduz a variável --fit de max até min antes de desistir; com `hide`, o que ainda passar da área some
 * inteiro. A conta é em proporção (tudo escala com --u), então o resultado é o mesmo no telão, no monitor e na
 * miniatura.
 */
export function useFit(
  box: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  report: SceneProps['report'],
  key: string,
  range?: { max: number; min: number; lines?: number; hide?: boolean },
) {
  useLayoutEffect(() => {
    const outer = box.current
    if (!outer) return
    const measure = () => {
      if (!outer.clientHeight) return // ainda sem tamanho (palco oculto)
      const el = content.current
      if (!el) return report?.(false)
      const fits = () => {
        if (el.getBoundingClientRect().height > outer.getBoundingClientRect().height + 0.5) return false
        if (outer.scrollWidth > outer.clientWidth + 1) return false // linha sem quebra (PIN, domínio) vazando de lado
        const text = range?.lines ? el.querySelector<HTMLElement>('[data-lines]') : null
        if (!text) return true
        const size = parseFloat(getComputedStyle(text).fontSize)
        return text.getBoundingClientRect().height <= size * 1.2 * (range!.lines! + 0.5)
      }
      const items = [...el.children] as HTMLElement[]
      for (const item of items) item.style.visibility = ''
      let n = range?.max ?? 0
      let ok = false
      for (;;) {
        if (range) el.style.setProperty('--fit', String(n))
        ok = fits()
        if (ok || !range || n <= range.min) break
        n = Math.max(range.min, n - 2)
      }
      // Mural que não coube nem no mínimo: os cartões que passariam da área somem inteiros (nunca uma
      // pergunta cortada no meio) e o console recebe o aviso.
      if (!ok && range?.hide) {
        const limit = outer.getBoundingClientRect().bottom + 0.5
        for (const item of items) if (item.getBoundingClientRect().bottom > limit) item.style.visibility = 'hidden'
      }
      report?.(!ok)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(outer)
    document.fonts.addEventListener('loadingdone', measure)
    return () => {
      ro.disconnect()
      document.fonts.removeEventListener('loadingdone', measure)
    }
    // `range` e o conteúdo medido entram pela chave.
  }, [key, report])
}

// ---------- título ----------

function TitleScene({ content, theme, box, report }: With<'title'>) {
  const s = theme.scale
  const center = theme.align === 'center'
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const paragraphs = content.body.split(/\n+/).map((t) => t.trim()).filter(Boolean)
  useFit(outer, inner, report, JSON.stringify([content, box, s, theme.fonts, theme.aspect]))
  return (
    <div ref={outer} className={cx('absolute flex flex-col justify-center', center && 'items-center text-center')} style={area(box)}>
      <div ref={inner} className={cx('flex shrink-0 flex-col wrap-anywhere', center && 'items-center')} style={{ maxWidth: u(1640) }}>
        {content.kicker && (
          <p className="font-body font-semibold text-accent-fg" style={{ fontSize: u(38 * s), lineHeight: 1.25 }}>
            {content.kicker}
          </p>
        )}
        {content.title && (
          <p
            className="font-heading tracking-tight text-balance text-fg"
            style={{ fontSize: u(110 * s), lineHeight: 1.15, fontWeight: 'var(--heading-weight)', marginTop: content.kicker ? u(24 * s) : undefined }}
          >
            {content.title}
          </p>
        )}
        {paragraphs.length > 0 && (
          <div
            className="font-body text-pretty text-fg-muted"
            style={{ fontSize: u(44 * s), lineHeight: 1.35, maxWidth: u(1400), marginTop: content.title || content.kicker ? u(40 * s) : undefined }}
          >
            {paragraphs.map((t, i) => (
              <p key={i} style={{ marginTop: i ? u(20 * s) : undefined }}>
                {t}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- imagem ----------

function ImageScene({ content, theme, box, mode }: With<'image'>) {
  const [failed, setFailed] = useState(false)
  const caption = content.caption.trim()
  const cover = content.fit === 'cover'
  const img =
    content.src && !failed ? (
      <img
        src={content.src}
        alt={caption}
        draggable={false}
        decoding="async"
        loading={mode === 'thumb' ? 'lazy' : undefined}
        onError={() => setFailed(true)}
        className="absolute inset-0 size-full"
        style={{ objectFit: content.fit }}
      />
    ) : (
      mode !== 'screen' && <Placeholder icon={<ImageIcon size="1em" weight="bold" />} label={content.src ? 'Imagem indisponível' : 'Sem imagem'} />
    )
  return (
    <>
      {cover && img}
      <div className="absolute inset-0 flex flex-col">
        <div className="relative min-h-0 flex-1">{!cover && img}</div>
        {caption && (
          // Sobre a imagem, a legenda ganha um véu sólido da cor de fundo; em "conter", a imagem fica acima dela.
          <div className={cx('shrink-0', cover && 'bg-canvas/85')} style={{ padding: `${u(32)} ${u(box.side)} ${u(box.bottom)}` }}>
            <p
              className="font-body text-pretty text-fg wrap-anywhere"
              style={{ fontSize: u(44 * theme.scale), lineHeight: 1.3, textAlign: theme.align, maxWidth: u(1536), marginInline: theme.align === 'center' ? 'auto' : undefined }}
            >
              {caption}
            </p>
          </div>
        )}
      </div>
    </>
  )
}

// ---------- apresentação ----------

/**
 * Slide atual inteiro, contido na área acima da linha de baixo (a marca fixa nunca cobre o slide; a faixa de
 * entrada também não, em cima ou embaixo). No telão, os vizinhos ficam pré-carregados: passar o slide não pisca.
 */
function SlidesScene({ scene, content, live, box, mode }: With<'slides'>) {
  const i = slideIndex(live, { id: scene.id, content })
  const src = content.slides[i]
  useEffect(() => {
    if (mode !== 'screen') return
    for (const n of [i + 1, i + 2, i - 1]) if (content.slides[n]) new Image().src = content.slides[n]
  }, [mode, i, content.slides])
  if (!src) return mode !== 'screen' && <Placeholder icon={<PresentationIcon size="1em" weight="bold" />} label="Sem slides" />
  return (
    <div className="absolute inset-x-0" style={{ top: u(box.slidesTop ?? 0), bottom: u(box.bottom - 24) }}>
      <img
        src={src}
        alt={`Slide ${i + 1} de ${content.slides.length}`}
        draggable={false}
        decoding="async"
        loading={mode === 'thumb' ? 'lazy' : undefined}
        className="size-full object-contain"
      />
    </div>
  )
}

// ---------- vídeo ----------

function VideoScene(props: With<'video'>) {
  const yt = youtubeId(props.content.src)
  return yt ? <YouTubeVideo id={yt} {...props} /> : <FileVideo {...props} />
}

/**
 * Link do YouTube colado em "Usar URL": o <video> não toca, então vai o player oficial. Como a página web, só o
 * telão carrega; no console, um aviso. O estado inicial vai no endereço (o player só aceita comandos depois de
 * carregar) e os botões do console chegam por postMessage (enablejsapi).
 */
function YouTubeVideo({ id, scene, content, live, offset, mode }: With<'video'> & { id: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const p = live.playback
  const synced = mode === 'screen' && p.sceneId === scene.id
  // Só id e "Repetir" recarregam o player; tocar, pausar e voltar ao início vão por comando.
  const src = useMemo(() => {
    const q = new URLSearchParams({ enablejsapi: '1', rel: '0', playsinline: '1', origin: location.origin })
    if (synced) {
      q.set('start', String(Math.floor(playbackPosition(p, Date.now() + offset) / 1000)))
      if (p.playing) q.set('autoplay', '1')
    }
    if (content.loop) {
      q.set('loop', '1')
      q.set('playlist', id) // o YouTube só repete um vídeo como lista dele mesmo
    }
    return `https://www.youtube.com/embed/${id}?${q}`
  }, [id, content.loop])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false // o primeiro estado já foi no endereço
      return
    }
    if (!synced) return
    const send = (func: string, args: unknown[] = []) =>
      ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com')
    send('seekTo', [playbackPosition(p, Date.now() + offset) / 1000, true])
    send(p.playing ? 'playVideo' : 'pauseVideo')
    // Dependências nos campos de `playback`, não no objeto: cada snapshot traz um objeto novo.
  }, [synced, p.playing, p.startedAt, p.positionMs])

  if (mode !== 'screen') return <Placeholder icon={<FilmStripIcon size="1em" weight="bold" />} label="Vídeo do YouTube" />
  return (
    <iframe
      ref={ref}
      src={src}
      title="Vídeo do YouTube"
      className="absolute inset-0 size-full border-0"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      // O app manda "same-origin"; sem a origem de quem incorpora, o YouTube recusa tocar.
      referrerPolicy="strict-origin-when-cross-origin"
    />
  )
}

function FileVideo({ scene, content, live, offset, mode }: With<'video'>) {
  const ref = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const p = live.playback
  // Só a cena que o servidor marcou como tocando segue o relógio; prévia e miniatura ficam paradas no início.
  const synced = mode !== 'thumb' && p.sceneId === scene.id
  const { loop } = content

  useEffect(() => {
    const v = ref.current
    if (!v || !synced) return
    v.muted = mode !== 'screen'
    const sync = () => {
      const d = v.duration
      if (!(d > 0)) return // sem metadados ainda: 'loadedmetadata' chama de novo
      let t = playbackPosition(p, Date.now() + offset) / 1000
      if (!loop && t >= d) {
        if (!v.paused) v.pause()
        if (d - v.currentTime > 0.5) v.currentTime = d
        return
      }
      if (loop) t %= d
      const drift = Math.abs(v.currentTime - t)
      if (Math.min(drift, loop ? d - drift : drift) > 0.5) v.currentTime = t
      if (p.playing && v.paused)
        v.play().catch(() => {
          // Som bloqueado (página sem gesto do usuário): tocar mudo é melhor que congelar o quadro.
          if (v.muted) return
          v.muted = true
          v.play().catch(() => {})
        })
      else if (!p.playing && !v.paused) v.pause()
    }
    sync()
    v.addEventListener('loadedmetadata', sync)
    const timer = p.playing ? setInterval(sync, 1000) : undefined
    return () => {
      clearInterval(timer)
      v.removeEventListener('loadedmetadata', sync)
    }
    // Dependências nos campos de `playback`, não no objeto: cada snapshot traz um objeto novo.
  }, [synced, p.playing, p.startedAt, p.positionMs, offset, mode, loop])

  if (!content.src || failed)
    return mode === 'screen' ? null : <Placeholder icon={<FilmStripIcon size="1em" weight="bold" />} label={content.src ? 'Vídeo indisponível' : 'Sem vídeo'} />
  return (
    <video
      ref={ref}
      // Miniatura: o fragmento faz o Safari mostrar um quadro em vez de preto.
      src={mode === 'thumb' && !content.src.includes('#') ? `${content.src}#t=0.1` : content.src}
      className="absolute inset-0 size-full"
      style={{ objectFit: content.fit }}
      loop={loop}
      muted={mode !== 'screen'}
      playsInline
      disablePictureInPicture
      preload={synced ? 'auto' : 'metadata'}
      onError={() => setFailed(true)}
    />
  )
}

// ---------- página web ----------

function urlOf(s: string): URL | null {
  try {
    const url = new URL(s)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

/** Só o telão carrega a página. No console, um aviso calmo com o endereço (monitores e miniaturas ficam leves). */
function EmbedScene({ content, mode, theme, box }: With<'embed'>) {
  const url = urlOf(content.url)
  if (url && content.display === 'link') return <LinkView url={url} theme={theme} box={box} />
  if (mode !== 'screen') return <Placeholder icon={<GlobeIcon size="1em" weight="bold" />} label={url?.host ?? 'Sem endereço'} />
  if (!url) return null
  return (
    <iframe
      src={url.href}
      title={url.host}
      className="absolute inset-0 size-full border-0"
      // Sem formulários, pop-ups nem navegação da página da tela. Mesma origem não ganha allow-same-origin:
      // com scripts, ela poderia remover o próprio sandbox.
      sandbox={url.origin === location.origin ? 'allow-scripts allow-presentation' : 'allow-scripts allow-same-origin allow-presentation'}
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      // O app manda "same-origin"; players como o YouTube recusam incorporar sem a origem de quem incorpora.
      referrerPolicy="strict-origin-when-cross-origin"
    />
  )
}

/** Site que não abre dentro de outra página: endereço e QR code para o público abrir no celular. */
function LinkView({ url, theme, box }: { url: URL; theme: Theme; box: Box }) {
  const s = theme.scale
  const short = `${url.host}${url.pathname}${url.search}`.replace(/^www\./, '').replace(/\/$/, '')
  return (
    <div className={cx('absolute flex items-center', theme.align === 'center' && 'justify-center')} style={{ ...area(box), gap: u(72) }}>
      <QrTile value={url.href} size={420} radius={Math.min(theme.radius, 24)} label={`QR code de ${url.host}`} />
      <div className="flex min-w-0 flex-col font-body" style={{ gap: u(20) }}>
        <p className="text-fg-muted" style={{ fontSize: u(48 * s), lineHeight: 1.25 }}>
          Acesse pelo celular
        </p>
        <p className="font-semibold text-fg wrap-anywhere" style={{ fontSize: u(72 * s), lineHeight: 1.15, maxWidth: u(1100) }}>
          {short}
        </p>
      </div>
    </div>
  )
}

// ---------- entrada ----------

/**
 * A faixa de entrada em tela cheia, para o começo do evento: QR code grande, endereço para quem prefere digitar e
 * PIN. O QR começa com a altura da área do texto (até 42% da largura) e cede espaço até 300 para o texto caber ao
 * lado; se ainda assim não couber, o texto encolhe até 70% (--fit, em %) antes do aviso. Evento só com convidados:
 * sem QR, pede o link do convite.
 */
function JoinScene({ content, theme, box, joinUrl, pin, report }: With<'join'>) {
  const s = theme.scale
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useFit(outer, inner, report, JSON.stringify([content, box, s, theme.fonts, theme.aspect, joinUrl, pin]), { max: 100, min: 70 })
  const qr = Math.min(1080 - box.top - box.bottom, (CANVAS[theme.aspect].w - 2 * box.side) * 0.42)
  const fit = (n: number) => `calc(var(--u) * var(--fit, 100) * ${Math.round(n * s) / 100})` // n × escala × --fit%
  return (
    <div ref={outer} className={cx('absolute flex items-center', theme.align === 'center' && 'justify-center')} style={{ ...area(box), gap: u(96) }}>
      {joinUrl && <QrTile value={joinUrl} size={qr} min={300} radius={Math.min(theme.radius, 24)} label="QR code da página de entrada do evento" />}
      {/* Sem min-w-0: a coluna nunca fica mais estreita que a parte mais longa que não quebra (trecho do domínio, PIN). */}
      <div ref={inner} className="flex flex-col font-body" style={{ gap: fit(48) }}>
        {content.title && (
          <p
            className="font-heading tracking-tight text-balance text-fg wrap-anywhere"
            style={{ fontSize: fit(88), lineHeight: 1.15, fontWeight: 'var(--heading-weight)' }}
          >
            {content.title}
          </p>
        )}
        {joinUrl ? (
          <div className="flex flex-col" style={{ gap: fit(8) }}>
            <p className="text-pretty text-fg-muted" style={{ fontSize: fit(44), lineHeight: 1.25 }}>
              Aponte a câmera para o QR code ou acesse
            </p>
            <p className="font-semibold text-fg" style={{ fontSize: fit(64), lineHeight: 1.2 }}>
              <Address url={joinUrl} />
            </p>
          </div>
        ) : (
          <p className="font-semibold text-fg" style={{ fontSize: fit(56), lineHeight: 1.25 }}>
            Use o link do seu convite
          </p>
        )}
        <p className="flex items-baseline" style={{ gap: fit(24) }}>
          <span className="font-semibold text-fg-muted" style={{ fontSize: fit(48) }}>
            PIN
          </span>
          <span className="font-numbers font-semibold whitespace-nowrap text-fg tabular-nums" style={{ fontSize: fit(128), lineHeight: 1.1 }}>
            {group(pin)}
          </span>
        </p>
      </div>
    </div>
  )
}

function Placeholder({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-fg-muted" style={{ gap: u(24) }}>
      <span className="flex" style={{ fontSize: u(96) }}>
        {icon}
      </span>
      <p className="max-w-[80%] truncate font-body" style={{ fontSize: u(44) }}>
        {label}
      </p>
    </div>
  )
}

// ---------- perguntas ----------

function QuestionsScene({ content, questions, likes, theme, box, report }: With<'questions'>) {
  const s = theme.scale
  const spot = content.layout === 'spotlight'
  const center = theme.align === 'center'
  const list = visible(content, questions)
  const outer = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  // Destaque: 80 → 64, até 6 linhas. Mural e grade: 56 → 40. Nunca truncar: sem caber, avisa o console.
  const [max, min] = spot ? [80 * s, 64 * s] : [56 * s, 40 * s]
  useFit(
    outer,
    body,
    report,
    JSON.stringify([list.map((q) => [q.text, q.author]), content, box, s, theme.fonts, theme.aspect, theme.cardStyle]),
    { max, min, lines: spot ? 6 : undefined, hide: !spot },
  )
  return (
    <div className={cx('absolute flex flex-col', center && 'items-center')} style={area(box)}>
      {content.title && (
        <p className="shrink-0 font-body font-semibold text-accent-fg" style={{ fontSize: u(40 * s), lineHeight: 1.25, marginBottom: u(40 * s) }}>
          {content.title}
        </p>
      )}
      <div ref={outer} className={cx('flex min-h-0 w-full flex-1 flex-col', spot && 'justify-center', center && 'items-center')}>
        {list.length > 0 && (
          <div
            ref={body}
            className={cx('w-full shrink-0', content.layout === 'grid' ? 'grid grid-cols-2' : 'flex flex-col')}
            style={{ gap: u(24), maxWidth: spot ? u(1536) : undefined }}
          >
            {list.map((q) => (
              <QuestionCard key={q.id} q={q} likes={likes?.[q.id] ?? q.likes} spot={spot} fallback={max} content={content} theme={theme} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function QuestionCard({
  q,
  likes,
  spot,
  fallback,
  content,
  theme,
}: {
  q: PublicQuestion
  likes: number
  spot: boolean
  fallback: number
  content: SceneContent<'questions'>
  theme: Theme
}) {
  const s = theme.scale
  const author = content.showAuthor ? q.author : null // anônima: sem linha de autor
  const frame = card(theme, spot ? [56, 64] : [32, 40])
  return (
    <div className={cx('min-w-0 text-left', frame.className)} style={frame.style}>
      <p
        data-lines={spot || undefined}
        className={cx('font-body text-fg wrap-anywhere', spot ? 'font-semibold' : 'font-medium')}
        style={{ fontSize: `calc(var(--u) * var(--fit, ${fallback}))`, lineHeight: 1.2 }}
      >
        {q.text}
      </p>
      {/* A linha existe sempre que curtidas estão ligadas: a primeira curtida não muda a altura do cartão. */}
      {(author || content.showLikes) && (
        <div
          className="flex items-center justify-between font-body text-fg-muted"
          style={{ fontSize: u((spot ? 40 : 36) * s), lineHeight: 1.25, marginTop: u((spot ? 28 : 16) * s), gap: u(24) }}
        >
          <span className="min-w-0">{author}</span>
          {content.showLikes && (
            <span className={cx('flex shrink-0 items-center font-numbers tabular-nums', !likes && 'invisible')} style={{ gap: u(10) }}>
              <ThumbsUpIcon size="1em" weight="bold" alt="Curtidas" />
              {likes.toLocaleString('pt-BR')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- cronômetro ----------

function TimerScene({ scene, content, live, offset, mode, theme, box, amber }: With<'timer'>) {
  // O relógio do servidor só vale para a cena que o configurou; fora do ar, mostra a duração configurada.
  const t = live.timer.sceneId === scene.id ? live.timer : null
  const spec: TimerSpec = t ?? {
    mode: content.mode,
    durationMs: content.durationSec * 1000,
    warnMs: content.warnSec * 1000,
    criticalMs: content.criticalSec * 1000,
    onEnd: content.onEnd,
    endText: content.endText,
  }
  const view = (elapsed: number) => <TimerView face={timerFace(spec, elapsed)} label={content.title} theme={theme} box={box} amber={amber} />
  if (t?.running && mode !== 'thumb') return <Ticking>{(now) => view(timerElapsed(t, now + offset))}</Ticking>
  return view(t ? timerElapsed(t, Date.now() + offset) : 0)
}

/** Re-renderiza só enquanto o cronômetro corre: parado ou em miniatura, nada fica acordando a página. */
export function Ticking({ children }: { children: (now: number) => ReactNode }) {
  // 50 ms: cada tela vira o segundo no máximo 50 ms depois da hora certa (com 200, telas lado a lado discordavam).
  return children(useNow(50))
}

function TimerView({ face, label, theme, box, amber }: { face: TimerFace; label: string; theme: Theme; box: Box; amber: string }) {
  const s = theme.scale
  // Algarismos de 320 (×escala), limitados à largura útil: "1:02:03" não pode vazar em 4:3.
  const width = CANVAS[theme.aspect].w - 2 * box.side
  const size = face.message ? 150 * s : Math.min(320 * s, width / (face.text.length * 0.62))
  return (
    <div className={cx('absolute flex flex-col justify-center', theme.align === 'center' && 'items-center text-center')} style={area(box)}>
      {label && (
        <p className="font-body font-medium text-fg-muted wrap-anywhere" style={{ fontSize: u(56 * s), lineHeight: 1.25 }}>
          {label}
        </p>
      )}
      <p
        role="timer"
        className={cx(
          face.message ? 'font-heading tracking-tight text-balance wrap-anywhere' : 'font-numbers font-semibold whitespace-nowrap tabular-nums',
          face.tone === 'critical' ? 'text-critical' : face.tone === 'normal' && 'text-fg',
        )}
        style={{
          fontSize: u(size),
          lineHeight: face.message ? 1.15 : 1.1,
          fontWeight: face.message ? 'var(--heading-weight)' : undefined,
          color: face.tone === 'warn' ? amber : undefined,
          marginTop: label ? u(24 * s) : undefined,
        }}
      >
        {face.text}
      </p>
    </div>
  )
}
