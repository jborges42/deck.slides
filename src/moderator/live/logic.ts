// Regras do console Ao vivo, sem React nem DOM: testadas em logic.test.ts (`pnpm test`).
import { clock } from '../../lib/format.ts'
import type { Scene, SceneContent, SceneType, TimerState } from '../../../shared/types.ts'

/** Edição local de uma cena no inspetor. */
export type Draft = { name: string; content: Scene['content'] }

/** Conteúdo de cada tipo de cena criada pelo roteiro. */
export const DEFAULT_CONTENT: { [T in SceneType]: SceneContent<T> } = {
  title: { kicker: '', title: '', body: '' },
  image: { src: '', fit: 'contain', caption: '' },
  video: { src: '', fit: 'contain', loop: false, autoplay: true },
  embed: { url: '' },
  questions: { title: 'Perguntas', layout: 'spotlight', max: 1, showAuthor: true, showLikes: false },
  timer: { title: '', mode: 'countdown', durationSec: 300, warnSec: 60, criticalSec: 15, onEnd: 'overtime', endText: 'Tempo encerrado' },
}

/** O servidor já tem este rascunho? Nome vazio não é enviado, então conta o nome atual. */
export function sameDraft(d: Draft, s: Scene): boolean {
  const a = d.content as Record<string, unknown>
  const b = s.content as Record<string, unknown>
  const keys = Object.keys(a)
  return (d.name.trim() || s.name) === s.name && keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** Nova ordem do roteiro com `id` antes (ou depois) de `target`. */
export function moveId(ids: string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !ids.includes(target)) return ids
  const out = ids.filter((x) => x !== id)
  out.splice(out.indexOf(target) + (after ? 1 : 0), 0, id)
  return out
}

/** Duração digitada em segundos: "5" = 5 min, "1:30" = 90 s, "1:00:00" = 1 h. null se não der para ler. */
export function parseDuration(text: string): number | null {
  const parts = text.trim().split(':')
  if (parts.length > 3 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const n = parts.map(Number)
  if (n.length === 1) return n[0] * 60
  if (n.slice(1).some((v) => v > 59)) return null
  return n.reduce((acc, v) => acc * 60 + v, 0)
}

/** Endereço da cena de página web: só http(s); vídeos do YouTube viram o player incorporado. */
export function embedUrl(input: string): string | null {
  const raw = input.trim()
  let u: URL
  try {
    u = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.replace(/^(www|m)\./, '')
  const id =
    host === 'youtu.be'
      ? u.pathname.slice(1)
      : host === 'youtube.com' && u.pathname === '/watch'
        ? u.searchParams.get('v')
        : host === 'youtube.com' && /^\/(shorts|live)\/[^/]+/.test(u.pathname)
          ? u.pathname.split('/')[2]
          : null
  return id ? `https://www.youtube.com/embed/${id}` : u.href
}

/** O que impede colocar a prévia no ar, já em texto para o console; null = pode. */
export function takeBlocker(preview: Scene | null, program: string | null): string | null {
  if (!preview) return 'Nada na prévia. Escolha uma cena no roteiro.'
  if (preview.id === program) return 'A cena da prévia já está no ar.'
  if (preview.type === 'image' && !preview.content.src) return 'A cena não tem imagem. Escolha uma abaixo.'
  if (preview.type === 'video' && !preview.content.src) return 'A cena não tem vídeo. Escolha um abaixo.'
  if (preview.type === 'embed' && !preview.content.url) return 'A cena não tem endereço. Preencha abaixo.'
  return null
}

/** Linha de apoio da cena no roteiro. */
export function sceneDetail(s: Scene): string {
  switch (s.type) {
    case 'title':
      return 'Título'
    case 'image':
      return s.content.src ? 'Imagem' : 'Imagem sem arquivo'
    case 'video':
      return s.content.src ? 'Vídeo' : 'Vídeo sem arquivo'
    case 'embed':
      return s.content.url ? s.content.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : 'Página sem endereço'
    case 'questions':
      return { spotlight: 'Perguntas em destaque', list: 'Mural de perguntas', grid: 'Grade de perguntas' }[s.content.layout]
    case 'timer':
      return s.content.mode === 'countdown' ? `Cronômetro ${clock(s.content.durationSec * 1000)}` : 'Cronômetro progressivo'
  }
}

export type Tone = 'normal' | 'warn' | 'critical'

/** Leitura do cronômetro no console: regressivo mostra o que falta (e o tempo extra como "+0:12"). */
export function timerReadout(t: TimerState, elapsed: number): { text: string; tone: Tone } {
  if (t.mode === 'stopwatch') return { text: clock(elapsed), tone: 'normal' }
  const left = t.durationMs - elapsed
  if (left <= 0) {
    const text = t.onEnd === 'overtime' && left < 0 ? `+${clock(-left).replace(/^0(?=\d:)/, '')}` : '00:00'
    return { text, tone: 'critical' }
  }
  // Limite maior ou igual à duração é ignorado: o cronômetro começaria já colorido.
  const within = (ms: number) => ms < t.durationMs && left <= ms
  return { text: clock(left, true), tone: within(t.criticalMs) ? 'critical' : within(t.warnMs) ? 'warn' : 'normal' }
}
