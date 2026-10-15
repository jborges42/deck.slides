import { useEffect, useRef } from 'react'

/** Mapa de atalhos. Chave = combinação no formato de `comboOf`: "Space", "Shift+Space", "Digit1", "KeyA", "Mod+KeyZ". */
export type Hotkeys = Record<string, (e: KeyboardEvent) => void>

/** Combinação a partir de `event.code` (independe do layout do teclado): modificadores + código. */
export function comboOf(e: KeyboardEvent): string {
  return `${e.metaKey || e.ctrlKey ? 'Mod+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code}`
}

const typing = (el: Element | null) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLElement && el.isContentEditable)

// Dentro destes, as setas, Espaço e Enter pertencem ao componente (menu aberto, lista de opções, select).
const OWNS_KEYS = '[role="menu"], [role="listbox"], [role="combobox"], [role="dialog"], [role="alertdialog"]'
const NATIVE_ACTIVATION = 'button, a, [role="button"], [role="tab"], [role="switch"], [role="option"], [role="menuitem"], [role="combobox"]'

/**
 * Atalhos globais do console. Ignorados enquanto se digita, com diálogo/menu aberto, em tecla repetida
 * e quando um componente já tratou a tecla (preventDefault) — ex.: Enter para salvar uma edição não vira "Fusão".
 * Botão focado pelo teclado mantém Espaço/Enter nativos; focado por clique, perde o foco e o atalho vale.
 */
export function useHotkeys(map: Hotkeys, enabled = true) {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.defaultPrevented) return
      const el = document.activeElement
      // A origem da tecla conta mesmo que o campo tenha perdido o foco ou saído da tela no próprio handler.
      if (typing(e.target as Element | null) || typing(el)) return
      if ((e.target instanceof Element && e.target.closest(OWNS_KEYS)) || el?.closest(OWNS_KEYS)) return
      if (document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open]')) return
      const combo = comboOf(e)
      const run = ref.current[combo]
      if (!run) return
      if ((e.code === 'Space' || e.code === 'Enter') && el instanceof HTMLElement && el.matches(NATIVE_ACTIVATION)) {
        if (el.matches(':focus-visible')) return
        el.blur()
      }
      e.preventDefault()
      run(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
