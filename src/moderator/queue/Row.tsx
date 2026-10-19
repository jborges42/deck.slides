// Linha da fila: autor, texto, estado e ações. As ações aparecem na linha atual ou sob o ponteiro,
// no lugar do horário, para a altura da linha não mudar (nada pula sob o ponteiro).
import { useState, type MouseEvent, type PointerEvent } from 'react'
import { CheckIcon } from '@phosphor-icons/react/Check'
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree'
import { MinusIcon } from '@phosphor-icons/react/Minus'
import { PlusIcon } from '@phosphor-icons/react/Plus'
import { ProjectorScreenIcon } from '@phosphor-icons/react/ProjectorScreen'
import { ThumbsUpIcon } from '@phosphor-icons/react/ThumbsUp'
import { patch } from '../../lib/api.ts'
import { ago } from '../../lib/format.ts'
import { Button, Chip, Field, IconButton, Menu, Popover, Textarea, cx } from '../../ui'
import { run } from '../context.ts'
import type { Question } from '../../../shared/types.ts'
import type { Air, Tab } from './logic.ts'

export type Action = 'approve' | 'reject' | 'answer' | 'restore' | 'spotlight' | 'show' | 'hide' | 'edit'

const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+'

/** Clique em controle da linha (botão, campo, item de menu) não mexe na seleção. */
export const inControl = (t: EventTarget) => t instanceof Element && !!t.closest('button, a, input, textarea, [role="menuitem"]')

export interface RowProps {
  q: Question
  tab: Tab
  eventId: string
  likes: number
  air: Air
  /** Única pergunta na tela: "Destacar" não mudaria nada. */
  solo: boolean
  /** Relógio do servidor, para "há 3 min". */
  now: number
  current: boolean
  tabbable: boolean
  picked: boolean
  picking: boolean
  editing: boolean
  onPoint: (q: Question, e: PointerEvent) => void
  onSelect: (q: Question, e: MouseEvent) => void
  onPick: (q: Question, e: MouseEvent) => void
  onAct: (a: Action, q: Question) => void
  onEditEnd: (q: Question) => void
}

export function Row(p: RowProps) {
  const { q, tab, air, current, editing } = p
  const act = (a: Action) => () => p.onAct(a, q)
  const chips = [
    air === 'program' && (
      <Chip key="air" tone="program">
        No ar
      </Chip>
    ),
    air === 'preview' && (
      <Chip key="air" tone="preview">
        Na prévia
      </Chip>
    ),
    air === 'screen' && <Chip key="air">Na tela</Chip>,
    q.status === 'answered' && <Chip key="st">Respondida</Chip>,
    q.status === 'rejected' && (
      <Chip key="st" tone="outline">
        Rejeitada
      </Chip>
    ),
    q.flagged && (
      <Chip key="flag" tone={tab === 'pending' ? 'attention' : 'critical'}>
        Termo sensível
      </Chip>
    ),
    q.anonymous && q.author && (
      <Chip key="anon" tone="outline">
        Anônima
      </Chip>
    ),
    q.text !== q.original && <Edited key="edit" q={q} eventId={p.eventId} tabbable={current} />,
  ].filter(Boolean)

  return (
    <li
      data-qid={q.id}
      tabIndex={p.tabbable ? 0 : -1}
      aria-current={current || undefined}
      onPointerDown={(e) => p.onPoint(q, e)}
      onMouseDown={(e) => e.shiftKey && !inControl(e.target) && e.preventDefault()} // Shift+clique seleciona linhas, não texto
      onClick={(e) => p.onSelect(q, e)}
      className={cx(
        'group relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 px-3 pt-1 pb-2.5 focus-visible:-outline-offset-2 focus-visible:outline-(--focus)',
        current ? 'bg-raised' : p.picked ? 'bg-[color-mix(in_oklab,var(--fg)_5%,transparent)]' : 'hover:bg-[color-mix(in_oklab,var(--fg)_4%,transparent)]',
        air === 'program' && 'tally-program',
        air === 'preview' && 'tally-preview',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={p.picked}
        aria-label="Selecionar pergunta"
        onClick={(e) => p.onPick(q, e)}
        className={cx(
          'mt-1.5 grid size-4 place-items-center rounded-[3px] border',
          p.picked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong hover:border-fg-muted',
          !(p.picking || p.picked || current) && 'invisible group-focus-within:visible group-hover:visible',
        )}
      >
        {p.picked && <CheckIcon size={12} weight="bold" />}
      </button>
      <div className="flex h-7 min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-ui font-medium text-fg-muted">{q.author || 'Anônimo'}</span>
        <span
          className={cx(
            'ml-auto shrink-0 text-meta text-fg-subtle tabular-nums',
            !editing && (current ? 'hidden' : 'group-focus-within:hidden group-hover:hidden'),
          )}
        >
          {ago(q.createdAt, p.now)}
        </span>
        {!editing && (
          <div className={cx('ml-auto shrink-0 items-center gap-1', current ? 'flex' : 'hidden group-focus-within:flex group-hover:flex')}>
            {tab === 'pending' && (
              <>
                <Button size="sm" kbd="A" onClick={act('approve')}>
                  Aprovar
                </Button>
                <Button size="sm" variant="ghost" kbd="E" onClick={act('edit')}>
                  Editar
                </Button>
                <Button size="sm" variant="ghost" kbd="R" onClick={act('reject')}>
                  Rejeitar
                </Button>
              </>
            )}
            {tab === 'approved' && (
              <>
                {!p.solo && (
                  <Button size="sm" icon={<ProjectorScreenIcon />} kbd="D" onClick={act('spotlight')}>
                    Destacar
                  </Button>
                )}
                {q.screen === null ? (
                  <Button size="sm" variant="ghost" icon={<PlusIcon />} onClick={act('show')}>
                    Adicionar à tela
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" icon={<MinusIcon />} onClick={act('hide')}>
                    Remover da tela
                  </Button>
                )}
                <Menu
                  trigger={<IconButton size="sm" label="Mais ações" icon={<DotsThreeIcon size={16} weight="bold" />} />}
                  items={[
                    {
                      label: q.status === 'answered' ? 'Desmarcar respondida' : 'Marcar como respondida',
                      kbd: 'M',
                      onSelect: act('answer'),
                    },
                    { label: 'Editar', kbd: 'E', onSelect: act('edit') },
                    'separator',
                    { label: 'Rejeitar', kbd: 'R', onSelect: act('reject') },
                  ]}
                />
              </>
            )}
            {tab === 'archive' && (
              <Button size="sm" onClick={act('restore')}>
                Restaurar
              </Button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <Editor q={q} eventId={p.eventId} onAir={air === 'program'} onDone={() => p.onEditEnd(q)} />
      ) : (
        <p className="col-start-2 text-read break-words text-fg">{q.text}</p>
      )}

      {(chips.length > 0 || tab === 'approved' || p.likes > 0) && (
        <div className="col-start-2 mt-2 flex flex-wrap items-center gap-1.5">
          {chips}
          {(tab === 'approved' || p.likes > 0) && (
            <span className="ml-auto flex items-center gap-1 text-meta text-fg-muted tabular-nums">
              <ThumbsUpIcon size={14} aria-hidden />
              {p.likes}
              <span className="sr-only">{p.likes === 1 ? 'curtida' : 'curtidas'}</span>
            </span>
          )}
        </div>
      )}
    </li>
  )
}

/** Edição no lugar. O texto fica local enquanto se edita: snapshots novos não apagam o que foi digitado. */
function Editor({ q, eventId, onAir, onDone }: { q: Question; eventId: string; onAir: boolean; onDone: () => void }) {
  const [text, setText] = useState(q.text)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return
    if (clean !== q.text) {
      setSaving(true)
      const ok = await run(() => patch(`/events/${eventId}/questions/${q.id}`, { text: clean }))
      setSaving(false)
      if (!ok) return
    }
    onDone()
  }
  return (
    <div className="col-start-2 mt-1 flex flex-col gap-2">
      <Field label="Texto exibido" hint={q.participantId ? 'Quem enviou verá o texto ajustado.' : undefined}>
        <Textarea
          autoFocus
          rows={3}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onDone()
            }
          }}
          size="read"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={onAir ? 'program' : 'primary'} kbd={`${MOD}Enter`} loading={saving} disabled={!text.trim()} onClick={save}>
          {onAir ? 'Salvar e atualizar na tela' : 'Salvar edição'}
        </Button>
        <Button size="sm" variant="ghost" kbd="Esc" onClick={onDone}>
          Descartar alterações
        </Button>
      </div>
    </div>
  )
}

/** Chip "Editada": mostra o texto original e permite voltar a ele. */
function Edited({ q, eventId, tabbable }: { q: Question; eventId: string; tabbable: boolean }) {
  return (
    <Popover
      align="start"
      className="w-80"
      trigger={
        <button type="button" tabIndex={tabbable ? 0 : -1} className="state-layer rounded-chip">
          <Chip tone="outline">Editada</Chip>
        </button>
      }
    >
      <p className="text-meta font-medium text-fg-muted">Texto original</p>
      <p className="mt-1 text-ui break-words text-fg">{q.original}</p>
      <Button size="sm" className="mt-3" onClick={() => run(() => patch(`/events/${eventId}/questions/${q.id}`, { text: q.original }))}>
        Restaurar original
      </Button>
    </Popover>
  )
}
