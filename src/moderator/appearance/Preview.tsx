// Pré-visualização da aparência: o mesmo <Stage> da tela, com conteúdo de exemplo e o tema em edição.
import { useEffect, useMemo, useState } from 'react'
import { CANVAS } from '../../lib/theme.ts'
import { Chip, Segmented, Switch, type Option } from '../../ui'
import { Stage } from '../../stage/Stage.tsx'
import { defaultLive, type PublicQuestion, type ReactionKind, type Scene, type Theme } from '../../../shared/types.ts'

type Sample = 'title' | 'question' | 'wall' | 'timer' | 'standby'

const SAMPLES: Option<Sample>[] = [
  { value: 'title', label: 'Título' },
  { value: 'question', label: 'Pergunta' },
  { value: 'wall', label: 'Mural' },
  { value: 'timer', label: 'Cronômetro' },
  { value: 'standby', label: 'Espera' },
]

const QUESTION: Scene = {
  id: 'amostra-pergunta',
  name: 'Pergunta em destaque',
  position: 1,
  type: 'questions',
  content: { title: 'Perguntas', layout: 'spotlight', max: 1, showAuthor: true, showLikes: false },
}
const WALL: Scene = {
  id: 'amostra-mural',
  name: 'Mural',
  position: 2,
  type: 'questions',
  content: { title: 'Perguntas', layout: 'list', max: 3, showAuthor: true, showLikes: true },
}
const TIMER: Scene = {
  id: 'amostra-cronometro',
  name: 'Intervalo',
  position: 3,
  type: 'timer',
  content: { title: 'Intervalo', mode: 'countdown', durationSec: 300, warnSec: 120, criticalSec: 30, onEnd: 'overtime', endText: 'Tempo encerrado' },
}

const SPOTLIGHT: PublicQuestion[] = [
  {
    id: 'amostra-1',
    text: 'Como vocês decidem quando vale a pena dividir um monólito em serviços menores, sem aumentar demais o custo de operação?',
    author: 'Ana S.',
    likes: 24,
  },
]
const MURAL: PublicQuestion[] = [
  { id: 'amostra-2', text: 'Quais métricas vocês acompanham para saber se uma arquitetura está envelhecendo mal?', author: 'Bruno M.', likes: 18 },
  { id: 'amostra-3', text: 'Como equilibrar prazos curtos com o tempo necessário para revisar decisões de arquitetura?', author: null, likes: 9 },
  { id: 'amostra-4', text: 'Que tipo de documentação ajuda uma equipe nova a entender um sistema legado?', author: 'Carla T.', likes: 5 },
]

// Cronômetro da cena de exemplo, parado em 05:00.
const BASE_LIVE = defaultLive()
const TIMER_STATE = { ...BASE_LIVE.timer, sceneId: TIMER.id, durationMs: 300_000, label: 'Intervalo', warnMs: 120_000, criticalMs: 30_000 }

export function Preview({
  theme,
  eventName,
  pin,
  joinUrl,
  reactions,
  offset,
}: {
  theme: Theme
  eventName: string
  pin: string
  joinUrl: string | null
  reactions: ReactionKind[]
  offset: number
}) {
  const [sample, setSample] = useState<Sample>('title')
  const [join, setJoin] = useState(false)
  const [showReactions, setShowReactions] = useState(false)
  const [totals, setTotals] = useState<Partial<Record<ReactionKind, number>>>({})
  const [overflow, setOverflow] = useState(false)

  // Reações de exemplo chegando, para ver a animação (ou o contador) com o tema em edição.
  const kinds = reactions.join()
  useEffect(() => {
    const list = kinds.split(',').filter(Boolean) as ReactionKind[]
    if (!showReactions || !list.length) return
    const id = setInterval(() => {
      const k = list[Math.floor(Math.random() * list.length)]
      setTotals((t) => ({ ...t, [k]: (t[k] ?? 0) + 1 + Math.floor(Math.random() * 3) }))
    }, 700)
    return () => clearInterval(id)
  }, [showReactions, kinds])

  const title = useMemo<Scene>(
    () => ({
      id: 'amostra-titulo',
      name: 'Abertura',
      position: 0,
      type: 'title',
      content: { kicker: eventName, title: 'Aula magna de arquitetura de software', body: 'Helena Duarte, Departamento de Computação' },
    }),
    [eventName],
  )
  const live = useMemo(
    () => ({ ...BASE_LIVE, timer: TIMER_STATE, overlays: { join, reactions: showReactions }, transition: theme.transition }),
    [join, showReactions, theme.transition],
  )
  const scene = { title, question: QUESTION, wall: WALL, timer: TIMER, standby: null }[sample]
  const { w, h } = CANVAS[theme.aspect]

  return (
    <section aria-label="Pré-visualização" className="flex min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-5 border-b border-line px-4">
        <Segmented size="sm" label="Conteúdo de exemplo" value={sample} onChange={setSample} options={SAMPLES} />
        <div className="flex items-center gap-4">
          <Switch label="Entrada" checked={join} onChange={setJoin} className="items-center" />
          <Switch
            label="Reações"
            checked={showReactions && reactions.length > 0}
            onChange={setShowReactions}
            disabled={!reactions.length}
            className="items-center"
          />
        </div>
      </div>

      {/* Monitor na proporção do tema, o maior que couber. */}
      <div className="grid min-h-0 flex-1 place-items-center p-6" style={{ containerType: 'size' }}>
        <div
          className="relative overflow-hidden rounded-monitor outline-1 outline-line"
          style={{ width: `min(100cqw, ${((100 * w) / h).toFixed(3)}cqh)`, aspectRatio: `${w} / ${h}` }}
        >
          <Stage
            className="absolute inset-0"
            mode="monitor"
            theme={theme}
            eventName={eventName}
            pin={pin}
            joinUrl={joinUrl}
            scene={scene}
            questions={sample === 'question' ? SPOTLIGHT : sample === 'wall' ? MURAL : []}
            live={live}
            standby={sample === 'standby'}
            reactions={totals}
            enabledReactions={reactions}
            offset={offset}
            onOverflow={setOverflow}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-6 pb-4 text-meta text-fg-subtle" aria-live="polite">
        {overflow ? (
          <>
            <Chip tone="attention">Não cabe na tela</Chip>
            Diminua a escala do texto ou a margem de segurança.
          </>
        ) : reactions.length ? (
          'Conteúdo de exemplo. Logo, nome e PIN são os do evento.'
        ) : (
          'Conteúdo de exemplo. Nenhuma reação liberada nos ajustes do evento.'
        )}
      </div>
    </section>
  )
}
