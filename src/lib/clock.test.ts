// Offset do relógio do servidor no cliente: vale a amostra de menor atraso desde que a conexão abriu.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bestOffset } from './clock.ts'

describe('bestOffset', () => {
  test('amostra maior (mensagem mais rápida) vence; menor (atrasada pelo Wi-Fi) é ignorada', () => {
    let best = bestOffset(null, 480)
    best = bestOffset(best, 500)
    assert.equal(best, 500)
    best = bestOffset(best, 430)
    assert.equal(best, 500)
    // Relógio daqui adiantado (offset negativo) e offset zero valem como qualquer outro.
    assert.equal(bestOffset(bestOffset(null, -60), -25), -25)
    assert.equal(bestOffset(0, -5), 0)
  })

  test('conexão reaberta (null): a primeira amostra vale mesmo menor que a melhor da anterior', () => {
    let best = bestOffset(bestOffset(null, 500), 510)
    assert.equal(best, 510)
    best = bestOffset(null, 200) // relógio daqui corrigido entre as conexões
    assert.equal(best, 200)
    assert.equal(bestOffset(best, 190), 200)
    assert.equal(bestOffset(null, -40), -40) // null não é zero
  })
})
