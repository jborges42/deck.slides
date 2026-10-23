// Controles do que está no ar: tela de espera, sobreposições (faixa, reações, cronômetro e pergunta sobre o
// conteúdo), cronômetro, vídeo e slides da apresentação.
// Tudo aqui age direto na tela; o estado mostrado é sempre o do último snapshot.
import { useEffect, useRef, useState } from 'react'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/ArrowCounterClockwise'
import { ArrowLeftIcon } from '@phosphor-icons/react/ArrowLeft'
import { ArrowRightIcon } from '@phosphor-icons/react/ArrowRight'
import { PauseIcon } from '@phosphor-icons/react/Pause'
import { PlayIcon } from '@phosphor-icons/react/Play'
import { ProjectorScreenIcon } from '@phosphor-icons/react/ProjectorScreen'
import { TimerIcon } from '@phosphor-icons/react/Timer'
import { XIcon } from '@phosphor-icons/react/X'
import { clock } from '../../lib/format.ts'
import { useNow } from '../../lib/stream.ts'
import { Button, Field, Input, Kbd, Segmented, Switch, Tooltip, cx, undoable, type Option } from '../../ui'
import { manualTimer, parseDuration, timerInUse, timerReadout, type Tone } from './logic.ts'
import {
  playbackPosition,
  slideIndex,
  timerElapsed,
  type LiveCommand,
  type LiveState,
  type PlaybackState,
  type PublicQuestion,
  type Scene,
  type SceneContent,
  type TimerState,
} from '../../../shared/types.ts'

type Command = (cmd: LiveCommand) => Promise<unknown>

export function OnAirControls({
  live,
  program,
  offset,
  openJoin,
  onOpenJoin,
  question,
  command,
}: {
  live: LiveState
  program: Scene | null
  offset: number
  openJoin: boolean
  /** Liga a entrada aberta do evento (o QR só existe com ela). */
  onOpenJoin: () => void
  /** Pergunta sobre o conteúdo, já resolvida (`overlayQuestion`). */
  question: PublicQuestion | null
  command: Command
}) {
  const timer = timerInUse(live, program) ? live.timer : null
  const removeQuestion = async () => {
    const before = live.questionOverlay
    if (await command({ op: 'questionOverlay', questionId: null }))
      undoable('Pergunta removida de cima do conteúdo.', () => command({ op: 'questionOverlay', questionId: before }))
  }
  const video = program?.type === 'video' && live.playback.sceneId === program.id ? program.content : null
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
      <Button
        variant={live.standby ? 'ghost' : 'secondary'}
        aria-pressed={live.standby}
        icon={<ProjectorScreenIcon weight={live.standby ? 'fill' : 'regular'} />}
        className={live.standby ? 'border border-transparent text-on-signal! [--state-bg:var(--attention)]' : undefined}
        onClick={() => void command({ op: 'standby', on: !live.standby })}
      >
        Tela de espera
        <Kbd className={cx('ml-0.5', live.standby && 'border-current/40! text-current!')}>B</Kbd>
      </Button>
      <Switch label="Entrada (QR e PIN)" checked={live.overlays.join} onChange={(join) => void command({ op: 'overlays', join })} />
      <Switch label="Reações na tela" checked={live.overlays.reactions} onChange={(reactions) => void command({ op: 'overlays', reactions })} />
      <Switch label="Cronômetro sobre o conteúdo" checked={live.timerOverlay} onChange={(on) => void command({ op: 'timerOverlay', on })} />
      {live.overlays.join && (
        <div className="flex basis-full flex-col items-start gap-1.5">
          <span className="text-meta font-medium text-fg-muted">Posição da entrada</span>
          <Segmented
            size="sm"
            label="Posição da faixa de entrada"
            value={live.joinPosition}
            onChange={(joinPosition) => void command({ op: 'overlays', joinPosition })}
            options={EDGES}
          />
        </div>
      )}
      {/* Só convidados: faixa e cena de entrada mostram o PIN sem QR. Sem este aviso, parece que o QR não existe. */}
      {!openJoin && (
        <div className="flex basis-full items-center gap-3 text-meta text-fg-subtle">
          Sem QR code na tela: o evento aceita só convidados.
          <Button size="sm" onClick={onOpenJoin}>
            Ligar entrada aberta
          </Button>
        </div>
      )}
      {question && (
        <div className="flex basis-full items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-meta text-fg-muted">Pergunta sobre o conteúdo</span>
            <p className="line-clamp-2 text-read text-fg">{question.text}</p>
            {question.author && <span className="text-meta text-fg-subtle">{question.author}</span>}
          </div>
          <Button size="sm" icon={<XIcon />} onClick={() => void removeQuestion()}>
            Remover de cima do conteúdo
          </Button>
        </div>
      )}
      {timer && <TimerControls t={timer} offset={offset} command={command} />}
      {live.timerOverlay && (
        <div className="flex basis-full flex-wrap items-start gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-fg-muted">Posição na tela</span>
            <Segmented
              size="sm"
              label="Posição do cronômetro"
              value={live.timerCorner}
              onChange={(corner) => void command({ op: 'timerOverlay', corner })}
              options={CORNERS}
            />
          </div>
          {/* Definir à mão desvincula o cronômetro da cena: a cena de cronômetro no ar ficaria com a duração parada. */}
          {program?.type !== 'timer' && <SetTimer onSet={(s) => command(manualTimer(s))} />}
        </div>
      )}
      {video && <VideoControls p={live.playback} content={video} offset={offset} command={command} />}
      {program?.type === 'slides' && <SlidesControls scene={program} live={live} command={command} />}
    </div>
  )
}

/** Apresentação no ar: slide atual, anterior e próximo (também pelo teclado e pelo passador) e as miniaturas para pular. */
function SlidesControls({ scene, live, command }: { scene: Extract<Scene, { type: 'slides' }>; live: LiveState; command: Command }) {
  const { slides } = scene.content
  const i = slideIndex(live, scene)
  const strip = useRef<HTMLOListElement>(null)
  // Corpo em bloco: scrollIntoView devolve uma Promise no Chrome novo, e o React trataria como limpeza.
  useEffect(() => {
    strip.current?.children[i]?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [i])
  const go = (to: 'next' | 'prev' | number) => void command({ op: 'slide', to })
  if (!slides.length) return null
  return (
    <div className="flex min-w-0 basis-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="pr-1 text-ui text-fg tabular-nums">
          <span className="mr-2 text-meta text-fg-muted">Slide</span>
          {i + 1}
          <span className="text-fg-subtle"> de {slides.length}</span>
        </span>
        <Tooltip label="Seta para a esquerda ou Page Up">
          <Button size="sm" icon={<ArrowLeftIcon />} disabled={i === 0} onClick={() => go('prev')}>
            Anterior
          </Button>
        </Tooltip>
        <Tooltip label="Seta para a direita ou Page Down (o passador também serve)">
          <Button size="sm" icon={<ArrowRightIcon />} disabled={i >= slides.length - 1} onClick={() => go('next')}>
            Próximo
          </Button>
        </Tooltip>
      </div>
      <ol ref={strip} aria-label="Slides da apresentação no ar" className="flex gap-1.5 overflow-x-auto pb-1.5">
        {slides.map((src, j) => (
          <li key={`${j}:${src}`} className="shrink-0">
            <button
              type="button"
              aria-label={`Slide ${j + 1}`}
              aria-current={j === i || undefined}
              onClick={() => go(j)}
              className="relative block h-11 aspect-video overflow-hidden rounded-monitor bg-black"
            >
              <img src={src} alt="" loading="lazy" draggable={false} className="size-full object-contain" />
              <span aria-hidden className={cx('pointer-events-none absolute inset-0 rounded-monitor', j === i ? 'tally-program' : 'border border-line')} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

// Em cima, a faixa fica visível também para quem senta na frente, abaixo do telão.
const EDGES: Option<LiveState['joinPosition']>[] = [
  { value: 'top', label: 'Em cima' },
  { value: 'bottom', label: 'Embaixo' },
]

const CORNERS: Option<LiveState['timerCorner']>[] = [
  { value: 'top-left', label: 'Em cima à esquerda' },
  { value: 'top-right', label: 'Em cima à direita' },
]

/** Duração da fala sem cena de cronômetro, com a mesma leitura do inspetor ("5" = 5 min, "1:30"). */
function SetTimer({ onSet }: { onSet: (seconds: number) => Promise<unknown> }) {
  const [text, setText] = useState('')
  const parsed = parseDuration(text)
  const seconds = parsed !== null && parsed >= 1 && parsed <= 86_400 ? parsed : null
  const midway = /^\s*$|:\s*$/.test(text) // vazio ou "1:": ainda está sendo digitado
  return (
    // Formulário: Enter no campo também define.
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (seconds !== null) void onSet(seconds).then((ok) => ok && setText(''))
      }}
    >
      <Field label="Duração da fala" error={seconds !== null || midway ? null : 'Use minutos e segundos, como 05:00.'}>
        <div className="flex gap-2">
          <Input value={text} inputMode="numeric" placeholder="mm:ss" className="w-20" onChange={(e) => setText(e.target.value)} />
          <Button type="submit" icon={<TimerIcon />} disabled={seconds === null}>
            Definir tempo
          </Button>
        </div>
      </Field>
    </form>
  )
}

const TONE: Record<Tone, string> = { normal: 'text-fg', warn: 'text-attention', critical: 'text-critical' }

function TimerControls({ t, offset, command }: { t: TimerState; offset: number; command: Command }) {
  const now = useNow(t.running ? 200 : 60_000)
  const elapsed = timerElapsed(t, now + offset)
  const { text, tone } = timerReadout(t, elapsed)
  const add = (ms: number) => void command({ op: 'timer', action: 'add', ms })
  return (
    <div className="flex basis-full flex-wrap items-center gap-2">
      <span className="flex min-w-0 items-baseline gap-2 pr-1">
        <span className="truncate text-meta text-fg-muted">{t.label || 'Cronômetro'}</span>
        <span role="timer" className={cx('text-readout font-semibold tabular-nums', TONE[tone])}>
          {text}
        </span>
      </span>
      <Button
        size="sm"
        icon={t.running ? <PauseIcon /> : <PlayIcon />}
        kbd="T"
        onClick={() => void command({ op: 'timer', action: t.running ? 'pause' : 'start' })}
      >
        {t.running ? 'Pausar' : elapsed > 0 ? 'Continuar' : 'Iniciar'}
      </Button>
      <Button size="sm" icon={<ArrowCounterClockwiseIcon />} disabled={!t.running && !elapsed} onClick={() => void command({ op: 'timer', action: 'reset' })}>
        Zerar
      </Button>
      <Button size="sm" onClick={() => add(-60_000)}>
        −1&nbsp;min
      </Button>
      <Button size="sm" onClick={() => add(60_000)}>
        +1&nbsp;min
      </Button>
    </div>
  )
}

function VideoControls({ p, content, offset, command }: { p: PlaybackState; content: SceneContent<'video'>; offset: number; command: Command }) {
  const now = useNow(p.playing ? 250 : 60_000)
  const duration = useVideoDuration(content.src)
  let at = playbackPosition(p, now + offset)
  if (duration) at = content.loop ? at % duration : Math.min(at, duration)
  return (
    <div className="flex basis-full flex-wrap items-center gap-2">
      <span className="pr-1 text-ui text-fg tabular-nums">
        <span className="mr-2 text-meta text-fg-muted">Vídeo</span>
        {clock(at)}
        {duration ? <span className="text-fg-subtle"> / {clock(duration)}</span> : null}
      </span>
      <Button
        size="sm"
        icon={p.playing ? <PauseIcon /> : <PlayIcon />}
        kbd="P"
        onClick={() => void command({ op: 'playback', action: p.playing ? 'pause' : 'play' })}
      >
        {p.playing ? 'Pausar' : 'Tocar'}
      </Button>
      <Button size="sm" icon={<ArrowCounterClockwiseIcon />} onClick={() => void command({ op: 'playback', action: 'restart' })}>
        Voltar ao início
      </Button>
    </div>
  )
}

/** Duração do arquivo de vídeo (só os metadados são baixados). */
function useVideoDuration(src: string): number | null {
  const [ms, setMs] = useState<number | null>(null)
  useEffect(() => {
    setMs(null)
    if (!src) return
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => setMs(Number.isFinite(v.duration) ? v.duration * 1000 : null)
    v.src = src
    return () => {
      v.onloadedmetadata = null
      v.removeAttribute('src')
      v.load()
    }
  }, [src])
  return ms
}
