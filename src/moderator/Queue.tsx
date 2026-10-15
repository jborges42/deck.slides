// Fila de perguntas do console (coluna da direita do Ao vivo): moderação, destaque na tela,
// seleção múltipla e atalhos. Toda ação vai ao servidor; a lista só reflete o snapshot confirmado.
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { ArrowsDownUpIcon } from '@phosphor-icons/react/ArrowsDownUp'
import { MagnifyingGlassIcon } from '@phosphor-icons/react/MagnifyingGlass'
import { PlusIcon } from '@phosphor-icons/react/Plus'
import { XIcon } from '@phosphor-icons/react/X'
import { patch, post } from '../lib/api.ts'
import { ago, plural } from '../lib/format.ts'
import { useHotkeys, type Hotkeys } from '../lib/hotkeys.ts'
import { useNow } from '../lib/stream.ts'
import { Button, Dot, Empty, Field, IconButton, Input, Kbd, Panel, Segmented, TabBar, Textarea, Tooltip, cx, inputClass, notify, undoable } from '../ui'
import { run, type EventContext } from './context.ts'
import { normalize, type Question, type QuestionStatus } from '../../shared/types.ts'
import { airOf, capture, matches, merge, order, restorePlan, same, tabOf, type Before, type Sort, type Tab } from './queue/logic.ts'
import { Row, inControl, type Action } from './queue/Row.tsx'

const LIST_LABEL: Record<Tab, string> = { pending: 'Perguntas aguardando', approved: 'Perguntas aprovadas', archive: 'Arquivo de perguntas' }

/** "Pergunta aprovada." / "3 perguntas aprovadas." */
const said = (n: number, one: string, many: string) => (n === 1 ? `${one[0].toUpperCase()}${one.slice(1)}.` : `${plural(n, one, many)}.`)

export function Queue({ ctx }: { ctx: EventContext }) {
  const { snap } = ctx
  const questions = snap.questions
  const api = `/events/${ctx.id}/questions`

  const [tab, setTab] = useState<Tab>('pending')
  const [sort, setSort] = useState<Sort>('likes')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [hover, setHover] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const [kept, setKept] = useState<string[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  // O desfazer roda segundos depois: compara com o snapshot mais recente, não com o do clique.
  const latest = useRef(questions)
  useEffect(() => {
    latest.current = questions
    // Linha focada que sumiu (outra moderação agiu nela) não dispara blur: sem isso a ordem ficaria congelada.
    if (focusIn && !scroller.current?.contains(document.activeElement)) setFocusIn(false)
  })
  const now = useNow(15_000) + ctx.offset

  const likes = (q: Question) => ctx.counts.likes[q.id] ?? q.likes
  const groups = Map.groupBy(questions, tabOf)
  const count = (t: Tab) => groups.get(t)?.length ?? 0
  const needle = normalize(query)
  const list = order(groups.get(tab) ?? [], tab, sort, likes).filter((q) => matches(q, needle))
  const byId = new Map(list.map((q) => [q.id, q]))
  const desired = list.map((q) => q.id)
  // Aprovadas reordenam por curtidas: com o ponteiro sobre a lista ou foco numa linha, a ordem congela
  // e o que chega entra no fim. A fila já cresce só no fim; lá, desfazer devolve a pergunta ao lugar dela.
  const frozen = tab === 'approved' && (hover || focusIn)
  const shown = frozen ? merge(kept, desired) : desired
  if (!same(kept, shown)) setKept(shown) // a ordem exibida vira a base do próximo render (merge é idempotente: converge)
  const rows = shown.map((id) => byId.get(id)!)
  const stale = !same(shown, desired)

  const cur = cursor && byId.has(cursor) ? cursor : null
  const pickedIds = shown.filter((id) => picked.has(id))
  const air = airOf(snap)
  const onScreenCount = questions.filter((q) => q.screen !== null).length
  const pending = groups.get('pending') ?? []
  const oldest = Math.min(...pending.map((q) => q.createdAt))
  const late = pending.length > 0 && now - oldest > 120_000

  // ---------- seleção ----------

  const focusRow = (id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-qid="${id}"]`)
    el?.focus({ preventScroll: true })
    el?.scrollIntoView({ block: 'nearest' })
  }
  const move = (delta: number) => {
    if (!shown.length) return
    const i = cur ? shown.indexOf(cur) : -1
    const next = shown[i < 0 ? 0 : Math.min(Math.max(i + delta, 0), shown.length - 1)]
    setCursor(next)
    focusRow(next)
  }
  const togglePick = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (!n.delete(id)) n.add(id)
      return n
    })
  const pickRange = (to: string) => {
    const [a, b] = [shown.indexOf(cur ?? to), shown.indexOf(to)].sort((x, y) => x - y)
    setPicked((s) => new Set([...s, ...shown.slice(a, b + 1)]))
  }
  const onPoint = (q: Question, e: { shiftKey: boolean }) => !e.shiftKey && setCursor(q.id)
  const onSelect = (q: Question, e: MouseEvent) => {
    if (inControl(e.target)) return
    if (e.shiftKey) pickRange(q.id)
    else if (e.metaKey || e.ctrlKey) togglePick(q.id)
    setCursor(q.id)
  }
  const onPick = (q: Question, e: MouseEvent) => {
    if (e.shiftKey) pickRange(q.id)
    else togglePick(q.id)
    setCursor(q.id)
  }
  const changeTab = (t: Tab) => {
    setTab(t)
    setPicked(new Set())
    setEditing(null)
    scroller.current?.scrollTo({ top: 0 })
  }

  /** A pergunta atual saiu desta aba (aprovada, rejeitada…): a seleção passa para a próxima linha. */
  const advance = (gone: Set<string>) => {
    if (!cur || !gone.has(cur)) return
    const i = shown.indexOf(cur)
    const next = shown.slice(i + 1).find((id) => !gone.has(id)) ?? shown.slice(0, i).findLast((id) => !gone.has(id)) ?? null
    setCursor(next)
    if (next && scroller.current?.contains(document.activeElement)) focusRow(next)
  }

  // ---------- comandos ----------

  const undoTo = (before: Before[]) => () =>
    run(async () => {
      for (const c of restorePlan(before, latest.current)) await post(api + c.path, c.body)
    })

  async function setStatus(changes: [string, QuestionStatus][], [one, many]: [string, string]) {
    const todo = changes.filter(([id, s]) => questions.find((q) => q.id === id)?.status !== s)
    if (!todo.length) return
    const screenOf = (id: string) => questions.find((q) => q.id === id)?.screen ?? null
    advance(new Set(todo.filter(([id, status]) => tabOf({ status, screen: screenOf(id) }) !== tab).map(([id]) => id)))
    const before = capture(questions, todo.map(([id]) => id))
    const ok = await run(async () => {
      for (const [status, cs] of Map.groupBy(todo, ([, s]) => s)) await post(`${api}/bulk`, { ids: cs.map(([id]) => id), status })
      return true
    })
    if (ok) undoable(said(todo.length, one, many), undoTo(before))
  }

  /** Destacar: só estas perguntas na tela (a primeira sozinha, as demais em seguida). */
  async function present(ids: string[]) {
    const solo = ids.length === 1 && onScreenCount === 1 && questions.find((q) => q.id === ids[0])?.screen !== null
    if (!ids.length || solo) return
    if (tab !== 'approved') advance(new Set(ids)) // destacar também aprova
    const before = capture(questions, ids)
    const ok = await run(async () => {
      for (const [i, id] of ids.entries()) await post(`${api}/${id}/screen`, i ? { on: true } : { on: true, solo: true })
      return true
    })
    if (!ok) return
    undoable(said(ids.length, 'pergunta destacada', 'perguntas destacadas'), undoTo(before))
    await cueQuestionsScene()
  }

  /** A pergunta só aparece se uma cena de perguntas estiver no ar: senão, deixa uma na prévia. */
  async function cueQuestionsScene() {
    const { live } = snap.event
    const questionsScene = (id: string | null) => snap.scenes.find((s) => s.id === id && s.type === 'questions')
    if (questionsScene(live.program)) return
    const scene = questionsScene(live.preview) ?? snap.scenes.find((s) => s.type === 'questions')
    if (!scene)
      return notify('Nenhuma cena de perguntas no roteiro.', { description: 'Crie uma cena de perguntas para mostrar a pergunta na tela.' })
    if (scene.id !== live.preview && !(await run(() => post(`/events/${ctx.id}/live`, { op: 'preview', sceneId: scene.id })))) return
    notify(`Cena “${scene.name}” na prévia.`, { description: 'Pressione Espaço para colocar no ar.' })
  }

  async function clearScreen() {
    const before = capture(questions, [])
    if (await run(() => post(`${api}/screen/clear`)))
      undoable(onScreenCount === 1 ? 'Pergunta removida da tela.' : 'Perguntas removidas da tela.', undoTo(before))
  }

  /** Ação pelo botão da linha (`target`) ou pelo teclado: seleção múltipla, se houver; senão, a linha atual. */
  function perform(action: Action, target?: Question) {
    const many = target ? [] : pickedIds
    const one = target ?? (cur ? byId.get(cur) : undefined)
    const ids = many.length ? many : one ? [one.id] : []
    if (!ids.length) return
    if (many.length && action !== 'edit') setPicked(new Set())
    const all = (status: QuestionStatus) => ids.map((id): [string, QuestionStatus] => [id, status])
    switch (action) {
      case 'approve':
        return setStatus(all('approved'), ['pergunta aprovada', 'perguntas aprovadas'])
      case 'reject':
        return setStatus(all('rejected'), ['pergunta rejeitada', 'perguntas rejeitadas'])
      case 'answer':
        // M alterna numa pergunta; na seleção múltipla, marca todas.
        return !many.length && one?.status === 'answered'
          ? setStatus(all('approved'), ['pergunta desmarcada como respondida', ''])
          : setStatus(all('answered'), ['pergunta marcada como respondida', 'perguntas marcadas como respondidas'])
      case 'restore':
        return setStatus(
          ids.map((id): [string, QuestionStatus] => [id, byId.get(id)?.status === 'answered' ? 'approved' : 'pending']),
          ['pergunta restaurada', 'perguntas restauradas'],
        )
      case 'spotlight':
        return present(ids)
      case 'show':
      case 'hide':
        return one && run(() => post(`${api}/${one.id}/screen`, { on: action === 'show' }))
      case 'edit':
        if (one) setEditing(one.id)
    }
  }

  const endEdit = (q: Question) => {
    setEditing(null)
    focusRow(q.id)
  }

  const focusSearch = () => {
    search.current?.focus()
    search.current?.select()
  }

  // J/K, A/R/E/D/M, X, Esc e /. Espaço, Enter, números, setas, B, T, P, ? e ⌘Z são do console ao vivo.
  const keys: Hotkeys = {
    KeyJ: () => move(1),
    KeyK: () => move(-1),
    KeyA: () => perform('approve'),
    KeyR: () => perform('reject'),
    KeyE: () => perform('edit'),
    KeyD: () => perform('spotlight'),
    KeyM: () => perform('answer'),
    KeyX: () => cur && togglePick(cur),
    Escape: () => {
      if (pickedIds.length) return setPicked(new Set())
      setCursor(null)
      if (scroller.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
    },
    Slash: focusSearch,
    IntlRo: focusSearch, // tecla "/" do teclado ABNT2
  }
  useHotkeys(keys) // o hook ignora teclas com menu, lista ou campo de texto em foco

  const toolbar =
    pickedIds.length > 0 ? (
      <div className="flex h-7 items-center gap-1">
        <span className="mr-auto text-ui font-medium text-fg tabular-nums">{plural(pickedIds.length, 'selecionada', 'selecionadas')}</span>
        {tab === 'pending' && (
          <Button size="sm" kbd="A" onClick={() => perform('approve')}>
            Aprovar
          </Button>
        )}
        {tab === 'approved' && (
          <Button size="sm" kbd="M" onClick={() => perform('answer')}>
            Marcar respondidas
          </Button>
        )}
        {tab === 'archive' ? (
          <Button size="sm" onClick={() => perform('restore')}>
            Restaurar
          </Button>
        ) : (
          <Button size="sm" variant="ghost" kbd="R" onClick={() => perform('reject')}>
            Rejeitar
          </Button>
        )}
        <Tooltip label="Limpar seleção" kbd="Esc">
          <IconButton label="Limpar seleção" size="sm" icon={<XIcon size={14} />} onClick={() => setPicked(new Set())} />
        </Tooltip>
      </div>
    ) : tab === 'pending' ? (
      pending.length > 0 && (
        <div className="flex h-7 items-center gap-2">
          <span className={cx('text-meta tabular-nums', late ? 'text-attention' : 'text-fg-subtle')}>Mais antiga: {ago(oldest, now)}</span>
          {rows.length > 0 && (
            <Button
              size="sm"
              className="ml-auto tabular-nums"
              onClick={() => setStatus(rows.map((q): [string, QuestionStatus] => [q.id, 'approved']), ['pergunta aprovada', 'perguntas aprovadas'])}
            >
              Aprovar todas ({rows.length.toLocaleString('pt-BR')})
            </Button>
          )}
        </div>
      )
    ) : tab === 'approved' ? (
      <>
        {onScreenCount > 0 && (
          <div className="flex h-7 items-center gap-2">
            <span className="text-ui text-fg-muted">
              Na tela: <span className="text-fg tabular-nums">{onScreenCount}</span>
            </span>
            <Button size="sm" variant="ghost" icon={<XIcon />} className="ml-auto" onClick={clearScreen}>
              Limpar tela
            </Button>
          </div>
        )}
        <div className="flex h-7 items-center gap-2">
          <Segmented
            size="sm"
            label="Ordenar aprovadas"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'likes', label: 'Mais curtidas' },
              { value: 'recent', label: 'Mais recentes' },
            ]}
          />
          {stale && (
            <Button size="sm" variant="ghost" icon={<ArrowsDownUpIcon />} className="ml-auto" onClick={() => setKept(desired)}>
              Reordenar
            </Button>
          )}
        </div>
      </>
    ) : null

  const empty = query ? (
    <Empty
      title="Nenhuma pergunta encontrada."
      action={
        <Button size="sm" onClick={() => setQuery('')}>
          Limpar busca
        </Button>
      }
    >
      Nada nesta aba corresponde a “{query}”.
    </Empty>
  ) : tab === 'pending' ? (
    snap.event.settings.questionsOpen ? (
      <Empty title="Nenhuma pergunta aguardando.">As novas perguntas aparecem aqui assim que forem enviadas.</Empty>
    ) : (
      <Empty
        title="Nenhuma pergunta aguardando."
        action={
          <Button size="sm" onClick={() => run(() => patch(`/events/${ctx.id}`, { settings: { questionsOpen: true } }))}>
            Abrir envio de perguntas
          </Button>
        }
      >
        O envio está fechado.
      </Empty>
    )
  ) : tab === 'approved' ? (
    <Empty title="Nenhuma pergunta aprovada.">Aprove perguntas na fila para escolher o que vai para a tela.</Empty>
  ) : (
    <Empty title="Nenhuma pergunta no arquivo.">Perguntas respondidas e rejeitadas aparecem aqui.</Empty>
  )

  return (
    <Panel
      title="Perguntas"
      className="h-full bg-surface"
      bodyClassName="flex flex-col"
      actions={
        <Button size="sm" variant="ghost" icon={<PlusIcon />} aria-expanded={composing} onClick={() => setComposing((c) => !c)}>
          Nova pergunta
        </Button>
      }
    >
      {composing && <Compose eventId={ctx.id} onClose={() => setComposing(false)} />}

      <TabBar
        value={tab}
        onChange={changeTab}
        className="shrink-0 px-3"
        items={[
          { value: 'pending', label: 'Aguardando', count: count('pending') || undefined, icon: late ? <Dot tone="attention" /> : undefined },
          { value: 'approved', label: 'Aprovadas', count: count('approved') || undefined },
          { value: 'archive', label: 'Arquivo', count: count('archive') || undefined },
        ]}
      />

      <div className="relative mx-3 mt-3 flex shrink-0 items-center">
        <MagnifyingGlassIcon size={14} aria-hidden className="pointer-events-none absolute left-2.5 text-fg-subtle" />
        <input
          ref={search}
          type="search"
          aria-label="Buscar perguntas"
          placeholder="Buscar por texto ou autor"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              if (query) setQuery('')
              else e.currentTarget.blur()
            } else if (e.key === 'Enter' && shown.length) {
              e.preventDefault()
              setCursor(shown[0])
              focusRow(shown[0])
            }
          }}
          className={cx(inputClass, 'h-8 pr-9 pl-8 text-ui [&::-webkit-search-cancel-button]:hidden')}
        />
        {query ? (
          <Tooltip label="Limpar busca" kbd="Esc">
            <IconButton label="Limpar busca" size="sm" icon={<XIcon size={12} />} className="absolute right-0.5" onClick={() => setQuery('')} />
          </Tooltip>
        ) : (
          <Kbd className="pointer-events-none absolute right-2">/</Kbd>
        )}
      </div>

      {toolbar && <div className="flex shrink-0 flex-col gap-2 px-3 py-2.5">{toolbar}</div>}

      <div
        ref={scroller}
        className={cx('min-h-0 flex-1 overflow-y-auto border-t border-line', !toolbar && 'mt-3')}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setFocusIn(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocusIn(false)}
      >
        {rows.length ? (
          <ul aria-label={LIST_LABEL[tab]} className="divide-y divide-line">
            {rows.map((q, i) => (
              <Row
                key={q.id}
                q={q}
                tab={tab}
                eventId={ctx.id}
                likes={likes(q)}
                air={air(q)}
                solo={onScreenCount === 1 && q.screen !== null}
                now={now}
                current={q.id === cur}
                tabbable={cur ? q.id === cur : i === 0}
                picked={picked.has(q.id)}
                picking={pickedIds.length > 0}
                editing={editing === q.id}
                onPoint={onPoint}
                onSelect={onSelect}
                onPick={onPick}
                onAct={perform}
                onEditEnd={endEdit}
              />
            ))}
          </ul>
        ) : (
          empty
        )}
      </div>
    </Panel>
  )
}

/** Pergunta da moderação (ex.: feita no microfone). Entra direto nas aprovadas. */
function Compose({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean || busy) return
    setBusy(true)
    const ok = await run(() => post(`/events/${eventId}/questions`, { text: clean, author: author.trim() }))
    setBusy(false)
    if (!ok) return
    notify('Pergunta adicionada às aprovadas.')
    onClose()
  }
  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="flex shrink-0 flex-col gap-3 border-b border-line p-3"
      aria-label="Nova pergunta"
    >
      <Field label="Texto">
        <Textarea
          autoFocus
          rows={2}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void submit()}
        />
      </Field>
      <Field label="Autor (opcional)" hint="Sem autor, a pergunta fica anônima.">
        <Input value={author} maxLength={80} onChange={(e) => setAuthor(e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!text.trim()}>
          Adicionar pergunta
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
