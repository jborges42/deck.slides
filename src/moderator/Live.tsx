// Ao vivo: roteiro | prévia e no ar, controles e inspetor | perguntas.
// Os monitores mostram só o estado confirmado pelo servidor; a prévia inclui as edições locais da cena.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownIcon } from '@phosphor-icons/react/ArrowDown'
import { ArrowLeftIcon } from '@phosphor-icons/react/ArrowLeft'
import { ArrowRightIcon } from '@phosphor-icons/react/ArrowRight'
import { ArrowUpIcon } from '@phosphor-icons/react/ArrowUp'
import { BroadcastIcon } from '@phosphor-icons/react/Broadcast'
import { CommandIcon } from '@phosphor-icons/react/Command'
import { KeyboardIcon } from '@phosphor-icons/react/Keyboard'
import { patch, post } from '../lib/api.ts'
import { useHotkeys, type Hotkeys } from '../lib/hotkeys.ts'
import { CANVAS } from '../lib/theme.ts'
import { Button, Chip, Dialog, Empty, IconButton, Kbd, Segmented, Tooltip, cx, notify, undoLast } from '../ui'
import { Stage } from '../stage/Stage.tsx'
import { Queue } from './Queue.tsx'
import { run, useEvent } from './context.ts'
import { useDrafts } from './live/drafts.ts'
import { Inspector } from './live/Inspector.tsx'
import { playable, takeBlocker, timerInUse } from './live/logic.ts'
import { OnAirControls } from './live/OnAir.tsx'
import { Rundown } from './live/Rundown.tsx'
import { onScreen, overlayQuestion, slideIndex, type LiveCommand, type Scene } from '../../shared/types.ts'

type Transition = 'cut' | 'fade'

export default function Live() {
  const ctx = useEvent()
  const { id, snap, counts, offset } = ctx
  const { event, scenes } = snap
  const { live, settings, theme } = event
  const program = scenes.find((s) => s.id === live.program) ?? null
  const cued = scenes.find((s) => s.id === live.preview) ?? null
  const drafts = useDrafts(id, scenes, live.program)
  const draft = cued && drafts.drafts[cued.id]
  const preview = cued && draft ? ({ ...cued, name: draft.name, content: draft.content } as Scene) : cued

  const [transition, setTransition] = useTakeTransition(id, theme.transition)
  const [pending, setPending] = useState<number | null>(null) // takenAt de antes do corte, até o snapshot confirmar
  const [help, setHelp] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [previewOverflow, setPreviewOverflow] = useState(false)
  const [programOverflow, setProgramOverflow] = useState(false)
  const lastTake = useRef(0)
  const editor = useRef<HTMLDivElement>(null)

  const command = (cmd: LiveCommand) => run(() => post(`/events/${id}/live`, cmd))
  const blocker = takeBlocker(preview, live.program)

  const take = async (t: Transition) => {
    // Toque duplo viraria corte + desfazer (prévia e no ar trocam de lugar).
    if (pending !== null || Date.now() - lastTake.current < 500) return
    if (blocker) {
      notify(blocker)
      return
    }
    lastTake.current = Date.now()
    setPending(live.takenAt)
    await drafts.flush() // o que vai ao ar é o que está no monitor da prévia
    if (!(await command({ op: 'take', transition: t }))) setPending(null)
  }

  useEffect(() => setPending(null), [live.takenAt])
  useEffect(() => {
    if (pending === null) return
    const t = setTimeout(() => setPending(null), 5000) // nunca prender o botão se a confirmação se perder
    return () => clearTimeout(t)
  }, [pending])

  const cue = (sceneId: string) => {
    if (sceneId !== live.preview) void command({ op: 'preview', sceneId })
  }
  const edit = (sceneId: string) => {
    cue(sceneId)
    setFocusId(sceneId)
  }
  // "Editar" e "Nova cena": o primeiro campo ganha foco quando a cena chega à prévia.
  useEffect(() => {
    if (!focusId || live.preview !== focusId) return
    const root = editor.current
    ;(root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('input, textarea, [role="combobox"]'))?.focus()
    setFocusId(null)
  }, [focusId, live.preview])

  // Teclas de cena (1 a 0, ↑/↓) contam só o que vai para a tela: títulos de pasta ficam de fora.
  const cues = playable(scenes)
  const step = (delta: number) => {
    const at = cues.findIndex((s) => s.id === (live.preview ?? live.program))
    const next = cues[at < 0 ? 0 : Math.min(cues.length - 1, Math.max(0, at + delta))]
    if (next) cue(next.id)
  }
  const slide = (to: 'next' | 'prev') => program?.type === 'slides' && void command({ op: 'slide', to })
  const timerOn = timerInUse(live, program)
  const videoOn = program?.type === 'video' && live.playback.sceneId === program.id

  const keys: Hotkeys = {
    Space: () => void take('cut'),
    Enter: () => void take('fade'),
    ArrowUp: () => step(-1),
    ArrowDown: () => step(1),
    // Apresentação no ar: setas e Page Up/Down (as teclas que os passadores sem fio enviam).
    ArrowRight: () => slide('next'),
    ArrowLeft: () => slide('prev'),
    PageDown: () => slide('next'),
    PageUp: () => slide('prev'),
    KeyB: () => void command({ op: 'standby', on: !live.standby }),
    KeyT: () => timerOn && void command({ op: 'timer', action: live.timer.running ? 'pause' : 'start' }),
    KeyP: () => videoOn && void command({ op: 'playback', action: live.playback.playing ? 'pause' : 'play' }),
    'Mod+KeyZ': () => void undoLast(),
    'Shift+Slash': () => setHelp(true),
    'Shift+IntlRo': () => setHelp(true), // "?" no teclado ABNT2
  }
  for (let i = 0; i < 10; i++) keys[`Digit${(i + 1) % 10}`] = () => cues[i] && cue(cues[i].id)
  useHotkeys(keys)

  const { w, h } = CANVAS[theme.aspect]
  const overlay = overlayQuestion(snap.questions, live.questionOverlay, settings.screenName)
  const stage = {
    theme,
    eventName: event.name,
    pin: event.pin,
    joinUrl: settings.openJoin ? ctx.links.join : null,
    questionOverlay: overlay,
    likes: counts.likes,
    live,
    enabledReactions: settings.reactions,
    offset,
    mode: 'monitor' as const,
    className: 'size-full',
  }
  const questions = (s: Scene | null) => (s?.type === 'questions' ? onScreen(snap.questions, s.content.max, settings.screenName) : [])

  return (
    <div className="grid h-full grid-cols-[264px_minmax(0,1fr)_440px] grid-rows-[minmax(0,1fr)] min-[1920px]:grid-cols-[300px_minmax(0,1fr)_520px]">
      <Rundown ctx={ctx} onCue={cue} onEdit={edit} />

      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto">
        <div className="grid shrink-0 grid-cols-2 gap-x-4 px-4 pt-3 pb-4">
          <section aria-label="Prévia" className="flex min-w-0 flex-col gap-2">
            <MonitorHead chip={<Chip tone="preview">Prévia</Chip>} name={preview?.name ?? ''}>
              {preview && previewOverflow && <Chip tone="attention">Não cabe na tela</Chip>}
            </MonitorHead>
            <Monitor ratio={`${w} / ${h}`} tally={preview ? 'preview' : null}>
              {preview ? (
                <Stage {...stage} scene={preview} questions={questions(preview)} standby={false} onOverflow={setPreviewOverflow} />
              ) : (
                <p className="grid size-full place-items-center bg-canvas text-meta text-fg-subtle">Nada na prévia</p>
              )}
            </Monitor>
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 pt-1">
              <Tooltip label="Atalhos de teclado" kbd="?">
                <IconButton label="Atalhos de teclado" size="sm" icon={<KeyboardIcon />} className="mr-auto" onClick={() => setHelp(true)} />
              </Tooltip>
              <Segmented
                label="Transição"
                value={transition}
                onChange={setTransition}
                options={[
                  { value: 'cut', label: 'Corte' },
                  { value: 'fade', label: 'Fusão' },
                ]}
              />
              <Tooltip
                label={
                  <span className="flex items-center gap-1.5">
                    Corte <Kbd>Espaço</Kbd>
                    <span className="ml-1">Fusão</span> <Kbd>Enter</Kbd>
                  </span>
                }
              >
                <Button variant="program" size="lg" icon={<BroadcastIcon weight="fill" />} disabled={!!blocker} loading={pending !== null} onClick={() => void take(transition)}>
                  Colocar no ar
                  <Kbd className="ml-0.5 border-current/40! text-current!">{transition === 'cut' ? 'Espaço' : 'Enter'}</Kbd>
                </Button>
              </Tooltip>
              <p aria-live="polite" className="min-h-4 basis-full text-right text-meta text-fg-subtle">
                {blocker}
              </p>
            </div>
          </section>

          <section aria-label="No ar" className="flex min-w-0 flex-col gap-2">
            <MonitorHead chip={<Chip tone="program">No ar</Chip>} name={program?.name ?? 'Nada no ar'}>
              {/* Aparece só se a confirmação demorar: em rede boa, o corte chega antes de 200 ms. */}
              {pending !== null && (
                <Chip tone="attention" className="[animation:fade-in_1ms_200ms_both]">
                  Aguardando confirmação
                </Chip>
              )}
              {live.standby && <Chip tone="attention">Tela de espera</Chip>}
              {programOverflow && <Chip tone="attention">Não cabe na tela</Chip>}
            </MonitorHead>
            <Monitor ratio={`${w} / ${h}`} tally="program">
              <Stage
                {...stage}
                scene={program}
                questions={questions(program)}
                standby={live.standby}
                reactions={program ? counts.reactions[program.id] : undefined}
                onOverflow={setProgramOverflow}
              />
            </Monitor>
            <div className="pt-1">
              <OnAirControls
                live={live}
                program={program}
                offset={offset}
                openJoin={settings.openJoin}
                onOpenJoin={() => void run(() => patch(`/events/${id}`, { settings: { openJoin: true } }))}
                question={overlay}
                command={command}
              />
            </div>
          </section>
        </div>

        <div ref={editor} className="flex min-h-[240px] flex-1 flex-col border-t border-line bg-surface">
          {cued ? (
            <Inspector
              key={cued.id}
              eventId={id}
              scene={cued}
              draft={drafts.drafts[cued.id]}
              onAir={cued.id === live.program}
              state={drafts.states[cued.id]}
              media={snap.media}
              onChange={(d) => drafts.edit(cued.id, d)}
              onPublish={() => void drafts.save(cued.id)}
              onDiscard={() => drafts.discard(cued.id)}
              slide={cued.type === 'slides' ? slideIndex(live, cued) : undefined}
              onSlide={(to) => void command({ op: 'slide', sceneId: cued.id, to })}
            />
          ) : (
            <Empty title="Nenhuma cena para editar">Escolha uma cena no roteiro. Ela aparece no monitor da prévia e pode ser editada aqui.</Empty>
          )}
        </div>
      </div>

      <aside aria-label="Perguntas" className="grid min-h-0 grid-rows-[minmax(0,1fr)] border-l border-line bg-surface">
        <Queue ctx={ctx} />
      </aside>

      <Shortcuts open={help} onOpenChange={setHelp} />
    </div>
  )
}

/** Transição do botão "Colocar no ar": a escolhida neste computador ou, sem escolha, a do tema. */
function useTakeTransition(eventId: string, fallback: Transition) {
  const key = `deck:transicao:${eventId}`
  const [value, setValue] = useState<Transition | null>(() => {
    try {
      const v = localStorage.getItem(key)
      return v === 'cut' || v === 'fade' ? v : null
    } catch {
      return null
    }
  })
  const set = (v: Transition) => {
    setValue(v)
    try {
      localStorage.setItem(key, v)
    } catch {
      // sem armazenamento (janela privada): vale só nesta sessão
    }
  }
  return [value ?? fallback, set] as const
}

function MonitorHead({ chip, name, children }: { chip: ReactNode; name: string; children?: ReactNode }) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-2">
      {chip}
      <span className="min-w-0 truncate text-ui text-fg-muted">{name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">{children}</span>
    </div>
  )
}

/** Monitor na proporção do evento; a moldura de tally fica por cima do conteúdo. */
function Monitor({ ratio, tally, children }: { ratio: string; tally: 'program' | 'preview' | null; children: ReactNode }) {
  return (
    <div className="relative w-full overflow-hidden rounded-monitor bg-black" style={{ aspectRatio: ratio }}>
      <div className="pointer-events-none absolute inset-0">{children}</div>
      <span
        aria-hidden
        className={cx(
          'pointer-events-none absolute inset-0 rounded-monitor',
          tally === 'program' ? 'tally-program' : tally === 'preview' ? 'tally-preview' : 'border border-line',
        )}
      />
    </div>
  )
}

// ---------- folha de atalhos ----------

const SHEET: { title: string; keys: [ReactNode[], string][] }[] = [
  {
    title: 'Ao vivo',
    keys: [
      [['Espaço'], 'Corte: a prévia vai ao ar. Cortar de novo desfaz.'],
      [['Enter'], 'Fusão'],
      [['1–9', '0'], 'Cena 1 a 10 do roteiro para a prévia'],
      [[<ArrowUpIcon key="u" size={11} />, <ArrowDownIcon key="d" size={11} />], 'Cena anterior ou seguinte para a prévia'],
      [[<ArrowLeftIcon key="l" size={11} />, <ArrowRightIcon key="r" size={11} />], 'Slide anterior ou seguinte da apresentação no ar (Page Up e Page Down do passador também)'],
      [['B'], 'Liga e desliga a tela de espera'],
      [['T'], 'Inicia e pausa o cronômetro'],
      [['P'], 'Toca e pausa o vídeo'],
    ],
  },
  {
    title: 'Fila de perguntas',
    keys: [
      [['J', 'K'], 'Próxima e anterior na fila'],
      [['A'], 'Aprovar'],
      [['R'], 'Rejeitar'],
      [['E'], 'Editar'],
      [['D'], 'Destacar na tela, só esta pergunta'],
      [['S'], 'Sobrepor a pergunta ao conteúdo no ar; de novo, remove'],
      [['M'], 'Marcar como respondida'],
      [['X'], 'Selecionar várias'],
      [['/'], 'Buscar perguntas'],
    ],
  },
  {
    title: 'Geral',
    keys: [
      [[<span key="m" className="flex items-center gap-0.5"><CommandIcon size={11} />Z</span>, 'Ctrl+Z'], 'Desfazer a última ação'],
      [['?'], 'Mostrar os atalhos'],
    ],
  },
]

function Shortcuts({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Atalhos de teclado" description="Não valem enquanto você digita num campo ou com um diálogo aberto." width={520}>
      <div className="flex flex-col gap-5">
        {SHEET.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-meta font-medium text-fg-muted">{group.title}</h3>
            <dl className="grid grid-cols-[112px_1fr] items-center gap-x-4 gap-y-2 text-ui">
              {group.keys.map(([keys, label]) => (
                <Fragment key={label}>
                  <dt className="flex items-center gap-1">
                    {keys.map((k, i) => (
                      <Kbd key={i}>{k}</Kbd>
                    ))}
                  </dt>
                  <dd className="text-fg">{label}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
