// Controles do que está no ar: tela de espera, sobreposições, cronômetro, vídeo e slides da apresentação.
// Tudo aqui age direto na tela; o estado mostrado é sempre o do último snapshot.
import { useEffect, useRef, useState } from 'react'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/ArrowCounterClockwise'
import { ArrowLeftIcon } from '@phosphor-icons/react/ArrowLeft'
import { ArrowRightIcon } from '@phosphor-icons/react/ArrowRight'
import { PauseIcon } from '@phosphor-icons/react/Pause'
import { PlayIcon } from '@phosphor-icons/react/Play'
import { ProjectorScreenIcon } from '@phosphor-icons/react/ProjectorScreen'
import { clock } from '../../lib/format.ts'
import { useNow } from '../../lib/stream.ts'
import { Button, Kbd, Switch, Tooltip, cx } from '../../ui'
import { timerReadout, type Tone } from './logic.ts'
import {
  playbackPosition,
  slideIndex,
  timerElapsed,
  type LiveCommand,
  type LiveState,
  type PlaybackState,
  type Scene,
  type SceneContent,
  type TimerState,
} from '../../../shared/types.ts'

type Command = (cmd: LiveCommand) => Promise<unknown>

export function OnAirControls({ live, program, offset, command }: { live: LiveState; program: Scene | null; offset: number; command: Command }) {
  const timer = program?.type === 'timer' || live.timer.running ? live.timer : null
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
      {timer && <TimerControls t={timer} offset={offset} command={command} />}
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
