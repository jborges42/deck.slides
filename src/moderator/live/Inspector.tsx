// Inspetor: edita a cena da prévia. Fora do ar, salva sozinho; no ar, as mudanças esperam "Atualizar no ar".
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BroadcastIcon } from '@phosphor-icons/react/Broadcast'
import { clock } from '../../lib/format.ts'
import { Button, Chip, Field, Input, Segmented, Select, Switch, Textarea, cx, type Option } from '../../ui'
import { MediaPicker } from '../MediaPicker.tsx'
import type { SaveState } from './drafts.ts'
import { KIND } from './kinds.ts'
import { embedUrl, parseDuration, sameDraft, type Draft } from './logic.ts'
import type { Media, Scene, SceneContent } from '../../../shared/types.ts'

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
}

export function Inspector({ eventId, scene, draft, onAir, state, media, onChange, onPublish, onDiscard }: Props) {
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
          <Fields key={epoch} eventId={eventId} type={scene.type} c={value.content} set={set} media={media} />
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
      return <UrlField value={(c as SceneContent<'embed'>).url} onChange={(url) => set({ url })} />
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
  }
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
      hint="Links do YouTube viram o player. Alguns sites não permitem aparecer dentro de outra página."
      error={error}
      className="col-span-2"
    >
      <Input data-autofocus value={text} placeholder="https://…" spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={commit} />
    </Field>
  )
}
