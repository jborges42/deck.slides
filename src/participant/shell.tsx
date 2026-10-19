// Peças comuns das páginas do participante (celular): paleta do evento, campos em tamanho de toque e o PIN.
// Os componentes de src/ui são densos (console); aqui a escala é a do celular: 16 px e alvos de 48 px.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react'
import { Field as BaseField } from '@base-ui/react/field'
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { ApiError } from '../lib/api.ts'
import { contrast, eventPalette, fontVars, loadFont, tokenVars } from '../lib/theme.ts'
import { BrandFooter, BrandIcon, Button, Input, Spinner, cx } from '../ui'
import { DEFAULT_THEME, type Theme } from '../../shared/types.ts'

/** Marca do evento: vem do convite, do link aberto ou do snapshot. */
export type Brand = Pick<Theme, 'brand' | 'contrast' | 'logo' | 'fonts'>

/** Dados públicos do evento antes da entrada. `pinLength` ainda não vem do servidor (padrão 6). */
export type EventBrand = Brand & { id: string; name: string; pinLength?: number }

export const firstName = (name: string) => name.trim().split(/\s+/)[0]

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = matchMedia(query)
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    () => matchMedia(query).matches,
  )
}

/**
 * Página do celular: segue claro/escuro do sistema e aplica a paleta do evento na raiz do documento,
 * para que o fundo da rolagem elástica, os avisos (portal) e a barra do navegador acompanhem.
 */
export function PhonePage({ brand, title, top, children }: { brand?: Brand | null; title?: string; top?: ReactNode; children: ReactNode }) {
  const mode = useMedia('(prefers-color-scheme: dark)') ? 'dark' : 'light'
  const level = useMedia('(prefers-contrast: more)') || brand?.contrast === 'high' ? 'high' : 'standard'
  const color = brand?.brand ?? DEFAULT_THEME.brand
  const fonts = brand?.fonts
  const fontsKey = JSON.stringify(fonts ?? null)

  // Dependência por `fontsKey`, não por `fonts`: o snapshot traz um objeto novo a cada envio.
  const palette = useMemo(() => {
    let { tokens } = eventPalette({ brand: color, contrast: level, background: null, mode, overrides: {} }, { mode, contrast: level })
    // Marca quase igual ao fundo (ex.: preta no modo escuro): a ação principal fica neutra para continuar visível.
    if (contrast(tokens.accent, tokens.canvas) < 1.5) tokens = { ...tokens, accent: tokens.fg, onAccent: tokens.canvas }
    const vars = { ...tokenVars(tokens, mode), ...(fonts && fontVars(fonts)) } as Record<string, string | number>
    return { canvas: tokens.canvas, vars: Object.entries(vars).map(([k, v]) => [k === 'colorScheme' ? 'color-scheme' : k, String(v)]) }
  }, [color, level, mode, fontsKey])

  useLayoutEffect(() => {
    const root = document.documentElement
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const previous = meta?.content
    for (const [k, v] of palette.vars) root.style.setProperty(k, v)
    if (meta) meta.content = palette.canvas
    return () => {
      for (const [k] of palette.vars) root.style.removeProperty(k)
      if (meta && previous !== undefined) meta.content = previous
    }
  }, [palette])

  // Só a fonte de títulos (nome do evento): o celular não baixa as fontes do texto e dos números da tela.
  const heading = fonts?.heading
  useEffect(() => {
    if (heading) loadFont(heading)
  }, [heading?.family, heading?.url])

  useEffect(() => {
    if (!title) return
    const previous = document.title
    document.title = title
    return () => {
      document.title = previous
    }
  }, [title])

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-body text-fg">
      {top}
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(2.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
        {children}
      </main>
      {/* Enquanto o teclado ocupa a tela, o rodapé sai (ver hide-while-typing em styles.css). */}
      <BrandFooter negative={mode === 'dark'} className="hide-while-typing" />
    </div>
  )
}

/**
 * Logo e nome do evento (fonte de títulos do tema). Sem logo enviado, o ícone da marca (negativo no modo escuro).
 * 56 px de altura: um logo horizontal (3:1) chega aos 160 px de largura mínima do manual da marca.
 */
export function EventHeader({ name, logo, size = 'event', children }: { name: string; logo?: string | null; size?: 'event' | 'head'; children?: ReactNode }) {
  const dark = useMedia('(prefers-color-scheme: dark)')
  return (
    <header className="flex flex-col gap-3">
      {logo ? (
        <img src={logo} alt="" className="h-14 w-auto max-w-64 self-start object-contain object-left" />
      ) : (
        <BrandIcon size={40} negative={dark} />
      )}
      <div className="flex flex-col gap-1">
        <h1 className={cx('font-heading [font-weight:var(--heading-weight,650)] text-balance wrap-anywhere', size === 'event' ? 'text-event' : 'text-head')}>{name}</h1>
        {children}
      </div>
    </header>
  )
}

/** Mensagem de página inteira (convite inválido, acesso encerrado, falha ao carregar). */
export function Notice({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 pt-6">
      <h1 className="font-heading text-head font-semibold text-balance">{title}</h1>
      {children && <p className="text-fg-muted">{children}</p>}
      {action && <div className="mt-4 w-full">{action}</div>}
    </div>
  )
}

export function Loading() {
  return (
    <div className="grid min-h-[50dvh] place-items-center text-fg-muted">
      <Spinner size={20} />
    </div>
  )
}

/** Falha ao carregar: a mensagem do servidor e "Tentar de novo". */
export function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <Notice
      title={error.message}
      action={
        <Button size="xl" className="w-full" onClick={onRetry}>
          Tentar de novo
        </Button>
      }
    />
  )
}

/** Rótulo, controle e ajuda/erro com 16 px (o `Field` de src/ui usa a escala do console). */
export function PhoneField({ label, aside, hint, error, children }: { label: string; aside?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <BaseField.Root invalid={!!error} className="group flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <BaseField.Label className="font-medium">{label}</BaseField.Label>
        {aside}
      </div>
      {children}
      {error ? (
        <BaseField.Error match role="alert" className="text-critical">
          {error}
        </BaseField.Error>
      ) : (
        hint && <BaseField.Description className="text-fg-muted">{hint}</BaseField.Description>
      )}
    </BaseField.Root>
  )
}

/** Interruptor com a linha inteira tocável (48 px). Ligado na cor de destaque, como no console. */
export function PhoneSwitch({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: ReactNode }) {
  return (
    <BaseField.Root className="flex flex-col">
      <BaseField.Label className="flex min-h-12 items-center justify-between gap-4">
        {label}
        <BaseSwitch.Root
          checked={checked}
          onCheckedChange={(v) => onChange(v)}
          className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-line-strong transition-colors duration-150 data-[checked]:bg-accent"
        >
          <BaseSwitch.Thumb className="block size-6 translate-x-0.5 rounded-full bg-canvas transition-transform duration-150 ease-out data-[checked]:translate-x-[22px] data-[checked]:bg-on-accent" />
        </BaseSwitch.Root>
      </BaseField.Label>
      {description && <BaseField.Description className="text-fg-muted">{description}</BaseField.Description>}
    </BaseField.Root>
  )
}

interface PinInputProps {
  value: string
  onChange: (digits: string) => void
  /** Chamado quando o último dígito entra (digitado ou colado). */
  onComplete: (digits: string) => void
  length: number
  readOnly?: boolean
  autoFocus?: boolean
  ref?: Ref<HTMLInputElement>
}

/**
 * PIN em UM campo (colar e preenchimento automático funcionam) desenhado como casas.
 * O texto do campo é transparente por cima das casas; os dígitos visíveis são das casas.
 * Sem maxLength nativo: ele cortaria um "482 913" colado antes de removermos o espaço.
 */
export function PinInput({ value, onChange, onComplete, length, readOnly, autoFocus, ref }: PinInputProps) {
  const [selected, setSelected] = useState(false)
  const active = Math.min(value.length, length - 1)
  return (
    <div className="relative flex w-full max-w-[328px] gap-2">
      {Array.from({ length }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={cx(
            'grid h-14 min-w-0 flex-1 place-items-center rounded-control border font-code text-event tabular-nums group-data-[invalid]:border-critical',
            selected && i < value.length ? 'border-fg bg-raised' : 'border-line-strong bg-canvas',
            !selected && i === active && 'group-data-[focused]:outline-2 group-data-[focused]:-outline-offset-1 group-data-[focused]:outline-(--focus)',
          )}
        >
          {value[i]}
        </span>
      ))}
      <BaseField.Control
        ref={ref}
        name="pin"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        enterKeyHint="go"
        spellCheck={false}
        autoFocus={autoFocus}
        readOnly={readOnly}
        value={value}
        onChange={(e) => {
          const digits = e.currentTarget.value.replace(/\D/g, '').slice(0, length)
          onChange(digits)
          if (digits.length === length && digits !== value) onComplete(digits)
        }}
        // Cursor sempre no fim (as casas não têm cursor no meio). PIN completo ou seleção parcial viram
        // seleção total: depois de um erro, tocar no campo e digitar substitui tudo.
        onSelect={(e) => {
          const el = e.currentTarget
          const end = el.value.length
          const whole = end > 0 && (end >= length || el.selectionStart !== el.selectionEnd)
          const from = whole ? 0 : end
          if (el.selectionStart !== from || el.selectionEnd !== end) el.setSelectionRange(from, end)
          setSelected(whole)
        }}
        onBlur={() => setSelected(false)}
        className="absolute inset-0 size-full bg-transparent text-body text-transparent caret-transparent outline-none selection:bg-transparent"
      />
    </div>
  )
}

/** Formulário de entrada: PIN (convite) ou nome + PIN (link aberto). Envia sozinho no último dígito. */
export function EntryForm({ withName, length = 6, onSubmit }: { withName?: boolean; length?: number; onSubmit: (pin: string, name: string) => Promise<unknown> }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ name?: string; pin?: string }>({})
  const pinRef = useRef<HTMLInputElement>(null)
  const nameOk = !withName || name.trim().length >= 2

  const submit = async (digits: string) => {
    if (busy) return
    if (!nameOk) return setError({ name: 'Informe seu nome.' })
    if (!digits) return setError({ pin: 'Informe o PIN do evento.' })
    setBusy(true)
    setError({})
    try {
      await onSubmit(digits, name.trim())
      // Sucesso: quem chamou troca de página; o botão segue "carregando" até lá.
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('Não foi possível concluir. Tente novamente.', 0)
      setBusy(false)
      // 400 só vem da validação do nome. O resto (PIN incorreto, tentativas, rede) fica no PIN,
      // com os dígitos mantidos e selecionados: digitar de novo substitui tudo.
      if (withName && err.status === 400) return setError({ name: err.message })
      setError({ pin: err.message })
      pinRef.current?.focus()
      pinRef.current?.select()
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit(pin)
      }}
      className="flex flex-col gap-6"
    >
      {withName && (
        <PhoneField label="Seu nome" error={error.name}>
          <Input
            size="lg"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError({})
            }}
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="next"
            maxLength={80}
            autoFocus
          />
        </PhoneField>
      )}
      <PhoneField label="PIN do evento" hint="Fornecido pela organização." error={error.pin}>
        <PinInput
          ref={pinRef}
          value={pin}
          length={length}
          readOnly={busy}
          autoFocus={!withName}
          onChange={(digits) => {
            setPin(digits)
            setError({})
          }}
          onComplete={(digits) => nameOk && void submit(digits)}
        />
      </PhoneField>
      <Button type="submit" variant="primary" size="xl" loading={busy} className="w-full">
        Entrar no evento
      </Button>
    </form>
  )
}
