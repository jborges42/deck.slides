// Inspetor: edita a cena da prévia. Fora do ar, salva sozinho; no ar, as mudanças esperam "Atualizar no ar".
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BroadcastIcon } from '@phosphor-icons/react/Broadcast'
import { CheckCircleIcon } from '@phosphor-icons/react/CheckCircle'
import { InfoIcon } from '@phosphor-icons/react/Info'
import { WarningIcon } from '@phosphor-icons/react/Warning'
import { FilePdfIcon } from '@phosphor-icons/react/FilePdf'
import { XIcon } from '@phosphor-icons/react/X'
import { patch, post } from '../../lib/api.ts'
import { clock, plural } from '../../lib/format.ts'
import { Button, Chip, Field, IconButton, Input, Segmented, Select, Spinner, Switch, Textarea, cx, notify, undoable, type Option } from '../../ui'
import { run, useEvent } from '../context.ts'
import { MediaPicker } from '../MediaPicker.tsx'
import type { SaveState } from './drafts.ts'
import { KIND } from './kinds.ts'
import { embedUrl, parseDuration, sameDraft, type Draft } from './logic.ts'
import { SLIDE_ACCEPT, importSlides } from './slides.ts'
import type { EmbedCheck, Media, Scene, SceneContent } from '../../../shared/types.ts'

interface Props {
  eventId: string
  scene: Scene
  draft: Draft | undefined
  onAir: boolean
  state: SaveState | undefined
  media: Media[]
  onChange: (d: Draft) => void
  onPublish: () => void
  onDiscard: () => void
  /** Apresentação: slide atual (do servidor) e escolha de slide (no ar, muda a tela; na prévia, de onde começa). */
  slide?: number
  onSlide?: (index: number) => void
}

export function Inspector({ eventId, scene, draft, onAir, state, media, onChange, onPublish, onDiscard, slide = 0, onSlide }: Props) {
  const value: Draft = draft ?? { name: scene.name, content: scene.content }
  const dirty = !!draft && !sameDraft(draft, scene)
  const [epoch, setEpoch] = useState(0) // remonta os campos ao descartar (o de URL do MediaPicker não é controlado)
  const set = (patch: Partial<Scene['content']>) => onChange({ ...value, content: { ...value.content, ...patch } as Scene['content'] })

  return (
    <section aria-label="Edição da cena na prévia" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
        <Chip tone={onAir ? 'program' : 'preview'}>{onAir ? 'No ar' : 'Prévia'}</Chip>
        <h2 className="truncate text-ui font-semibold text-fg">{value.name.trim() || scene.name}</h2>
        <span className="shrink-0 text-ui text-fg-subtle">{KIND[scene.type].label}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {onAir ? (
            dirty && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state === 'saving'}
                  onClick={() => {
                    onDiscard()
                    setEpoch(epoch + 1)
                  }}
                >
                  Descartar
                </Button>
                <Button size="sm" variant="program" icon={<BroadcastIcon />} loading={state === 'saving'} onClick={onPublish}>
                  Atualizar no ar
                </Button>
              </>
            )
          ) : (
            <SaveStatus state={state} onRetry={onPublish} />
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid max-w-[720px] grid-cols-2 gap-x-4 gap-y-4" onKeyDown={leaveField}>
          {scene.type === 'slides' ? (
            <SlidesFields
              key={epoch}
              eventId={eventId}
              c={value.content as SceneContent<'slides'>}
              set={set}
              // Primeira importação numa apresentação com nome padrão: ela ganha o nome do arquivo.
              onAdd={(urls, file) => {
                const slides = [...(value.content as SceneContent<'slides'>).slides, ...urls]
                const name = /^Apresentação( \d+)?$/.test(value.name.trim()) ? file.replace(/\.[^.]+$/, '').slice(0, 80) : value.name
                onChange({ name, content: { ...value.content, slides } as Scene['content'] })
              }}
              current={slide}
              onAir={onAir}
              onPick={onSlide}
            />
          ) : (
            <Fields key={epoch} eventId={eventId} type={scene.type} c={value.content} set={set} media={media} />
          )}
          <Field label="Nome no roteiro" hint="Só aparece no console.">
            <Input
              value={value.name}
              maxLength={80}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              onBlur={() => !value.name.trim() && onChange({ ...value, name: scene.name })}
            />
          </Field>
        </div>
      </div>
    </section>
  )
}

// Esc sai do campo e Enter confirma campos de uma linha; nenhum dos dois mexe na tela.
// A tecla não segue até os atalhos globais: com o campo já sem foco, Enter viraria fusão.
function leaveField(e: KeyboardEvent<HTMLDivElement>) {
  const el = e.target as HTMLElement
  if (e.nativeEvent.isComposing) return
  if ((e.key === 'Escape' && el.matches('input, textarea')) || (e.key === 'Enter' && el instanceof HTMLInputElement)) {
    e.stopPropagation()
    el.blur()
  }
}

function SaveStatus({ state, onRetry }: { state: SaveState | undefined; onRetry: () => void }) {
  if (state === 'error')
    return (
      <>
        <span className="text-meta text-critical">Não foi possível salvar.</span>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Tentar de novo
        </Button>
      </>
    )
  return <span className="text-meta text-fg-subtle">{state === 'saving' ? 'Salvando…' : state === 'saved' ? 'Alterações salvas' : ''}</span>
}

// ---------- campos por tipo ----------

const FIT: Option<'contain' | 'cover'>[] = [
  { value: 'contain', label: 'Conter' },
  { value: 'cover', label: 'Preencher' },
]
const LAYOUTS: Option<'spotlight' | 'list' | 'grid'>[] = [
  { value: 'spotlight', label: 'Destaque' },
  { value: 'list', label: 'Mural' },
  { value: 'grid', label: 'Grade' },
]
// Ao trocar o layout, o máximo volta ao padrão dele: destaque mostra uma, mural três, grade seis.
const LAYOUT_MAX = { spotlight: 1, list: 3, grid: 6 }
const MAX: Option<string>[] = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
const MODES: Option<'countdown' | 'stopwatch'>[] = [
  { value: 'countdown', label: 'Regressivo' },
  { value: 'stopwatch', label: 'Progressivo' },
]
const ON_END: Option<'overtime' | 'stop' | 'message'>[] = [
  { value: 'overtime', label: 'Contar tempo extra' },
  { value: 'stop', label: 'Parar em 00:00' },
  { value: 'message', label: 'Mostrar mensagem' },
]

interface FieldsProps {
  eventId: string
  type: Scene['type']
  c: Scene['content']
  set: (patch: Partial<Scene['content']>) => void
  media: Media[]
}

function Fields({ eventId, type, c, set, media }: FieldsProps) {
  switch (type) {
    case 'title': {
      const t = c as SceneContent<'title'>
      return (
        <>
          <Field label="Sobretítulo" hint="Linha curta acima do título." className="col-span-2">
            <Input value={t.kicker} maxLength={120} onChange={(e) => set({ kicker: e.target.value })} />
          </Field>
          <Field label="Título" className="col-span-2">
            <Input data-autofocus value={t.title} maxLength={300} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Texto" className="col-span-2">
            <Textarea value={t.body} maxLength={2000} onChange={(e) => set({ body: e.target.value })} />
          </Field>
        </>
      )
    }
    case 'image':
    case 'video': {
      const m = c as SceneContent<'image'> | SceneContent<'video'>
      const label = type === 'image' ? 'Imagem' : 'Vídeo'
      return (
        <>
          <Group label={label} className="col-span-2">
            <MediaPicker eventId={eventId} media={media} kind={type} label={label} value={m.src || null} onChange={(url) => set({ src: url ?? '' })} />
          </Group>
          <Group label="Encaixe">
            <Segmented label="Encaixe" className="self-start" value={m.fit} onChange={(fit) => set({ fit })} options={FIT} />
          </Group>
          {'caption' in m ? (
            <Field label="Legenda">
              <Input value={m.caption} maxLength={300} onChange={(e) => set({ caption: e.target.value })} />
            </Field>
          ) : (
            <div className="flex flex-col gap-3">
              <Switch label="Repetir" checked={m.loop} onChange={(loop) => set({ loop })} />
              <Switch
                label="Iniciar automaticamente"
                description="Começa a tocar ao entrar no ar."
                checked={m.autoplay}
                onChange={(autoplay) => set({ autoplay })}
              />
            </div>
          )}
        </>
      )
    }
    case 'embed':
      return <EmbedFields eventId={eventId} c={c as SceneContent<'embed'>} set={set} />
    case 'questions': {
      const q = c as SceneContent<'questions'>
      return (
        <>
          <Field label="Título" hint="Aparece acima das perguntas." className="col-span-2">
            <Input data-autofocus value={q.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Group label="Layout">
            <Segmented label="Layout" className="self-start" value={q.layout} onChange={(layout) => set({ layout, max: LAYOUT_MAX[layout] })} options={LAYOUTS} />
          </Group>
          {q.layout === 'spotlight' ? (
            <p className="self-end pb-1.5 text-meta text-fg-subtle">O destaque mostra uma pergunta por vez.</p>
          ) : (
            <Field label="Máximo na tela">
              <Select value={String(q.max)} onChange={(v) => set({ max: Number(v) })} options={MAX} />
            </Field>
          )}
          <Switch label="Mostrar autor" checked={q.showAuthor} onChange={(showAuthor) => set({ showAuthor })} />
          <Switch label="Mostrar curtidas" checked={q.showLikes} onChange={(showLikes) => set({ showLikes })} />
        </>
      )
    }
    case 'timer': {
      const t = c as SceneContent<'timer'>
      return (
        <>
          <Field label="Título" hint="Aparece com os números." className="col-span-2">
            <Input data-autofocus value={t.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Group label="Modo">
            <Segmented label="Modo" className="self-start" value={t.mode} onChange={(mode) => set({ mode })} options={MODES} />
          </Group>
          <TimeField label="Duração" seconds={t.durationSec} min={1} onChange={(durationSec) => set({ durationSec })} />
          <TimeField label="Aviso em" hint="Faltando este tempo, os números ficam âmbar." seconds={t.warnSec} onChange={(warnSec) => set({ warnSec })} />
          <TimeField label="Crítico em" hint="Faltando este tempo, ficam vermelhos." seconds={t.criticalSec} onChange={(criticalSec) => set({ criticalSec })} />
          <Field label="Ao terminar">
            <Select value={t.onEnd} onChange={(onEnd) => set({ onEnd })} options={ON_END} />
          </Field>
          {t.onEnd === 'message' && (
            <Field label="Mensagem">
              <Input value={t.endText} maxLength={120} onChange={(e) => set({ endText: e.target.value })} />
            </Field>
          )}
        </>
      )
    }
    case 'join': {
      const j = c as SceneContent<'join'>
      return (
        <>
          <Field label="Título" hint="Aparece acima das instruções de entrada e do PIN." className="col-span-2">
            <Input data-autofocus value={j.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <OpenJoin eventId={eventId} />
        </>
      )
    }
  }
}

/**
 * A mesma chave de Ajustes, aqui porque decide o que a cena mostra: desligada, o evento aceita só convidados e a
 * tela fica sem QR code (quem lesse cairia numa página que pede o link do convite). É do evento, não da cena: vale
 * na hora, mesmo com a cena no ar, sem passar por "Atualizar no ar". A descrição diz isso.
 */
function OpenJoin({ eventId }: { eventId: string }) {
  const on = useEvent().snap.event.settings.openJoin
  return (
    <Switch
      label="Entrada aberta"
      description={
        on
          ? 'Vale para o evento todo, na hora: quem lê o QR code ou digita o endereço entra com o nome e o PIN.'
          : 'Vale para o evento todo, na hora. Desligada, só convidados entram e a tela mostra o PIN, sem QR code.'
      }
      checked={on}
      onChange={(openJoin) => void run(() => patch(`/events/${eventId}`, { settings: { openJoin } }))}
      className="col-span-2 max-w-[480px]"
    />
  )
}

/** Slides da apresentação: enviar (PDF ou imagens, também arrastando), escolher o slide e remover. */
function SlidesFields({
  eventId,
  c,
  set,
  onAdd,
  current,
  onAir,
  onPick,
}: {
  eventId: string
  c: SceneContent<'slides'>
  set: (patch: Partial<SceneContent<'slides'>>) => void
  onAdd: (urls: string[], firstFile: string) => void
  current: number
  onAir: boolean
  onPick?: (index: number) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const add = async (files: File[]) => {
    if (!files.length || progress) return
    setProgress([0, 0])
    try {
      const urls = await importSlides(eventId, files, (done, total) => setProgress([done, total]))
      if (urls?.length) {
        onAdd(urls, files[0].name)
        notify(plural(urls.length, 'slide adicionado', 'slides adicionados'))
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Não foi possível preparar os slides.', { tone: 'critical' })
    }
    setProgress(null)
  }
  const remove = (i: number) => {
    const before = c.slides
    set({ slides: before.filter((_, j) => j !== i) })
    undoable(`Slide ${i + 1} removido`, () => set({ slides: before }))
  }
  return (
    <div
      className="col-span-2 flex flex-col gap-3"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void add([...e.dataTransfer.files])
      }}
    >
      <div className="flex items-center gap-3">
        <input
          ref={input}
          type="file"
          multiple
          accept={SLIDE_ACCEPT}
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            void add(files)
          }}
        />
        <Button
          variant={c.slides.length ? 'secondary' : 'primary'}
          icon={<FilePdfIcon />}
          loading={!!progress}
          className="shrink-0"
          onClick={() => input.current?.click()}
        >
          {progress ? (progress[1] ? `Preparando ${progress[0] + 1} de ${progress[1]}…` : 'Abrindo…') : c.slides.length ? 'Adicionar slides' : 'Enviar apresentação'}
        </Button>
        <p className="text-meta text-fg-subtle">
          PDF exportado do PowerPoint, Keynote, Google Slides ou Canva, ou as imagens dos slides. Também dá para arrastar os arquivos para cá.
          Animações e vídeos dentro dos slides não vêm junto.
        </p>
      </div>
      {c.slides.length > 0 && (
        <>
          <p className="text-meta text-fg-subtle">
            {onAir ? 'Clique num slide para mostrá-lo na tela agora.' : 'Clique num slide para a apresentação começar nele.'}
          </p>
          <ol aria-label="Slides" className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-2 gap-y-1">
            {c.slides.map((src, i) => (
              <li key={`${i}:${src}`} className="group flex min-w-0 flex-col gap-0.5">
                <button
                  type="button"
                  aria-label={`Slide ${i + 1}`}
                  aria-current={i === current || undefined}
                  onClick={() => onPick?.(i)}
                  className="relative block aspect-video w-full overflow-hidden rounded-monitor bg-black"
                >
                  <img src={src} alt="" loading="lazy" draggable={false} className="size-full object-contain" />
                  <span
                    aria-hidden
                    className={cx(
                      'pointer-events-none absolute inset-0 rounded-monitor',
                      i === current ? (onAir ? 'tally-program' : 'tally-preview') : 'border border-line',
                    )}
                  />
                </button>
                <span className="flex h-6 items-center justify-between text-meta text-fg-subtle tabular-nums">
                  {i + 1}
                  <IconButton
                    size="sm"
                    label={`Remover slide ${i + 1}`}
                    icon={<XIcon size={12} />}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => remove(i)}
                  />
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

/** Rótulo visual para controles que já têm nome acessível próprio (Segmented, MediaPicker). */
function Group({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <span aria-hidden className="text-meta font-medium text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  )
}

/** Tempo em mm:ss. Enquanto digita, só valores válidos seguem adiante; ao sair, o campo mostra o valor salvo. */
function TimeField({ label, hint, seconds, min = 0, onChange }: { label: string; hint?: string; seconds: number; min?: number; onChange: (s: number) => void }) {
  const [text, setText] = useState<string | null>(null) // null = sem foco, mostra o valor atual
  const parsed = text === null ? seconds : parseDuration(text)
  const valid = parsed !== null && parsed >= min && parsed <= 86_400
  const midway = text !== null && /^\s*$|:\s*$/.test(text) // vazio ou "1:": ainda está sendo digitado
  return (
    <Field label={label} hint={hint} error={valid || midway ? null : 'Use minutos e segundos, como 05:00.'}>
      <Input
        value={text ?? clock(seconds * 1000)}
        inputMode="numeric"
        placeholder="mm:ss"
        onFocus={(e) => setText(e.target.value)}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value)
          const s = parseDuration(e.target.value)
          if (s !== null && s >= min && s <= 86_400) onChange(s)
        }}
      />
    </Field>
  )
}

const DISPLAY: Option<'page' | 'link'>[] = [
  { value: 'page', label: 'Página' },
  { value: 'link', label: 'Endereço e QR code' },
]

/**
 * Página web: endereço, verificação no servidor (o site aceita aparecer dentro da tela?) e o que vai para a tela.
 * Site que bloqueia troca sozinho para endereço e QR code (a tela nunca mostra o erro) quando o endereço acabou de
 * ser digitado ou a cena ainda não tem escolha (cenas antigas incluídas). Escolha feita à mão é respeitada.
 */
function EmbedFields({ eventId, c, set }: { eventId: string; c: SceneContent<'embed'>; set: (p: Partial<SceneContent<'embed'>>) => void }) {
  const [check, setCheck] = useState<EmbedCheck | 'checking' | null>(null)
  const typed = useRef<string | null>(null)
  const display = c.display ?? 'page'
  useEffect(() => {
    setCheck(c.url ? 'checking' : null)
    if (!c.url) return
    let alive = true
    post<EmbedCheck>(`/events/${eventId}/embed-check`, { url: c.url }).then(
      (r) => {
        if (!alive) return
        setCheck(r)
        const auto = typed.current === c.url || c.display === undefined
        const patch: Partial<SceneContent<'embed'>> = {}
        if (r.embeddable !== null && r.url && r.url !== c.url) patch.url = typed.current = r.url // mesmo site, endereço final
        if (r.embeddable === false && auto && display === 'page') patch.display = 'link'
        if (Object.keys(patch).length) set(patch)
      },
      () => alive && setCheck({ embeddable: null }),
    )
    return () => {
      alive = false
    }
  }, [c.url])
  const tail =
    display === 'link' ? ' Na tela vai o endereço com QR code, para o público abrir no celular.' : ' Escolha “Endereço e QR code” para o público abrir no celular.'
  const note: [ReactNode, string] | null =
    check === 'checking'
      ? [<Spinner size={14} />, 'Verificando se o site abre dentro da tela…']
      : !check
        ? null
        : check.embeddable === true
          ? [<CheckCircleIcon size={14} className="text-accent-fg" />, 'O site abre dentro da tela.']
          : check.embeddable === false
            ? [
                <WarningIcon size={14} className="text-attention" />,
                (check.reason === 'blocked'
                  ? 'Este site não permite aparecer dentro de outra página: na tela ficaria uma página de erro.'
                  : `O site recusou a conexão (erro ${check.status}) e provavelmente não abre na tela.`) + tail,
              ]
            : [<InfoIcon size={14} className="text-fg-subtle" />, 'Não foi possível verificar o site agora. Confira na tela antes de o público chegar.']
  return (
    <>
      <UrlField
        value={c.url}
        onChange={(url) => {
          typed.current = url
          set({ url })
        }}
      />
      <Group label="Na tela" className="col-span-2">
        <Segmented label="Na tela" className="self-start" value={display} onChange={(d) => set({ display: d })} options={DISPLAY} />
      </Group>
      {note && (
        <p role="status" className="col-span-2 flex items-start gap-2 text-meta text-fg-muted">
          <span className="mt-px flex shrink-0">{note[0]}</span>
          {note[1]}
        </p>
      )}
    </>
  )
}

/** Endereço da página: confirmado ao sair do campo, para a página não recarregar a cada tecla. */
function UrlField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setText(value), [value])
  const commit = () => {
    if (!text.trim()) {
      setError(null)
      return onChange('')
    }
    const url = embedUrl(text)
    if (!url) return setError('Use um endereço que comece com http:// ou https://.')
    setError(null)
    setText(url)
    onChange(url)
  }
  return (
    <Field
      label="Endereço da página"
      hint="Links do YouTube, do Vimeo, do Google (apresentações, documentos, planilhas e Drive) e do Canva viram a versão que abre dentro da tela."
      error={error}
      className="col-span-2"
    >
      <Input data-autofocus value={text} placeholder="https://…" spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={commit} />
    </Field>
  )
}
