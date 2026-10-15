// Regras do editor de aparência. Rodar com `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_THEME, type Theme } from '../../../shared/types.ts'
import { contrastReport, deriveTheme } from '../../../shared/screen-theme.ts'
import { PRESETS, applyPreset, canon, familyOf, wghtRange, withEdit } from './draft.ts'

const mine: Theme = {
  ...DEFAULT_THEME,
  logo: '/media/x/logo.svg',
  logoSize: 120,
  backgroundImage: '/media/x/fundo.jpg',
  backgroundDim: 0.4,
  aspect: '32:9',
  safe: 7,
  footer: '#semanadeengenharia',
  standby: 'black',
  overrides: { fg: '#777777' },
}

test('predefinição troca o visual e mantém logo, fundo, proporção, margem, rodapé e comportamento', () => {
  const t = applyPreset(mine, PRESETS.find((p) => p.id === 'claro')!)
  assert.equal(t.preset, 'claro')
  assert.equal(t.mode, 'light')
  assert.deepEqual(t.overrides, {})
  for (const k of ['logo', 'logoSize', 'backgroundImage', 'backgroundDim', 'aspect', 'safe', 'footer', 'standby'] as const)
    assert.equal(t[k], mine[k], k)
})

test('a predefinição padrão é o tema padrão', () => {
  assert.equal(canon(applyPreset(DEFAULT_THEME, PRESETS[0])), canon(DEFAULT_THEME))
})

test('toda predefinição gera uma paleta sem ajuste e sem contraste abaixo do mínimo', () => {
  for (const { id, look } of PRESETS) {
    const mode = look.mode === 'auto' ? undefined : look.mode
    const th = deriveTheme({ brand: look.brand, background: look.background ?? undefined, mode, contrast: look.contrast })
    assert.deepEqual(th.adjusted, [], id)
    assert.deepEqual(contrastReport(th, look.contrast).filter((r) => !r.ok), [], id)
  }
})

test('editar o visual vira "personalizado"; rodapé e comportamento não', () => {
  assert.equal(withEdit(DEFAULT_THEME, { brand: '#123456' }).preset, 'personalizado')
  assert.equal(withEdit(DEFAULT_THEME, { footer: 'x', transitionMs: 800 }).preset, 'padrao')
})

test('comparação de temas ignora a ordem das chaves', () => {
  const a = { ...DEFAULT_THEME, overrides: { fg: '#111111', canvas: '#222222' } }
  const b = { ...DEFAULT_THEME, overrides: { canvas: '#222222', fg: '#111111' } }
  assert.equal(canon(a), canon(b))
  assert.notEqual(canon(a), canon({ ...b, footer: 'x' }))
})

test('pesos lidos dos eixos pedidos ao Google; família do arquivo enviado', () => {
  assert.deepEqual(wghtRange('wght@400..700'), [400, 700])
  assert.deepEqual(wghtRange('wght@400;500;600;700;800'), [400, 800])
  assert.deepEqual(wghtRange('opsz,wght@7..72,200..900'), [200, 900])
  assert.equal(wghtRange('opsz@8..60'), null)
  assert.equal(familyOf('Marca "Display".woff2'), 'Marca Display')
  assert.equal(familyOf('.woff2'), 'Fonte enviada')
})
