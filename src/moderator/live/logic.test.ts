// Regras do console Ao vivo. Rodar com `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultLive, type Scene, type TimerState } from '../../../shared/types.ts'
import { embedUrl, moveId, parseDuration, sameDraft, takeBlocker, timerReadout } from './logic.ts'

test('duração: minutos soltos, mm:ss e h:mm:ss', () => {
  assert.equal(parseDuration('5'), 300)
  assert.equal(parseDuration('1:30'), 90)
  assert.equal(parseDuration(' 01:00:00 '), 3600)
  assert.equal(parseDuration('0:90'), null)
  assert.equal(parseDuration(''), null)
  assert.equal(parseDuration('5 min'), null)
})

test('página web: só http(s), YouTube vira player incorporado', () => {
  assert.equal(embedUrl('https://www.youtube.com/watch?v=abc123&t=30'), 'https://www.youtube.com/embed/abc123')
  assert.equal(embedUrl('youtu.be/abc123'), 'https://www.youtube.com/embed/abc123')
  assert.equal(embedUrl('exemplo.com.br/agenda'), 'https://exemplo.com.br/agenda')
  assert.equal(embedUrl('javascript:alert(1)'), null)
  assert.equal(embedUrl('ftp://exemplo.com'), null)
})

test('reordenar o roteiro', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b'])
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a'])
  assert.deepEqual(moveId(['a', 'b', 'c'], 'b', 'b', true), ['a', 'b', 'c'])
})

const title = (id: string, over: Partial<{ title: string; name: string }> = {}): Scene => ({
  id,
  name: over.name ?? 'Abertura',
  position: 0,
  type: 'title',
  content: { kicker: '', title: over.title ?? 'Olá', body: '' },
})

test('rascunho confirmado pelo servidor, em qualquer ordem de chaves', () => {
  const s = title('a')
  assert.ok(sameDraft({ name: 'Abertura ', content: { body: '', title: 'Olá', kicker: '' } }, s))
  assert.ok(sameDraft({ name: '', content: s.content }, s))
  assert.ok(!sameDraft({ name: 'Abertura', content: { ...s.content, title: 'Oi' } }, s))
})

test('colocar no ar: motivos para bloquear', () => {
  assert.match(takeBlocker(null, null)!, /Nada na prévia/)
  assert.match(takeBlocker(title('a'), 'a')!, /já está no ar/)
  assert.equal(takeBlocker(title('a'), 'b'), null)
  const image: Scene = { id: 'i', name: 'Foto', position: 1, type: 'image', content: { src: '', fit: 'contain', caption: '' } }
  assert.match(takeBlocker(image, null)!, /não tem imagem/)
})

test('cronômetro: aviso, crítico e tempo extra', () => {
  const t: TimerState = { ...defaultLive().timer, durationMs: 300_000, warnMs: 60_000, criticalMs: 15_000 }
  assert.deepEqual(timerReadout(t, 0), { text: '05:00', tone: 'normal' })
  assert.deepEqual(timerReadout(t, 250_000), { text: '00:50', tone: 'warn' })
  assert.deepEqual(timerReadout(t, 290_500), { text: '00:10', tone: 'critical' })
  assert.deepEqual(timerReadout(t, 312_400), { text: '+0:12', tone: 'critical' })
  assert.deepEqual(timerReadout({ ...t, onEnd: 'stop' }, 312_400), { text: '00:00', tone: 'critical' })
  // Limite igual à duração é ignorado.
  assert.equal(timerReadout({ ...t, warnMs: 300_000 }, 0).tone, 'normal')
})
