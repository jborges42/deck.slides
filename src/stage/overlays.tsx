// Sobreposições do palco: faixa de entrada (QR, endereço e PIN), reações da plateia e, sobre o conteúdo,
// cronômetro e pergunta.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { renderSVG } from 'uqr'
import { cx } from '../ui'
import { TIMER_CARD, addressParts, card, group, safeOf, timerFace, u, type TimerFace } from './lib.ts'
import { Crossfade, Ticking, useFit, type Box } from './scenes.tsx'
import { REACTION, ReactionEmoji } from '../lib/reactions.tsx'
import { REACTIONS, timerElapsed, type LiveState, type PublicQuestion, type ReactionKind, type Theme, type TimerState } from '../../shared/types.ts'

// ---------- entrada ----------

// Lado do QR da faixa. Medido com leitores em tempo real (prévia de ~1920 px): lido até umas 4 vezes a altura da
// tela (8 m numa tela de 2 m). O fundo do auditório precisa da cena Entrada, que chega a umas 9 vezes.
const QR = 300
const PAD = 40
const INVITE = 160 // altura das duas linhas do evento só com convidados

/** Altura da faixa de entrada, medida da borda do canvas em que ela fica (inclui a margem de segurança). */
export const bandHeight = (theme: Theme, qr: boolean) => safeOf(theme) + PAD + (qr ? QR : INVITE)

/**
 * QR escuro sobre ladrilho branco (ECC M, borda de 4 módulos), com lado `size` em unidades do canvas. Com `min`,
 * cede espaço numa linha flexível até esse lado, sempre quadrado.
 */
export function QrTile({ value, size, min = size, radius, label }: { value: string; size: number; min?: number; radius: number; label: string }) {
  const svg = useMemo(() => renderSVG(value, { ecc: 'M', border: 4, pixelSize: 1, blackColor: '#000', whiteColor: '#fff' }), [value])
  return (
    <div
      role="img"
      aria-label={label}
      className="aspect-square overflow-hidden [&>svg]:block [&>svg]:size-full"
      style={{ width: u(size), minWidth: u(min), flexShrink: min < size ? 1 : 0, borderRadius: u(radius), shapeRendering: 'crispEdges' }}
      // seguro: SVG gerado aqui pelo uqr a partir de um endereço; só retângulos, sem texto
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** Endereço sem "https://", que só quebra entre as partes de `addressParts` ("site.com.br" / "/e/K7QX2M"). */
export function Address({ url }: { url: string }) {
  return (
    <>
      {addressParts(url).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          <span className="whitespace-nowrap">{part}</span>
        </Fragment>
      ))}
    </>
  )
}

/**
 * Faixa de ponta a ponta, em cima ou embaixo (a margem de segurança fica do lado da borda). QR escuro sobre
 * ladrilho branco, endereço sem "https://", PIN 3 + 3.
 */
export function JoinBand(p: { theme: Theme; joinUrl: string | null; pin: string; show: boolean; at: LiveState['joinPosition'] }) {
  const { theme, joinUrl, pin, show } = p
  const safe = safeOf(theme)
  const top = p.at === 'top'
  return (
    <div
      aria-hidden={!show || undefined}
      className={cx('pointer-events-none absolute inset-x-0 bg-surface', top ? 'top-0' : 'bottom-0')}
      style={{ height: u(bandHeight(theme, !!joinUrl)), opacity: show ? 1 : 0, transition: 'opacity 300ms linear' }}
    >
      <div
        className={cx('absolute flex items-center', theme.align === 'center' && 'justify-center')}
        style={{ top: u(top ? safe : PAD), bottom: u(top ? PAD : safe), left: u(safe), right: u(safe), gap: u(56) }}
      >
        {joinUrl && <QrTile value={joinUrl} size={QR} radius={Math.min(theme.radius, 24)} label="QR code do endereço de entrada" />}
        <div className="flex min-w-0 flex-col font-body" style={{ gap: u(12) }}>
          {joinUrl ? (
            <>
              <p className="text-fg-muted" style={{ fontSize: u(40), lineHeight: 1.25 }}>
                Participe pelo celular
              </p>
              <p className="font-semibold text-fg" style={{ fontSize: u(48), lineHeight: 1.25 }}>
                <Address url={joinUrl} />
              </p>
            </>
          ) : (
            <p className="font-semibold text-fg" style={{ fontSize: u(48), lineHeight: 1.25 }}>
              Use o link do seu convite
            </p>
          )}
          <p className="flex items-baseline" style={{ gap: u(20), marginTop: u(8) }}>
            <span className="font-semibold text-fg-muted" style={{ fontSize: u(40) }}>
              PIN
            </span>
            <span className="font-numbers font-semibold whitespace-nowrap text-fg tabular-nums" style={{ fontSize: u(72), lineHeight: 1.1 }}>
              {group(pin)}
            </span>
          </p>
        </div>
      </div>
    </div>
  )
}

// ---------- reações ----------

type Totals = Partial<Record<ReactionKind, number>>


interface ReactionsProps {
  theme: Theme
  totals?: Totals
  enabled: ReactionKind[]
  sceneId: string
  /** Distância da base do canvas até a faixa (acima do rodapé ou da faixa de entrada). */
  bottom: number
}

/** Canto inferior direito, dentro da área segura: ícones que sobem ("animated") ou um placar discreto ("counter"). */
export function Reactions(p: ReactionsProps) {
  return p.theme.reactionsStyle === 'counter' ? <Counter {...p} /> : <Lane {...p} />
}

function Counter({ theme, totals, enabled, bottom }: ReactionsProps) {
  if (!enabled.length) return null
  const frame = card(theme, [14, 28])
  return (
    <div
      className={cx('absolute flex items-center', frame.className)}
      style={{ ...frame.style, right: u(safeOf(theme)), bottom: u(bottom), gap: u(36) }}
    >
      {enabled.map((kind) => {
        const n = totals?.[kind] ?? 0
        return (
          <span key={kind} className="flex items-center" style={{ gap: u(12) }}>
            <ReactionEmoji kind={kind} alt={REACTION[kind].label} className="block" style={{ fontSize: u(56) }} />
            <span className="font-numbers font-semibold text-fg tabular-nums" style={{ fontSize: u(48) }}>
              {n.toLocaleString('pt-BR')}
            </span>
          </span>
        )
      })}
    </div>
  )
}

interface Burst {
  id: number
  kind: ReactionKind
  x: number
  drift: number
  delay: number
}

const LIFE = 5000 // sobe devagar e fica inteira até três quartos do caminho (keyframes `rise` em styles.css)
const LANE = 240 // largura da faixa: ícones de 64 espalhados, sem empilhar
const MAX_ALIVE = 16
const PER_KIND = 4 // por lote de totais (até 4 por segundo)
let seq = 0

function Lane({ theme, totals, sceneId, bottom }: ReactionsProps) {
  const [items, setItems] = useState<Burst[]>([])
  const [extra, setExtra] = useState(0)
  const alive = useRef(0)
  const base = useRef<{ scene: string; totals?: Totals; at: number } | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const b = base.current
    // Primeira renderização ou outra cena: os totais atuais viram a base, sem animar o que já existia.
    if (!b || b.scene !== sceneId) {
      base.current = { scene: sceneId, totals, at: performance.now() }
      return
    }
    const prev = b.totals
    b.totals = totals
    // Totais que chegam logo depois de montar (o SSE manda `counts` após o snapshot) também são só base.
    if (!totals || (!prev && performance.now() - b.at < 1500)) return
    const add: Burst[] = []
    let over = 0
    for (const kind of REACTIONS) {
      const n = (totals[kind] ?? 0) - (prev?.[kind] ?? 0)
      if (n <= 0) continue
      const spawn = Math.max(0, Math.min(n, PER_KIND, MAX_ALIVE - alive.current - add.length))
      for (let i = 0; i < spawn; i++)
        add.push({ id: ++seq, kind, x: Math.random(), drift: Math.random() * 48 - 24, delay: Math.random() * 800 })
      over += n - spawn
    }
    if (add.length) {
      alive.current += add.length
      setItems((list) => [...list, ...add])
      // Timer em vez de animationend: some mesmo se o palco estiver oculto (animação parada).
      const t = setTimeout(() => {
        timers.current.delete(t)
        alive.current -= add.length
        setItems((list) => list.filter((i) => !add.includes(i)))
      }, LIFE + 850)
      timers.current.add(t)
    }
    if (over) {
      // Excedente agregado num "+N" discreto, visível até 1,5 s depois do último lote que passou do limite.
      setExtra((e) => e + over)
      clearTimeout(hide.current)
      hide.current = setTimeout(() => setExtra(0), 1500)
    }
  }, [totals, sceneId])

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach(clearTimeout)
      clearTimeout(hide.current)
    }
  }, [])

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{ right: u(safeOf(theme)), bottom: u(bottom), width: u(LANE), height: u(480) }}
    >
      {items.map((b) => {
        return (
          <span
            key={b.id}
            className="absolute flex"
            style={
              {
                left: u(b.x * (LANE - 80)),
                bottom: u(48),
                fontSize: u(80),
                '--drift': u(b.drift),
                animation: `rise ${LIFE}ms linear ${Math.round(b.delay)}ms both`,
              } as CSSProperties
            }
          >
            <ReactionEmoji kind={b.kind} />
          </span>
        )
      })}
      {extra > 0 && (
        <span className="absolute right-0 bottom-0 font-numbers text-fg-muted tabular-nums" style={{ fontSize: u(36), lineHeight: 1.25 }}>
          +{extra.toLocaleString('pt-BR')}
        </span>
      )}
    </div>
  )
}

// ---------- sobre o conteúdo ----------

interface TimerOverlayProps {
  timer: TimerState
  offset: number
  theme: Theme
  corner: LiveState['timerCorner']
  /** Distância do topo do canvas: `timerOverlayTop` ou, com a faixa de entrada em cima, logo abaixo dela. */
  top: number
  /** Âmbar do aviso com contraste garantido sobre o cartão (`surface`), não sobre o fundo. */
  amber: string
}

/**
 * Cronômetro ao vivo num canto de cima, sobre qualquer cena. Cartão sempre sólido: fica sobre slide, imagem e vídeo
 * e precisa de contraste garantido. Só ele re-renderiza enquanto corre; parado, nada acorda a página.
 */
export function TimerOverlay({ timer, offset, ...rest }: TimerOverlayProps) {
  const view = (elapsed: number) => <TimerCard face={timerFace(timer, elapsed)} label={timer.label.trim()} {...rest} />
  if (timer.running) return <Ticking>{(now) => view(timerElapsed(timer, now + offset))}</Ticking>
  return view(timerElapsed(timer, Date.now() + offset))
}

function TimerCard({ face, label, theme, corner, top, amber }: Omit<TimerOverlayProps, 'timer' | 'offset'> & { face: TimerFace; label: string }) {
  const s = theme.scale
  const t = TIMER_CARD
  const right = corner === 'top-right'
  return (
    <div
      className={cx('pointer-events-none absolute flex flex-col bg-surface', right && 'items-end text-right')}
      style={{
        top: u(top),
        [right ? 'right' : 'left']: u(safeOf(theme)),
        borderRadius: u(theme.radius),
        padding: `${u(t.pad[0])} ${u(t.pad[1])}`,
      }}
    >
      {label && (
        <p
          className="font-body text-fg-muted wrap-anywhere"
          style={{ fontSize: u(t.label * s), lineHeight: 1.25, maxWidth: u(t.width * s), marginBottom: u(t.gap * s) }}
        >
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
          fontSize: u((face.message ? t.message : t.digits) * s),
          lineHeight: face.message ? 1.15 : 1.1,
          fontWeight: face.message ? 'var(--heading-weight)' : undefined,
          maxWidth: face.message ? u(t.width * s) : undefined,
          color: face.tone === 'warn' ? amber : undefined,
        }}
      >
        {face.text}
      </p>
    </div>
  )
}

interface QuestionOverlayProps {
  /** null = nenhuma: a anterior sai na mesma fusão. */
  q: PublicQuestion | null
  theme: Theme
  /** Área onde o cartão cabe: base na da cena; topo na da cena ou abaixo do cronômetro (questionOverlayTop). */
  box: Box
  /** Fusão ao trocar, aparecer ou sair; 0 = corte. */
  ms: number
  report: (overflow: boolean) => void
}

/**
 * Pergunta sobre o conteúdo: cartão sólido na base da área da cena, que cresce para cima. Um véu da cor de fundo
 * recua a cena (que continua visível): sem ele, no tema padrão o cartão quase some no fundo e corta o título ao meio.
 */
export function QuestionOverlay({ q, ms, ...rest }: QuestionOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0">
      <Crossfade id={q ? JSON.stringify([q.id, q.text, q.author]) : 'none'} ms={ms}>
        {q && (
          <>
            <div className="absolute inset-0 bg-canvas" style={{ opacity: QUESTION_VEIL }} />
            <QuestionOnTop q={q} {...rest} />
          </>
        )}
      </Crossfade>
    </div>
  )
}

const QUESTION_VEIL = 0.7

/** Texto de 72 até 40 (× escala) para caber; nem assim, avisa o console. Nunca trunca. */
function QuestionOnTop({ q, theme, box, report }: Omit<QuestionOverlayProps, 'ms'> & { q: PublicQuestion }) {
  const s = theme.scale
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useFit(outer, inner, report, JSON.stringify([q.text, q.author, box, s, theme.fonts, theme.aspect]), { max: 72 * s, min: 40 * s })
  return (
    <div
      ref={outer}
      className={cx('absolute flex flex-col justify-end', theme.align === 'center' ? 'items-center' : 'items-start')}
      style={{ top: u(box.top), bottom: u(box.bottom), left: u(box.side), right: u(box.side) }}
    >
      <div
        ref={inner}
        className="shrink-0 bg-surface text-left font-body wrap-anywhere"
        style={{ maxWidth: u(1536), borderRadius: u(theme.radius), padding: `${u(48)} ${u(64)}` }}
      >
        <p className="font-semibold text-fg" style={{ fontSize: `calc(var(--u) * var(--fit, ${72 * s}))`, lineHeight: 1.2 }}>
          {q.text}
        </p>
        {q.author && (
          <p className="text-fg-muted" style={{ fontSize: u(40 * s), lineHeight: 1.25, marginTop: u(24 * s) }}>
            {q.author}
          </p>
        )}
      </div>
    </div>
  )
}
