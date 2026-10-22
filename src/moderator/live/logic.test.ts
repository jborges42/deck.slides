// Regras do console Ao vivo. Rodar com `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultLive, type Scene, type SceneContent, type TimerState } from '../../../shared/types.ts'
import { embedUrl, folderEnd, folderOf, moveFolder, moveId, parseDuration, playable, sameDraft, sceneDetail, takeBlocker, timerReadout } from './logic.ts'

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

test('página web: links do Google, Drive, Canva e Vimeo viram a versão que abre dentro da tela', () => {
  assert.equal(
    embedUrl('https://docs.google.com/presentation/d/1AbC_d-9/edit#slide=id.p'),
    'https://docs.google.com/presentation/d/1AbC_d-9/embed?start=false&loop=false',
  )
  assert.equal(
    embedUrl('https://docs.google.com/presentation/d/e/2PACX-1vX/pub?start=false'),
    'https://docs.google.com/presentation/d/e/2PACX-1vX/embed?start=false&loop=false',
  )
  assert.equal(embedUrl('docs.google.com/document/d/1AbC/edit?usp=sharing'), 'https://docs.google.com/document/d/1AbC/preview')
  assert.equal(embedUrl('https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0'), 'https://docs.google.com/spreadsheets/d/1AbC/preview')
  assert.equal(embedUrl('https://docs.google.com/document/d/e/2PACX-1vX/pub'), 'https://docs.google.com/document/d/e/2PACX-1vX/pub') // publicado: já abre
  assert.equal(embedUrl('https://drive.google.com/file/d/1AbC/view?usp=drive_link'), 'https://drive.google.com/file/d/1AbC/preview')
  assert.equal(embedUrl('https://www.canva.com/design/DAGx1/AbCd/edit'), 'https://www.canva.com/design/DAGx1/AbCd/view?embed')
  assert.equal(embedUrl('https://www.canva.com/design/DAGx1/view?embed'), 'https://www.canva.com/design/DAGx1/view?embed')
  assert.equal(embedUrl('https://vimeo.com/76979871'), 'https://player.vimeo.com/video/76979871')
  assert.equal(embedUrl('https://www.magazineluiza.com.br/'), 'https://www.magazineluiza.com.br/') // os outros ficam como estão
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
  assert.ok(!sameDraft({ name: 'Abertura', content: { ...(s.content as SceneContent<'title'>), title: 'Oi' } }, s))
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

// Roteiro com pastas: a, b soltas; pasta F com c, d; pasta G vazia; pasta H com e.
const R = [
  { id: 'a', type: 'title' },
  { id: 'b', type: 'title' },
  { id: 'F', type: 'section' },
  { id: 'c', type: 'slides' },
  { id: 'd', type: 'timer' },
  { id: 'G', type: 'section' },
  { id: 'H', type: 'section' },
  { id: 'e', type: 'questions' },
] as Scene[]

test('pastas: cada cena pertence à última pasta acima dela; títulos não contam na numeração', () => {
  assert.deepEqual([...folderOf(R)], [['a', null], ['b', null], ['c', 'F'], ['d', 'F'], ['e', 'H']])
  assert.deepEqual(playable(R).map((s) => s.id), ['a', 'b', 'c', 'd', 'e'])
})

test('nova cena pelo "+" da pasta entra depois da última cena dela (ou do título, se vazia)', () => {
  assert.equal(folderEnd(R, 'F'), 'd')
  assert.equal(folderEnd(R, 'G'), 'G')
  assert.equal(folderEnd(R, 'H'), 'e')
})

test('mover pasta leva título e cenas juntos, antes ou depois de outro bloco', () => {
  assert.deepEqual(moveFolder(R, 'H', 'F', false), ['a', 'b', 'H', 'e', 'F', 'c', 'd', 'G'])
  assert.deepEqual(moveFolder(R, 'F', 'e', true), ['a', 'b', 'G', 'H', 'e', 'F', 'c', 'd'])
  assert.deepEqual(moveFolder(R, 'F', 'd', true), R.map((s) => s.id)) // dentro dela mesma: nada muda
})

test('pasta nunca entra antes das cenas soltas do começo (elas passariam a ser dela)', () => {
  assert.deepEqual(moveFolder(R, 'H', 'a', false), ['a', 'b', 'H', 'e', 'F', 'c', 'd', 'G'])
})

test('rascunho com a mesma lista de slides (outro array) é o que o servidor já tem', () => {
  const s = { id: 's', name: 'Palestra', position: 0, type: 'slides', content: { slides: ['/media/X/a.webp', '/media/X/b.webp'] } } as Scene
  assert.ok(sameDraft({ name: 'Palestra', content: { slides: ['/media/X/a.webp', '/media/X/b.webp'] } }, s))
  assert.ok(!sameDraft({ name: 'Palestra', content: { slides: ['/media/X/a.webp'] } }, s))
  assert.equal(takeBlocker({ ...s, content: { slides: [] } } as Scene, null), 'A apresentação não tem slides. Envie o PDF abaixo.')
})

test('cena de entrada no roteiro: sem a entrada aberta, não promete QR nem endereço', () => {
  const s = { id: 'j', name: 'Entrada', position: 0, type: 'join', content: { title: 'Participe pelo celular' } } as Scene
  assert.equal(sceneDetail(s), 'QR code, endereço e PIN')
  assert.equal(sceneDetail(s, false), 'Só o PIN: evento só com convidados')
  assert.equal(takeBlocker(s, null), null)
})
