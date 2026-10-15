// Roteiro: as cenas na ordem do evento. Clique leva à prévia (nunca ao ar); arrastar reordena.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ArrowDownIcon } from '@phosphor-icons/react/ArrowDown'
import { ArrowUpIcon } from '@phosphor-icons/react/ArrowUp'
import { CopyIcon } from '@phosphor-icons/react/Copy'
import { DotsThreeVerticalIcon } from '@phosphor-icons/react/DotsThreeVertical'
import { PencilSimpleIcon } from '@phosphor-icons/react/PencilSimple'
import { PlusIcon } from '@phosphor-icons/react/Plus'
import { TrashIcon } from '@phosphor-icons/react/Trash'
import { del, post } from '../../lib/api.ts'
import { plural } from '../../lib/format.ts'
import { CANVAS } from '../../lib/theme.ts'
import { Button, Chip, Empty, IconButton, Menu, Panel, confirm, cx, notify, type ButtonVariant } from '../../ui'
import { Stage, type StageProps } from '../../stage/Stage.tsx'
import { run, type EventContext } from '../context.ts'
import { KIND, KINDS } from './kinds.ts'
import { DEFAULT_CONTENT, moveId, sceneDetail } from './logic.ts'
import { onScreen, type Scene, type SceneType } from '../../../shared/types.ts'

type Action = 'cue' | 'edit' | 'duplicate' | 'up' | 'down' | 'remove'
type Thumb = Omit<StageProps, 'scene' | 'mode' | 'standby'> & { w: number; h: number }

export function Rundown({ ctx, onCue, onEdit }: { ctx: EventContext; onCue: (id: string) => void; onEdit: (id: string) => void }) {
  const { id: eventId, snap, counts, offset, links } = ctx
  const { event, scenes } = snap
  const { live, settings, theme } = event
  const [order, setOrder] = useState<string[] | null>(null) // ordem nova enquanto o servidor não confirma
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => setOrder(null), [scenes])

  // Cena levada à prévia pelo teclado: o roteiro rola até ela.
  useEffect(() => {
    if (live.preview) list.current?.querySelector(`[data-scene="${CSS.escape(live.preview)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [live.preview])

  const rows = order ? order.map((id) => scenes.find((s) => s.id === id)).filter((s): s is Scene => !!s) : scenes
  const ids = rows.map((s) => s.id)

  const reorder = (next: string[]) => {
    if (next.every((id, i) => id === ids[i])) return
    setOrder(next)
    void run(() => post(`/events/${eventId}/scenes/order`, { ids: next })).then((ok) => ok || setOrder(null))
  }

  const create = async (type: SceneType) => {
    const { label } = KIND[type]
    const n = scenes.filter((s) => s.type === type).length
    const res = await run(() =>
      post<{ id: string }>(`/events/${eventId}/scenes`, { type, name: n ? `${label} ${n + 1}` : label, content: DEFAULT_CONTENT[type] }),
    )
    if (res) onEdit(res.id)
  }

  const remove = async (s: Scene) => {
    const ok = await confirm({ title: 'Excluir a cena?', body: `“${s.name}” sai do roteiro. Não é possível desfazer.`, confirm: 'Excluir cena' })
    if (ok && (await run(() => del(`/events/${eventId}/scenes/${s.id}`)))) notify('Cena excluída.')
  }

  // Linhas memorizadas recebem uma função estável; ela sempre chama a versão mais nova das ações.
  const actions = useRef<(a: Action, s: Scene) => void>(() => {})
  actions.current = (a, s) => {
    const i = ids.indexOf(s.id)
    if (a === 'cue') onCue(s.id)
    else if (a === 'edit') onEdit(s.id)
    else if (a === 'duplicate') void run(() => post(`/events/${eventId}/scenes/${s.id}/duplicate`))
    else if (a === 'up' && i > 0) reorder(moveId(ids, s.id, ids[i - 1], false))
    else if (a === 'down' && i < ids.length - 1) reorder(moveId(ids, s.id, ids[i + 1], true))
    else if (a === 'remove') void remove(s)
  }
  const act = useCallback((a: Action, s: Scene) => actions.current(a, s), [])

  const { w, h } = CANVAS[theme.aspect]
  const tw = Math.min(64, (36 * w) / h)
  const questions = useMemo(() => onScreen(snap.questions, 12, settings.screenName), [snap.questions, settings.screenName])
  const thumb = useMemo<Thumb>(
    () => ({
      theme,
      eventName: event.name,
      pin: event.pin,
      joinUrl: settings.openJoin ? links.join : null,
      questions,
      live,
      enabledReactions: settings.reactions,
      offset,
      w: tw,
      h: (tw * h) / w,
    }),
    [theme, event.name, event.pin, settings.openJoin, settings.reactions, links.join, questions, live, offset, tw, w, h],
  )

  const rowOf = (e: DragEvent) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-scene]') : null)

  const newScene = (variant: ButtonVariant) => (
    <Menu
      align={variant === 'ghost' ? 'end' : 'start'}
      trigger={
        <Button size="sm" variant={variant} icon={<PlusIcon />}>
          Nova cena
        </Button>
      }
      items={KINDS.map((k) => ({ label: k.label, icon: <k.Icon />, onSelect: () => void create(k.type) }))}
    />
  )

  return (
    <Panel title="Roteiro" count={scenes.length || undefined} actions={newScene('ghost')} className="border-r border-line bg-surface">
      {rows.length ? (
        <ol
          ref={list}
          aria-label="Cenas do roteiro"
          onDragStart={(e) => {
            const id = rowOf(e)?.dataset.scene
            if (!id) return
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', id)
            setDrag({ id, over: null, after: false })
          }}
          onDragOver={(e) => {
            const row = rowOf(e)
            const over = row?.dataset.scene
            if (!drag || !row || !over) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const r = row.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            if (drag.over !== over || drag.after !== after) setDrag({ ...drag, over, after })
          }}
          onDragLeave={(e) => {
            if (drag && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag({ ...drag, over: null })
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (drag?.over) reorder(moveId(ids, drag.id, drag.over, drag.after))
            setDrag(null)
          }}
          onDragEnd={() => setDrag(null)}
        >
          {rows.map((s, i) => (
            <Row
              key={s.id}
              scene={s}
              index={i}
              last={i === rows.length - 1}
              onAir={s.id === live.program}
              inPreview={s.id === live.preview}
              reactions={Object.values(counts.reactions[s.id] ?? {}).reduce<number>((a, b) => a + (b ?? 0), 0)}
              drop={drag && drag.over === s.id && drag.id !== s.id ? (drag.after ? 'after' : 'before') : null}
              dragging={drag?.id === s.id}
              thumb={thumb}
              act={act}
            />
          ))}
        </ol>
      ) : (
        <Empty title="Nenhuma cena no roteiro" action={newScene('secondary')}>
          Crie a primeira cena. Ela entra na prévia para você conferir antes de colocar no ar.
        </Empty>
      )}
    </Panel>
  )
}

interface RowProps {
  scene: Scene
  index: number
  last: boolean
  onAir: boolean
  inPreview: boolean
  reactions: number
  drop: 'before' | 'after' | null
  dragging: boolean
  thumb: Thumb
  act: (a: Action, s: Scene) => void
}

const Row = memo(function Row({ scene: s, index, last, onAir, inPreview, reactions, drop, dragging, thumb, act }: RowProps) {
  const { Icon } = KIND[s.type]
  return (
    <li
      data-scene={s.id}
      draggable
      className={cx(
        'relative flex items-center gap-1 border-b border-line py-2 pr-1.5 pl-2 transition-colors duration-100 select-none hover:bg-raised',
        onAir ? 'tally-program' : inPreview && 'tally-preview',
        dragging && 'opacity-45',
      )}
    >
      {drop && (
        <span aria-hidden className={cx('pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-fg', drop === 'before' ? '-top-px' : '-bottom-px')} />
      )}
      {/* div e não <button>: o Firefox não inicia o arraste de uma linha a partir de um botão. */}
      <div
        role="button"
        tabIndex={0}
        aria-keyshortcuts={index < 10 ? String((index + 1) % 10) : undefined}
        onClick={() => act('cue', s)}
        onKeyDown={(e) => {
          // Só pelo teclado: com foco vindo do mouse, Espaço e Enter continuam sendo corte e fusão.
          if ((e.key === 'Enter' || e.key === ' ') && e.currentTarget.matches(':focus-visible')) {
            e.preventDefault()
            act('cue', s)
          }
        }}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-chip py-0.5 focus-visible:-outline-offset-2"
      >
        <span className="w-5 shrink-0 text-right text-meta text-fg-subtle tabular-nums">{index + 1}</span>
        <span className="pointer-events-none relative shrink-0 overflow-hidden rounded-monitor bg-black" style={{ width: thumb.w, height: thumb.h }}>
          <Stage
            theme={thumb.theme}
            eventName={thumb.eventName}
            pin={thumb.pin}
            joinUrl={thumb.joinUrl}
            scene={s}
            questions={s.type === 'questions' ? thumb.questions.slice(0, s.content.max) : []}
            live={thumb.live}
            standby={false}
            enabledReactions={thumb.enabledReactions}
            offset={thumb.offset}
            mode="thumb"
            className="size-full"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-ui font-medium text-fg">{s.name}</span>
            {onAir && <Chip tone="program">No ar</Chip>}
            {inPreview && <Chip tone="preview">Prévia</Chip>}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-meta text-fg-subtle">
            <Icon size={12} className="shrink-0" />
            <span className="truncate">{sceneDetail(s)}</span>
            {reactions > 0 && <span className="ml-auto shrink-0 pl-1.5 tabular-nums">{plural(reactions, 'reação', 'reações')}</span>}
          </span>
        </span>
      </div>
      <Menu
        trigger={<IconButton label={`Ações da cena ${s.name}`} size="sm" icon={<DotsThreeVerticalIcon />} />}
        items={[
          { label: 'Editar', icon: <PencilSimpleIcon />, onSelect: () => act('edit', s) },
          { label: 'Duplicar', icon: <CopyIcon />, onSelect: () => act('duplicate', s) },
          { label: 'Mover para cima', icon: <ArrowUpIcon />, onSelect: () => act('up', s), disabled: index === 0 },
          { label: 'Mover para baixo', icon: <ArrowDownIcon />, onSelect: () => act('down', s), disabled: last },
          'separator',
          {
            label: 'Excluir',
            icon: <TrashIcon />,
            danger: true,
            disabled: onAir,
            hint: onAir ? 'Tire a cena do ar para excluir.' : undefined,
            onSelect: () => act('remove', s),
          },
        ]}
      />
    </li>
  )
})
