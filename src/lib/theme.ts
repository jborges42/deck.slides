import type { CSSProperties } from 'react'
import { deriveTheme, type TokenName } from '../../shared/screen-theme.ts'
import type { Aspect, FontChoice, Theme } from '../../shared/types.ts'

export { contrast, contrastReport } from '../../shared/screen-theme.ts'

export type Tokens = Record<TokenName, string>

/**
 * Paleta do evento com contraste garantido (WCAG 2.x) + ajustes manuais da organização.
 * `force` serve ao celular: segue claro/escuro do sistema e ignora fundo e ajustes da tela.
 */
export function eventPalette(
  t: Pick<Theme, 'brand' | 'background' | 'mode' | 'contrast' | 'overrides'>,
  force?: { mode: 'dark' | 'light'; contrast?: 'standard' | 'high' },
) {
  const th = deriveTheme({
    brand: t.brand,
    background: force ? undefined : (t.background ?? undefined),
    mode: force?.mode ?? (t.mode === 'auto' ? undefined : t.mode),
    contrast: force?.contrast ?? t.contrast,
  })
  return force ? th : { ...th, tokens: { ...th.tokens, ...t.overrides } }
}

const VAR: Record<TokenName, string> = {
  canvas: '--canvas',
  surface: '--surface',
  raised: '--raised',
  line: '--line',
  lineStrong: '--line-strong',
  fg: '--fg',
  fgMuted: '--fg-muted',
  accent: '--accent',
  onAccent: '--on-accent',
  accentFg: '--accent-fg',
  accentSoft: '--accent-soft',
  critical: '--critical',
}

/** Tokens -> variáveis CSS. Aplicadas num elemento, as classes (bg-canvas, text-fg…) passam a usar a paleta do evento. */
export function tokenVars(tokens: Tokens, mode: 'dark' | 'light'): CSSProperties {
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(tokens)) vars[VAR[k as TokenName]] = v
  return { ...vars, '--fg-subtle': tokens.fgMuted, '--focus': tokens.fg, colorScheme: mode } as CSSProperties
}

// ---------- canvas da tela ----------

/** Canvas lógico: altura fixa de 1080; largura pela proporção. */
export const CANVAS: Record<Aspect, { w: number; h: number }> = {
  '16:9': { w: 1920, h: 1080 },
  '16:10': { w: 1728, h: 1080 },
  '4:3': { w: 1440, h: 1080 },
  '21:9': { w: 2520, h: 1080 },
  '32:9': { w: 3840, h: 1080 },
}

// ---------- fontes do evento ----------

/** Fontes servidas pelo próprio app: funcionam sem acesso externo na rede do evento. */
const LOCAL_FONTS: Record<string, () => Promise<unknown>> = {
  // Fontes da marca Conexão Profissional: Poppins nos títulos, Arial (do sistema: Windows, macOS, iOS) no texto e nos números.
  // Poppins não é variável: um arquivo por peso (o Vite não resolve import com variável em pacote).
  Poppins: () =>
    Promise.all([
      import('@fontsource/poppins/400.css'),
      import('@fontsource/poppins/500.css'),
      import('@fontsource/poppins/600.css'),
      import('@fontsource/poppins/700.css'),
      import('@fontsource/poppins/800.css'),
    ]),
  Arial: async () => {},
  'Schibsted Grotesk Variable': () => import('@fontsource-variable/schibsted-grotesk'),
  'Spline Sans Mono Variable': () => import('@fontsource-variable/spline-sans-mono'),
  'Archivo Variable': () => import('@fontsource-variable/archivo/wdth.css'),
  'Chivo Mono Variable': () => import('@fontsource-variable/chivo-mono'),
  'Atkinson Hyperlegible Next Variable': () => import('@fontsource-variable/atkinson-hyperlegible-next'),
  'Atkinson Hyperlegible Mono Variable': () => import('@fontsource-variable/atkinson-hyperlegible-mono'),
}

export const LOCAL_FONT_FAMILIES = Object.keys(LOCAL_FONTS)

/** Sem algarismos de largura fixa: o cronômetro tremeria. Ficam fora da lista de números. */
export const NO_TNUM = new Set(['Poppins'])

/**
 * Famílias do Google Fonts oferecidas no editor, com os eixos pedidos à API.
 * Família fora do catálogo e sem arquivo: pesos 400 e 700.
 * Todas conferidas (CSS2 responde 200, acentos do português no subconjunto latin, recurso tnum):
 * por isso também servem ao cronômetro. Família sem tnum não entra aqui.
 */
export const GOOGLE_FONTS: Record<string, string> = {
  // sem serifa
  'Familjen Grotesk': 'wght@400..700',
  Chivo: 'wght@100..900',
  'Public Sans': 'wght@100..900',
  Barlow: 'wght@400;500;600;700;800',
  // condensadas, para títulos longos e telas estreitas
  'Barlow Condensed': 'wght@400;500;600;700;800',
  'Archivo Narrow': 'wght@400..700',
  'Sofia Sans Condensed': 'wght@1..1000',
  // com serifa
  Literata: 'opsz,wght@7..72,200..900',
  Spectral: 'wght@400;500;600;700;800',
  Bitter: 'wght@100..900',
}

const requested = new Set<string>()

/** Carrega uma fonte do tema: pacote local, arquivo enviado (FontFace) ou Google Fonts. Idempotente. */
export function loadFont(f: FontChoice) {
  const key = f.url ?? f.family
  if (requested.has(key)) return
  requested.add(key)
  if (f.url) {
    // Faixa de pesos: fonte variável enviada usa o eixo de peso em vez de negrito sintético.
    new FontFace(f.family, `url("${f.url}")`, { weight: '100 900' })
      .load()
      .then((face) => document.fonts.add(face))
      .catch(() => requested.delete(key))
    return
  }
  const local = LOCAL_FONTS[f.family]
  if (local) {
    local().catch(() => requested.delete(key))
    return
  }
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family.trim()).replace(/%20/g, '+')}:${GOOGLE_FONTS[f.family] ?? 'wght@400;700'}&display=swap`
  document.head.append(link)
}

export function loadThemeFonts(fonts: Theme['fonts']) {
  loadFont(fonts.heading)
  loadFont(fonts.body)
  loadFont(fonts.numbers)
}

const stack = (f: FontChoice) => `"${f.family}", ui-sans-serif, system-ui, sans-serif`

/** Variáveis das fontes do evento: alimentam as classes font-heading, font-body e font-numbers. */
export function fontVars(fonts: Theme['fonts']): CSSProperties {
  return {
    '--heading-family': stack(fonts.heading),
    '--body-family': stack(fonts.body),
    '--numbers-family': stack(fonts.numbers),
    '--heading-weight': fonts.headingWeight,
  } as CSSProperties
}
