// Roteiro: as cenas na ordem do evento, organizadas em pastas (por momento ou palestrante). Clique leva à prévia
// (nunca ao ar); arrastar reordena: uma cena muda de lugar (e de pasta), uma pasta leva as cenas dela junto.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { ArrowDownIcon } from '@phosphor-icons/react/ArrowDown'
import { ArrowUpIcon } from '@phosphor-icons/react/ArrowUp'
import { CaretRightIcon } from '@phosphor-icons/react/CaretRight'
import { CopyIcon } from '@phosphor-icons/react/Copy'
import { DotsThreeVerticalIcon } from '@phosphor-icons/react/DotsThreeVertical'
import { FolderSimpleIcon } from '@phosphor-icons/react/FolderSimple'
import { FolderSimplePlusIcon } from '@phosphor-icons/react/FolderSimplePlus'
import { PencilSimpleIcon } from '@phosphor-icons/react/PencilSimple'
import { PlusIcon } from '@phosphor-icons/react/Plus'
import { TrashIcon } from '@phosphor-icons/react/Trash'
import { del, patch, post } from '../../lib/api.ts'
import { plural } from '../../lib/format.ts'
import { CANVAS } from '../../lib/theme.ts'
import { Button, Chip, Dialog, Empty, Field, IconButton, Input, Menu, Panel, Tooltip, confirm, cx, notify, type ButtonVariant } from '../../ui'
import { Stage, type StageProps } from '../../stage/Stage.tsx'
import { run, type EventContext } from '../context.ts'
import { KIND, KINDS } from './kinds.ts'
import { DEFAULT_CONTENT, folderEnd, folderOf, moveFolder, moveId, playable, sceneDetail } from './logic.ts'
import { onScreen, type Scene, type SceneType } from '../../../shared/types.ts'

type Action = 'cue' | 'edit' | 'duplicate' | 'up' | 'down' | 'remove'
type Thumb = Omit<StageProps, 'scene' | 'mode' | 'standby'> & { w: number; h: number }

/** Pastas recolhidas neste computador (cada operador recolhe o que já passou). */
function useCollapsed(eventId: string) {
  const key = `deck:pastas:${eventId}`
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const save = (next: Set<string>) => {
    setCollapsed(next)
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // sem armazenamento (janela privada): vale só nesta sessão
    }
  }
  const toggle = (id: string) => save(new Set(collapsed.has(id) ? [...collapsed].filter((x) => x !== id) : [...collapsed, id]))
  const expand = (id: string | null | undefined) => id && collapsed.has(id) && save(new Set([...collapsed].filter((x) => x !== id)))
  return { collapsed, toggle, expand }
}

export function Rundown({ ctx, onCue, onEdit }: { ctx: EventContext; onCue: (id: string) => void; onEdit: (id: string) => void }) {
  const { id: eventId, snap, counts, offset, links } = ctx
  const { event, scenes } = snap
  const { live, settings, theme } = event
  const [order, setOrder] = useState<string[] | null>(null) // ordem nova enquanto o servidor não confirma
  const [drag, setDrag] = useState<{ id: string; folder: boolean; over: string | null; after: boolean } | null>(null)
  const [naming, setNaming] = useState<Scene | 'new' | null>(null) // diálogo de pasta: nova ou renomear
  const { collapsed, toggle, expand } = useCollapsed(eventId)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => setOrder(null), [scenes])

  const rows = order ? order.map((id) => scenes.find((s) => s.id === id)).filter((s): s is Scene => !!s) : scenes
  const ids = rows.map((s) => s.id)
  const folders = useMemo(() => folderOf(rows), [rows])
  const numbers = new Map(playable(rows).map((s, i) => [s.id, i]))
  const inFolder = (folder: string) => rows.filter((s) => folders.get(s.id) === folder)

  // Cena levada à prévia pelo teclado: a pasta dela abre e o roteiro rola até ela.
  useEffect(() => {
    if (!live.preview) return
    expand(folders.get(live.preview))
    requestAnimationFrame(() => list.current?.querySelector(`[data-scene="${CSS.escape(live.preview!)}"]`)?.scrollIntoView({ block: 'nearest' }))
  }, [live.preview])

  const reorder = (next: string[]) => {
    if (next.every((id, i) => id === ids[i])) return
    setOrder(next)
    void run(() => post(`/events/${eventId}/scenes/order`, { ids: next })).then((ok) => ok || setOrder(null))
  }

  /** Nova cena no fim do roteiro ou, pelo "+" de uma pasta, no fim dela. */
  const create = async (type: SceneType, folder?: string) => {
    const { label } = KIND[type]
    const n = scenes.filter((s) => s.type === type).length
    if (folder) expand(folder)
    const res = await run(() =>
      post<{ id: string }>(`/events/${eventId}/scenes`, {
        type,
        name: n ? `${label} ${n + 1}` : label,
        content: DEFAULT_CONTENT[type],
        ...(folder && { after: folderEnd(rows, folder) }),
      }),
    )
    if (res) onEdit(res.id)
  }

  const remove = async (s: Scene) => {
    const ok = await confirm({ title: 'Excluir a cena?', body: `“${s.name}” sai do roteiro. Não é possível desfazer.`, confirm: 'Excluir cena' })
    if (ok && (await run(() => del(`/events/${eventId}/scenes/${s.id}`)))) notify('Cena excluída.')
  }

  const removeFolder = async (s: Scene) => {
    const n = inFolder(s.id).length
    const ok = await confirm({
      title: 'Excluir a pasta?',
      body: n ? `As cenas de “${s.name}” continuam no roteiro, junto da pasta de cima.` : `“${s.name}” sai do roteiro.`,
      confirm: 'Excluir pasta',
    })
    if (ok && (await run(() => del(`/events/${eventId}/scenes/${s.id}`)))) notify('Pasta excluída.')
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

  const kinds = (folder?: string) => KINDS.map((k) => ({ label: k.label, icon: <k.Icon />, onSelect: () => void create(k.type, folder) }))
  const newScene = (variant: ButtonVariant) => (
    <Menu
      align={variant === 'ghost' ? 'end' : 'start'}
      trigger={
        <Button size="sm" variant={variant} icon={<PlusIcon />}>
          Nova cena
        </Button>
      }
      items={kinds()}
    />
  )
  const newFolder = (
    <Tooltip label="Nova pasta">
      <IconButton label="Nova pasta" size="sm" icon={<FolderSimplePlusIcon />} onClick={() => setNaming('new')} />
    </Tooltip>
  )
  const playing = numbers.size

  return (
    <Panel
      title="Roteiro"
      count={playing || undefined}
      actions={
        <>
          {newFolder}
          {newScene('ghost')}
        </>
      }
      className="border-r border-line bg-surface"
    >
      {rows.length ? (
        <ol
          ref={list}
          aria-label="Cenas do roteiro"
          onDragStart={(e) => {
            const id = rowOf(e)?.dataset.scene
            if (!id) return
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', id)
            setDrag({ id, folder: rows.find((s) => s.id === id)?.type === 'section', over: null, after: false })
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
            if (drag?.over) reorder(drag.folder ? moveFolder(rows, drag.id, drag.over, drag.after) : moveId(ids, drag.id, drag.over, drag.after))
            setDrag(null)
          }}
          onDragEnd={() => setDrag(null)}
        >
          {rows.map((s, i) => {
            const drop = drag && drag.over === s.id && drag.id !== s.id ? (drag.after ? 'after' : 'before') : null
            if (s.type === 'section') {
              const inside = inFolder(s.id)
              return (
                <FolderRow
                  key={s.id}
                  scene={s}
                  count={inside.length}
                  collapsed={collapsed.has(s.id)}
                  onAir={inside.some((x) => x.id === live.program)}
                  inPreview={inside.some((x) => x.id === live.preview)}
                  drop={drop}
                  dragging={drag?.id === s.id}
                  onToggle={() => toggle(s.id)}
                  kinds={kinds(s.id)}
                  onRename={() => setNaming(s)}
                  onRemove={() => void removeFolder(s)}
                />
              )
            }
            const folder = folders.get(s.id)
            if (folder && collapsed.has(folder)) return null
            return (
              <Row
                key={s.id}
                scene={s}
                index={numbers.get(s.id)!}
                first={i === 0}
                last={i === rows.length - 1}
                nested={!!folder}
                onAir={s.id === live.program}
                inPreview={s.id === live.preview}
                reactions={Object.values(counts.reactions[s.id] ?? {}).reduce<number>((a, b) => a + (b ?? 0), 0)}
                drop={drop}
                dragging={drag?.id === s.id}
                thumb={thumb}
                act={act}
              />
            )
          })}
        </ol>
      ) : (
        <Empty title="Nenhuma cena no roteiro" action={newScene('secondary')}>
          Crie a primeira cena. Ela entra na prévia para você conferir antes de colocar no ar. Pastas organizam as cenas por momento ou palestrante.
        </Empty>
      )}
      <FolderDialog eventId={eventId} target={naming} onClose={() => setNaming(null)} />
    </Panel>
  )
}

interface FolderRowProps {
  scene: Scene
  count: number
  collapsed: boolean
  onAir: boolean
  inPreview: boolean
  drop: 'before' | 'after' | null
  dragging: boolean
  onToggle: () => void
  kinds: { label: string; icon: ReactNode; onSelect: () => void }[]
  onRename: () => void
  onRemove: () => void
}

/** Título de pasta: recolhe e abre as cenas dela; recolhida, avisa se tem cena no ar ou na prévia. */
function FolderRow({ scene: s, count, collapsed, onAir, inPreview, drop, dragging, onToggle, kinds, onRename, onRemove }: FolderRowProps) {
  return (
    <li
      data-scene={s.id}
      draggable
      className={cx('relative flex items-center gap-1 border-b border-line bg-raised py-1.5 pr-1.5 pl-1 select-none', dragging && 'opacity-45')}
    >
      {drop && <DropLine at={drop} />}
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-chip py-1 text-left focus-visible:-outline-offset-2"
      >
        <CaretRightIcon size={12} className={cx('shrink-0 text-fg-subtle transition-transform duration-150', !collapsed && 'rotate-90')} />
        <FolderSimpleIcon size={14} weight="fill" className="shrink-0 text-accent-fg" />
        <span title={s.name} className="truncate text-ui font-semibold text-fg">
          {s.name}
        </span>
        <span className="shrink-0 text-meta text-fg-subtle tabular-nums">{count || ''}</span>
        {collapsed && onAir && <Chip tone="program">No ar</Chip>}
        {collapsed && inPreview && <Chip tone="preview">Prévia</Chip>}
      </button>
      <Menu
        align="end"
        trigger={<IconButton label={`Nova cena em ${s.name}`} size="sm" icon={<PlusIcon />} />}
        items={kinds}
      />
      <Menu
        trigger={<IconButton label={`Ações da pasta ${s.name}`} size="sm" icon={<DotsThreeVerticalIcon />} />}
        items={[
          { label: 'Renomear', icon: <PencilSimpleIcon />, onSelect: onRename },
          'separator',
          { label: 'Excluir pasta', icon: <TrashIcon />, danger: true, onSelect: onRemove },
        ]}
      />
    </li>
  )
}

/** Criar ou renomear pasta: só o nome (ex.: “Abertura”, “Felipe Kraemer — Cresol”). */
function FolderDialog({ eventId, target, onClose }: { eventId: string; target: Scene | 'new' | null; onClose: () => void }) {
  const form = useId()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editing = target && target !== 'new' ? target : null
  const close = () => {
    setError(null)
    setBusy(false)
    onClose()
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim()
    if (!name) return setError('Informe o nome da pasta.')
    setBusy(true)
    const ok = await run(() =>
      editing ? patch(`/events/${eventId}/scenes/${editing.id}`, { name }) : post(`/events/${eventId}/scenes`, { type: 'section', name, content: {} }),
    )
    setBusy(false)
    if (ok) close()
  }
  return (
    <Dialog
      open={!!target}
      onOpenChange={(o) => !o && close()}
      title={editing ? 'Renomear pasta' : 'Nova pasta'}
      description={editing ? undefined : 'Agrupa as cenas de um momento ou de um palestrante. Ela entra no fim do roteiro; arraste para mudar de lugar.'}
      footer={
        <>
          <Button onClick={close}>Cancelar</Button>
          <Button type="submit" form={form} variant="primary" loading={busy}>
            {editing ? 'Renomear' : 'Criar pasta'}
          </Button>
        </>
      }
    >
      <form id={form} onSubmit={submit} noValidate>
        <Field label="Nome da pasta" error={error}>
          <Input
            key={editing?.id ?? 'new'}
            name="name"
            maxLength={80}
            autoComplete="off"
            autoFocus
            defaultValue={editing?.name ?? ''}
            placeholder="Ex.: Abertura, Felipe Kraemer — Cresol"
            onChange={() => error && setError(null)}
          />
        </Field>
      </form>
    </Dialog>
  )
}

const DropLine = ({ at }: { at: 'before' | 'after' }) => (
  <span aria-hidden className={cx('pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-accent', at === 'before' ? '-top-px' : '-bottom-px')} />
)

interface RowProps {
  scene: Scene
  index: number
  first: boolean
  last: boolean
  nested: boolean
  onAir: boolean
  inPreview: boolean
  reactions: number
  drop: 'before' | 'after' | null
  dragging: boolean
  thumb: Thumb
  act: (a: Action, s: Scene) => void
}

const Row = memo(function Row({ scene: s, index, first, last, nested, onAir, inPreview, reactions, drop, dragging, thumb, act }: RowProps) {
  const { Icon } = KIND[s.type]
  return (
    <li
      data-scene={s.id}
      draggable
      className={cx(
        'relative flex items-center gap-1 border-b border-line py-2 pr-1.5 transition-colors duration-100 select-none hover:bg-raised',
        nested ? 'pl-4' : 'pl-2',
        onAir ? 'tally-program' : inPreview && 'tally-preview',
        dragging && 'opacity-45',
      )}
    >
      {drop && <DropLine at={drop} />}
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
          { label: 'Mover para cima', icon: <ArrowUpIcon />, onSelect: () => act('up', s), disabled: first },
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
