// Palco: renderiza o que a tela do evento mostra. O MESMO componente é usado no telão (/tela),
// nos monitores Prévia/No ar do console e na pré-visualização do editor de aparência.
// CONTRATO ESTÁVEL: outras partes do app dependem destas props.
//
// Canvas lógico de 1080 de altura (largura pela proporção do tema), encaixado no pai com container queries.
// Toda medida é unidade do canvas (--u = 1/1080 da altura): o layout é idêntico em qualquer tamanho e o texto
// continua nítido (nada de transform: scale). Camadas, de baixo para cima: fundo (cor e imagem com véu) ·
// cena ou tela de espera · logo e rodapé · sobreposições (entrada, reações) · preto da tela de espera.
import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { CANVAS, eventPalette, fontVars, loadThemeFonts, tokenVars } from '../lib/theme.ts'
import { BrandStrip, cx } from '../ui'
import { BRAND, BRAND_FONT, BRAND_W, amberOn, safeOf, u } from './lib.ts'
import { JoinBand, Reactions, bandHeight } from './overlays.tsx'
import { Crossfade, SceneView, type Box } from './scenes.tsx'
import type { LiveState, PublicQuestion, ReactionKind, Scene, Theme } from '../../shared/types.ts'

export interface StageProps {
  theme: Theme
  eventName: string
  pin: string
  /** Link de entrada para o QR (evento com entrada aberta) ou null (só convidados: mostra apenas o PIN). */
  joinUrl: string | null
  /** Cena a renderizar. null = nada no ar: mostra a tela de espera da marca. */
  scene: Scene | null
  /** Perguntas da cena de perguntas, já filtradas e ordenadas (use `onScreen` de shared/types). */
  questions: PublicQuestion[]
  /** Curtidas ao vivo por pergunta (vindas de `counts.likes`); sobrepõem `questions[].likes`. */
  likes?: Record<string, number>
  /** Cronômetro, vídeo e sobreposições. O cronômetro só vale para a cena se `timer.sceneId === scene.id`. */
  live: Pick<LiveState, 'timer' | 'playback' | 'overlays' | 'transition' | 'slides'>
  /** Tela de espera ativa (tecla B). Só faz sentido no telão e no monitor No ar. */
  standby: boolean
  /** Totais de reações da cena exibida; aumentos entre renders viram animação. */
  reactions?: Partial<Record<ReactionKind, number>>
  enabledReactions: ReactionKind[]
  /** Somar a Date.now() para obter o relógio do servidor. */
  offset: number
  /** screen: telão (som, animações). monitor: console (vídeo mudo). thumb: miniatura estática, sem vídeo nem animação. */
  mode: 'screen' | 'monitor' | 'thumb'
  /** Avisa quando o texto não cabe na área segura, para o console mostrar "Não cabe na tela". */
  onOverflow?: (overflow: boolean) => void
  className?: string
}

const GAP = 40 // entre a linha do logo/rodapé e o conteúdo
const FOOTER = 36

const palettes = new Map<string, { palette: ReturnType<typeof eventPalette>; amber: string }>()

/** Paleta do evento (e o âmbar do cronômetro), compartilhada entre palcos: o roteiro pode ter dezenas de miniaturas. */
function paletteOf(theme: Theme) {
  const key = JSON.stringify([theme.brand, theme.background, theme.mode, theme.contrast, theme.overrides])
  let p = palettes.get(key)
  if (!p) {
    if (palettes.size > 50) palettes.clear() // o editor de aparência gera uma por cor arrastada
    const palette = eventPalette(theme)
    p = { palette, amber: amberOn(palette.tokens.canvas, palette.mode === 'dark', theme.contrast === 'high' ? 7 : 4.5) }
    palettes.set(key, p)
  }
  return p
}

type Layout = Box & { footer: boolean }

/** Área do texto da cena: margem de segurança menos a linha do logo (topo ou base) e a do rodapé. */
function layout(theme: Theme, scene: Scene | null): Layout {
  const safe = safeOf(theme)
  const at = theme.logo ? theme.logoPosition : 'none'
  // Rodapé só em cenas de texto: sobre imagem, vídeo ou página ele ficaria sem contraste garantido.
  const footer = !!theme.footer.trim() && (scene?.type === 'title' || scene?.type === 'questions' || scene?.type === 'timer')
  // A linha de baixo sempre existe: o logo da marca fica nela em toda cena.
  const row = Math.max(at.startsWith('bottom') ? theme.logoSize : 0, footer ? FOOTER * theme.scale * 1.3 : 0, BRAND)
  return { side: safe, top: safe + (at.startsWith('top') ? theme.logoSize + GAP : 0), bottom: safe + row + GAP, footer }
}

/**
 * Ocupa 100% do elemento pai e encaixa o canvas na proporção do tema (sobra preenchida com a cor de fundo).
 * O pai define a largura (o palco é um container de tamanho e não cresce pelo conteúdo); sem altura definida,
 * o palco assume a da proporção. O palco pinta por cima de um outline interno do pai: moldura de tally vai num
 * irmão sobreposto ou num pai com 2 px de respiro.
 */
export function Stage(props: StageProps) {
  const { theme, scene, live, mode } = props
  const thumb = mode === 'thumb'
  const { w, h } = CANVAS[theme.aspect]
  const { palette, amber } = paletteOf(theme)

  useEffect(() => loadThemeFonts(theme.fonts), [theme.fonts])

  // Aviso de texto que não cabe: só quando muda. A cena exibida mede; as demais (e a tela de espera) cabem.
  const onOverflow = useRef(props.onOverflow)
  useLayoutEffect(() => {
    onOverflow.current = props.onOverflow
  })
  const reported = useRef<boolean | null>(null)
  const report = useCallback((overflow: boolean) => {
    if (reported.current === overflow) return
    reported.current = overflow
    onOverflow.current?.(overflow)
  }, [])

  const shown = props.standby ? null : scene // null = tela de espera
  const black = !shown && theme.standby === 'black'
  const measured = shown?.type === 'title' || shown?.type === 'questions' || shown?.type === 'join'
  useEffect(() => {
    if (!measured) report(false)
  }, [measured, report])

  const fadeMs = thumb || live.transition !== 'fade' ? 0 : theme.transitionMs
  const box = layout(theme, black ? scene : shown) // sob o preto, a cena guarda o próprio layout: nada pula ao voltar
  const join = !thumb && live.overlays.join && !black && shown?.type !== 'join' // a cena de entrada já mostra o QR e o PIN
  const band = bandHeight(theme, !!props.joinUrl)
  // Faixa da marca: na margem de segurança ou, com a faixa de entrada visível, logo acima dela.
  const brand = join ? band + 24 : safeOf(theme)
  // Com a faixa de entrada visível, o texto da cena termina acima dela e da marca (e o aviso de "não cabe" passa a valer).
  const sceneBox = join ? { ...box, bottom: Math.max(box.bottom, brand + BRAND + GAP) } : box

  const view = (s: Scene) => (
    <SceneView
      scene={s}
      theme={theme}
      mode={mode}
      live={live}
      offset={props.offset}
      questions={props.questions}
      likes={props.likes}
      box={sceneBox}
      amber={amber}
      joinUrl={props.joinUrl}
      pin={props.pin}
      report={shown ? report : undefined}
    />
  )
  // Na tela de espera preta a cena continua por baixo do preto, para reaparecer na mesma fusão.
  const [contentId, content] = black
    ? [scene?.id ?? 'none', scene && view(scene)]
    : shown
      ? [shown.id, view(shown)]
      : ['standby', <BrandStandby theme={theme} name={props.eventName} bottom={brand + BRAND + GAP} />]

  return (
    <div
      aria-hidden={thumb || undefined}
      className={cx('grid size-full place-items-center overflow-hidden bg-canvas select-none', props.className)}
      style={{
        ...tokenVars(palette.tokens, palette.mode),
        ...fontVars(theme.fonts),
        containerType: 'size',
        aspectRatio: `${w} / ${h}`,
        backgroundColor: black ? '#000' : undefined,
        transition: `background-color ${fadeMs}ms linear`,
      }}
    >
      <div
        className="relative overflow-hidden bg-canvas font-body text-fg"
        style={
          {
            width: `min(100cqw, ${((100 * w) / h).toFixed(3)}cqh)`,
            aspectRatio: `${w} / ${h}`,
            containerType: 'size',
            '--u': 'calc(100cqh / 1080)',
          } as CSSProperties
        }
      >
        {theme.backgroundImage && (
          <>
            <img src={theme.backgroundImage} alt="" draggable={false} decoding="async" className="absolute inset-0 size-full object-cover" />
            <div className="absolute inset-0 bg-canvas" style={{ opacity: theme.backgroundDim }} />
          </>
        )}
        <Crossfade id={contentId} ms={fadeMs}>
          {content}
        </Crossfade>
        <Chrome theme={theme} box={box} show={!!shown} ms={fadeMs} />
        {!thumb && <JoinBand theme={theme} joinUrl={props.joinUrl} pin={props.pin} show={join} />}
        {!thumb && live.overlays.reactions && shown && shown.type !== 'video' && (
          <Reactions
            theme={theme}
            totals={props.reactions}
            enabled={props.enabledReactions}
            sceneId={shown.id}
            bottom={join ? brand + BRAND + 24 : box.bottom}
          />
        )}
        {/* Marca fixa em toda cena e na tela de espera; a tela de espera preta cobre. */}
        <BrandStrip
          stacked
          negative={palette.mode === 'dark'}
          className="pointer-events-none absolute"
          style={{ right: u(safeOf(theme)), bottom: u(brand), fontSize: u(BRAND_FONT), transition: `bottom ${thumb ? 0 : 300}ms linear` }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-black"
          style={{ opacity: black ? 1 : 0, transition: `opacity ${fadeMs}ms linear` }}
        />
      </div>
    </div>
  )
}

/** Logo no canto escolhido e rodapé fixo, dentro da margem de segurança. Somem na tela de espera. */
function Chrome({ theme, box, show, ms }: { theme: Theme; box: Layout; show: boolean; ms: number }) {
  const at = theme.logo ? theme.logoPosition : 'none'
  const text = theme.footer.trim()
  if (at === 'none' && !text) return null
  const safe = safeOf(theme)
  const bottom = at === 'bottom-left' || at === 'bottom-right'
  const logo = at !== 'none' && (
    <img
      src={theme.logo!}
      alt=""
      draggable={false}
      decoding="async"
      className="block w-auto shrink-0 object-contain"
      style={{ height: u(theme.logoSize), maxWidth: '30cqw' }}
    />
  )
  // Rodapé numa linha: texto longo reduz a fonte (estimativa de 0,55 em por caractere) antes de chegar às reticências.
  const width = CANVAS[theme.aspect].w - 2 * safe - BRAND_W - GAP - (bottom ? theme.logoSize * 3 + GAP : 0)
  const size = Math.max(24, Math.min(FOOTER * theme.scale, width / (Math.max(text.length, 1) * 0.55)))
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: show ? 1 : 0, transition: `opacity ${ms}ms linear` }}>
      {(at === 'top-left' || at === 'top-right') && (
        <div className="absolute" style={at === 'top-right' ? { top: u(safe), right: u(safe) } : { top: u(safe), left: u(safe) }}>
          {logo}
        </div>
      )}
      {(bottom || text) && (
        <div
          className={cx('absolute flex items-end', at === 'bottom-right' && 'flex-row-reverse')}
          style={{ left: u(safe), right: u(safe + BRAND_W + GAP), bottom: u(safe), gap: u(GAP) }}
        >
          {bottom && logo}
          {text && (
            <p
              className="min-w-0 flex-1 truncate font-body text-fg-muted"
              style={{ fontSize: u(size), lineHeight: 1.3, textAlign: theme.align, opacity: box.footer ? 1 : 0, transition: `opacity ${ms}ms linear` }}
            >
              {text}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Tela de espera da marca: logo e nome do evento, centralizados acima da faixa de entrada (quando ligada). */
function BrandStandby({ theme, name, bottom }: { theme: Theme; name: string; bottom: number }) {
  const s = theme.scale
  const safe = safeOf(theme)
  return (
    <div
      className="absolute flex flex-col items-center justify-center text-center"
      style={{ top: u(safe), left: u(safe), right: u(safe), bottom: u(bottom), gap: u(48 * s) }}
    >
      {theme.logo && (
        <img
          src={theme.logo}
          alt=""
          draggable={false}
          decoding="async"
          className="block w-auto object-contain"
          style={{ height: u(Math.min(Math.max(theme.logoSize * 2, 96), 240)), maxWidth: '60cqw' }}
        />
      )}
      <p
        className="font-heading tracking-tight text-balance text-fg wrap-anywhere"
        style={{ fontSize: u(96 * s), lineHeight: 1.15, fontWeight: 'var(--heading-weight)', maxWidth: u(1536) }}
      >
        {name}
      </p>
    </div>
  )
}
