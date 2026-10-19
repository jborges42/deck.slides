// Controles do sistema visual. Use estes componentes antes de estilizar elementos na mão.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { Field as BaseField } from '@base-ui/react/field'
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { Select as BaseSelect } from '@base-ui/react/select'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { Toggle } from '@base-ui/react/toggle'
import { Slider as BaseSlider } from '@base-ui/react/slider'
import { Tabs } from '@base-ui/react/tabs'
import { CaretUpDownIcon } from '@phosphor-icons/react/CaretUpDown'
import { CheckIcon } from '@phosphor-icons/react/Check'
import { Kbd, Spinner } from './display.tsx'

export const cx = (...c: (string | false | null | undefined | 0)[]) => c.filter(Boolean).join(' ')

// ---------- botões ----------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'program'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

const VARIANT: Record<ButtonVariant, string> = {
  primary: '[--state-bg:var(--accent)] text-on-accent', // ação principal da tela; uma por região
  secondary: '[--state-bg:var(--raised)] text-fg border border-line',
  ghost: 'text-fg-muted hover:text-fg',
  danger: '[--state-bg:var(--raised)] text-critical border border-line',
  program: '[--state-bg:var(--program-strong)] text-white', // só para "Colocar no ar" e "Atualizar no ar"
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-meta',
  md: 'h-8 gap-2 px-3 text-ui',
  lg: 'h-10 gap-2 px-4 text-read',
  xl: 'h-12 gap-2.5 px-5 text-body', // celular: alvo de toque de 48 px
}

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string) {
  return cx(
    'state-layer inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-control font-medium',
    'disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45',
    VARIANT[variant],
    SIZE[size],
    className,
  )
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  /** Atalho mostrado à direita do rótulo, ex.: "Espaço". */
  kbd?: string
  loading?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant, size, icon, kbd, loading, className, children, type = 'button', disabled, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {kbd && <Kbd className="ml-0.5">{kbd}</Kbd>}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Obrigatório: vira aria-label. Para dica visual, envolva em <Tooltip>. */
  label: string
  icon: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  ref?: Ref<HTMLButtonElement>
}

const ICON_SIZE: Record<ButtonSize, string> = { sm: 'size-7', md: 'size-8', lg: 'size-10', xl: 'size-12' }

export function IconButton({ label, icon, variant = 'ghost', size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} className={cx(buttonClass(variant, size), ICON_SIZE[size], 'px-0!', className)} {...rest}>
      {icon}
    </button>
  )
}

// ---------- campos ----------

/** Visual de campo. Sem largura: Input, Textarea e Select ocupam a linha; quem precisa de outra largura passa a sua. */
export const inputClass = cx(
  'rounded-control border border-line-strong bg-canvas px-2.5 text-fg',
  'transition-colors duration-100 hover:border-fg-subtle focus-visible:border-(--focus) focus-visible:outline-none',
  'disabled:opacity-50 data-[invalid]:border-critical aria-[invalid=true]:border-critical',
)

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  className?: string
  children: ReactNode
}

/** Rótulo + controle + ajuda/erro, com associação acessível automática (Base UI Field). */
export function Field({ label, hint, error, className, children }: FieldProps) {
  return (
    <BaseField.Root invalid={!!error} className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <BaseField.Label className="text-meta font-medium text-fg-muted">{label}</BaseField.Label>
      {children}
      {error ? (
        <BaseField.Error match className="text-meta text-critical">
          {error}
        </BaseField.Error>
      ) : (
        hint && <BaseField.Description className="text-meta text-fg-subtle">{hint}</BaseField.Description>
      )}
    </BaseField.Root>
  )
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: 'md' | 'lg'; ref?: Ref<HTMLInputElement> }

export function Input({ className, size = 'md', ...rest }: InputProps) {
  return (
    <BaseField.Control
      className={cx(inputClass, size === 'lg' ? 'h-12 text-body' : 'h-8 text-ui', className ?? 'w-full')}
      {...(rest as object)}
    />
  )
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>
  /** ui = 13 px (padrão do console); read = 15 px (texto de pergunta); body = 16 px (celular). */
  size?: 'ui' | 'read' | 'body'
}

const TEXTAREA_SIZE = { ui: 'py-1.5 text-ui', read: 'py-2 text-read', body: 'py-2.5 text-body' }

export function Textarea({ className, rows = 3, size = 'ui', ...rest }: TextareaProps) {
  return (
    <BaseField.Control
      render={<textarea rows={rows} />}
      className={cx(inputClass, 'w-full resize-y', TEXTAREA_SIZE[size], className)}
      {...(rest as object)}
    />
  )
}

// ---------- seleção ----------

export interface Option<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}

/** Interruptor com rótulo à esquerda. Estado é neutro (claro/escuro), nunca verde/vermelho. */
export function Switch({ checked, onChange, label, description, disabled, className }: SwitchProps) {
  return (
    <BaseField.Root className={cx('flex items-start justify-between gap-4', className)} disabled={disabled}>
      <span className="flex min-w-0 flex-col">
        <BaseField.Label className="text-ui text-fg">{label}</BaseField.Label>
        {description && <BaseField.Description className="text-meta text-fg-subtle">{description}</BaseField.Description>}
      </span>
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={(v) => onChange(v)}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line transition-colors duration-150 data-[checked]:bg-accent data-[disabled]:opacity-45"
      >
        <BaseSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-fg-muted transition-transform duration-150 ease-out data-[checked]:translate-x-[18px] data-[checked]:bg-on-accent" />
      </BaseSwitch.Root>
    </BaseField.Root>
  )
}

interface SelectProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: Option<T>[]
  label?: string // aria-label quando não há <Field> em volta
  className?: string
  disabled?: boolean
}

export function Select<T extends string>({ value, onChange, options, label, className, disabled }: SelectProps<T>) {
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]))
  return (
    <BaseSelect.Root items={items} value={value} onValueChange={(v) => v !== null && onChange(v as T)} disabled={disabled}>
      <BaseSelect.Trigger
        aria-label={label}
        className={cx(inputClass, 'flex h-8 items-center justify-between gap-2 text-left text-ui', className ?? 'w-full')}
      >
        <BaseSelect.Value className="truncate" />
        <BaseSelect.Icon className="text-fg-subtle">
          <CaretUpDownIcon size={14} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50 outline-none">
          <BaseSelect.Popup className="max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-control border border-line-strong/50 bg-canvas p-1 text-ui transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            <BaseSelect.List>
              {options.map((o) => (
                <BaseSelect.Item
                  key={o.value}
                  value={o.value}
                  className="grid cursor-default grid-cols-[16px_1fr] items-center gap-2 rounded-chip py-1.5 pr-3 pl-1.5 text-fg outline-none select-none data-[highlighted]:bg-[color-mix(in_oklab,var(--fg)_9%,transparent)]"
                >
                  <BaseSelect.ItemIndicator className="col-start-1">
                    <CheckIcon size={14} />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText className="col-start-2 flex items-center gap-2">
                    {o.icon}
                    {o.label}
                  </BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: Option<T>[]
  label: string // aria-label do grupo
  size?: 'sm' | 'md'
  className?: string
}

/** Escolha única entre 2–5 opções curtas (ex.: alinhamento, layout). */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md', className }: SegmentedProps<T>) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(v) => v[0] && onChange(v[0] as T)}
      className={cx('inline-flex rounded-control border border-line bg-canvas p-0.5', className)}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          className={cx(
            'state-layer inline-flex items-center justify-center gap-1.5 rounded-[4px] px-2.5 font-medium text-fg-muted',
            'data-[pressed]:text-accent-fg data-[pressed]:[--state-bg:var(--accent-soft)]',
            size === 'sm' ? 'h-6 text-meta' : 'h-7 text-ui',
          )}
        >
          {o.icon}
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  )
}

interface SliderProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  label: string
  format?: (value: number) => string
  className?: string
}

export function Slider({ value, onChange, min, max, step = 1, label, format = String, className }: SliderProps) {
  return (
    <BaseSlider.Root
      value={value}
      onValueChange={(v) => onChange(v as number)}
      min={min}
      max={max}
      step={step}
      className={cx('flex flex-col gap-2', className)}
    >
      <div className="flex items-center justify-between text-meta">
        <BaseSlider.Label className="font-medium text-fg-muted">{label}</BaseSlider.Label>
        <span className="text-fg tabular-nums">{format(value)}</span>
      </div>
      <BaseSlider.Control className="flex h-4 w-full touch-none items-center select-none">
        <BaseSlider.Track className="h-1 w-full rounded-full bg-line">
          <BaseSlider.Indicator className="rounded-full bg-accent" />
          <BaseSlider.Thumb
            aria-label={label}
            className="size-3.5 rounded-full bg-accent outline-offset-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-(--focus)"
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  )
}

interface ColorFieldProps {
  value: string
  onChange: (value: string) => void
  label: string
  className?: string
}

/** Amostra nativa (<input type="color">) + campo hexadecimal. */
export function ColorField({ value, onChange, label, className }: ColorFieldProps) {
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="size-8 shrink-0 cursor-pointer rounded-control border border-line-strong bg-transparent p-0.5 [&::-moz-color-swatch]:rounded-[3px] [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <input
        aria-label={`${label} (hexadecimal)`}
        defaultValue={value}
        key={value}
        maxLength={7}
        spellCheck={false}
        onBlur={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && onChange(e.target.value.toUpperCase())}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className={cx(inputClass, 'h-8 w-24 font-code text-meta uppercase')}
      />
    </div>
  )
}

// ---------- abas ----------

interface TabBarProps<T extends string> {
  value: T
  onChange: (value: T) => void
  items: (Option<T> & { count?: number })[]
  className?: string
}

/** Abas com indicador sublinhado. O conteúdo é renderizado por quem usa, conforme `value`. */
export function TabBar<T extends string>({ value, onChange, items, className }: TabBarProps<T>) {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <Tabs.List className={cx('relative flex items-center gap-4 border-b border-line', className)}>
        {items.map((t) => (
          <Tabs.Tab
            key={t.value}
            value={t.value}
            className="flex h-9 items-center gap-1.5 text-ui font-medium text-fg-subtle outline-none transition-colors duration-100 hover:text-fg-muted focus-visible:text-fg data-[active]:text-fg"
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && <span className="tabular-nums text-fg-subtle">{t.count}</span>}
          </Tabs.Tab>
        ))}
        <Tabs.Indicator className="absolute bottom-[-1px] left-(--active-tab-left) h-0.5 w-(--active-tab-width) bg-accent transition-[left,width] duration-200 ease-out" />
      </Tabs.List>
    </Tabs.Root>
  )
}
