// Elementos de exibição: chips de estado, atalhos, vazio, painéis.
import type { ReactNode } from 'react'
import { cx } from './controls.tsx'

/** Dica de atalho de teclado. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border border-line px-1 font-ui text-[11px] leading-none font-medium text-fg-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export type Tone = 'neutral' | 'program' | 'preview' | 'attention' | 'accent' | 'critical' | 'outline'

const TONE: Record<Tone, string> = {
  neutral: 'bg-raised text-fg-muted',
  outline: 'border border-line text-fg-muted',
  program: 'bg-program-strong text-white', // "No ar" — fixo, nunca pulsante
  preview: 'bg-preview text-on-signal', // "Prévia"
  attention: 'bg-attention text-on-signal', // aguardando ação, conexão instável
  accent: 'bg-accent text-on-accent',
  critical: 'border border-critical text-critical',
}

/** Rótulo de estado: canto de 4 px (não é pílula), texto curto, sem caixa-alta. */
export function Chip({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-chip px-1.5 text-meta font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** Indicador circular de estado (conexão, presença). */
export function Dot({ tone = 'neutral', className }: { tone?: 'neutral' | 'program' | 'preview' | 'attention' | 'off'; className?: string }) {
  const color = {
    neutral: 'bg-fg-muted',
    program: 'bg-program',
    preview: 'bg-preview',
    attention: 'bg-attention',
    off: 'bg-line-strong',
  }[tone]
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', color, className)} />
}

/** Indicador de carregamento: só aparece após 200 ms, para não piscar em respostas rápidas. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Carregando"
      className={cx('inline-block shrink-0 rounded-full border-2 border-current border-r-transparent', className)}
      style={{ width: size, height: size, animation: 'spin 0.8s linear infinite, fade-in 1ms 200ms both' }}
    />
  )
}

/** Estado vazio: o que aparece aqui + como fazer aparecer + no máximo uma ação. Sem ilustração. */
export function Empty({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-start gap-1.5 px-4 py-6', className)}>
      <p className="text-ui font-medium text-fg">{title}</p>
      {children && <p className="max-w-[46ch] text-ui text-fg-subtle">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** Seção de coluna do console: cabeçalho fixo (título, contagem, ações) e corpo com rolagem própria. */
export function Panel({
  title,
  count,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode
  count?: number
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cx('flex min-h-0 flex-col', className)}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-ui font-semibold text-fg">{title}</h2>
        {count !== undefined && <span className="text-ui text-fg-subtle tabular-nums">{count}</span>}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </header>
      <div className={cx('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
    </section>
  )
}

/** PIN e códigos: fonte mono com zero pontilhado, agrupado 3 + 3. */
export function Code({ children, className }: { children: string; className?: string }) {
  const grouped = /^\d{6}$/.test(children) ? `${children.slice(0, 3)} ${children.slice(3)}` : children
  return <span className={cx('font-code tabular-nums', className)}>{grouped}</span>
}
