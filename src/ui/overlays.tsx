// Camadas sobrepostas: diálogo, confirmação, menu, dica, popover e avisos (toasts).
import { useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Menu as BaseMenu } from '@base-ui/react/menu'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import { Popover as BasePopover } from '@base-ui/react/popover'
import { Toast } from '@base-ui/react/toast'
import { XIcon } from '@phosphor-icons/react/X'
import { Button, IconButton, cx } from './controls.tsx'
import { Kbd } from './display.tsx'

// Sobreposição sem sombra: no claro, "subir" é ficar branca com borda firme (raised escurece: é seleção).
const popupClass =
  'rounded-control border border-line-strong/50 bg-canvas text-fg transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0'

// ---------- diálogo ----------

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: number
}

/** Diálogo modal. Use para criar/editar fora da operação ao vivo; ao vivo, prefira edição no painel. */
export function Dialog({ open, onOpenChange, title, description, children, footer, width = 480 }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/55 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Popup
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          className={cx(
            'fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] -translate-x-1/2 flex-col rounded-panel border border-line bg-surface',
            'transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:translate-y-1 data-[starting-style]:opacity-0',
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <BaseDialog.Title className="text-title font-semibold">{title}</BaseDialog.Title>
              {description && <BaseDialog.Description className="mt-1 text-ui text-fg-muted">{description}</BaseDialog.Description>}
            </div>
            <BaseDialog.Close render={<IconButton label="Fechar" icon={<XIcon size={16} />} size="sm" className="-mr-1.5" />} />
          </div>
          {children && <div className="min-h-0 overflow-y-auto px-5 pb-4">{children}</div>}
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

// ---------- confirmação (só para ações irreversíveis ou com efeito no ar) ----------

interface ConfirmOptions {
  title: string // a ação como pergunta: "Excluir a cena?"
  body?: ReactNode // a consequência concreta
  confirm: string // repete o verbo: "Excluir cena"
  cancel?: string
  tone?: 'danger' | 'program' | 'primary'
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void }
let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** `if (await confirm({...})) ...` — precisa de <ConfirmHost /> montado (já está em main.tsx). */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  pending?.resolve(false)
  return new Promise((resolve) => {
    pending = { ...options, resolve }
    emit()
  })
}

function close(ok: boolean) {
  pending?.resolve(ok)
  pending = null
  emit()
}

export function ConfirmHost() {
  const current = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => pending,
  )
  return (
    <AlertDialog.Root open={!!current} onOpenChange={(o) => !o && close(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/55 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-[18vh] left-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 rounded-panel border border-line bg-surface p-5 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
          <AlertDialog.Title className="text-title font-semibold">{current?.title}</AlertDialog.Title>
          {current?.body && <AlertDialog.Description className="mt-2 text-ui text-fg-muted">{current.body}</AlertDialog.Description>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close render={<Button>{current?.cancel ?? 'Cancelar'}</Button>} />
            <Button variant={current?.tone ?? 'danger'} onClick={() => close(true)}>
              {current?.confirm}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

// ---------- menu ----------

export type MenuItem =
  | { label: string; onSelect: () => void; icon?: ReactNode; kbd?: string; danger?: boolean; disabled?: boolean; hint?: string }
  | 'separator'

/** Menu de ações. `trigger` precisa ser um elemento que aceite ref e props (ex.: <IconButton>). */
export function Menu({ trigger, items, align = 'end' }: { trigger: ReactElement; items: MenuItem[]; align?: 'start' | 'end' | 'center' }) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={4} align={align} className="z-50 outline-none">
          <BaseMenu.Popup className={cx(popupClass, 'min-w-48 origin-(--transform-origin) p-1 text-ui')}>
            {items.map((item, i) =>
              item === 'separator' ? (
                <BaseMenu.Separator key={i} className="mx-1 my-1 h-px bg-line" />
              ) : (
                <BaseMenu.Item
                  key={i}
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  className={cx(
                    'flex min-h-8 cursor-default items-center gap-2.5 rounded-chip px-2 py-1 outline-none select-none',
                    'data-[highlighted]:bg-[color-mix(in_oklab,var(--fg)_9%,transparent)] data-[disabled]:opacity-45',
                    item.danger ? 'text-critical' : 'text-fg',
                  )}
                >
                  {item.icon && <span className="text-fg-muted">{item.icon}</span>}
                  <span className="flex flex-1 flex-col">
                    {item.label}
                    {item.hint && <span className="text-meta text-fg-subtle">{item.hint}</span>}
                  </span>
                  {item.kbd && <Kbd>{item.kbd}</Kbd>}
                </BaseMenu.Item>
              ),
            )}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

// ---------- dica ----------

/** Dica ao passar o mouse/focar. `children` precisa aceitar ref e props (botão, link). */
export function Tooltip({
  label,
  kbd,
  side = 'top',
  children,
}: {
  label: ReactNode
  kbd?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup className={cx(popupClass, 'flex items-center gap-2 px-2 py-1 text-meta')}>
            {label}
            {kbd && <Kbd>{kbd}</Kbd>}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

export const TooltipProvider = BaseTooltip.Provider

// ---------- popover ----------

export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'end',
  className,
}: {
  trigger: ReactElement
  children: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'end' | 'center'
  className?: string
}) {
  return (
    <BasePopover.Root>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={6} className="z-50">
          <BasePopover.Popup className={cx(popupClass, 'origin-(--transform-origin) p-3 text-ui', className)}>{children}</BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}

// ---------- avisos ----------

export const toastManager = Toast.createToastManager()

/** Aviso curto. Erros: o que aconteceu + o que fazer. Nunca "com sucesso". */
export function notify(title: string, opts: { description?: string; tone?: 'neutral' | 'critical'; timeout?: number } = {}) {
  return toastManager.add({ title, description: opts.description, type: opts.tone ?? 'neutral', timeout: opts.timeout })
}

let lastUndo: { run: () => void; until: number } | null = null

/** Ação reversível já executada: aviso com "Desfazer" (6 s), também acionável por ⌘Z / Ctrl+Z. */
export function undoable(title: string, undo: () => void | Promise<unknown>) {
  const id = toastManager.add({
    title,
    timeout: 6000,
    actionProps: {
      children: 'Desfazer',
      onClick: () => {
        toastManager.close(id)
        void undo()
      },
    },
  })
  lastUndo = {
    run: () => {
      toastManager.close(id)
      void undo()
    },
    until: Date.now() + 6000,
  }
}

/** Desfaz a última ação reversível, se ainda dentro da janela. Retorna se desfez algo. */
export function undoLast(): boolean {
  if (!lastUndo || lastUndo.until < Date.now()) return false
  lastUndo.run()
  lastUndo = null
  return true
}

function ToastList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((t) => (
    <Toast.Root
      key={t.id}
      toast={t}
      className={cx(
        'absolute right-0 bottom-0 flex w-full items-start gap-3 rounded-control border bg-canvas px-3 py-2.5',
        'transition-[opacity,transform] duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0',
        '[transform:translateY(calc(var(--toast-index)*-8px))] data-[expanded]:[transform:translateY(calc(var(--toast-offset-y)*-1))]',
        t.type === 'critical' ? 'border-critical' : 'border-line-strong/50',
      )}
    >
      <Toast.Content className="min-w-0 flex-1">
        <Toast.Title className="text-ui font-medium text-fg" />
        <Toast.Description className="text-ui text-fg-muted" />
      </Toast.Content>
      {t.actionProps && <Toast.Action className={cx('state-layer -my-0.5 h-6 rounded-chip px-2 text-meta font-semibold text-fg underline-offset-2')} />}
      <Toast.Close aria-label="Fechar aviso" className="state-layer -mr-1 grid size-6 place-items-center rounded-chip text-fg-subtle">
        <XIcon size={12} />
      </Toast.Close>
    </Toast.Root>
  ))
}

export function Toaster() {
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] w-[min(360px,calc(100vw-32px))]">
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  )
}

export const ToastProvider = Toast.Provider
