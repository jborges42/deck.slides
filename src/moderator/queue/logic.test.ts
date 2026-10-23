// Regras da fila: abas, ordem congelada e o plano de desfazer. Rodar com `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Question } from '../../../shared/types.ts'
import { capture, merge, order, restorePlan, tabOf } from './logic.ts'

const q = (id: string, over: Partial<Question> = {}): Question => ({
  id,
  participantId: null,
  author: 'Ana',
  anonymous: false,
  text: id,
  original: id,
  status: 'approved',
  screen: null,
  flagged: false,
  likes: 0,
  createdAt: 0,
  ...over,
})

test('respondida na tela fica nas aprovadas; fora dela, no arquivo', () => {
  assert.equal(tabOf({ status: 'answered', screen: 0 }), 'approved')
  assert.equal(tabOf({ status: 'answered', screen: null }), 'archive')
  assert.equal(tabOf({ status: 'rejected', screen: null }), 'archive')
  assert.equal(tabOf({ status: 'pending', screen: null }), 'pending')
})

test('respondida sobre o conteúdo fica nas aprovadas; as outras abas não mudam', () => {
  const a = (status: Question['status'], screen: number | null = null) => ({ id: 'a', status, screen })
  assert.equal(tabOf(a('answered'), 'a'), 'approved')
  assert.equal(tabOf(a('answered'), 'b'), 'archive') // outra pergunta sobre o conteúdo
  assert.equal(tabOf(a('answered'), null), 'archive')
  assert.equal(tabOf(a('answered')), 'archive') // sem o segundo argumento, como antes
  assert.equal(tabOf({ status: 'answered', screen: null }, undefined), 'archive') // sem id não casa com "nenhuma"
  assert.equal(tabOf(a('rejected'), 'a'), 'archive')
  assert.equal(tabOf(a('pending'), 'a'), 'pending')
  assert.equal(tabOf(a('approved'), 'a'), 'approved')
  assert.equal(tabOf(a('answered', 0), 'b'), 'approved')
})

test('aprovadas por curtidas, empate pela mais antiga', () => {
  const qs = [q('a', { likes: 1, createdAt: 3 }), q('b', { likes: 5, createdAt: 2 }), q('c', { likes: 1, createdAt: 1 })]
  assert.deepEqual(order(qs, 'approved', 'likes', (x) => x.likes).map((x) => x.id), ['b', 'c', 'a'])
  assert.deepEqual(order(qs, 'pending', 'likes', (x) => x.likes).map((x) => x.id), ['c', 'b', 'a'])
})

test('ordem congelada: o que chega vai para o fim, o que sai some', () => {
  assert.deepEqual(merge(['a', 'b', 'c'], ['d', 'c', 'a']), ['a', 'c', 'd'])
  assert.deepEqual(merge(merge(['a', 'b'], ['b', 'x']), ['b', 'x']), ['b', 'x'])
})

test('desfazer destaque: volta o status e a tela na ordem original', () => {
  const before = capture([q('a', { screen: 0 }), q('b', { screen: 1 }), q('n', { status: 'pending' })], ['n'])
  // Depois de destacar "n" com resposta automática: a e b respondidas e fora da tela.
  const now = [q('a', { status: 'answered' }), q('b', { status: 'answered' }), q('n', { screen: 0 })]
  assert.deepEqual(restorePlan(before, now), [
    { path: '/n/screen', body: { on: false } },
    { path: '/bulk', body: { ids: ['a', 'b'], status: 'approved' } },
    { path: '/bulk', body: { ids: ['n'], status: 'pending' } },
    { path: '/a/screen', body: { on: true } },
    { path: '/b/screen', body: { on: true } },
  ])
})

test('desfazer rejeição no mural: reinsere mantendo a ordem', () => {
  const before = capture([q('a', { screen: 0 }), q('b', { screen: 1 })], ['a'])
  const now = [q('a', { status: 'rejected' }), q('b', { screen: 1 })]
  assert.deepEqual(restorePlan(before, now), [
    { path: '/bulk', body: { ids: ['a'], status: 'approved' } },
    { path: '/a/screen', body: { on: true } },
    { path: '/b/screen', body: { on: false } },
    { path: '/b/screen', body: { on: true } },
  ])
})

test('desfazer aprovação simples: um lote, sem mexer na tela', () => {
  const before = capture([q('a', { status: 'pending' }), q('x', { screen: 0 })], ['a'])
  assert.deepEqual(restorePlan(before, [q('a'), q('x', { screen: 0 })]), [{ path: '/bulk', body: { ids: ['a'], status: 'pending' } }])
})
