// Ajustes do evento (/eventos/:id/ajustes): dados do evento, participação, telas e ações sem volta.
// Cada mudança é gravada na hora (campos de texto, ao sair do campo); o valor exibido vem do próximo snapshot.
import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArrowSquareOutIcon } from '@phosphor-icons/react/ArrowSquareOut'
import { ArrowsClockwiseIcon } from '@phosphor-icons/react/ArrowsClockwise'
import { CheckIcon } from '@phosphor-icons/react/Check'
import { CopyIcon } from '@phosphor-icons/react/Copy'
import { PencilSimpleIcon } from '@phosphor-icons/react/PencilSimple'
import { del, patch, post } from '../lib/api.ts'
import { ago } from '../lib/format.ts'
import { Button, Code, Dot, Field, Input, Segmented, Select, Switch, Textarea, buttonClass, confirm, cx, inputClass, notify } from '../ui'
import { run, useEvent } from './context.ts'
import { Page, copy, message } from './setup/kit.tsx'
import { REACTION, ReactionEmoji } from '../lib/reactions.tsx'
import { REACTIONS, normalize, publicAuthor, type EventSettings, type ScreenInfo } from '../../shared/types.ts'

type Save = (body: { name?: string; pin?: string; settings?: Partial<EventSettings> }) => Promise<boolean>


const IDENTITY: Record<EventSettings['identity'], string> = {
  name: 'As perguntas aparecem com o nome cadastrado de quem enviou.',
  choice: 'Cada pessoa decide se envia com o nome ou sem identificação.',
  anonymous: 'O público não vê quem enviou. A moderação continua vendo.',
}

const enterBlur = (e: KeyboardEvent<HTMLElement>) => e.key === 'Enter' && e.currentTarget.blur()

export default function Settings() {
  const { id, snap, links } = useEvent()
  const navigate = useNavigate()
  const { event } = snap
  const s = event.settings
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const save: Save = async (body) => {
    const ok = !!(await run(() => patch(`/events/${id}`, body)))
    clearTimeout(timer.current)
    setSaved(ok)
    if (ok) timer.current = setTimeout(() => setSaved(false), 2500)
    return ok
  }
  const set = (settings: Partial<EventSettings>) => void save({ settings })

  const resetReactions = async () => {
    const ok = await confirm({
      title: 'Zerar as reações?',
      body: 'As contagens de todas as cenas voltam a zero, na tela e no console. Não é possível desfazer.',
      confirm: 'Zerar reações',
    })
    if (ok && (await run(() => post(`/events/${id}/reactions/reset`)))) notify('Reações zeradas.')
  }
  const remove = async () => {
    const ok = await confirm({
      title: 'Excluir o evento?',
      body: 'Roteiro, perguntas, participantes e arquivos são apagados. Não é possível desfazer.',
      confirm: 'Excluir evento',
    })
    if (!ok || !(await run(() => del(`/events/${id}`)))) return
    notify('Evento excluído.', { description: event.name })
    navigate('/eventos', { replace: true })
  }

  return (
    <Page
      title="Ajustes"
      actions={
        <span role="status" className="flex items-center gap-1.5 text-meta text-fg-subtle">
          {saved && (
            <>
              <CheckIcon size={14} />
              Alterações salvas
            </>
          )}
        </span>
      }
    >
      <Section title="Evento">
        <NameField name={event.name} save={save} />
        <PinField pin={event.pin} save={save} />
      </Section>

      <Section title="Participação">
        <Group label="Identificação nas perguntas" hint={IDENTITY[s.identity]}>
          <Segmented
            label="Identificação nas perguntas"
            value={s.identity}
            onChange={(identity) => set({ identity })}
            options={[
              { value: 'name', label: 'Nome sempre' },
              { value: 'choice', label: 'Participante escolhe' },
              { value: 'anonymous', label: 'Sempre anônimo' },
            ]}
          />
        </Group>

        <Group
          label="Nome na tela"
          hint={
            s.identity === 'anonymous'
              ? 'Sem efeito enquanto as perguntas forem sempre anônimas.'
              : `Exemplo: “${publicAuthor('Ana Paula Souza', false, s.screenName)}”.`
          }
        >
          <div className="w-64">
            <Select
              label="Nome na tela"
              value={s.screenName}
              disabled={s.identity === 'anonymous'}
              onChange={(screenName) => set({ screenName })}
              options={[
                { value: 'first-initial', label: 'Primeiro nome e inicial' },
                { value: 'full', label: 'Nome completo' },
                { value: 'first', label: 'Primeiro nome' },
              ]}
            />
          </div>
        </Group>

        <MaxLength value={s.maxLength} onSave={(maxLength) => set({ maxLength })} />

        <Group label="Reações disponíveis" hint="Os celulares mostram as reações nesta ordem. Para pausar todas, use a chave “Reações” na barra do evento.">
          <div className="flex flex-wrap gap-2">
            {REACTIONS.map((r) => {
              const on = s.reactions.includes(r)
              const { label } = REACTION[r]
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    if (on && s.reactions.length === 1) return void notify('Mantenha pelo menos uma reação.')
                    set({ reactions: REACTIONS.filter((k) => (k === r ? !on : s.reactions.includes(k))) })
                  }}
                  className="state-layer inline-flex h-8 items-center gap-1.5 rounded-control border border-line px-2.5 text-ui font-medium text-fg-subtle aria-pressed:border-accent aria-pressed:text-accent-fg aria-pressed:[--state-bg:var(--accent-soft)]"
                >
                  <ReactionEmoji kind={r} className={cx('text-[16px]', !on && 'opacity-50 grayscale')} />
                  {label}
                </button>
              )
            })}
          </div>
        </Group>

        <Switch
          label="Marcar como respondida ao destacar outra"
          description="Ao destacar uma pergunta na tela, a que estava antes passa para Respondida."
          checked={s.autoAnswer}
          onChange={(autoAnswer) => set({ autoAnswer })}
        />

        <FlagWords words={s.flagWords} onSave={(flagWords) => set({ flagWords })} />

        <div className="flex flex-col gap-2">
          <Switch
            label="Entrada aberta"
            description="Qualquer pessoa com o link entra informando o nome e o PIN do evento, sem convite."
            checked={s.openJoin}
            onChange={(openJoin) => set({ openJoin })}
          />
          {s.openJoin && (
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-ui text-fg-muted">{links.join}</span>
              <Button size="sm" icon={<CopyIcon />} onClick={() => copy(links.join)}>
                Copiar link
              </Button>
            </div>
          )}
        </div>
      </Section>

      <Section
        title="Telas"
        description={
          <>
            A tela do evento é o computador ligado ao projetor ou ao painel. Nele, abra{' '}
            <span className="font-code text-fg">{links.pair.replace(/^https?:\/\//, '')}</span> e digite aqui o código que aparecer.
          </>
        }
      >
        <Screens eventId={id} screens={snap.screens} />
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<CopyIcon />} onClick={() => copy(links.pair, 'Endereço copiado.')}>
            Copiar endereço de pareamento
          </Button>
          <a href={links.screen} target="_blank" rel="noopener" className={buttonClass('ghost', 'sm')}>
            Abrir a tela neste computador
            <ArrowSquareOutIcon size={14} />
          </a>
        </div>
      </Section>

      <Section title="Zona de risco">
        <Danger title="Zerar reações" description="As contagens de reações de todas as cenas voltam a zero.">
          <Button variant="danger" onClick={resetReactions}>
            Zerar reações
          </Button>
        </Danger>
        <Danger title="Excluir evento" description="Apaga o evento com roteiro, perguntas, participantes e arquivos.">
          <Button variant="danger" onClick={remove}>
            Excluir evento
          </Button>
        </Danger>
      </Section>
    </Page>
  )
}

// ---------- estrutura ----------

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-6 pb-9">
      <h2 className="font-heading text-title font-semibold">{title}</h2>
      {description && <p className="mt-1 max-w-[64ch] text-ui text-fg-muted">{description}</p>}
      <div className="mt-5 flex max-w-[640px] flex-col gap-6">{children}</div>
    </section>
  )
}

/** Rótulo + controle + ajuda, para controles que não são campos de texto (o <Field> cuida dos campos). */
function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col items-start gap-1.5">
      <span id={id} className="text-meta font-medium text-fg-muted">
        {label}
      </span>
      {children}
      {hint && <p className="text-meta text-fg-subtle">{hint}</p>}
    </div>
  )
}

function Danger({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="text-ui text-fg">{title}</p>
        <p className="text-meta text-fg-subtle">{description}</p>
      </div>
      {children}
    </div>
  )
}

// ---------- evento ----------

function NameField({ name, save }: { name: string; save: Save }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <Field label="Nome do evento" error={error}>
      <Input
        key={name}
        defaultValue={name}
        maxLength={120}
        autoComplete="off"
        onChange={() => error && setError(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.value = name
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }}
        onBlur={(e) => {
          const value = e.currentTarget.value.replace(/\s+/g, ' ').trim()
          if (!value) return setError('Informe o nome do evento.')
          if (value !== name) void save({ name: value })
        }}
      />
    </Field>
  )
}

function PinField({ pin, save }: { pin: string; save: Save }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useId()
  const hint = useId()
  const close = () => {
    setEditing(false)
    setError(null)
  }
  const regenerate = async () => {
    const ok = await confirm({
      title: 'Gerar um novo PIN?',
      body: 'Quem já entrou continua no evento. Quem ainda não entrou vai precisar do PIN novo.',
      confirm: 'Gerar novo PIN',
    })
    if (ok) await save({ pin: String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0') })
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const value = String(new FormData(e.currentTarget).get('pin') ?? '').trim()
    if (!/^\d{4,8}$/.test(value)) return setError('Use de 4 a 8 dígitos, só números.')
    if (value === pin || (await save({ pin: value }))) close()
  }
  return (
    <div className="flex flex-col gap-1.5">
      {editing ? (
        <label htmlFor={input} className="text-meta font-medium text-fg-muted">
          Novo PIN
        </label>
      ) : (
        <span className="text-meta font-medium text-fg-muted">PIN do evento</span>
      )}
      {editing ? (
        <form onSubmit={submit} className="flex items-center gap-2" noValidate>
          <span className="w-32">
            <input
              id={input}
              name="pin"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              defaultValue={pin}
              autoFocus
              aria-invalid={!!error}
              aria-describedby={hint}
              onChange={() => error && setError(null)}
              onKeyDown={(e) => e.key === 'Escape' && close()}
              className={cx(inputClass, 'h-8 font-code text-ui tabular-nums')}
            />
          </span>
          <Button type="submit">Salvar PIN</Button>
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-3">
          <Code className="text-page font-medium text-fg">{pin}</Code>
          <Button size="sm" icon={<ArrowsClockwiseIcon />} onClick={regenerate}>
            Gerar novo PIN
          </Button>
          <Button size="sm" variant="ghost" icon={<PencilSimpleIcon />} onClick={() => setEditing(true)}>
            Definir PIN
          </Button>
        </div>
      )}
      <p id={hint} className={cx('text-meta', error ? 'text-critical' : 'text-fg-subtle')}>
        {error ??
          (editing
            ? 'De 4 a 8 dígitos. Quem ainda não entrou vai precisar do PIN novo.'
            : 'Quem entra pelo convite ou pelo link aberto confirma o acesso com este PIN.')}
      </p>
    </div>
  )
}

// ---------- participação ----------

function MaxLength({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <Field label="Tamanho máximo da pergunta" error={error} hint="De 100 a 500 caracteres. Perguntas curtas são mais fáceis de ler na tela.">
      <span className="flex items-center gap-2">
        <span className="w-24">
          <Input
            key={value}
            type="number"
            inputMode="numeric"
            min={100}
            max={500}
            step={10}
            defaultValue={value}
            onKeyDown={enterBlur}
            onChange={() => error && setError(null)}
            onBlur={(e) => {
              const n = Number(e.currentTarget.value)
              if (!Number.isInteger(n) || n < 100 || n > 500) return setError('Use um número inteiro de 100 a 500.')
              if (n !== value) onSave(n)
            }}
            className="tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </span>
        <span className="text-ui text-fg-muted">caracteres</span>
      </span>
    </Field>
  )
}

function FlagWords({ words, onSave }: { words: string[]; onSave: (words: string[]) => void }) {
  const [error, setError] = useState<string | null>(null)
  const current = words.join('\n')
  return (
    <Field
      label="Termos sensíveis"
      error={error}
      hint="Um termo por linha. Perguntas com estes termos ficam marcadas para a moderação. Nada é rejeitado automaticamente."
    >
      <Textarea
        key={current}
        defaultValue={current}
        rows={5}
        spellCheck={false}
        onChange={() => error && setError(null)}
        onBlur={(e) => {
          const lines = e.currentTarget.value.split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
          const long = lines.findIndex((l) => l.length > 60)
          if (long >= 0) return setError(`Linha ${long + 1}: use no máximo 60 caracteres por termo.`)
          // Sem vazios e sem repetidos (comparando como o servidor compara: sem acento e sem caixa).
          const next = lines.filter((l, i) => l && lines.findIndex((o) => normalize(o) === normalize(l)) === i)
          if (next.length > 200) return setError(`São ${next.length} termos. O limite é 200.`)
          if (next.join('\n') !== current) onSave(next)
        }}
      />
    </Field>
  )
}

// ---------- telas ----------

function Screens({ eventId, screens }: { eventId: string; screens: ScreenInfo[] }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const code = useId()
  const hint = useId()
  const pair = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const value = String(new FormData(form).get('code') ?? '').replace(/[\s-]/g, '')
    if (value.length < 6) return setError('Digite os 6 caracteres exibidos na tela.')
    setBusy(true)
    try {
      await post(`/events/${eventId}/screens`, { code: value })
      form.reset()
      setError(null)
      notify('Tela conectada.', { description: 'Renomeie a tela abaixo para identificá-la.' })
    } catch (err) {
      setError(message(err))
    }
    setBusy(false)
  }
  return (
    <>
      {screens.length > 0 ? (
        <ul className="divide-y divide-line border-y border-line">
          {screens.map((sc) => (
            <ScreenRow key={sc.id} screen={sc} eventId={eventId} />
          ))}
        </ul>
      ) : (
        <p className="text-ui text-fg-subtle">Nenhuma tela conectada a este evento.</p>
      )}
      <form onSubmit={pair} className="flex flex-col gap-1.5" noValidate>
        <label htmlFor={code} className="text-meta font-medium text-fg-muted">
          Código exibido na tela
        </label>
        <span className="flex items-center gap-2">
          <span className="w-36">
            <input
              id={code}
              name="code"
              autoComplete="off"
              spellCheck={false}
              maxLength={9}
              placeholder="K7Q X2M"
              aria-invalid={!!error}
              aria-describedby={hint}
              onChange={() => error && setError(null)}
              className={cx(inputClass, 'h-8 font-code text-ui')}
            />
          </span>
          <Button type="submit" loading={busy}>
            Conectar tela
          </Button>
        </span>
        <p id={hint} className={cx('text-meta', error ? 'text-critical' : 'text-fg-subtle')}>
          {error ?? 'O código muda a cada 15 minutos enquanto a tela espera.'}
        </p>
      </form>
    </>
  )
}

function ScreenRow({ screen, eventId }: { screen: ScreenInfo; eventId: string }) {
  const [renaming, setRenaming] = useState(false)
  const path = `/events/${eventId}/screens/${screen.id}`
  const rename = async (value: string) => {
    setRenaming(false)
    const name = value.replace(/\s+/g, ' ').trim()
    if (name && name !== screen.name) await run(() => patch(path, { name }))
  }
  const disconnect = async () => {
    const ok = await confirm({
      title: `Desconectar “${screen.name}”?`,
      body: 'O computador da projeção deixa de exibir o evento e volta a mostrar um código de pareamento.',
      confirm: 'Desconectar tela',
    })
    if (ok) await run(() => del(path))
  }
  return (
    <li className="flex min-h-12 items-center gap-3 py-1.5">
      <Dot tone={screen.online ? 'neutral' : 'off'} />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <span className="block w-64">
            <input
              aria-label={`Nome da tela “${screen.name}”`}
              defaultValue={screen.name}
              maxLength={60}
              autoFocus
              onBlur={(e) => void rename(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.currentTarget.value = screen.name
                  e.currentTarget.blur()
                }
                enterBlur(e)
              }}
              className={cx(inputClass, 'h-7 text-ui')}
            />
          </span>
        ) : (
          <p className="truncate text-ui text-fg">{screen.name}</p>
        )}
        <p className="text-meta text-fg-subtle">
          {screen.online ? 'Conectada' : screen.lastSeen ? `Desconectada. Vista ${ago(screen.lastSeen)}` : 'Ainda não conectou'}
        </p>
      </div>
      {!renaming && (
        <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
          Renomear
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={disconnect}>
        Desconectar
      </Button>
    </li>
  )
}
