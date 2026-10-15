// Curtidas e reações: disponibilidade, idempotência, contagens (`counts`), limites e zerar.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { asModerator, createEvent, joinParticipant, live, wait } from './helpers.ts'
import type { Counts, EventSettings, ModeratorSnapshot, ParticipantSnapshot, Question, Scene } from '../../shared/types.ts'

const { resetLimit } = await import('../auth.ts') // mesmo módulo da aplicação: simula o fim da janela do limite

const mod = await asModerator()

type Person = Awaited<ReturnType<typeof joinParticipant>>

const modSnap = (eventId: string) => mod.snapshot<ModeratorSnapshot>(`/api/events/${eventId}/stream`)
const settings = (eventId: string, s: Partial<EventSettings>) => mod.req('PATCH', `/api/events/${eventId}`, { settings: s })
const question = async (eventId: string, qid: string) => (await modSnap(eventId)).questions.find((q) => q.id === qid)!
const sceneOf = (snap: ModeratorSnapshot, type: Scene['type']) => snap.scenes.find((s) => s.type === type)!.id
const like = (person: Person, eventId: string, qid: string, on: unknown = true) =>
  person.phone.req('POST', `/api/p/${eventId}/questions/${qid}/like`, { on })
const react = (person: Person, eventId: string, kinds: unknown) => person.phone.req('POST', `/api/p/${eventId}/reactions`, { kinds })

/** Evento novo com participantes já dentro (um aparelho por nome). */
async function setup(names: string[] = ['Ana Souza'], s?: Partial<EventSettings>) {
  const snap = await createEvent(mod)
  const id = snap.event.id
  if (s) assert.equal((await settings(id, s)).status, 200)
  const people: Person[] = []
  for (const name of names) people.push(await joinParticipant(mod, id, name))
  return { id, snap, people }
}

/** Põe a cena no ar (prévia + corte). */
async function take(eventId: string, sceneId: string) {
  await live(mod, eventId, { op: 'preview', sceneId })
  assert.equal((await live(mod, eventId, { op: 'take' })).status, 200)
}

/** Pergunta da moderação, que já entra aprovada. */
async function approved(eventId: string, text: string): Promise<Question> {
  assert.equal((await mod.req('POST', `/api/events/${eventId}/questions`, { text, author: 'Convidado' })).status, 201)
  return (await modSnap(eventId)).questions.find((q) => q.text === text)!
}

/** Totais que um cliente recebe ao conectar agora. */
async function countsNow(eventId: string): Promise<Counts> {
  const s = await mod.stream(`/api/events/${eventId}/stream`)
  try {
    await s.next('state')
    return await s.next<Counts>('counts')
  } finally {
    s.close()
  }
}

/** 400 com mensagem em português, sem detalhes internos. */
function assertBadRequest(r: { status: number; data: any }, label = '') {
  assert.equal(r.status, 400, `${label} -> ${r.status} ${JSON.stringify(r.data)}`)
  assert.equal(typeof r.data?.error, 'string', label)
  assert.doesNotMatch(r.data.error, /^(Invalid|Too (small|big)|Expected|Required)|zod|sqlite|stack|\n\s+at /i, label)
}

describe('curtidas', () => {
  test('só aceita curtida em pergunta aprovada ou respondida do próprio evento', async () => {
    const { id, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    assert.equal((await bia!.phone.req('POST', `/api/p/${id}/questions`, { text: 'Pergunta ainda pendente' })).status, 201)
    const pending = (await modSnap(id)).questions.find((q) => q.text === 'Pergunta ainda pendente')!
    const rejected = await approved(id, 'Pergunta rejeitada')
    await mod.req('PATCH', `/api/events/${id}/questions/${rejected.id}`, { status: 'rejected' })
    const ok = await approved(id, 'Pergunta aprovada')
    const answered = await approved(id, 'Pergunta respondida')
    await mod.req('PATCH', `/api/events/${id}/questions/${answered.id}`, { status: 'answered' })
    const other = await setup([])
    const foreign = await approved(other.id, 'Pergunta de outro evento')

    for (const qid of [pending.id, rejected.id, foreign.id, 'inexistente']) {
      const r = await like(ana!, id, qid)
      assert.equal(r.status, 404, qid)
      assert.deepEqual(r.data, { error: 'Pergunta indisponível.' })
    }
    assert.equal((await like(ana!, id, ok.id)).status, 200)
    assert.equal((await like(ana!, id, answered.id)).status, 200)
    const likes = Object.fromEntries((await modSnap(id)).questions.map((q) => [q.text, q.likes]))
    assert.deepEqual(likes, { 'Pergunta ainda pendente': 0, 'Pergunta rejeitada': 0, 'Pergunta aprovada': 1, 'Pergunta respondida': 1 })
    assert.equal((await question(other.id, foreign.id)).likes, 0)
  })

  test('curtir e descurtir são idempotentes e a mensagem counts acompanha', async () => {
    const { id, snap, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    await take(id, sceneOf(snap, 'questions'))
    const q = await approved(id, 'Pergunta para curtir')
    await mod.req('POST', `/api/events/${id}/questions/${q.id}/screen`, { on: true })
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next('state')
      await screen.next('counts')
      assert.deepEqual((await like(ana!, id, q.id)).data, { ok: true })
      assert.equal((await like(ana!, id, q.id)).status, 200) // de novo: continua uma curtida
      await screen.next<Counts>('counts', { where: (c) => c.likes[q.id] === 1 })
      assert.equal((await question(id, q.id)).likes, 1)

      await like(bia!, id, q.id)
      await screen.next<Counts>('counts', { where: (c) => c.likes[q.id] === 2 })
      await like(ana!, id, q.id, false)
      await like(ana!, id, q.id, false)
      await screen.next<Counts>('counts', { where: (c) => c.likes[q.id] === 1 })
    } finally {
      screen.close()
    }
    assert.equal((await question(id, q.id)).likes, 1)
    const anaView = await ana!.phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)
    const biaView = await bia!.phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)
    assert.deepEqual(anaView.now?.questions.map((x) => [x.id, x.likes, x.liked]), [[q.id, 1, false]])
    assert.deepEqual(biaView.now?.questions.map((x) => [x.id, x.likes, x.liked]), [[q.id, 1, true]])
  })

  test('valida o corpo da curtida', async () => {
    const { id, people: [ana] } = await setup()
    const q = await approved(id, 'Pergunta aprovada')
    for (const body of [{}, null, { on: 'sim' }, { on: 1 }])
      assertBadRequest(await ana!.phone.req('POST', `/api/p/${id}/questions/${q.id}/like`, body), JSON.stringify(body))
    assert.equal((await question(id, q.id)).likes, 0)
  })

  test('curtidas acima de 60 por minuto são ignoradas sem erro, só para quem passou do limite', async () => {
    const { id, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    const q = await approved(id, 'Pergunta muito curtida')
    for (let i = 0; i < 60; i++) assert.equal((await like(ana!, id, q.id, i % 2 === 0)).status, 200) // termina descurtida
    const extra = await like(ana!, id, q.id, true)
    assert.deepEqual([extra.status, extra.data], [200, { ok: true }])
    assert.equal((await question(id, q.id)).likes, 0)
    assert.equal((await like(bia!, id, q.id)).status, 200)
    assert.equal((await question(id, q.id)).likes, 1)
  })

  test('remover participante desconta as curtidas dele e avisa as telas', async () => {
    const { id, snap, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    await take(id, sceneOf(snap, 'questions'))
    const q = await approved(id, 'Pergunta curtida por quem vai sair')
    await mod.req('POST', `/api/events/${id}/questions/${q.id}/screen`, { on: true })
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next('state')
      await screen.next('counts')
      await like(ana!, id, q.id)
      await like(bia!, id, q.id)
      // Espera o envio agrupado das curtidas: o próximo `counts` só pode vir da remoção.
      await screen.next<Counts>('counts', { where: (c) => c.likes[q.id] === 2 })
      assert.equal((await mod.req('DELETE', `/api/events/${id}/participants/${ana!.participant.id}`)).status, 200)
      await screen.next<Counts>('counts', { where: (c) => c.likes[q.id] === 1, timeout: 1000 })
    } finally {
      screen.close()
    }
  })
})

describe('reações', () => {
  test('lote soma as reações na cena que está no ar, não na prévia', async () => {
    const { id, snap, people: [ana] } = await setup()
    const title = sceneOf(snap, 'title')
    const questions = sceneOf(snap, 'questions')
    await take(id, title)
    const ms = await mod.stream(`/api/events/${id}/stream`)
    try {
      await ms.next('state')
      await ms.next('counts')
      assert.deepEqual((await react(ana!, id, { applause: 3, love: 2 })).data, { ok: true })
      await ms.next<Counts>('counts', { where: (c) => c.reactions[title]?.applause === 3 })
      await react(ana!, id, { applause: 1 })
      await ms.next<Counts>('counts', { where: (c) => c.reactions[title]?.applause === 4 })

      await wait(450) // cortes com menos de 400 ms de intervalo são ignorados
      await take(id, questions) // a abertura vai para a prévia
      resetLimit(`r:${ana!.participant.id}`)
      await react(ana!, id, { insight: 2 })
      const c = await ms.next<Counts>('counts', { where: (c) => c.reactions[questions]?.insight === 2 })
      assert.deepEqual(c.reactions, { [title]: { applause: 4, love: 2 }, [questions]: { insight: 2 } })
    } finally {
      ms.close()
    }
  })

  test('tipos não habilitados nas configurações são ignorados', async () => {
    const { id, snap, people: [ana] } = await setup()
    const title = sceneOf(snap, 'title')
    await take(id, title)
    assert.equal((await react(ana!, id, { applause: 1, laugh: 5, like: 2 })).status, 200)
    assert.deepEqual((await countsNow(id)).reactions, { [title]: { applause: 1 } })
    await settings(id, { reactions: ['laugh'] })
    assert.equal((await react(ana!, id, { laugh: 2, applause: 4 })).status, 200)
    assert.deepEqual((await countsNow(id)).reactions, { [title]: { applause: 1, laugh: 2 } })
  })

  test('valida a quantidade (1 a 5 por tipo) e o tipo de reação', async () => {
    const { id, snap, people: [ana] } = await setup()
    await take(id, sceneOf(snap, 'title'))
    const bodies = [{ kinds: { applause: 6 } }, { kinds: { applause: 0 } }, { kinds: { applause: 1.5 } }, { kinds: { applause: '2' } }, { kinds: { vaia: 1 } }, { kinds: [] }, {}, null]
    for (const body of bodies) {
      resetLimit(`r:${ana!.participant.id}`) // lote inválido também conta no limite de 3 a cada 2 s
      assertBadRequest(await ana!.phone.req('POST', `/api/p/${id}/reactions`, body), JSON.stringify(body))
    }
    assert.deepEqual((await countsNow(id)).reactions, {})
  })

  test('chave "__proto__" no lote é descartada: não conta reação nem contamina objetos', async () => {
    const { id, snap, people: [ana] } = await setup()
    await take(id, sceneOf(snap, 'title'))
    const body = '{"kinds":{"__proto__":{"applause":5,"polluted":true}}}'
    const r = await ana!.phone.raw('POST', `/api/p/${id}/reactions`, { body, headers: { 'content-type': 'application/json' } })
    assert.equal(r.status, 200)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    assert.deepEqual((await countsNow(id)).reactions, {})
  })

  test('sem cena no ar ou com a tela de espera, reações são ignoradas sem erro', async () => {
    const { id, snap, people: [ana] } = await setup()
    const title = sceneOf(snap, 'title')
    assert.deepEqual((await react(ana!, id, { applause: 2 })).data, { ok: true })
    assert.deepEqual((await countsNow(id)).reactions, {})

    await take(id, title)
    await live(mod, id, { op: 'standby', on: true })
    assert.deepEqual((await react(ana!, id, { applause: 2 })).data, { ok: true })
    assert.deepEqual((await countsNow(id)).reactions, {})

    await live(mod, id, { op: 'standby', on: false })
    assert.equal((await react(ana!, id, { applause: 2 })).status, 200)
    assert.deepEqual((await countsNow(id)).reactions, { [title]: { applause: 2 } })
  })

  test('mais de 3 lotes em 2 s: os excedentes são ignorados sem erro, só para quem passou do limite', async () => {
    const { id, snap, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    const title = sceneOf(snap, 'title')
    await take(id, title)
    for (let i = 0; i < 5; i++) assert.deepEqual((await react(ana!, id, { applause: 1 })).data, { ok: true })
    assert.deepEqual((await countsNow(id)).reactions, { [title]: { applause: 3 } })
    assert.equal((await react(bia!, id, { applause: 1 })).status, 200)
    assert.deepEqual((await countsNow(id)).reactions, { [title]: { applause: 4 } })
  })

  test('reações e curtidas pausadas respondem 403 até reabrir', async () => {
    const { id, snap, people: [ana] } = await setup()
    const title = sceneOf(snap, 'title')
    await take(id, title)
    const q = await approved(id, 'Pergunta aprovada')
    await settings(id, { reactionsOpen: false })
    const paused = { error: 'Reações pausadas pela moderação.' }
    const l = await like(ana!, id, q.id)
    assert.deepEqual([l.status, l.data], [403, paused])
    const r = await react(ana!, id, { applause: 1 })
    assert.deepEqual([r.status, r.data], [403, paused])
    assert.deepEqual(await countsNow(id), { reactions: {}, likes: {} })

    await settings(id, { reactionsOpen: true })
    assert.equal((await like(ana!, id, q.id)).status, 200)
    assert.equal((await react(ana!, id, { applause: 1 })).status, 200)
    assert.deepEqual(await countsNow(id), { reactions: { [title]: { applause: 1 } }, likes: { [q.id]: 1 } })
  })

  test('zerar reações limpa as contagens, mantém as curtidas e avisa quem está conectado', async () => {
    const { id, snap, people: [ana] } = await setup()
    const title = sceneOf(snap, 'title')
    await take(id, title)
    const q = await approved(id, 'Pergunta curtida antes de zerar')
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next('state')
      await screen.next('counts')
      await react(ana!, id, { applause: 3 })
      await like(ana!, id, q.id)
      // Espera o envio agrupado: o próximo `counts` só pode vir do reset.
      await screen.next<Counts>('counts', { where: (c) => c.reactions[title]?.applause === 3 && c.likes[q.id] === 1 })
      const r = await mod.req('POST', `/api/events/${id}/reactions/reset`)
      assert.deepEqual([r.status, r.data], [200, { ok: true }])
      const after = await screen.next<Counts>('counts', { where: (c) => !c.reactions[title], timeout: 1000 })
      assert.deepEqual(after, { reactions: {}, likes: { [q.id]: 1 } })
    } finally {
      screen.close()
    }
    assert.deepEqual(await countsNow(id), { reactions: {}, likes: { [q.id]: 1 } })
    assert.equal((await ana!.phone.req('POST', `/api/events/${id}/reactions/reset`)).status, 401) // só a moderação zera
  })
})
