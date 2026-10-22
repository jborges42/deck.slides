// Regras do console Ao vivo, sem React nem DOM: testadas em logic.test.ts (`pnpm test`).
import { clock, plural } from '../../lib/format.ts'
import type { Scene, SceneContent, SceneType, TimerState } from '../../../shared/types.ts'

/** Edição local de uma cena no inspetor. */
export type Draft = { name: string; content: Scene['content'] }

/** Conteúdo de cada tipo de cena criada pelo roteiro. */
export const DEFAULT_CONTENT: { [T in SceneType]: SceneContent<T> } = {
  title: { kicker: '', title: '', body: '' },
  image: { src: '', fit: 'contain', caption: '' },
  video: { src: '', fit: 'contain', loop: false, autoplay: true },
  embed: { url: '' }, // sem display: a verificação do site escolhe (página ou endereço com QR code)
  questions: { title: 'Perguntas', layout: 'spotlight', max: 1, showAuthor: true, showLikes: false },
  timer: { title: '', mode: 'countdown', durationSec: 300, warnSec: 60, criticalSec: 15, onEnd: 'overtime', endText: 'Tempo encerrado' },
  slides: { slides: [] },
  join: { title: 'Participe pelo celular' },
  section: {},
}

/** O servidor já tem este rascunho? Nome vazio não é enviado, então conta o nome atual. Listas (slides) por valor. */
export function sameDraft(d: Draft, s: Scene): boolean {
  const a = d.content as Record<string, unknown>
  const b = s.content as Record<string, unknown>
  const keys = Object.keys(a)
  const same = (x: unknown, y: unknown) => x === y || (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]))
  return (d.name.trim() || s.name) === s.name && keys.length === Object.keys(b).length && keys.every((k) => same(a[k], b[k]))
}

// ---------- pastas ----------

/** Cenas que vão para a tela, sem os títulos de pasta: numeração, teclas 1 a 0 e ↑/↓ contam só estas. */
export const playable = (scenes: Scene[]) => scenes.filter((s) => s.type !== 'section')

/** Pasta de cada cena: a última pasta acima dela no roteiro (null = antes da primeira pasta). */
export function folderOf(scenes: Scene[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  let folder: string | null = null
  for (const s of scenes) {
    if (s.type === 'section') folder = s.id
    else out.set(s.id, folder)
  }
  return out
}

/** Blocos do roteiro: as cenas soltas do começo (sem título) e cada pasta com as cenas dela. */
function blocks(scenes: Pick<Scene, 'id' | 'type'>[]): string[][] {
  const out: string[][] = []
  for (const s of scenes) {
    if (s.type === 'section' || !out.length) out.push([])
    out[out.length - 1].push(s.id)
  }
  return out
}

/** Última cena de uma pasta (ou o próprio título, se vazia): onde entra a cena criada pelo "+" dela. */
export function folderEnd(scenes: Pick<Scene, 'id' | 'type'>[], folder: string): string {
  const block = blocks(scenes).find((b) => b[0] === folder)
  return block ? block[block.length - 1] : folder
}

/**
 * Nova ordem com a pasta `id` inteira (título e cenas) antes ou depois do bloco que contém `target`.
 * Nunca entra antes das cenas soltas do começo: elas passariam a ser da pasta movida.
 */
export function moveFolder(scenes: Pick<Scene, 'id' | 'type'>[], id: string, target: string, after: boolean): string[] {
  const all = blocks(scenes)
  const ids = all.flat()
  const moving = all.find((b) => b[0] === id)
  const dest = all.find((b) => b.includes(target))
  if (!moving || !dest || moving === dest) return ids
  const loose = scenes.find((s) => s.id === dest[0])?.type !== 'section'
  const rest = all.filter((b) => b !== moving)
  rest.splice(rest.indexOf(dest) + (after || loose ? 1 : 0), 0, moving)
  return rest.flat()
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

/**
 * Endereço da cena de página web: só http(s). Links que têm versão própria para aparecer dentro de outra
 * página viram essa versão: vídeo do YouTube e do Vimeo, apresentação, documento e planilha do Google,
 * arquivo do Google Drive e design do Canva (o link normal deles se recusa a abrir dentro da tela).
 */
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
  if (id) return `https://www.youtube.com/embed/${id}`
  const p = u.pathname
  const vimeo = host === 'vimeo.com' && /^\/(\d+)/.exec(p)
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`
  const google = host === 'docs.google.com' && /^\/(presentation|document|spreadsheets)\/d\/((?:e\/)?[\w-]+)/.exec(p)
  if (google) {
    const [, kind, doc] = google
    if (kind === 'presentation') return `https://docs.google.com/presentation/d/${doc}/embed?start=false&loop=false`
    if (!doc!.startsWith('e/')) return `https://docs.google.com/${kind}/d/${doc}/preview`
  }
  const drive = host === 'drive.google.com' && /^\/file\/d\/([\w-]+)/.exec(p)
  if (drive) return `https://drive.google.com/file/d/${drive[1]}/preview`
  if (host === 'canva.com' && /^\/design\/[\w-]+/.test(p) && !u.searchParams.has('embed'))
    return `https://www.canva.com${p.replace(/\/(edit|watch|view)\/?$/, '')}/view?embed`
  return u.href
}

/** O que impede colocar a prévia no ar, já em texto para o console; null = pode. */
export function takeBlocker(preview: Scene | null, program: string | null): string | null {
  if (!preview) return 'Nada na prévia. Escolha uma cena no roteiro.'
  if (preview.id === program) return 'A cena da prévia já está no ar.'
  if (preview.type === 'image' && !preview.content.src) return 'A cena não tem imagem. Escolha uma abaixo.'
  if (preview.type === 'video' && !preview.content.src) return 'A cena não tem vídeo. Escolha um abaixo.'
  if (preview.type === 'embed' && !preview.content.url) return 'A cena não tem endereço. Preencha abaixo.'
  if (preview.type === 'slides' && !preview.content.slides.length) return 'A apresentação não tem slides. Envie o PDF abaixo.'
  return null
}

/** Linha de apoio da cena no roteiro. `openJoin`: sem a entrada aberta, a cena de entrada não tem QR nem endereço. */
export function sceneDetail(s: Scene, openJoin = true): string {
  switch (s.type) {
    case 'title':
      return 'Título'
    case 'image':
      return s.content.src ? 'Imagem' : 'Imagem sem arquivo'
    case 'video':
      return s.content.src ? 'Vídeo' : 'Vídeo sem arquivo'
    case 'embed':
      return s.content.url
        ? `${s.content.display === 'link' ? 'QR code: ' : ''}${s.content.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}`
        : 'Página sem endereço'
    case 'questions':
      return { spotlight: 'Perguntas em destaque', list: 'Mural de perguntas', grid: 'Grade de perguntas' }[s.content.layout]
    case 'timer':
      return s.content.mode === 'countdown' ? `Cronômetro ${clock(s.content.durationSec * 1000)}` : 'Cronômetro progressivo'
    case 'slides':
      return s.content.slides.length ? plural(s.content.slides.length, 'slide', 'slides') : 'Apresentação sem slides'
    case 'join':
      return openJoin ? 'QR code, endereço e PIN' : 'Só o PIN: evento só com convidados'
    case 'section':
      return 'Pasta'
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
