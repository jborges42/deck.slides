// Regras da fila de perguntas, sem React: abas, ordem, busca, estado na tela e o plano de "desfazer".
import { normalize, onScreen, type ModeratorSnapshot, type Question } from '../../../shared/types.ts'

export type Tab = 'pending' | 'approved' | 'archive'
export type Sort = 'likes' | 'recent'
export type Air = 'program' | 'preview' | 'screen' | null

/**
 * Respondida que continua na tela (ou sobre o conteúdo: `overlay` é o id em `live.questionOverlay`)
 * fica nas aprovadas até sair dela: é lá que se tira.
 */
export function tabOf(q: Pick<Question, 'status' | 'screen'> & { id?: string }, overlay?: string | null): Tab {
  if (q.status === 'pending') return 'pending'
  const shown = q.screen !== null || (!!overlay && q.id === overlay)
  return q.status === 'approved' || (q.status === 'answered' && shown) ? 'approved' : 'archive'
}

/** Fila por ordem de chegada (novas no fim); aprovadas por curtidas ou recência; arquivo, mais recentes primeiro. */
export function order(qs: Question[], tab: Tab, sort: Sort, likes: (q: Question) => number): Question[] {
  const age = (a: Question, b: Question) => a.createdAt - b.createdAt
  if (tab === 'pending') return qs.toSorted(age)
  if (tab === 'approved' && sort === 'likes') return qs.toSorted((a, b) => likes(b) - likes(a) || age(a, b))
  return qs.toSorted((a, b) => age(b, a))
}

/** Busca por texto ou autor, sem diferenciar acentos. `query` já normalizada. */
export const matches = (q: Question, query: string) => !query || normalize(`${q.text} ${q.author}`).includes(query)

/** Ordem congelada: mantém a ordem exibida, tira o que saiu e acrescenta o que chegou no fim. */
export function merge(shown: string[], desired: string[]): string[] {
  const want = new Set(desired)
  const kept = shown.filter((id) => want.has(id))
  const have = new Set(kept)
  return [...kept, ...desired.filter((id) => !have.has(id))]
}

export const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Perguntas visíveis em cada monitor: só cenas de perguntas mostram, até o limite da cena. */
export function airOf(snap: Pick<ModeratorSnapshot, 'event' | 'scenes' | 'questions'>): (q: Question) => Air {
  const { live, settings } = snap.event
  const visible = (sceneId: string | null) => {
    const s = snap.scenes.find((x) => x.id === sceneId)
    return new Set(s?.type === 'questions' ? onScreen(snap.questions, s.content.max, settings.screenName).map((q) => q.id) : [])
  }
  const program = live.standby ? new Set<string>() : visible(live.program) // tela de espera cobre o que está no ar
  const preview = visible(live.preview)
  return (q) => (program.has(q.id) ? 'program' : preview.has(q.id) ? 'preview' : q.screen !== null ? 'screen' : null)
}

export type Before = Pick<Question, 'id' | 'status' | 'screen'>

/** Foto do que uma ação pode mudar: os alvos e tudo o que está na tela (para desfazer na mesma ordem). */
export function capture(qs: Question[], ids: string[]): Before[] {
  const target = new Set(ids)
  return qs.filter((q) => target.has(q.id) || q.screen !== null).map(({ id, status, screen }) => ({ id, status, screen }))
}

/**
 * Comandos (POST relativos a /events/:id/questions) que devolvem status e tela ao estado `before`.
 * Ordem importa: colocar na tela também aprova, então o status volta antes e a tela por último.
 */
export function restorePlan(before: Before[], now: Question[]): { path: string; body: unknown }[] {
  const cur = new Map(now.map((q) => [q.id, q]))
  const was = before.filter((p) => cur.has(p.id))
  const onAir = (id: string) => cur.get(id)!.screen !== null
  const plan: { path: string; body: unknown }[] = []
  for (const p of was) if (p.screen === null && onAir(p.id)) plan.push({ path: `/${p.id}/screen`, body: { on: false } })
  const changed = Map.groupBy(
    was.filter((p) => cur.get(p.id)!.status !== p.status),
    (p) => p.status,
  )
  for (const [status, ps] of changed) plan.push({ path: '/bulk', body: { ids: ps.map((p) => p.id), status } })
  // Se alguma saiu da tela, reinsere todas as que estavam, na ordem original.
  const screen = was.filter((p) => p.screen !== null).sort((a, b) => a.screen! - b.screen!)
  if (screen.some((p) => !onAir(p.id)))
    for (const p of screen) {
      if (onAir(p.id)) plan.push({ path: `/${p.id}/screen`, body: { on: false } })
      plan.push({ path: `/${p.id}/screen`, body: { on: true } })
    }
  return plan
}

