// Aparência da tela: rascunho local com pré-visualização no mesmo <Stage> do telão.
// Nada chega à tela do evento antes de "Salvar alterações", que envia o tema inteiro.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/ArrowCounterClockwise'
import { CaretRightIcon } from '@phosphor-icons/react/CaretRight'
import { CheckIcon } from '@phosphor-icons/react/Check'
import { InfoIcon } from '@phosphor-icons/react/Info'
import { WarningIcon } from '@phosphor-icons/react/Warning'
import { patch } from '../lib/api.ts'
import { plural } from '../lib/format.ts'
import { CANVAS, GOOGLE_FONTS, LOCAL_FONT_FAMILIES, NO_TNUM, contrastReport, eventPalette, loadFont, loadThemeFonts } from '../lib/theme.ts'
import { TARGETS, TOKEN_NAMES, type TokenName } from '../../shared/screen-theme.ts'
import {
  Button,
  ColorField,
  Dot,
  Field,
  IconButton,
  Input,
  Segmented,
  Select,
  Slider,
  Tooltip,
  confirm,
  cx,
  notify,
  undoable,
  type Option,
} from '../ui'
import { MediaPicker, UploadButton } from './MediaPicker.tsx'
import { run, useEvent } from './context.ts'
import { Preview } from './appearance/Preview.tsx'
import {
  LOCAL_WEIGHTS,
  PRESETS,
  applyPreset,
  canon,
  familyOf,
  fontKey,
  fontLabel,
  uploadedFonts,
  wghtRange,
  withEdit,
  type Preset,
} from './appearance/draft.ts'
import type { Aspect, FontChoice, Theme } from '../../shared/types.ts'

const TILES = PRESETS.map((p) => ({ ...p, tokens: eventPalette(p.look).tokens }))

const ASPECTS: Option<Aspect>[] = [
  { value: '16:9', label: '16:9 (TV e projetor Full HD)' },
  { value: '16:10', label: '16:10 (projetor WXGA)' },
  { value: '4:3', label: '4:3 (projetor antigo)' },
  { value: '21:9', label: '21:9 (tela ultra-wide)' },
  { value: '32:9', label: '32:9 (LED ultra-wide)' },
]

const LOGO_POSITIONS: Option<Theme['logoPosition']>[] = [
  { value: 'top-left', label: 'Superior esquerda' },
  { value: 'top-right', label: 'Superior direita' },
  { value: 'bottom-left', label: 'Inferior esquerda' },
  { value: 'bottom-right', label: 'Inferior direita' },
  { value: 'none', label: 'Oculta' },
]

const TOKEN_LABEL: Record<TokenName, string> = {
  canvas: 'Fundo',
  surface: 'Superfície',
  raised: 'Superfície elevada',
  line: 'Divisórias',
  lineStrong: 'Contornos',
  fg: 'Texto principal',
  fgMuted: 'Texto secundário',
  accent: 'Cor de destaque',
  onAccent: 'Texto sobre o destaque',
  accentFg: 'Marca em textos e ícones',
  accentSoft: 'Destaque suave',
  critical: 'Alerta',
}
// Pares do relatório de contraste em português: "Texto principal sobre a superfície. Contraste 3,9:1. Mínimo 7:1 para texto principal."
const ON: Partial<Record<TokenName, string>> = {
  canvas: 'o fundo',
  surface: 'a superfície',
  raised: 'a superfície elevada',
  accent: 'a cor de destaque',
  accentSoft: 'o destaque suave',
}
const FOR: Partial<Record<TokenName, string>> = {
  fg: 'texto principal',
  fgMuted: 'texto secundário',
  accentFg: 'textos e ícones na cor da marca',
  critical: 'alertas',
  lineStrong: 'contornos',
  onAccent: 'texto sobre a cor de destaque',
}

/** Catálogo: pacotes locais (funcionam sem internet) + Google Fonts (todas com tnum). Monoespaçadas só para números. */
const catalog = (numbers: boolean) => [
  ...LOCAL_FONT_FAMILIES.filter((f) => (numbers ? !NO_TNUM.has(f) : !/ Mono\b/.test(f))),
  ...Object.keys(GOOGLE_FONTS),
]
const weights = (family: string) =>
  Object.hasOwn(LOCAL_WEIGHTS, family) ? LOCAL_WEIGHTS[family] : Object.hasOwn(GOOGLE_FONTS, family) ? wghtRange(GOOGLE_FONTS[family]) : null

// Amostra + campo hexadecimal com largura fixa (o campo do ColorField herda w-full e esticaria).
const COLOR_W = 'w-34 shrink-0'

const num = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
const unit = (u: string) => (v: number) => `${num(v)}\u00a0${u}`
const andList = new Intl.ListFormat('pt-BR', { type: 'conjunction' })

export default function Appearance() {
  const { id, snap, links, offset } = useEvent()
  const saved = snap.event.theme
  const savedRef = useRef(saved)
  savedRef.current = saved
  const [edit, setEdit] = useState<Theme | null>(null)
  const [saving, setSaving] = useState(false)
  const draft = edit ?? saved
  const dirty = edit !== null && canon(edit) !== canon(saved)

  // Rascunho igual ao salvo (depois de salvar, ou desfeito à mão): volta a seguir o servidor.
  useEffect(() => {
    if (edit && !dirty) setEdit(null)
  }, [edit, dirty])
  useLeaveGuard(dirty)

  const uploaded = uploadedFonts(snap.media)
  const uploadedKey = uploaded.map((f) => f.url).join()
  // Amostras das listas de fontes e das predefinições. Só baixa o arquivo quando a amostra aparece.
  useEffect(() => {
    for (const f of catalog(true)) loadFont({ family: f })
    for (const p of PRESETS) loadFont(p.look.fonts.heading)
  }, [])
  useEffect(() => uploaded.forEach(loadFont), [uploadedKey])
  useEffect(() => loadThemeFonts(draft.fonts), [draft.fonts])

  const set = (p: Partial<Theme> | ((t: Theme) => Partial<Theme>)) =>
    setEdit((e) => {
      const t = e ?? savedRef.current
      return withEdit(t, typeof p === 'function' ? p(t) : p)
    })
  const setFont = (slot: 'heading' | 'body' | 'numbers') => (f: FontChoice) => set((t) => ({ fonts: { ...t.fonts, [slot]: f } }))

  const save = async () => {
    if (!edit) return
    setSaving(true)
    const ok = await run(() => patch(`/events/${id}`, { theme: edit }))
    setSaving(false)
    if (ok) notify('Alterações salvas', { description: 'A tela do evento já usa a nova aparência.' })
  }
  // Predefinição troca muita coisa de uma vez: aplica na hora e oferece desfazer.
  const applyLook = (p: Preset) => {
    const kept = edit ?? saved // desfazer volta ao tema anterior mesmo depois de salvar
    set((t) => applyPreset(t, p))
    undoable(`Predefinição “${p.name}” aplicada`, () => setEdit(kept))
  }
  const discard = () => {
    const kept = edit
    setEdit(null)
    undoable('Alterações descartadas', () => setEdit(kept))
  }

  // Paleta gerada (base) + ajustes finos por cor. Avisos e contraste valem para o que a tela vai mostrar.
  const base = eventPalette({ ...draft, overrides: {} })
  const tokens = { ...base.tokens, ...draft.overrides }
  const failing = contrastReport({ ...base, tokens }, draft.contrast).filter((r) => !r.ok)
  const target = TARGETS[draft.contrast]
  const overrideCount = Object.keys(draft.overrides).length

  const option = (sample: string) => (f: string): Option<string> => ({ value: f, label: fontLabel(f), icon: <Specimen family={f} text={sample} /> })
  const textFonts = [
    ...catalog(false).map(option('Ag')),
    ...uploaded.map((f) => ({ value: f.url, label: `${f.family} (enviada)`, icon: <Specimen family={f.family} text="Ag" /> })),
  ]
  const numberFonts = catalog(true).map(option('09'))
  const heading = draft.fonts.heading
  const headingRange = heading.url ? null : weights(heading.family)
  // Fontes do Google dependem de internet no computador da tela (os pacotes locais, não).
  const online = [...new Set([heading, draft.fonts.body, draft.fonts.numbers].filter((f) => !f.url && Object.hasOwn(GOOGLE_FONTS, f.family)).map((f) => f.family))]
  const { w, h } = CANVAS[draft.aspect]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="shrink-0 font-heading text-title font-semibold">Aparência da tela</h1>
          <p className="truncate text-ui text-fg-subtle">A tela do evento só muda quando você salva.</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {dirty && (
            <span className="flex items-center gap-1.5 text-ui text-fg-muted">
              <Dot tone="attention" />
              Alterações não salvas
            </span>
          )}
          <Button variant="ghost" disabled={!dirty || saving} onClick={discard}>
            Descartar
          </Button>
          <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>
            Salvar alterações
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="w-[380px] shrink-0 overflow-y-auto border-r border-line bg-surface">
          <Section title="Predefinições">
            <div className="grid grid-cols-3 gap-3">
              {TILES.map((p) => (
                <PresetTile key={p.id} preset={p} tokens={p.tokens} active={draft.preset === p.id} onApply={() => applyLook(p)} />
              ))}
            </div>
            <Hint>Troca cores, fontes e estilo. Logo, imagem de fundo, proporção e rodapé continuam como estão.</Hint>
          </Section>

          <Section title="Cores">
            <Row label="Cor da marca">
              <ColorField label="Cor da marca" className={COLOR_W} value={draft.brand} onChange={(brand) => set({ brand })} />
            </Row>
            <Row label="Cor de fundo">
              <Segmented
                size="sm"
                label="Cor de fundo"
                value={draft.background ? 'custom' : 'auto'}
                onChange={(v) => set({ background: v === 'auto' ? null : base.tokens.canvas })}
                options={[
                  { value: 'auto', label: 'Automática' },
                  { value: 'custom', label: 'Personalizada' },
                ]}
              />
              {draft.background && (
                <ColorField
                  label="Cor de fundo personalizada"
                  className={COLOR_W}
                  value={draft.background}
                  onChange={(background) => set({ background })}
                />
              )}
            </Row>
            <Row
              label="Modo"
              hint={
                draft.mode === 'dark'
                  ? 'Texto claro sobre fundo escuro. Indicado para salas escuras e painéis de LED.'
                  : draft.mode === 'light'
                    ? 'Texto escuro sobre fundo claro. Indicado para salas iluminadas com projetor.'
                    : draft.background
                      ? 'Texto claro ou escuro, o que mudar menos a cor de fundo.'
                      : 'Sem cor de fundo personalizada, fica no modo escuro.'
              }
            >
              <Segmented
                size="sm"
                label="Modo"
                value={draft.mode}
                onChange={(mode) => set({ mode })}
                options={[
                  { value: 'auto', label: 'Automático' },
                  { value: 'dark', label: 'Escuro' },
                  { value: 'light', label: 'Claro' },
                ]}
              />
            </Row>
            <Row
              label="Contraste"
              hint={
                draft.contrast === 'high'
                  ? `Texto principal com contraste mínimo de ${num(target.text)}:1, para projetores fracos ou salas claras.`
                  : `Texto principal com contraste mínimo de ${num(target.text)}:1.`
              }
            >
              <Segmented
                size="sm"
                label="Contraste"
                value={draft.contrast}
                onChange={(contrast) => set({ contrast })}
                options={[
                  { value: 'standard', label: 'Padrão' },
                  { value: 'high', label: 'Alto' },
                ]}
              />
            </Row>

            {base.adjusted.includes('accent') && (
              <Note>
                Cor de destaque ajustada de <Hex color={draft.brand} /> para <Hex color={base.tokens.accent} /> para manter o texto legível
                (mínimo {num(target.onAccent)}:1).
              </Note>
            )}
            {draft.background && tokens.canvas.toUpperCase() !== draft.background.toUpperCase() && !draft.overrides.canvas && (
              <Note>
                Cor de fundo ajustada de <Hex color={draft.background} /> para <Hex color={tokens.canvas} /> para manter o texto legível
                (mínimo {num(target.text)}:1).
              </Note>
            )}

            <details className="group">
              <summary className="flex h-8 list-none items-center gap-2 rounded-control text-ui font-medium text-fg-muted transition-colors duration-100 hover:text-fg [&::-webkit-details-marker]:hidden">
                <CaretRightIcon size={12} className="transition-transform duration-150 group-open:rotate-90" />
                Ajustes finos
                {overrideCount > 0 && (
                  <span className="font-normal text-fg-subtle tabular-nums">{plural(overrideCount, 'cor trocada', 'cores trocadas')}</span>
                )}
              </summary>
              <div className="flex flex-col gap-2 pt-1">
                <Hint>Troque uma cor gerada por outra. O contraste deixa de ser garantido: confira os avisos abaixo.</Hint>
                {TOKEN_NAMES.map((k) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className={cx('min-w-0 flex-1 truncate text-ui', draft.overrides[k] ? 'text-fg' : 'text-fg-muted')}>{TOKEN_LABEL[k]}</span>
                    <ColorField
                      label={TOKEN_LABEL[k]}
                      className={COLOR_W}
                      value={tokens[k]}
                      onChange={(v) => set((t) => ({ overrides: { ...t.overrides, [k]: v } }))}
                    />
                    {draft.overrides[k] ? (
                      <Tooltip label="Voltar à cor gerada">
                        <IconButton
                          size="sm"
                          label={`Voltar à cor gerada: ${TOKEN_LABEL[k]}`}
                          icon={<ArrowCounterClockwiseIcon size={14} />}
                          onClick={() => set((t) => ({ overrides: Object.fromEntries(Object.entries(t.overrides).filter(([n]) => n !== k)) }))}
                        />
                      </Tooltip>
                    ) : (
                      <span aria-hidden className="size-7 shrink-0" />
                    )}
                  </div>
                ))}
                {overrideCount > 1 && (
                  <Button size="sm" variant="ghost" className="self-start" onClick={() => set({ overrides: {} })}>
                    Voltar às cores geradas
                  </Button>
                )}
              </div>
            </details>

            {failing.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="flex items-center gap-2 text-ui font-medium text-fg">
                  <WarningIcon className="shrink-0 text-attention" />
                  {plural(failing.length, 'combinação abaixo do contraste mínimo', 'combinações abaixo do contraste mínimo')}
                </p>
                <ul className="flex flex-col gap-1">
                  {failing.map((r) => {
                    const [fg, bg] = r.pair.split('/') as [TokenName, TokenName]
                    return (
                      <li key={r.pair} className="text-meta text-fg-muted">
                        <span className="text-fg">{fg === 'onAccent' ? 'Texto sobre a cor de destaque' : `${TOKEN_LABEL[fg]} sobre ${ON[bg]}`}.</span>{' '}
                        Contraste {num(Math.floor(r.ratio * 10) / 10)}:1. Mínimo {num(r.min)}:1 para {FOR[fg]}.
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </Section>

          <Section title="Fontes">
            <FontField label="Títulos" font={heading} options={textFonts} uploaded={uploaded} onChange={setFont('heading')} />
            <div className="flex flex-col gap-1.5">
              <Slider
                label="Peso dos títulos"
                min={400}
                max={900}
                step={50}
                value={draft.fonts.headingWeight}
                onChange={(headingWeight) => set((t) => ({ fonts: { ...t.fonts, headingWeight } }))}
              />
              {headingRange && draft.fonts.headingWeight > headingRange[1] && (
                <Hint>
                  {fontLabel(heading.family)} vai até o peso {headingRange[1]}. Acima disso, o título não muda.
                </Hint>
              )}
            </div>
            <FontField label="Textos" font={draft.fonts.body} options={textFonts} uploaded={uploaded} onChange={setFont('body')} />
            <FontField
              label="Números (cronômetro e contadores)"
              hint="Só fontes com algarismos de largura fixa, para o cronômetro não tremer."
              font={draft.fonts.numbers}
              options={numberFonts}
              uploaded={[]}
              onChange={setFont('numbers')}
            />
            {online.length > 0 && (
              <Note>
                {andList.format(online)} {online.length > 1 ? 'vêm' : 'vem'} do Google Fonts: o computador da tela precisa de internet.
              </Note>
            )}
            <div className="flex flex-col items-start gap-1.5">
              <UploadButton
                eventId={id}
                kind="font"
                size="sm"
                label="Enviar fonte"
                onUploaded={(m) => {
                  if (m.kind !== 'font') return notify('O arquivo enviado não é uma fonte. Envie WOFF2, WOFF, TTF ou OTF.', { tone: 'critical' })
                  const f = { family: familyOf(m.name), url: m.url }
                  loadFont(f)
                  set((t) => ({ fonts: { ...t.fonts, heading: f, body: f } }))
                  notify(`Fonte “${f.family}” aplicada aos títulos e textos`)
                }}
              />
              <Hint>WOFF2, WOFF, TTF ou OTF. A fonte enviada vai para títulos e textos; o cronômetro continua numa fonte do catálogo.</Hint>
            </div>
          </Section>

          <Section title="Logo">
            <Row label="Imagem" hint="PNG ou SVG com fundo transparente.">
              <div className="w-full">
                <MediaPicker
                  key={draft.logo ?? ''}
                  eventId={id}
                  media={snap.media}
                  kind="image"
                  label="Logo"
                  value={draft.logo}
                  onChange={(logo) => set({ logo })}
                />
              </div>
            </Row>
            {draft.logo && (
              <>
                <Field label="Posição">
                  <Select value={draft.logoPosition} onChange={(logoPosition) => set({ logoPosition })} options={LOGO_POSITIONS} />
                </Field>
                <Slider label="Tamanho" min={24} max={240} step={4} value={draft.logoSize} format={unit('px')} onChange={(logoSize) => set({ logoSize })} />
              </>
            )}
          </Section>

          <Section title="Fundo">
            <Row label="Imagem de fundo" hint={`Use ${w} × ${h}\u00a0px ou maior. Sem imagem, vale a cor de fundo.`}>
              <div className="w-full">
                <MediaPicker
                  key={draft.backgroundImage ?? ''}
                  eventId={id}
                  media={snap.media}
                  kind="image"
                  label="Imagem de fundo"
                  value={draft.backgroundImage}
                  onChange={(backgroundImage) => set({ backgroundImage })}
                />
              </div>
            </Row>
            {draft.backgroundImage && (
              <div className="flex flex-col gap-1.5">
                <Slider
                  label="Véu sobre a imagem"
                  min={0}
                  max={95}
                  step={5}
                  value={Math.round(draft.backgroundDim * 100)}
                  format={unit('%')}
                  onChange={(v) => set({ backgroundDim: v / 100 })}
                />
                <Hint>Cobre a imagem com a cor de fundo para o texto continuar legível.</Hint>
              </div>
            )}
          </Section>

          <Section title="Layout">
            <Field label="Proporção da tela" hint="A mesma da tela ou do painel de LED do local.">
              <Select value={draft.aspect} onChange={(aspect) => set({ aspect })} options={ASPECTS} />
            </Field>
            <Row label="Alinhamento">
              <Segmented
                size="sm"
                label="Alinhamento"
                value={draft.align}
                onChange={(align) => set({ align })}
                options={[
                  { value: 'left', label: 'Esquerda' },
                  { value: 'center', label: 'Centro' },
                ]}
              />
            </Row>
            <div className="flex flex-col gap-1.5">
              <Slider label="Margem de segurança" min={0} max={10} step={0.5} value={draft.safe} format={unit('%')} onChange={(safe) => set({ safe })} />
              <Hint>Espaço livre nas bordas, para projetores e painéis que cortam a imagem.</Hint>
            </div>
            <div className="flex flex-col gap-1.5">
              <Slider
                label="Escala do texto"
                min={0.8}
                max={1.6}
                step={0.05}
                value={draft.scale}
                format={(v) => `${Math.round(v * 100)}\u00a0%`}
                onChange={(scale) => set({ scale })}
              />
              {draft.scale < 1 && <Hint>Texto pequeno para leitura a distância.</Hint>}
            </div>
            <Slider label="Cantos" min={0} max={32} value={draft.radius} format={unit('px')} onChange={(radius) => set({ radius })} />
            <Row label="Cartões das perguntas">
              <Segmented
                size="sm"
                label="Cartões das perguntas"
                value={draft.cardStyle}
                onChange={(cardStyle) => set({ cardStyle })}
                options={[
                  { value: 'solid', label: 'Sólido' },
                  { value: 'outline', label: 'Contorno' },
                  { value: 'plain', label: 'Sem fundo' },
                ]}
              />
            </Row>
            <Field label="Rodapé" hint="Texto fixo no pé de todas as cenas. Vazio, não aparece.">
              <Input value={draft.footer} maxLength={120} placeholder="#semanadeengenharia" onChange={(e) => set({ footer: e.target.value })} />
            </Field>
          </Section>

          <Section title="Exibição">
            <Row label="Transição entre cenas">
              <Segmented
                size="sm"
                label="Transição entre cenas"
                value={draft.transition}
                onChange={(transition) => set({ transition })}
                options={[
                  { value: 'cut', label: 'Corte' },
                  { value: 'fade', label: 'Fusão' },
                ]}
              />
            </Row>
            {draft.transition === 'fade' && (
              <Slider
                label="Duração da fusão"
                min={100}
                max={2000}
                step={50}
                value={draft.transitionMs}
                format={(v) => `${v.toLocaleString('pt-BR')}\u00a0ms`}
                onChange={(transitionMs) => set({ transitionMs })}
              />
            )}
            <Row label="Tela de espera" hint={draft.standby === 'brand' ? 'Logo, nome do evento e como entrar.' : 'Tela toda preta.'}>
              <Segmented
                size="sm"
                label="Tela de espera"
                value={draft.standby}
                onChange={(standby) => set({ standby })}
                options={[
                  { value: 'brand', label: 'Marca' },
                  { value: 'black', label: 'Preto' },
                ]}
              />
            </Row>
            <Row label="Reações na tela">
              <Segmented
                size="sm"
                label="Reações na tela"
                value={draft.reactionsStyle}
                onChange={(reactionsStyle) => set({ reactionsStyle })}
                options={[
                  { value: 'animated', label: 'Animadas' },
                  { value: 'counter', label: 'Só contador' },
                ]}
              />
            </Row>
          </Section>
        </div>

        <Preview
          theme={draft}
          eventName={snap.event.name}
          pin={snap.event.pin}
          joinUrl={snap.event.settings.openJoin ? links.join : null}
          reactions={snap.event.settings.reactions}
          offset={offset}
        />
      </div>
    </div>
  )
}

// ---------- peças ----------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-b border-line px-4 py-5 last:border-b-0">
      <h2 className="text-ui font-semibold text-fg">{title}</h2>
      {children}
    </section>
  )
}

/** Rótulo visível acima de controles que já têm nome acessível próprio (Segmented, ColorField, MediaPicker). */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="text-meta font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <Hint>{hint}</Hint>}
    </div>
  )
}

const Hint = ({ children }: { children: ReactNode }) => <p className="text-meta text-fg-subtle">{children}</p>

const Note = ({ children }: { children: ReactNode }) => (
  <p className="flex gap-2 text-meta text-fg-muted">
    <InfoIcon size={14} className="mt-px shrink-0 text-fg-subtle" />
    <span>{children}</span>
  </p>
)

const Hex = ({ color }: { color: string }) => (
  <span className="inline-flex items-center gap-1 whitespace-nowrap font-code">
    <span aria-hidden className="inline-block size-2.5 rounded-monitor border border-line" style={{ background: color }} />
    {color}
  </span>
)

/** Amostra da fonte na lista. Texto via CSS: não entra no nome do item nem na busca por teclado. */
const Specimen = ({ family, text }: { family: string; text: string }) => (
  <span
    aria-hidden
    data-text={text}
    className="w-6 shrink-0 text-center text-read leading-none before:content-[attr(data-text)]"
    style={{ fontFamily: `"${family}"` }}
  />
)

function PresetTile({ preset, tokens, active, onApply }: { preset: Preset; tokens: Record<TokenName, string>; active: boolean; onApply: () => void }) {
  const { fonts, align } = preset.look
  return (
    <button type="button" aria-pressed={active} onClick={onApply} className="group flex min-w-0 flex-col gap-1.5 rounded-chip text-left">
      <span
        aria-hidden
        className={cx(
          'flex aspect-video w-full flex-col justify-between rounded-monitor border p-2 transition-colors duration-100',
          align === 'center' && 'items-center',
          active ? 'border-accent' : 'border-line group-hover:border-fg-subtle',
        )}
        style={{ background: tokens.canvas }}
      >
        <span className="text-title leading-none" style={{ color: tokens.fg, fontFamily: `"${fonts.heading.family}"`, fontWeight: fonts.headingWeight }}>
          Aa
        </span>
        <span className="h-1 w-1/2 rounded-[1px]" style={{ background: tokens.accent }} />
      </span>
      <span className={cx('flex items-center gap-1 truncate text-meta', active ? 'font-medium text-fg' : 'text-fg-muted group-hover:text-fg')}>
        {preset.name}
        {active && <CheckIcon size={12} className="shrink-0" />}
      </span>
    </button>
  )
}

function FontField({
  label,
  hint,
  font,
  options,
  uploaded,
  onChange,
}: {
  label: string
  hint?: string
  font: FontChoice
  options: Option<string>[]
  uploaded: Required<FontChoice>[]
  onChange: (f: FontChoice) => void
}) {
  const key = fontKey(font)
  return (
    <Field label={label} hint={hint}>
      <Select
        value={key}
        onChange={(v) => onChange(uploaded.find((f) => f.url === v) ?? { family: v })}
        // Fonte do tema fora da lista (arquivo excluído da biblioteca, por exemplo): continua visível.
        options={options.some((o) => o.value === key) ? options : [{ value: key, label: font.family }, ...options]}
      />
    </Field>
  )
}

/**
 * Pede confirmação antes de sair com alterações não salvas. O app usa <BrowserRouter> (modo declarativo),
 * onde useBlocker não funciona; então: cliques em links internos, voltar/avançar (Navigation API) e fechar a aba.
 */
function useLeaveGuard(dirty: boolean) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!dirty) return
    let leaving = false
    const ask = (go: () => void) =>
      void confirm({
        title: 'Sair sem salvar?',
        body: 'As alterações na aparência ainda não foram salvas e serão descartadas.',
        confirm: 'Sair sem salvar',
        cancel: 'Continuar editando',
      }).then((ok) => {
        if (!ok) return
        leaving = true
        go()
      })
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!(a instanceof HTMLAnchorElement) || a.target || a.origin !== location.origin || a.pathname === location.pathname) return
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation() // antes do React: o <Link> não chega a navegar
      ask(() => navigate(a.pathname + a.search + a.hash))
    }
    const onNavigate = (e: NavigateEvent) => {
      if (leaving || e.navigationType !== 'traverse' || !e.cancelable) return
      e.preventDefault()
      ask(() => void Promise.allSettled(Object.values(navigation.traverseTo(e.destination.key))))
    }
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    const nav = 'navigation' in window ? navigation : null
    document.addEventListener('click', onClick, true)
    window.addEventListener('beforeunload', onUnload)
    nav?.addEventListener('navigate', onNavigate)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('beforeunload', onUnload)
      nav?.removeEventListener('navigate', onNavigate)
    }
  }, [dirty, navigate])
}
