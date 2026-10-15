// Formatação exibida na interface (pt-BR): relógio, tempo relativo, tamanho de arquivo e plural.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, bytes, clock, plural } from './format.ts'

describe('clock', () => {
  test('abaixo de uma hora: minutos e segundos com dois dígitos', () => {
    assert.equal(clock(0), '00:00')
    assert.equal(clock(9_000), '00:09')
    assert.equal(clock(83_000), '01:23')
    assert.equal(clock(3_599_999), '59:59')
  })

  test('a partir de uma hora: horas sem zero à esquerda', () => {
    assert.equal(clock(3_600_000), '1:00:00')
    assert.equal(clock(3_723_000), '1:02:03')
    assert.equal(clock(36_000_000), '10:00:00')
  })

  test('arredonda para baixo por padrão e para cima na contagem regressiva', () => {
    assert.equal(clock(59_999), '00:59')
    assert.equal(clock(59_001, true), '01:00')
    assert.equal(clock(60_000, true), '01:00')
    assert.equal(clock(1, true), '00:01') // no último milissegundo ainda falta 1 s
  })

  test('tempo negativo (contagem estourada) mostra zero', () => {
    assert.equal(clock(-1), '00:00')
    assert.equal(clock(-5_000, true), '00:00')
    assert.equal(clock(-400, true), '00:00')
  })
})

describe('ago', () => {
  const now = new Date(2026, 9, 10, 15, 0, 0).getTime() // horário local: o resultado não depende do fuso

  test('menos de 45 s, ou no futuro (relógio adiantado): "agora"', () => {
    assert.equal(ago(now, now), 'agora')
    assert.equal(ago(now - 44_000, now), 'agora')
    assert.equal(ago(now + 120_000, now), 'agora')
  })

  test('minutos', () => {
    assert.match(ago(now - 45_000, now), /^há 1 min\.?$/)
    assert.match(ago(now - 30 * 60_000, now), /^há 30 min\.?$/)
  })

  test('horas', () => {
    assert.match(ago(now - 3_600_000, now), /^há 1 h\.?$/)
    assert.match(ago(now - 23 * 3_600_000, now), /^há 23 h\.?$/)
  })

  test('um dia ou mais: data curta', () => {
    assert.equal(ago(new Date(2026, 2, 5, 12, 0).getTime(), now), '05 de mar.')
  })

  test('na troca de unidade, usa a unidade do valor arredondado', () => {
    assert.match(ago(now - 3_580_000, now), /^há 1 h\.?$/) // 59 min 40 s
    assert.equal(ago(now - (23 * 60 + 40) * 60_000, now), new Date(now - (23 * 60 + 40) * 60_000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }))
  })
})

describe('bytes', () => {
  const _ = ' ' // espaço inseparável: número e unidade nunca quebram de linha

  test('abaixo de 1 KB: bytes inteiros', () => {
    assert.equal(bytes(0), `0${_}B`)
    assert.equal(bytes(1023), `1023${_}B`)
  })

  test('KB sem casas decimais', () => {
    assert.equal(bytes(1024), `1${_}KB`)
    assert.equal(bytes(1536), `2${_}KB`)
    assert.equal(bytes(500 * 1024), `500${_}KB`)
  })

  test('MB com uma casa e vírgula decimal', () => {
    assert.equal(bytes(1024 ** 2), `1,0${_}MB`)
    assert.equal(bytes(1.5 * 1024 ** 2), `1,5${_}MB`)
    assert.equal(bytes(734 * 1024 ** 2), `734,0${_}MB`)
  })

  test('GB com duas casas e vírgula decimal', () => {
    assert.equal(bytes(1024 ** 3), `1,00${_}GB`)
    assert.equal(bytes(2.25 * 1024 ** 3), `2,25${_}GB`)
  })

  test('na troca de unidade, usa a unidade do valor arredondado', () => {
    assert.equal(bytes(1024 ** 2 - 100), `1,0${_}MB`)
    assert.equal(bytes(1024 ** 3 - 10_000), `1,00${_}GB`)
  })
})

describe('plural', () => {
  test('1 usa o singular', () => {
    assert.equal(plural(1, 'pergunta', 'perguntas'), '1 pergunta')
  })

  test('0 usa o plural, como se diz em português', () => {
    assert.equal(plural(0, 'pergunta', 'perguntas'), '0 perguntas')
  })

  test('muitos usam o plural com separador de milhar pt-BR', () => {
    assert.equal(plural(2, 'tela', 'telas'), '2 telas')
    assert.equal(plural(1234, 'participante', 'participantes'), '1.234 participantes')
    assert.equal(plural(1_000_000, 'reação', 'reações'), '1.000.000 reações')
  })
})
