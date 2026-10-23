// Regras do palco. Rodar com `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrast, deriveTheme } from '../../shared/screen-theme.ts'
import { addressParts, amberOn, group, questionOverlayTop, safeOf, timerFace, timerOverlayTop, type TimerSpec } from './lib.ts'

const countdown: TimerSpec = { mode: 'countdown', durationMs: 600_000, warnMs: 120_000, criticalMs: 30_000, onEnd: 'overtime', endText: '' }

test('contagem regressiva: arredonda para cima e muda de tom nos limites', () => {
  assert.deepEqual(timerFace(countdown, 0), { text: '10:00', tone: 'normal', message: false })
  assert.equal(timerFace(countdown, 400).text, '10:00')
  assert.deepEqual(timerFace(countdown, 479_999), { text: '02:01', tone: 'normal', message: false })
  assert.deepEqual(timerFace(countdown, 480_000), { text: '02:00', tone: 'warn', message: false })
  assert.deepEqual(timerFace(countdown, 570_000), { text: '00:30', tone: 'critical', message: false })
})

test('contagem regressiva: o que mostrar no zero', () => {
  assert.deepEqual(timerFace(countdown, 600_000), { text: '+0:00', tone: 'critical', message: false })
  assert.deepEqual(timerFace(countdown, 612_400), { text: '+0:12', tone: 'critical', message: false })
  assert.equal(timerFace(countdown, 600_000 + 754_000).text, '+12:34')
  assert.equal(timerFace(countdown, 600_000 + 3_723_000).text, '+1:02:03')
  assert.deepEqual(timerFace({ ...countdown, onEnd: 'stop' }, 700_000), { text: '00:00', tone: 'critical', message: false })
  assert.deepEqual(timerFace({ ...countdown, onEnd: 'message', endText: ' Retomando ' }, 700_000), { text: 'Retomando', tone: 'normal', message: true })
  assert.equal(timerFace({ ...countdown, onEnd: 'message', endText: '' }, 700_000).text, '00:00')
})

test('limites iguais ou maiores que a duração são ignorados; cronômetro progressivo não muda de tom', () => {
  const short = { ...countdown, durationMs: 300_000, warnMs: 300_000, criticalMs: 60_000 }
  assert.equal(timerFace(short, 0).tone, 'normal')
  assert.equal(timerFace(short, 240_000).tone, 'critical')
  assert.deepEqual(timerFace({ ...countdown, mode: 'stopwatch' }, 754_900), { text: '12:34', tone: 'normal', message: false })
  assert.equal(timerFace({ ...countdown, mode: 'stopwatch' }, 3_723_000).text, '1:02:03')
})

test('âmbar do aviso: legível sobre qualquer fundo gerado, nas duas polaridades', () => {
  for (const brand of ['#E0A33B', '#1E6BFF', '#D7263D', '#FFFFFF', '#000000'])
    for (const background of [undefined, '#000000', '#FFFFFF', '#203040', '#808080', '#B0B0B0', '#F4E9D8'])
      for (const mode of [undefined, 'dark', 'light'] as const)
        for (const level of ['standard', 'high'] as const) {
          const th = deriveTheme({ brand, background, mode, contrast: level })
          const min = level === 'high' ? 7 : 4.5
          const amber = amberOn(th.tokens.canvas, th.mode === 'dark', min)
          assert.ok(contrast(amber, th.tokens.canvas) >= min, `${brand} ${background} ${mode} ${level}: ${amber}`)
        }
  assert.equal(amberOn('#0F0D0A', true), '#f5a524') // fundo escuro padrão: âmbar puro
})

test('endereço da entrada: quebra só antes de ponto do domínio e antes do caminho, e nunca lança erro', () => {
  assert.deepEqual(addressParts('https://deck-slides.vercel.app/e/K7QX2M'), ['deck-slides', '.vercel', '.app', '/e/K7QX2M'])
  assert.deepEqual(addressParts('http://localhost:5173/e/K7QX2M'), ['localhost:5173', '/e/K7QX2M'])
  // PUBLIC_URL malformado (letra O na porta): new URL() lançaria e apagaria a tela.
  assert.deepEqual(addressParts('https://deck.exemplo.com:8O80/e/K7QX2M'), ['deck', '.exemplo', '.com:8O80', '/e/K7QX2M'])
  assert.deepEqual(addressParts('https://deck.exemplo.com'), ['deck', '.exemplo', '.com'])
})

test('PIN e códigos em duas metades', () => {
  assert.equal(group('482913'), '482 913')
  assert.equal(group('K7QX2M'), 'K7Q X2M')
  assert.equal(group('12345678'), '1234 5678')
  assert.equal(group('1234'), '1234')
  assert.equal(group('12345'), '12345')
})

const look = { safe: 5, logo: null, logoPosition: 'top-left', logoSize: 96, scale: 1 } as const
const safe = safeOf(look)

test('cronômetro sobre o conteúdo: na margem de segurança ou logo abaixo do logo do mesmo canto', () => {
  assert.equal(timerOverlayTop(look, 'top-left'), safe)
  assert.equal(timerOverlayTop(look, 'top-right'), safe)
  assert.equal(timerOverlayTop({ ...look, logo: '/logo.png' }, 'top-left'), safe + 96 + 24)
  assert.equal(timerOverlayTop({ ...look, logo: '/logo.png', logoPosition: 'top-right' }, 'top-right'), safe + 96 + 24)
  // Logo no outro canto, embaixo, na posição "Oculta" ou sem logo enviado: fica na margem.
  assert.equal(timerOverlayTop({ ...look, logo: '/logo.png' }, 'top-right'), safe)
  assert.equal(timerOverlayTop({ ...look, logo: '/logo.png', logoPosition: 'bottom-left' }, 'top-left'), safe)
  assert.equal(timerOverlayTop({ ...look, logo: '/logo.png', logoPosition: 'none' }, 'top-left'), safe)
  assert.equal(timerOverlayTop({ ...look, logoPosition: 'top-right' }, 'top-right'), safe)
})

test('pergunta sobre o conteúdo: não invade a altura reservada ao cronômetro', () => {
  // Sem cronômetro: o topo da área da cena.
  assert.equal(questionOverlayTop(look, safe, null), safe)
  // Cartão: respiro 20 + 20, algarismos 120 × 1,1; rótulo 32 × 1,25 + 8; e o GAP de 40.
  const plain = questionOverlayTop(look, safe, { corner: 'top-left', label: '' })
  assert.equal(plain, safe + 40 + 132 + 40)
  assert.equal(questionOverlayTop(look, safe, { corner: 'top-right', label: 'Ana Souza' }), plain + 48)
  assert.equal(questionOverlayTop(look, safe, { corner: 'top-left', label: '   ' }), plain) // rótulo em branco não aparece
  assert.ok(questionOverlayTop({ ...look, scale: 1.5 }, safe, { corner: 'top-left', label: '' }) > plain)
  // Cronômetro abaixo do logo do mesmo canto: a reserva desce junto.
  const logo = { ...look, logo: '/logo.png' }
  assert.equal(questionOverlayTop(logo, safe + 96 + 40, { corner: 'top-left', label: '' }), plain + 96 + 24)
  // Área da cena já mais baixa que o cronômetro: vale a da cena.
  assert.equal(questionOverlayTop(look, 500, { corner: 'top-left', label: 'Ana' }), 500)
})
