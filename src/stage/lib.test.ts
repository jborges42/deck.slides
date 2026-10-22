// Regras do palco. Rodar com `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrast, deriveTheme } from '../../shared/screen-theme.ts'
import { addressParts, amberOn, group, timerFace, type TimerSpec } from './lib.ts'

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
