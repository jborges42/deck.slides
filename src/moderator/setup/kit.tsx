// Peças comuns das páginas de gestão (entrada, eventos, participantes, mídia, ajustes).
import type { ReactNode } from 'react'
import { ApiError } from '../../lib/api.ts'
import { plural } from '../../lib/format.ts'
import { BrandFooter, BrandLogo, BrandMark, cx, notify } from '../../ui'

/** Marca do evento nas barras azuis do console: ícone em negativo e o nome (manual do Conexão Profissional). */
export function Mark() {
  return <BrandMark negative />
}

/**
 * Páginas de acesso (entrar, definir senha): painel azul com o logo em negativo e o formulário no branco,
 * com o rodapé da marca. Em telas estreitas o painel sai e o logo fica só no rodapé.
 */
export function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      <div className="on-brand hidden place-items-center p-12 lg:grid">
        <BrandLogo negative width={560} />
      </div>
      <div className="flex flex-col">
        <div className="flex flex-1 justify-center px-6">
          <div className="w-full max-w-[340px] pt-[16vh] pb-16">{children}</div>
        </div>
        <BrandFooter />
      </div>
    </main>
  )
}

interface PageProps {
  title: string
  /** Ao lado do título: contagens, estado de gravação. */
  meta?: ReactNode
  actions?: ReactNode
  description?: ReactNode
  children: ReactNode
}

/** Página de gestão do evento: rola sozinha abaixo da barra do evento, com o conteúdo alinhado à esquerda. */
export function Page({ title, meta, actions, description, children }: PageProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1120px] px-10 pt-7 pb-24">
        <header className="flex min-h-8 items-center gap-6">
          <h1 className="font-heading text-page font-semibold">{title}</h1>
          {meta}
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
        {description && <p className="mt-1 max-w-[72ch] text-ui text-fg-muted">{description}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  )
}

/** Contagem rotulada para usar dentro de <dl>: itens separados, nunca uma corrente "A · B · C". */
export function Stat({ label, value, critical }: { label: string; value: number; critical?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={cx('font-medium tabular-nums', critical ? 'text-critical' : 'text-fg')}>{value.toLocaleString('pt-BR')}</dd>
    </div>
  )
}

/**
 * Para <IconButton>: o `px-0` dele perde para o padding do tamanho (px-2.5/px-3 vêm depois no CSS do Tailwind)
 * e o ícone encolhe para 8 px. Remover quando src/ui/controls.tsx usar `px-0!`.
 */
export const iconOnly = 'px-0!'

/** "Nenhuma pergunta", "1 pergunta", "12 perguntas": zero tem texto próprio. */
export const count = (n: number, zero: string, one: string, many: string) => (n ? plural(n, one, many) : zero)

/** Depois de validar no cliente: foco no primeiro campo com erro, para o teclado e o leitor de tela chegarem nele. */
export const focusInvalid = (form: HTMLFormElement) =>
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())

export const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente novamente.')

export const longDate = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' })
const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const shortDate = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' })

/** "às 19:04" (hoje) ou "em 8 de out.". */
export const when = (ts: number) =>
  new Date(ts).toDateString() === new Date().toDateString() ? `às ${time.format(ts)}` : `em ${shortDate.format(ts)}`

/** Copia para a área de transferência. Sem HTTPS (console aberto pelo IP da rede local) não existe navigator.clipboard. */
export async function copy(text: string, done = 'Link copiado.') {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text })
    area.style.cssText = 'position:fixed;opacity:0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (!ok) return void notify('Não foi possível copiar. Selecione o texto e copie manualmente.', { tone: 'critical' })
  }
  notify(done)
}

/** Baixa um texto como arquivo (exportações geradas no navegador). */
export function download(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
