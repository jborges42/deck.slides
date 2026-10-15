// Regras puras do editor de aparência: predefinições, rascunho e fontes. Sem DOM: testadas em draft.test.ts.
import { DEFAULT_THEME, type FontChoice, type Media, type Theme } from '../../../shared/types.ts'

/** O que uma predefinição troca. Logo, imagem de fundo, proporção, margem, rodapé e comportamento ficam como estão. */
export const LOOK_KEYS = ['brand', 'background', 'mode', 'contrast', 'overrides', 'fonts', 'scale', 'radius', 'cardStyle', 'align'] as const
export type Look = Pick<Theme, (typeof LOOK_KEYS)[number]>

const look = (l: Partial<Look>): Look => ({ ...(Object.fromEntries(LOOK_KEYS.map((k) => [k, DEFAULT_THEME[k]])) as Look), ...l })
const fonts = (heading: string, body: string, numbers: string, headingWeight: number): Theme['fonts'] => ({
  heading: { family: heading },
  body: { family: body },
  numbers: { family: numbers },
  headingWeight,
})

export interface Preset {
  id: string
  name: string
  look: Look
}

export const PRESETS: Preset[] = [
  { id: 'padrao', name: 'Padrão', look: look({}) },
  {
    id: 'transmissao',
    name: 'Transmissão',
    look: look({ brand: '#2EA8FF', background: '#0B1220', fonts: fonts('Archivo Variable', 'Archivo Variable', 'Chivo Mono Variable', 800), radius: 4 }),
  },
  {
    id: 'alta-legibilidade',
    name: 'Alta legibilidade',
    look: look({
      brand: '#FFD60A',
      contrast: 'high',
      fonts: fonts('Atkinson Hyperlegible Next Variable', 'Atkinson Hyperlegible Next Variable', 'Atkinson Hyperlegible Mono Variable', 700),
      scale: 1.2,
      radius: 8,
    }),
  },
  { id: 'claro', name: 'Claro', look: look({ brand: '#2456C8', mode: 'light' }) },
  // Cerimônias e aulas magnas: serifa centralizada. Números ficam na fonte local (funciona sem internet).
  {
    id: 'cerimonia',
    name: 'Cerimônia',
    look: look({
      brand: '#C8A45A',
      background: '#0F1B2D',
      fonts: fonts('Literata', 'Literata', 'Schibsted Grotesk Variable', 600),
      scale: 1.1,
      radius: 2,
      cardStyle: 'plain',
      align: 'center',
    }),
  },
  // Palco e LED: preto puro, monocromático, títulos condensados. Cartões em contorno (superfícies somem no preto).
  {
    id: 'palco',
    name: 'Palco',
    look: look({
      brand: '#F2F2F2',
      background: '#000000',
      fonts: fonts('Barlow Condensed', 'Barlow', 'Barlow Condensed', 700),
      scale: 1.1,
      radius: 0,
      cardStyle: 'outline',
    }),
  },
]

export const applyPreset = (t: Theme, p: Preset): Theme => ({ ...t, ...p.look, preset: p.id })

/** Aplica uma edição. Mexer no visual de uma predefinição a torna "personalizado". */
export function withEdit(t: Theme, patch: Partial<Theme>): Theme {
  const custom = LOOK_KEYS.some((k) => k in patch)
  return { ...t, ...patch, preset: patch.preset ?? (custom ? 'personalizado' : t.preset) }
}

/** JSON com chaves ordenadas: compara temas sem depender da ordem das chaves. */
export const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  )

// ---------- fontes ----------

export const fontLabel = (family: string) => family.replace(/ Variable$/, '')
export const fontKey = (f: FontChoice) => f.url ?? f.family

/** Família a partir do nome do arquivo enviado ("Marca-Bold.woff2" -> "Marca-Bold"). */
export const familyOf = (name: string) =>
  name.replace(/\.[^.]+$/, '').replace(/["\\]/g, '').trim().slice(0, 80) || 'Fonte enviada'

export const uploadedFonts = (media: Media[]): Required<FontChoice>[] =>
  media.filter((m) => m.kind === 'font').map((m) => ({ family: familyOf(m.name), url: m.url }))

/** Pesos dos pacotes locais (font-weight declarado no CSS do Fontsource). */
export const LOCAL_WEIGHTS: Record<string, [number, number]> = {
  'Schibsted Grotesk Variable': [400, 900],
  'Spline Sans Mono Variable': [300, 700],
  'Archivo Variable': [100, 900],
  'Chivo Mono Variable': [100, 900],
  'Atkinson Hyperlegible Next Variable': [200, 800],
  'Atkinson Hyperlegible Mono Variable': [200, 800],
}

/** Faixa de pesos pedida ao Google Fonts: 'wght@400..700', 'wght@400;500;700', 'opsz,wght@7..72,200..900'. */
export function wghtRange(spec: string): [number, number] | null {
  const [axes, tuples = ''] = spec.split('@')
  const i = axes.split(',').indexOf('wght')
  if (i < 0) return null
  const ns = tuples.split(';').flatMap((t) => (t.split(',')[i] ?? '').split('..').filter(Boolean).map(Number))
  return ns.length && ns.every(Number.isFinite) ? [Math.min(...ns), Math.max(...ns)] : null
}
