// Funções puras do contrato (shared/types.ts): relógio, nome na tela, fila da tela e termos sensíveis.
// Servidor e interface usam as mesmas funções; aqui fica o comportamento exato de cada uma.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  REACTIONS,
  defaultLive,
  hasFlagWord,
  normalize,
  onScreen,
  playbackPosition,
  publicAuthor,
  timerElapsed,
  type PlaybackState,
  type Question,
  type TimerState,
} from './types.ts'

describe('timerElapsed', () => {
  const timer = (patch: Partial<TimerState>): TimerState => ({ ...defaultLive().timer, ...patch })

  test('parado devolve só o acumulado, em qualquer instante', () => {
    const t = timer({ running: false, elapsedMs: 42_000, startedAt: 1_000 })
    assert.equal(timerElapsed(t, 0), 42_000)
    assert.equal(timerElapsed(t, 10_000_000), 42_000)
  })

  test('correndo soma ao acumulado o tempo desde o início', () => {
    const t = timer({ running: true, elapsedMs: 5_000, startedAt: 100_000 })
    assert.equal(timerElapsed(t, 100_000), 5_000)
    assert.equal(timerElapsed(t, 112_500), 17_500)
  })

  test('instante anterior ao início (relógio corrigido para trás) não desconta tempo', () => {
    assert.equal(timerElapsed(timer({ running: true, elapsedMs: 5_000, startedAt: 100_000 }), 99_000), 5_000)
  })
})

describe('playbackPosition', () => {
  const playback = (patch: Partial<PlaybackState>): PlaybackState => ({ ...defaultLive().playback, ...patch })

  test('pausado devolve a posição guardada', () => {
    assert.equal(playbackPosition(playback({ playing: false, positionMs: 7_000, startedAt: 1_000 }), 50_000), 7_000)
  })

  test('tocando soma o tempo desde que começou a tocar', () => {
    assert.equal(playbackPosition(playback({ playing: true, positionMs: 7_000, startedAt: 1_000 }), 4_500), 10_500)
  })

  test('instante anterior ao início não volta o vídeo', () => {
    assert.equal(playbackPosition(playback({ playing: true, positionMs: 7_000, startedAt: 1_000 }), 0), 7_000)
  })
})

describe('publicAuthor', () => {
  test('padrão: primeiro nome e inicial maiúscula do último sobrenome', () => {
    assert.equal(publicAuthor('Ana Souza', false, 'first-initial'), 'Ana S.')
    assert.equal(publicAuthor('Maria Clara de Souza Lima', false, 'first-initial'), 'Maria L.')
    assert.equal(publicAuthor('joão álvares', false, 'first-initial'), 'joão Á.')
  })

  test('nome completo e só o primeiro nome', () => {
    assert.equal(publicAuthor('Maria Clara Souza', false, 'full'), 'Maria Clara Souza')
    assert.equal(publicAuthor('Maria Clara Souza', false, 'first'), 'Maria')
  })

  test('nome único fica como está em qualquer formato', () => {
    for (const format of ['first-initial', 'full', 'first'] as const) assert.equal(publicAuthor('Pedro', false, format), 'Pedro')
  })

  test('espaços extras, tabulação e quebra de linha não viram partes vazias', () => {
    assert.equal(publicAuthor('  Ana \t  Souza \n', false, 'full'), 'Ana Souza')
    assert.equal(publicAuthor('  Ana    Souza  ', false, 'first-initial'), 'Ana S.')
    assert.equal(publicAuthor('  Ana  ', false, 'first-initial'), 'Ana')
  })

  test('anônimo ou nome vazio: sem autor', () => {
    for (const format of ['first-initial', 'full', 'first'] as const) {
      assert.equal(publicAuthor('Ana Souza', true, format), null)
      assert.equal(publicAuthor('', false, format), null)
      assert.equal(publicAuthor(' \t ', false, format), null)
    }
  })

  test('sobrenome que começa com emoji não corta o caractere ao meio', () => {
    assert.equal(publicAuthor('Ana 🎉', false, 'first-initial'), 'Ana 🎉.')
    assert.ok(publicAuthor('Ana 𝒮ouza', false, 'first-initial')!.isWellFormed())
  })
})

describe('onScreen', () => {
  const q = (id: string, patch: Partial<Question> = {}): Question => ({
    id,
    participantId: 'p1',
    author: 'Ana Souza',
    anonymous: false,
    text: `Pergunta ${id}`,
    original: `Pergunta ${id} (original)`,
    status: 'approved',
    screen: null,
    flagged: false,
    likes: 0,
    createdAt: 0,
    ...patch,
  })
  const list = [
    q('c', { screen: 7 }),
    q('a', { screen: 0, status: 'answered' }),
    q('pendente', { screen: 1, status: 'pending' }),
    q('rejeitada', { screen: 2, status: 'rejected' }),
    q('fora', { screen: null }),
    q('b', { screen: 3, likes: 4 }),
  ]

  test('só aprovadas ou respondidas marcadas para a tela, na ordem de exibição', () => {
    assert.deepEqual(onScreen(list, 12, 'first-initial').map((x) => x.id), ['a', 'b', 'c'])
  })

  test('respeita o limite da cena', () => {
    assert.deepEqual(onScreen(list, 2, 'first-initial').map((x) => x.id), ['a', 'b'])
    assert.deepEqual(onScreen(list, 0, 'first-initial'), [])
  })

  test('formato público: autor conforme a configuração, anônima sem autor e nenhum campo interno', () => {
    const out = onScreen([q('x', { screen: 1, author: 'Maria Clara Souza', likes: 3, flagged: true }), q('y', { screen: 2, anonymous: true })], 5, 'first')
    assert.deepEqual(out, [
      { id: 'x', text: 'Pergunta x', author: 'Maria', likes: 3 },
      { id: 'y', text: 'Pergunta y', author: null, likes: 0 },
    ])
  })

  test('não altera a lista recebida', () => {
    const before = structuredClone(list)
    onScreen(list, 12, 'full')
    assert.deepEqual(list, before)
  })
})

describe('normalize', () => {
  test('minúsculas e sem acentos', () => {
    assert.equal(normalize('AÇÃO É Óbvia'), 'acao e obvia')
  })

  test('acento composto ou decomposto dá o mesmo resultado', () => {
    assert.equal(normalize('José'), normalize('José'))
  })

  test('letra repetida 3 vezes ou mais vira uma; dupla legítima fica', () => {
    assert.equal(normalize('muuuuito boooom'), 'muito bom')
    assert.equal(normalize('carro assado'), 'carro assado')
    assert.equal(normalize('AAAH ééé'), 'ah e')
  })

  test('números repetidos não são letras e ficam', () => {
    assert.equal(normalize('1000 reais'), '1000 reais')
  })

  test('espaços, tabulações e quebras viram um espaço; pontas aparadas', () => {
    assert.equal(normalize('  oi \n\t  tudo   bem  '), 'oi tudo bem')
    assert.equal(normalize(' \n '), '')
  })
})

describe('hasFlagWord', () => {
  test('palavra inteira: não marca pedaço de outra palavra', () => {
    assert.equal(hasFlagWord('Que burro!', ['burro']), true)
    assert.equal(hasFlagWord('burro', ['burro']), true)
    assert.equal(hasFlagWord('Isso é uma burrice', ['burro']), false)
    assert.equal(hasFlagWord('Quem é o aburro?', ['burro']), false)
  })

  test('ignora acentos, maiúsculas, pontuação e letras esticadas, no texto e no termo', () => {
    assert.equal(hasFlagWord('Você é um IDIÓTA?!', ['idiota']), true)
    assert.equal(hasFlagWord('que idiotaaaa', ['idiota']), true)
    assert.equal(hasFlagWord('(idiota)', ['Idiôta']), true)
  })

  test('termo com mais de uma palavra casa a sequência, mesmo com pontuação no meio', () => {
    assert.equal(hasFlagWord('Isso é golpe de estado, gente', ['golpe de estado']), true)
    assert.equal(hasFlagWord('Foi golpe, de estado?', ['golpe de estado']), true)
    assert.equal(hasFlagWord('golpe no estado', ['golpe de estado']), false)
  })

  test('termo com hífen casa a palavra escrita com ou sem hífen', () => {
    assert.equal(hasFlagWord('Que professor mal-educado!', ['mal-educado']), true)
    assert.equal(hasFlagWord('ele é mal educado', ['mal-educado']), true)
  })

  test('lista vazia, termos vazios ou só de pontuação nunca marcam', () => {
    assert.equal(hasFlagWord('Pergunta comum', []), false)
    assert.equal(hasFlagWord('Pergunta comum', ['', '   ', '***', '-']), false)
    assert.equal(hasFlagWord('', ['']), false)
  })
})

describe('padrões do contrato', () => {
  test('defaultLive devolve um objeto novo a cada chamada (mudar um não afeta o próximo evento)', () => {
    const a = defaultLive()
    const b = defaultLive()
    assert.deepEqual(a, b)
    assert.notEqual(a, b)
    assert.notEqual(a.timer, b.timer)
    assert.notEqual(a.overlays, b.overlays)
    assert.notEqual(a.playback, b.playback)
    a.timer.running = true
    a.overlays.join = true
    a.playback.playing = true
    assert.deepEqual(defaultLive(), b)
  })

  test('estado inicial: nada no ar, sem espera, reações visíveis, regressiva de 5 min parada', () => {
    const l = defaultLive()
    assert.deepEqual([l.program, l.preview, l.standby, l.takenAt], [null, null, false, 0])
    assert.deepEqual(l.overlays, { join: false, reactions: true })
    assert.deepEqual([l.timer.mode, l.timer.durationMs, l.timer.running, timerElapsed(l.timer, Date.now())], ['countdown', 300_000, false, 0])
    assert.equal(playbackPosition(l.playback, Date.now()), 0)
  })

  test('reações padrão existem no catálogo e não se repetem', () => {
    assert.ok(DEFAULT_SETTINGS.reactions.every((r) => REACTIONS.includes(r)))
    assert.equal(new Set(DEFAULT_SETTINGS.reactions).size, DEFAULT_SETTINGS.reactions.length)
    assert.equal(new Set(REACTIONS).size, REACTIONS.length)
  })
})
