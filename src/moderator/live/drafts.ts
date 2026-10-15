// Rascunhos do inspetor, por cena. Fora do ar, salvam sozinhos 400 ms depois da última edição;
// na cena que está no ar, ficam locais até "Atualizar no ar". Snapshots nunca atropelam um rascunho:
// ele só some quando o servidor confirma exatamente o mesmo conteúdo.
import { useCallback, useEffect, useRef, useState } from 'react'
import { patch } from '../../lib/api.ts'
import { run } from '../context.ts'
import { sameDraft, type Draft } from './logic.ts'
import type { Scene } from '../../../shared/types.ts'

export type SaveState = 'saving' | 'saved' | 'error'

export function useDrafts(eventId: string, scenes: Scene[], program: string | null) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [states, setStates] = useState<Record<string, SaveState>>({})
  const ref = useRef(drafts)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const put = (next: Record<string, Draft>) => {
    ref.current = next
    setDrafts(next)
  }
  const mark = (id: string, s: SaveState) => setStates((m) => (m[id] === s ? m : { ...m, [id]: s }))

  // Um PATCH por vez e sempre com a versão mais nova: uma resposta atrasada nunca desfaz uma edição.
  const save = useCallback(
    (id: string) => {
      clearTimeout(timers.current.get(id))
      timers.current.delete(id)
      mark(id, 'saving')
      queue.current = queue.current.then(async () => {
        const d = ref.current[id]
        const ok = !d || (await run(() => patch(`/events/${eventId}/scenes/${id}`, { name: d.name.trim() || undefined, content: d.content })))
        if (!timers.current.has(id)) mark(id, ok ? 'saved' : 'error')
      })
      return queue.current
    },
    [eventId],
  )

  const edit = (id: string, d: Draft) => {
    put({ ...ref.current, [id]: d })
    if (id === program) return
    mark(id, 'saving')
    clearTimeout(timers.current.get(id))
    timers.current.set(id, setTimeout(() => void save(id), 400))
  }

  const discard = (id: string) => {
    const next = { ...ref.current }
    delete next[id]
    put(next)
  }

  /** Envia já o que espera o intervalo e aguarda a fila, inclusive o PATCH em andamento (antes de um corte). */
  const flush = () => {
    for (const id of [...timers.current.keys()]) void save(id)
    return queue.current
  }

  // O servidor confirmou (ou a cena foi excluída): o rascunho volta a espelhar o snapshot.
  useEffect(() => {
    const next = { ...ref.current }
    let changed = false
    for (const id of Object.keys(next)) {
      const s = scenes.find((x) => x.id === id)
      if (s && (timers.current.has(id) || !sameDraft(next[id], s))) continue
      clearTimeout(timers.current.get(id))
      timers.current.delete(id)
      delete next[id]
      changed = true
    }
    if (changed) put(next)
  }, [scenes])

  // Cena que saiu do ar com mudanças guardadas: agora elas podem ser salvas.
  useEffect(() => {
    for (const id of Object.keys(ref.current)) if (id !== program && !timers.current.has(id)) void save(id)
  }, [program, save])

  // Ao sair da página, nada fica para trás.
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((_, id) => void save(id))
  }, [save])

  return { drafts, states, edit, save, discard, flush }
}
