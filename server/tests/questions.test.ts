// Perguntas: envio pelo participante, limites, identidade, termos sensíveis e moderação (status, tela, lote, manual).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { asModerator, createEvent, joinParticipant, live, type Client } from './helpers.ts'
import type { EventSettings, ModeratorSnapshot, ParticipantSnapshot, Question, Scene, ScreenSnapshot } from '../../shared/types.ts'

const { resetLimit } = await import('../auth.ts') // mesmo módulo da aplicação: simula o fim do intervalo de 15 s

const mod = await asModerator()

type Person = Awaited<ReturnType<typeof joinParticipant>>
type QuestionsScene = Extract<Scene, { type: 'questions' }>

const modSnap = (eventId: string) => mod.snapshot<ModeratorSnapshot>(`/api/events/${eventId}/stream`)
const settings = (eventId: string, s: Partial<EventSettings>) => mod.req('PATCH', `/api/events/${eventId}`, { settings: s })
const ask = (phone: Client, eventId: string, text: unknown, extra: object = {}) =>
  phone.req('POST', `/api/p/${eventId}/questions`, { text, ...extra })
const patchQ = (eventId: string, qid: string, body: unknown) => mod.req('PATCH', `/api/events/${eventId}/questions/${qid}`, body)
const screenOn = (eventId: string, qid: string, body: unknown = { on: true }) =>
  mod.req('POST', `/api/events/${eventId}/questions/${qid}/screen`, body)
const question = async (eventId: string, qid: string) => (await modSnap(eventId)).questions.find((q) => q.id === qid)!
const pick = (q: Question) => [q.status, q.screen]

/** Evento novo com participantes já dentro (um aparelho por nome). */
async function setup(names: string[] = ['Ana Souza'], s?: Partial<EventSettings>) {
  const snap = await createEvent(mod)
  const id = snap.event.id
  if (s) assert.equal((await settings(id, s)).status, 200)
  const people: Person[] = []
  for (const name of names) people.push(await joinParticipant(mod, id, name))
  return { id, snap, people }
}

/** Pergunta enviada pelo participante, como a moderação a vê. Libera o próximo envio sem esperar 15 s. */
async function send(person: Person, eventId: string, text: string, extra: object = {}): Promise<Question> {
  const r = await ask(person.phone, eventId, text, extra)
  assert.equal(r.status, 201, JSON.stringify(r.data))
  resetLimit(`q:${person.participant.id}`)
  const expected = text.trim().replace(/\s+/g, ' ')
  return (await modSnap(eventId)).questions.find((q) => q.participantId === person.participant.id && q.original === expected)!
}

/** Coloca a cena de perguntas no ar, mostrando até `max` perguntas. */
async function questionsOnAir(eventId: string, snap: ModeratorSnapshot, max = 12) {
  const scene = snap.scenes.find((s): s is QuestionsScene => s.type === 'questions')!
  assert.equal((await mod.req('PATCH', `/api/events/${eventId}/scenes/${scene.id}`, { content: { ...scene.content, max } })).status, 200)
  await live(mod, eventId, { op: 'preview', sceneId: scene.id })
  assert.equal((await live(mod, eventId, { op: 'take' })).status, 200)
}

/** 400 com mensagem em português, sem detalhes internos. */
function assertBadRequest(r: { status: number; data: any }, label = '') {
  assert.equal(r.status, 400, `${label} -> ${r.status} ${JSON.stringify(r.data)}`)
  assert.equal(typeof r.data?.error, 'string', label)
  assert.doesNotMatch(r.data.error, /^(Invalid|Too (small|big)|Expected|Required)|zod|sqlite|stack|\n\s+at /i, label)
}

describe('envio pelo participante', () => {
  test('pergunta chega pendente, com espaços colapsados e o nome do participante como autor', async () => {
    const { id, people: [ana] } = await setup()
    const ms = await mod.stream(`/api/events/${id}/stream`)
    const ps = await ana!.phone.stream(`/api/p/${id}/stream`)
    try {
      await ms.next('state')
      await ps.next('state')
      const r = await ask(ana!.phone, id, '  Qual   a diferença\n\tentre SSE e WebSocket?  ')
      assert.equal(r.status, 201)
      assert.deepEqual(r.data, { ok: true })

      const snap = await ms.next<ModeratorSnapshot>('state', { where: (s) => s.questions.length === 1 })
      const q = snap.questions[0]!
      const text = 'Qual a diferença entre SSE e WebSocket?'
      assert.deepEqual(
        [q.text, q.original, q.status, q.author, q.participantId, q.anonymous, q.flagged, q.screen, q.likes],
        [text, text, 'pending', 'Ana Souza', ana!.participant.id, false, false, null, 0],
      )
      const mine = await ps.next<ParticipantSnapshot>('state', { where: (s) => s.mine.length === 1 })
      assert.deepEqual({ ...mine.mine[0]!, createdAt: 0 }, { id: q.id, text, status: 'pending', onScreen: false, edited: false, createdAt: 0 })
    } finally {
      ms.close()
      ps.close()
    }
  })

  test('valida o tamanho mínimo e o limite de caracteres das configurações', async () => {
    const { id, people: [ana] } = await setup()
    const phone = ana!.phone
    const short = await ask(phone, id, '   ab   ')
    assert.equal(short.status, 400)
    assert.deepEqual(short.data, { error: 'Escreva a pergunta.' })
    const long = await ask(phone, id, 'a'.repeat(201))
    assert.equal(long.status, 400)
    assert.deepEqual(long.data, { error: 'Limite de 200 caracteres.' })

    await settings(id, { maxLength: 100 })
    const over = await ask(phone, id, 'b'.repeat(101))
    assert.equal(over.status, 400)
    assert.deepEqual(over.data, { error: 'Limite de 100 caracteres.' })
    for (const body of [{}, null, { text: 42 }, { text: 'Pergunta válida', anonymous: 'sim' }])
      assertBadRequest(await phone.req('POST', `/api/p/${id}/questions`, body), JSON.stringify(body))

    // Envios recusados não contam no intervalo de 15 s: o primeiro válido passa.
    assert.equal((await ask(phone, id, 'Pergunta no limite exato '.padEnd(100, '.'))).status, 201)
    assert.equal((await modSnap(id)).questions.length, 1)
    assert.equal((await phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)).event.settings.maxLength, 100)
  })

  test('com perguntas fechadas responde 403 e reabrir volta a aceitar', async () => {
    const { id, people: [ana] } = await setup(['Ana Souza'], { questionsOpen: false })
    const closed = await ask(ana!.phone, id, 'Pergunta com envio fechado')
    assert.equal(closed.status, 403)
    assert.deepEqual(closed.data, { error: 'O envio de perguntas está fechado.' })
    assert.equal((await modSnap(id)).questions.length, 0)
    await settings(id, { questionsOpen: true })
    assert.equal((await ask(ana!.phone, id, 'Pergunta com envio fechado')).status, 201)
  })

  test('segunda pergunta em menos de 15 s responde 429 sem afetar outra pessoa', async () => {
    const { id, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    assert.equal((await ask(ana!.phone, id, 'Primeira pergunta da Ana')).status, 201)
    const again = await ask(ana!.phone, id, 'Segunda pergunta da Ana')
    assert.equal(again.status, 429)
    assert.deepEqual(again.data, { error: 'Aguarde 15 segundos para enviar outra pergunta.' })
    assert.equal((await ask(bia!.phone, id, 'Primeira pergunta da Bia')).status, 201)

    resetLimit(`q:${ana!.participant.id}`) // passados os 15 s
    assert.equal((await ask(ana!.phone, id, 'Segunda pergunta da Ana')).status, 201)
    assert.equal((await modSnap(id)).questions.length, 3)
  })

  test('texto repetido com outra caixa, acentos ou espaços responde 409, mesmo depois de rejeitado', async () => {
    const { id, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    const q = await send(ana!, id, 'Qual é a programação de amanhã?')
    for (const text of ['QUAL E A PROGRAMACAO DE AMANHA?', '  qual   é a  programação de amanhã?  ', 'Qual é a programaçããão de amanhã?']) {
      const r = await ask(ana!.phone, id, text)
      assert.equal(r.status, 409, text)
      assert.deepEqual(r.data, { error: 'Você já enviou esta pergunta.' })
    }
    await patchQ(id, q.id, { status: 'rejected' })
    assert.equal((await ask(ana!.phone, id, 'qual e a programacao de amanha?')).status, 409)
    assert.equal((await ask(bia!.phone, id, 'Qual é a programação de amanhã?')).status, 201) // outra pessoa pode
  })

  test('com 5 perguntas aguardando aprovação, a sexta responde 429 até a moderação analisar', async () => {
    const { id, people: [ana] } = await setup()
    const sent: Question[] = []
    for (let i = 1; i <= 5; i++) sent.push(await send(ana!, id, `Pergunta número ${i} da Ana`))
    const sixth = await ask(ana!.phone, id, 'Pergunta número 6 da Ana')
    assert.equal(sixth.status, 429)
    assert.deepEqual(sixth.data, { error: 'Você tem 5 perguntas aguardando aprovação. Aguarde a moderação analisar.' })

    await patchQ(id, sent[0]!.id, { status: 'approved' })
    assert.equal((await ask(ana!.phone, id, 'Pergunta número 6 da Ana')).status, 201)
  })

  test('identidade: "name" força o nome, "anonymous" força anônimo e "choice" respeita a escolha', async () => {
    const { id, snap, people: [ana, bia, caio] } = await setup(['Ana Souza', 'Bia Lima', 'Caio Prado'])
    const named = await send(ana!, id, 'Pergunta com identidade obrigatória', { anonymous: true })
    assert.equal(named.anonymous, false)

    await settings(id, { identity: 'anonymous' })
    const hidden = await send(bia!, id, 'Pergunta sempre anônima', { anonymous: false })
    assert.equal(hidden.anonymous, true)
    assert.equal(hidden.author, 'Bia Lima') // a moderação ainda sabe quem perguntou

    await settings(id, { identity: 'choice' })
    assert.equal((await send(caio!, id, 'Caio prefere anonimato', { anonymous: true })).anonymous, true)
    assert.equal((await send(caio!, id, 'Caio prefere se identificar', { anonymous: false })).anonymous, false)
    assert.equal((await send(caio!, id, 'Caio não escolheu nada')).anonymous, false)

    // Tela e celulares só mostram o autor de quem não é anônimo.
    await questionsOnAir(id, snap)
    await screenOn(id, hidden.id)
    await screenOn(id, named.id)
    const screen = await mod.snapshot<ScreenSnapshot>(`/api/screen/stream?event=${id}`)
    assert.deepEqual(screen.questions.map((q) => q.author), [null, 'Ana S.'])
    const phone = await caio!.phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)
    assert.deepEqual(phone.now?.questions.map((q) => q.author), [null, 'Ana S.'])
  })

  test('termos sensíveis marcam a pergunta por palavra inteira, sem acento e sem pegar pedaços; editar recalcula', async () => {
    const names = ['Ana Souza', 'Bia Lima', 'Caio Prado', 'Davi Reis', 'Eva Melo']
    const { id, people } = await setup(names, { flagWords: ['Política', 'golpe de estado', 'anti-vacina'] })
    const [ana, bia, caio, davi, eva] = people
    const accent = await send(ana!, id, 'O que acha da POLITICA atual?')
    const substring = await send(bia!, id, 'Ele é apolítico ou politicamente neutro?')
    const phrase = await send(caio!, id, 'Houve um golpe de estado em 1964?')
    const hyphen = await send(davi!, id, 'O movimento anti-vacina cresceu?')
    const clean = await send(eva!, id, 'Qual o horário do intervalo?')
    assert.deepEqual(
      [accent, substring, phrase, hyphen, clean].map((q) => q.flagged),
      [true, false, true, true, false],
    )
    assert.equal(accent.status, 'pending') // marca, nunca rejeita sozinho

    await patchQ(id, accent.id, { text: 'O que acha da economia atual?' })
    await patchQ(id, clean.id, { text: 'Qual o horário do intervalo e da política?' })
    assert.equal((await question(id, accent.id)).flagged, false)
    assert.equal((await question(id, clean.id)).flagged, true)
  })
})

describe('moderação de perguntas', () => {
  test('edição guarda o original e aparece como editada para o autor', async () => {
    const { id, people: [ana] } = await setup()
    const q = await send(ana!, id, 'Qual a difrença entre SSE e WebSocket?')
    const ps = await ana!.phone.stream(`/api/p/${id}/stream`)
    try {
      await ps.next('state')
      assert.equal((await patchQ(id, q.id, { text: '  Qual a   diferença entre SSE e WebSocket?  ' })).status, 200)
      const edited = await question(id, q.id)
      assert.deepEqual(
        [edited.text, edited.original, edited.status],
        ['Qual a diferença entre SSE e WebSocket?', 'Qual a difrença entre SSE e WebSocket?', 'pending'],
      )
      const mine = await ps.next<ParticipantSnapshot>('state', { where: (s) => s.mine[0]?.edited === true })
      assert.equal(mine.mine[0]!.text, 'Qual a diferença entre SSE e WebSocket?')

      await patchQ(id, q.id, { text: q.original }) // voltar ao texto original deixa de contar como edição
      await ps.next<ParticipantSnapshot>('state', { where: (s) => s.mine[0]?.edited === false })
    } finally {
      ps.close()
    }
    for (const body of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(1001) }, { status: 'arquivada' }, { anonymous: 'sim' }, null])
      assertBadRequest(await patchQ(id, q.id, body), JSON.stringify(body))
    const missing = await patchQ(id, 'inexistente', { status: 'approved' })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.data, { error: 'Pergunta não encontrada.' })
  })

  test('só aprovada ou respondida fica na tela: rejeitar ou voltar a pendente tira da tela', async () => {
    const { id, snap, people: [ana] } = await setup()
    await questionsOnAir(id, snap)
    const q = await send(ana!, id, 'Pergunta que entra e sai da tela')
    const shown = (s: ScreenSnapshot) => s.questions.some((x) => x.id === q.id)
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next('state')
      await patchQ(id, q.id, { status: 'approved' })
      await screenOn(id, q.id)
      await screen.next<ScreenSnapshot>('state', { where: shown })

      await patchQ(id, q.id, { status: 'answered' })
      assert.deepEqual(pick(await question(id, q.id)), ['answered', 0])

      await patchQ(id, q.id, { status: 'rejected' })
      await screen.next<ScreenSnapshot>('state', { where: (s) => !shown(s) })
      assert.deepEqual(pick(await question(id, q.id)), ['rejected', null])
      await patchQ(id, q.id, { status: 'approved' })
      assert.deepEqual(pick(await question(id, q.id)), ['approved', null]) // reaprovar não devolve à tela

      await screenOn(id, q.id)
      await screen.next<ScreenSnapshot>('state', { where: shown })
      await patchQ(id, q.id, { status: 'pending' })
      await screen.next<ScreenSnapshot>('state', { where: (s) => !shown(s) })
      assert.deepEqual(pick(await question(id, q.id)), ['pending', null])
    } finally {
      screen.close()
    }
  })

  test('colocar na tela aprova a pergunta pendente; tirar da tela mantém o status', async () => {
    const { id, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    const q = await send(ana!, id, 'Pergunta pendente direto para a tela')
    assert.equal((await screenOn(id, q.id)).status, 200)
    assert.deepEqual(pick(await question(id, q.id)), ['approved', 0])
    const mine = (await ana!.phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)).mine[0]!
    assert.deepEqual([mine.status, mine.onScreen], ['approved', true])

    assert.equal((await screenOn(id, q.id, { on: false })).status, 200)
    assert.deepEqual(pick(await question(id, q.id)), ['approved', null])

    const rejected = await send(bia!, id, 'Pergunta rejeitada e depois escolhida')
    await patchQ(id, rejected.id, { status: 'rejected' })
    await screenOn(id, rejected.id)
    assert.deepEqual(pick(await question(id, rejected.id)), ['approved', 0])

    for (const body of [{}, { on: 'sim' }, { on: true, solo: 'sim' }]) assertBadRequest(await screenOn(id, q.id, body), JSON.stringify(body))
    const missing = await screenOn(id, 'inexistente')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.data, { error: 'Pergunta não encontrada.' })
  })

  /** Duas perguntas na tela, uma terceira destacada sozinha e uma quarta pendente fora da tela. */
  async function soloScenario(autoAnswer: boolean) {
    const { id, people } = await setup(['Ana Souza', 'Bia Lima', 'Caio Prado', 'Davi Reis'], { autoAnswer })
    const qs: Question[] = []
    for (const [i, text] of ['Primeira pergunta na tela', 'Segunda pergunta na tela', 'Pergunta destacada sozinha', 'Pergunta que segue pendente'].entries())
      qs.push(await send(people[i]!, id, text))
    await screenOn(id, qs[0]!.id)
    await screenOn(id, qs[1]!.id)
    assert.equal((await screenOn(id, qs[2]!.id, { on: true, solo: true })).status, 200)
    const after = (await modSnap(id)).questions
    return { id, qs, state: qs.map((q) => pick(after.find((x) => x.id === q.id)!)) }
  }

  test('"solo" limpa a tela e, com autoAnswer, marca como respondidas as que estavam nela', async () => {
    const { id, qs, state } = await soloScenario(true)
    assert.deepEqual(state, [['answered', null], ['answered', null], ['approved', 0], ['pending', null]])
    await screenOn(id, qs[0]!.id) // respondida volta à tela sem deixar de ser respondida
    assert.deepEqual(pick(await question(id, qs[0]!.id)), ['answered', 1])
  })

  test('"solo" sem autoAnswer limpa a tela e mantém as anteriores aprovadas', async () => {
    const { state } = await soloScenario(false)
    assert.deepEqual(state, [['approved', null], ['approved', null], ['approved', 0], ['pending', null]])
  })

  test('altera status em lote só nas perguntas do próprio evento e valida o corpo', async () => {
    const a = await setup(['Ana Souza', 'Bia Lima', 'Caio Prado'])
    const [qa, qb, qc] = [
      await send(a.people[0]!, a.id, 'Pergunta A em lote'),
      await send(a.people[1]!, a.id, 'Pergunta B em lote'),
      await send(a.people[2]!, a.id, 'Pergunta C fora do lote'),
    ]
    const b = await setup(['Davi Reis'])
    const other = await send(b.people[0]!, b.id, 'Pergunta de outro evento')
    const bulk = (body: unknown) => mod.req('POST', `/api/events/${a.id}/questions/bulk`, body)

    assert.equal((await bulk({ ids: [qa!.id, qb!.id, other.id], status: 'approved' })).status, 200)
    const now = async () => (await modSnap(a.id)).questions.map(pick)
    assert.deepEqual(await now(), [['approved', null], ['approved', null], ['pending', null]])
    assert.equal((await question(b.id, other.id)).status, 'pending')

    await screenOn(a.id, qa!.id)
    await bulk({ ids: [qa!.id, qb!.id], status: 'answered' })
    assert.deepEqual(await now(), [['answered', 0], ['answered', null], ['pending', null]]) // respondida continua na tela
    await bulk({ ids: [qa!.id], status: 'rejected' })
    assert.deepEqual(pick(await question(a.id, qa!.id)), ['rejected', null])
    assert.equal((await question(a.id, qc!.id)).status, 'pending')

    for (const body of [
      { ids: [], status: 'approved' },
      { ids: [qa!.id], status: 'apagada' },
      { ids: qa!.id, status: 'approved' },
      { status: 'approved' },
      { ids: Array.from({ length: 1001 }, (_, i) => `q${i}`), status: 'approved' },
    ])
      assertBadRequest(await bulk(body), JSON.stringify(body).slice(0, 60))
  })

  test('limpar a tela tira todas as perguntas sem mudar o status', async () => {
    const { id, snap, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    await questionsOnAir(id, snap)
    const q1 = await send(ana!, id, 'Primeira pergunta exibida')
    const q2 = await send(bia!, id, 'Segunda pergunta exibida')
    await screenOn(id, q1.id)
    await screenOn(id, q2.id)
    await patchQ(id, q2.id, { status: 'answered' })
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next<ScreenSnapshot>('state', { where: (s) => s.questions.length === 2 })
      assert.equal((await mod.req('POST', `/api/events/${id}/questions/screen/clear`)).status, 200)
      await screen.next<ScreenSnapshot>('state', { where: (s) => s.questions.length === 0 })
    } finally {
      screen.close()
    }
    assert.deepEqual(pick(await question(id, q1.id)), ['approved', null])
    assert.deepEqual(pick(await question(id, q2.id)), ['answered', null])
  })

  test('excluir pergunta tira da moderação, da tela e da lista do autor', async () => {
    const { id, snap, people: [ana] } = await setup()
    await questionsOnAir(id, snap)
    const q = await send(ana!, id, 'Pergunta que será excluída')
    await screenOn(id, q.id)
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    const ps = await ana!.phone.stream(`/api/p/${id}/stream`)
    try {
      await screen.next<ScreenSnapshot>('state', { where: (s) => s.questions.length === 1 })
      await ps.next<ParticipantSnapshot>('state', { where: (s) => s.mine.length === 1 && s.now?.questions.length === 1 })
      assert.equal((await mod.req('DELETE', `/api/events/${id}/questions/${q.id}`)).status, 200)
      await screen.next<ScreenSnapshot>('state', { where: (s) => s.questions.length === 0 })
      await ps.next<ParticipantSnapshot>('state', { where: (s) => s.mine.length === 0 && s.now?.questions.length === 0 })
    } finally {
      screen.close()
      ps.close()
    }
    assert.equal((await modSnap(id)).questions.length, 0)
  })

  test('pergunta de outro evento não é alterada pelas rotas deste evento', async () => {
    const a = await setup([])
    const b = await setup(['Bia Lima'])
    const other = await send(b.people[0]!, b.id, 'Pergunta de outro evento')
    assert.equal((await patchQ(a.id, other.id, { status: 'approved' })).status, 404)
    assert.equal((await screenOn(a.id, other.id)).status, 404)
    await mod.req('DELETE', `/api/events/${a.id}/questions/${other.id}`)
    assert.deepEqual(pick(await question(b.id, other.id)), ['pending', null])
  })

  test('pergunta manual da moderação entra aprovada; sem autor fica anônima', async () => {
    const { id } = await setup([])
    const add = (body: unknown) => mod.req('POST', `/api/events/${id}/questions`, body)
    assert.equal((await add({ text: '  Pergunta recebida por e-mail  ', author: '  Convidado Especial ' })).status, 201)
    assert.equal((await add({ text: 'Pergunta sem autor', author: '   ' })).status, 201)
    const qs = (await modSnap(id)).questions
    const named = qs.find((q) => q.text === 'Pergunta recebida por e-mail')!
    const anon = qs.find((q) => q.text === 'Pergunta sem autor')!
    assert.deepEqual(
      [named.author, named.anonymous, named.status, named.participantId, named.screen, named.flagged],
      ['Convidado Especial', false, 'approved', null, null, false],
    )
    assert.deepEqual([anon.author, anon.anonymous, anon.status], ['', true, 'approved'])

    for (const body of [{ text: '', author: 'X' }, { text: 'x'.repeat(1001), author: '' }, { text: 'Pergunta válida', author: 'a'.repeat(81) }, { author: 'X' }, { text: 42, author: '' }])
      assertBadRequest(await add(body), JSON.stringify(body).slice(0, 60))
    assert.equal((await modSnap(id)).questions.length, 2)
  })
})

describe('limites de acesso', () => {
  test('participante não usa as rotas de moderação de perguntas', async () => {
    const { id, people: [ana] } = await setup()
    const q = await send(ana!, id, 'Pergunta que só a moderação controla')
    const routes: [string, string, unknown?][] = [
      ['PATCH', `/api/events/${id}/questions/${q.id}`, { status: 'approved' }],
      ['POST', `/api/events/${id}/questions/${q.id}/screen`, { on: true }],
      ['POST', `/api/events/${id}/questions/bulk`, { ids: [q.id], status: 'approved' }],
      ['POST', `/api/events/${id}/questions/screen/clear`],
      ['DELETE', `/api/events/${id}/questions/${q.id}`],
      ['POST', `/api/events/${id}/questions`, { text: 'Pergunta forjada como aprovada', author: '' }],
    ]
    for (const [method, path, body] of routes) {
      const r = await ana!.phone.req(method, path, body)
      assert.equal(r.status, 401, `${method} ${path}`)
      assert.deepEqual(r.data, { error: 'Sua sessão expirou. Entre de novo para continuar.' })
    }
    const qs = (await modSnap(id)).questions
    assert.deepEqual(qs.map(pick), [['pending', null]])
  })

  test('cada participante vê só as próprias perguntas; tela e celulares recebem só campos públicos', async () => {
    const { id, snap, people: [ana, bia] } = await setup(['Ana Souza', 'Bia Lima'])
    await questionsOnAir(id, snap)
    const qa = await send(ana!, id, 'Pergunta privada da Ana')
    const qb = await send(bia!, id, 'Pergunta da Bia que vai para a tela')
    await screenOn(id, qb.id)

    const anaSnap = await ana!.phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)
    const biaSnap = await bia!.phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)
    assert.deepEqual(anaSnap.mine.map((q) => q.id), [qa.id])
    assert.deepEqual(biaSnap.mine.map((q) => q.id), [qb.id])
    assert.ok(!JSON.stringify(biaSnap).includes('Pergunta privada da Ana'))
    assert.deepEqual(anaSnap.me, { id: ana!.participant.id, name: 'Ana Souza' })

    const pub = { id: qb.id, text: qb.text, author: 'Bia L.', likes: 0 }
    assert.deepEqual(anaSnap.now?.questions, [{ ...pub, liked: false }])
    const screen = await mod.snapshot<ScreenSnapshot>(`/api/screen/stream?event=${id}`)
    assert.deepEqual(screen.questions, [pub])

    for (const json of [JSON.stringify(anaSnap), JSON.stringify(screen)]) {
      for (const secret of ['participantId', 'original', 'flagged', ana!.participant.token, bia!.participant.token, bia!.participant.id])
        assert.ok(!json.includes(secret), secret)
    }
    assert.ok(!JSON.stringify(anaSnap).includes('"pin"'))
  })
})
