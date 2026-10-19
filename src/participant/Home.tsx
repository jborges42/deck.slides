// Página do participante já confirmado: o que está na tela, reações, envio de perguntas e as próprias perguntas.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Field as BaseField } from '@base-ui/react/field'
import { ThumbsUpIcon } from '@phosphor-icons/react/ThumbsUp'
import { ApiError, post } from '../lib/api.ts'
import { REACTION, ReactionEmoji } from '../lib/reactions.tsx'
import { useStream, type StreamStatus } from '../lib/stream.ts'
import { Button, Chip, cx, inputClass, notify, type Tone } from '../ui'
import { EventHeader, Loading, Notice, PhoneField, PhonePage, PhoneSwitch, firstName, type EventBrand } from './shell.tsx'
import type { ParticipantSnapshot, QuestionStatus, ReactionKind, SceneType } from '../../shared/types.ts'

type Settings = ParticipantSnapshot['event']['settings']

const failure = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente novamente.')

export function Home({ id, brand, onLeave }: { id: string; brand: EventBrand | null; onLeave: () => void }) {
  const { state: snap, counts, status } = useStream<ParticipantSnapshot>(`/api/p/${id}/stream`)
  const banner = useConnectionBanner(status)
  const offline = banner === 'offline' || banner === 'busy'
  const ended = status === 'denied' || status === 'gone'
  const [leaving, setLeaving] = useState(false)

  // A linha "envio fechado" promete avisar quando abrir.
  const open = snap?.event.settings.questionsOpen
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current === false && open) notify('O envio de perguntas está aberto.')
    wasOpen.current = open
  }, [open])

  const leave = async () => {
    setLeaving(true)
    try {
      await post(`/p/${id}/leave`)
      onLeave()
    } catch (e) {
      setLeaving(false)
      notify(failure(e), { tone: 'critical' })
    }
  }

  const now = snap?.now ?? null
  const onAir = new Set(now?.questions.map((q) => q.id))
  const mine = new Set(snap?.mine.map((q) => q.id))
  // O servidor omite perguntas sem curtidas em counts.likes. Depois do primeiro `counts` (o useStream troca
  // o objeto inicial), ausência = 0; antes dele, vale o número do snapshot.
  const firstCounts = useRef(counts).current
  const likes = counts === firstCounts ? null : counts.likes

  return (
    <PhonePage brand={snap?.event.theme ?? brand} title={snap?.event.name ?? brand?.name} top={!ended && <ConnectionBanner state={banner} />}>
      {ended ? (
        <Notice title="Seu acesso a este evento foi encerrado.">Em caso de dúvida, fale com a organização do evento.</Notice>
      ) : !snap ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-8">
          <EventHeader name={snap.event.name} logo={snap.event.theme.logo} size="head">
            <p className="text-fg-muted">Olá, {firstName(snap.me.name)}.</p>
          </EventHeader>

          <div className="flex flex-col gap-3">
            <NowCard id={id} now={now} likes={likes} mine={mine} canLike={snap.event.settings.reactionsOpen && !offline} />
            {snap.event.settings.reactionsOpen && now && (
              <Reactions key={now.sceneId} id={id} kinds={snap.event.settings.reactions} disabled={offline} />
            )}
          </div>

          <Composer id={id} settings={snap.event.settings} offline={offline} />
          <Mine items={snap.mine} onAir={onAir} />

          <footer className="flex justify-center border-t border-line pt-4">
            <Button variant="ghost" size="xl" loading={leaving} onClick={leave}>
              Sair do evento
            </Button>
          </footer>
        </div>
      )}
    </PhonePage>
  )
}

// ---------- conexão ----------

/** Só avisa depois de 3 s sem conexão; ao voltar, mostra "restabelecida" por um instante. */
function useConnectionBanner(status: StreamStatus): 'offline' | 'busy' | 'back' | null {
  const [banner, setBanner] = useState<'offline' | 'busy' | 'back' | null>(null)
  useEffect(() => {
    if (status === 'busy') return setBanner('busy') // servidor recusou: já há abas demais com este convite
    if (status === 'reconnecting') {
      const t = setTimeout(() => setBanner('offline'), 3000)
      return () => clearTimeout(t)
    }
    if (status === 'live') setBanner((b) => (b === 'offline' || b === 'busy' ? 'back' : b))
  }, [status])
  useEffect(() => {
    if (banner !== 'back') return
    const t = setTimeout(() => setBanner(null), 2500)
    return () => clearTimeout(t)
  }, [banner])
  return banner
}

const BANNER = {
  offline: 'Sem conexão. Tentando reconectar…',
  busy: 'Este evento já está aberto em outras abas ou aparelhos. Feche as outras e esta página reconecta sozinha.',
  back: 'Conexão restabelecida.',
}

function ConnectionBanner({ state }: { state: 'offline' | 'busy' | 'back' | null }) {
  // A região existe sempre, para o leitor de tela anunciar a troca de texto.
  return (
    <div
      role="status"
      className={cx('sticky top-0 z-10', state && 'pt-[env(safe-area-inset-top)]', state === 'back' || !state ? 'bg-raised text-fg' : 'bg-attention text-on-signal')}
    >
      {state && <p className="mx-auto max-w-[560px] px-4 py-2.5 font-medium">{BANNER[state]}</p>}
    </div>
  )
}

// ---------- na tela agora ----------

const TYPE_HINT: Partial<Record<SceneType, string>> = { image: 'Imagem', video: 'Vídeo', embed: 'Página web', timer: 'Cronômetro', slides: 'Apresentação' }

function NowCard({
  id,
  now,
  likes,
  mine,
  canLike,
}: {
  id: string
  now: ParticipantSnapshot['now']
  likes: Record<string, number> | null
  mine: Set<string>
  canLike: boolean
}) {
  // Curtida otimista: vale até o snapshot confirmar o mesmo estado; em erro, volta ao do servidor.
  const [optimistic, setOptimistic] = useState<Record<string, { liked: boolean; likes: number }>>({})

  const toggle = async (qid: string, liked: boolean, count: number) => {
    const next = { liked: !liked, likes: Math.max(0, count + (liked ? -1 : 1)) }
    setOptimistic((o) => ({ ...o, [qid]: next }))
    try {
      await post(`/p/${id}/questions/${qid}/like`, { on: next.liked })
    } catch (e) {
      setOptimistic((o) => {
        const rest = { ...o }
        delete rest[qid]
        return rest
      })
      notify(failure(e), { tone: 'critical' })
    }
  }

  return (
    <section aria-labelledby="na-tela" className="rounded-panel bg-accent-soft p-4">
      <h2 id="na-tela" className="font-semibold text-accent-fg">
        Na tela agora
      </h2>
      {!now ? (
        <p className="mt-1 text-fg-muted">Nada na tela no momento.</p>
      ) : now.type !== 'questions' ? (
        <>
          <p className="mt-1 text-head font-semibold wrap-anywhere">{now.label}</p>
          {TYPE_HINT[now.type] && <p className="text-fg-muted">{TYPE_HINT[now.type]}</p>}
        </>
      ) : !now.questions.length ? (
        <p className="mt-1 text-fg-muted">As perguntas escolhidas pela moderação aparecem aqui.</p>
      ) : (
        <ul className="divide-y divide-line">
          {now.questions.map((q) => {
            const o = optimistic[q.id]
            const pending = o && o.liked !== q.liked
            const liked = pending ? o.liked : q.liked
            const count = pending ? o.likes : likes ? (likes[q.id] ?? 0) : q.likes
            const author = mine.has(q.id) ? 'Sua pergunta' : q.author
            return (
              <li key={q.id} className="py-3 last:pb-0">
                <p className={cx('wrap-anywhere', now.questions.length === 1 && 'text-head')}>{q.text}</p>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="min-w-0 text-fg-muted wrap-anywhere">{author}</span>
                  {/* Fundo da página (não "raised"): sobre o cartão tingido, o botão fica limpo. */}
                  <button
                    type="button"
                    aria-pressed={liked}
                    disabled={!canLike}
                    onClick={() => toggle(q.id, liked, count)}
                    className="state-layer inline-flex h-12 shrink-0 items-center gap-2.5 rounded-control border border-line px-4 font-medium [--state-bg:var(--canvas)] disabled:opacity-45"
                  >
                    <ThumbsUpIcon size={20} weight={liked ? 'fill' : 'regular'} className={liked ? 'text-accent-fg' : undefined} />
                    Curtir
                    {count > 0 && <span className="tabular-nums">{count.toLocaleString('pt-BR')}</span>}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ---------- reações ----------


const COLS = ['', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4']

/**
 * Toques agrupados por tipo: no máximo um envio por segundo, até 5 por tipo (o excedente só anima).
 * Montado por cena (key): trocou a cena, a contagem local zera e os toques pendentes são descartados.
 */
function Reactions({ id, kinds, disabled }: { id: string; kinds: ReactionKind[]; disabled: boolean }) {
  const [taps, setTaps] = useState<Partial<Record<ReactionKind, number>>>({})
  const batch = useRef<Partial<Record<ReactionKind, number>>>({})
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const last = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const flush = () => {
    timer.current = undefined
    last.current = Date.now()
    const body = batch.current
    batch.current = {}
    post(`/p/${id}/reactions`, { kinds: body }).catch(() => {}) // reação perdida não merece aviso
  }

  const tap = (kind: ReactionKind) => {
    navigator.vibrate?.(10)
    setTaps((t) => ({ ...t, [kind]: (t[kind] ?? 0) + 1 }))
    batch.current[kind] = Math.min(5, (batch.current[kind] ?? 0) + 1)
    timer.current ??= setTimeout(flush, Math.max(0, last.current + 1000 - Date.now()))
  }

  if (!kinds.length) return null
  return (
    <div role="group" aria-label="Reações" className={cx('grid gap-2', COLS[kinds.length] ?? 'grid-cols-3')}>
      {kinds.map((kind) => {
        const { label } = REACTION[kind]
        const n = taps[kind] ?? 0
        return (
          <button
            key={kind}
            type="button"
            disabled={disabled}
            onClick={() => tap(kind)}
            className="state-layer relative flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-control border border-line text-ui font-medium [--state-bg:var(--surface)] disabled:opacity-45"
          >
            {/* key muda a cada toque: o ícone remonta e a animação recomeça */}
            <ReactionEmoji key={n} kind={kind} className={cx('text-[28px]', n > 0 && 'animate-[pop_160ms_var(--ease-out)]')} />
            {label}
            {n > 0 && (
              <span aria-hidden className="absolute top-1 right-2 text-meta text-fg-muted tabular-nums">
                {n}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ---------- envio de perguntas ----------

const IDENTITY_NOTE = {
  name: 'Seu nome aparece na tela com a pergunta.',
  anonymous: 'As perguntas aparecem na tela sem nome.',
}

const readDraft = (key: string) => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function Composer({ id, settings, offline }: { id: string; settings: Settings; offline: boolean }) {
  const key = `deck:pergunta:${id}`
  const [draft, setDraft] = useState(() => readDraft(key))
  const [anonymous, setAnonymous] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // O rascunho sobrevive a recarregar a página e ao envio fechado.
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(key, draft)
      else localStorage.removeItem(key)
    } catch {
      // armazenamento indisponível (aba anônima): o rascunho fica só na memória
    }
  }, [key, draft])

  if (!settings.questionsOpen) return <p className="text-fg-muted">O envio de perguntas está fechado. Esta página avisa quando abrir.</p>

  const max = settings.maxLength
  const length = draft.trim().length
  const over = length - max

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!length || over > 0 || busy || offline) return
    setBusy(true)
    try {
      await post(`/p/${id}/questions`, { text: draft.trim(), anonymous: settings.identity === 'choice' && anonymous })
      setDraft('')
      setError(null)
      notify('Pergunta enviada para a moderação.')
    } catch (err) {
      setError(
        err instanceof ApiError && err.status
          ? err.message
          : 'Não foi possível enviar. Sua pergunta continua aqui. Tente de novo quando a conexão voltar.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={send} className="flex flex-col gap-4">
      <PhoneField
        label="Sua pergunta"
        error={over > 0 ? `Limite de ${max} caracteres. Remova ${over} para enviar.` : error}
        aside={
          <span className={cx('tabular-nums', over > 0 ? 'text-critical' : 'text-fg-muted')}>
            {length}/{max}
          </span>
        }
      >
        <BaseField.Control
          render={<textarea rows={3} />}
          value={draft}
          onChange={(e) => {
            setDraft(e.currentTarget.value)
            setError(null)
          }}
          placeholder="Escreva sua pergunta…"
          className={cx(inputClass, 'block max-h-64 min-h-24 resize-none py-2.5 text-body field-sizing-content')}
        />
      </PhoneField>
      {settings.identity === 'choice' ? (
        <PhoneSwitch checked={anonymous} onChange={setAnonymous} label="Enviar sem meu nome na tela" description="A moderação vê quem enviou." />
      ) : (
        <p className="text-fg-muted">{IDENTITY_NOTE[settings.identity]}</p>
      )}
      <Button type="submit" variant="primary" size="xl" loading={busy} disabled={offline || !length || over > 0} className="w-full">
        Enviar pergunta
      </Button>
    </form>
  )
}

// ---------- minhas perguntas ----------

const STATUS: Record<QuestionStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Aguardando aprovação', tone: 'outline' },
  approved: { label: 'Aprovada', tone: 'neutral' },
  answered: { label: 'Respondida', tone: 'neutral' },
  rejected: { label: 'Não aprovada', tone: 'outline' },
}

function Mine({ items, onAir }: { items: ParticipantSnapshot['mine']; onAir: Set<string> }) {
  return (
    <section aria-labelledby="minhas" className="flex flex-col gap-1">
      <h2 id="minhas" className="font-semibold">
        Minhas perguntas
      </h2>
      {items.length ? (
        <ul aria-live="polite" className="divide-y divide-line">
          {items.map((q) => {
            // "Na tela agora" só quando a pergunta está de fato na cena no ar (não basta estar marcada).
            const status = onAir.has(q.id) ? { label: 'Na tela agora', tone: 'accent' as const } : STATUS[q.status]
            return (
              <li key={q.id} className="py-3">
                <p className={cx('wrap-anywhere', q.status === 'rejected' && 'text-fg-muted')}>{q.text}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Chip tone={status.tone}>{status.label}</Chip>
                  {q.edited && <Chip tone="outline">Texto ajustado pela moderação</Chip>}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-fg-muted">Suas perguntas aparecem aqui depois de enviadas.</p>
      )}
    </section>
  )
}
