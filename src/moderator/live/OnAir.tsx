// Controles do que está no ar: tela de espera, sobreposições, cronômetro e vídeo.
// Tudo aqui age direto na tela; o estado mostrado é sempre o do último snapshot.
import { useEffect, useState } from 'react'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/ArrowCounterClockwise'
import { PauseIcon } from '@phosphor-icons/react/Pause'
import { PlayIcon } from '@phosphor-icons/react/Play'
import { ProjectorScreenIcon } from '@phosphor-icons/react/ProjectorScreen'
import { clock } from '../../lib/format.ts'
import { useNow } from '../../lib/stream.ts'
import { Button, Kbd, Switch, cx } from '../../ui'
import { timerReadout, type Tone } from './logic.ts'
import {
  playbackPosition,
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
