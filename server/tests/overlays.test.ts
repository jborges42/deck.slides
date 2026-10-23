// Sobre o conteúdo (POST /api/events/:id/live): cronômetro num canto e pergunta em destaque por cima da cena no ar,
// conferidos no estado ao vivo, na tela e na limpeza quando a pergunta deixa de poder aparecer.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { asModerator, Client, createEvent, joinParticipant, live } from './helpers.ts'
import { defaultLive, type LiveState, type ModeratorSnapshot, type ScreenSnapshot } from '../../shared/types.ts'

const { run, newCode } = await import('../db.ts')
const mod = await asModerator()

/** Evento novo com as cenas padrão: Abertura (título), Perguntas e Intervalo (cronômetro). */
async function setup() {
  const snap = await createEvent(mod)
  return { id: snap.event.id, title: snap.scenes[0]! }
}

const modSnap = (id: string) => mod.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)
const liveOf = async (id: string): Promise<LiveState> => (await modSnap(id)).event.live
const screenOf = (id: string) => mod.snapshot<ScreenSnapshot>(`/api/screen/stream?event=${id}`)
const patchQ = (id: string, qid: string, body: unknown) => mod.req('PATCH', `/api/events/${id}/questions/${qid}`, body)
const bulk = (id: string, ids: string[], status: string) => mod.req('POST', `/api/events/${id}/questions/bulk`, { ids, status })
const overlays = (l: LiveState) => ({ timerOverlay: l.timerOverlay, timerCorner: l.timerCorner, questionOverlay: l.questionOverlay })

/** Pergunta digitada pela moderação (já aprovada); autor vazio = anônima. Devolve o id. */
async function ask(id: string, text: string, author = 'Maria Clara Souza'): Promise<string> {
  assert.equal((await mod.req('POST', `/api/events/${id}/questions`, { text, author })).status, 201)
  return (await modSnap(id)).questions.find((q) => q.text === text)!.id
}

/** Mensagem em português do Brasil: nem inglês, nem as formas de Portugal. */
function assertPtBr(message: string) {
  assert.match(message, /\p{L}{3}/u)
  assert.doesNotMatch(message, /\b(invalid|expected|required|too (big|small))\b/i, `mensagem em inglês: ${message}`)
  assert.doesNotMatch(message, /demasiad|registo|ficheiro|tuplo/i, `mensagem em português de Portugal: ${message}`)
}

async function ok(id: string, cmd: unknown) {
  const r = await live(mod, id, cmd)
  assert.equal(r.status, 200, `${JSON.stringify(cmd)} -> ${r.status} ${JSON.stringify(r.data)}`)
}

async function refused(client: Client, id: string, cmd: unknown, status: number): Promise<string> {
  const r = await live(client, id, cmd)
  assert.equal(r.status, status, `${JSON.stringify(cmd)} -> ${r.status} ${JSON.stringify(r.data)}`)
  assertPtBr(r.data.error)
  return r.data.error
}

describe('padrões', () => {
  test('evento novo: cronômetro desligado no canto esquerdo e nenhuma pergunta sobre o conteúdo', async () => {
    const { id } = await setup()
    assert.deepEqual(overlays(await liveOf(id)), { timerOverlay: false, timerCorner: 'top-left', questionOverlay: null })
    assert.equal((await screenOf(id)).questionOverlay, null)
  })

  test('evento gravado antes dos campos novos lê os padrões e aceita os comandos novos', async () => {
    const { timerOverlay: _t, timerCorner: _c, questionOverlay: _q, joinPosition: _j, ...old } = defaultLive()
    const id = newCode()
    await run(
      'INSERT INTO events (id, name, pin, settings, theme, live, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      'Evento antigo',
      '482913',
      '{}',
      '{}',
      JSON.stringify({ ...old, standby: true }),
      Date.now(),
    )
    assert.deepEqual(await liveOf(id), { ...defaultLive(), standby: true })
    assert.equal((await screenOf(id)).questionOverlay, null)
    await ok(id, { op: 'timerOverlay', on: true })
    assert.deepEqual(overlays(await liveOf(id)), { timerOverlay: true, timerCorner: 'top-left', questionOverlay: null })
  })
})

describe('cronômetro sobre o conteúdo', () => {
  test('liga, desliga e troca o canto; campo omitido mantém o valor; a tela recebe na hora', async () => {
    const { id } = await setup()
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next('state')
      const steps: [unknown, Pick<LiveState, 'timerOverlay' | 'timerCorner'>][] = [
        [{ op: 'timerOverlay', on: true }, { timerOverlay: true, timerCorner: 'top-left' }],
        [{ op: 'timerOverlay', corner: 'top-right' }, { timerOverlay: true, timerCorner: 'top-right' }],
        [{ op: 'timerOverlay' }, { timerOverlay: true, timerCorner: 'top-right' }],
        [{ op: 'timerOverlay', corner: 'bottom-left' }, { timerOverlay: true, timerCorner: 'bottom-left' }],
        [{ op: 'timerOverlay', corner: 'bottom-right' }, { timerOverlay: true, timerCorner: 'bottom-right' }],
        [{ op: 'timerOverlay', on: false }, { timerOverlay: false, timerCorner: 'bottom-right' }],
        [{ op: 'timerOverlay', on: true, corner: 'top-left' }, { timerOverlay: true, timerCorner: 'top-left' }],
      ]
      for (const [cmd, want] of steps) {
        await ok(id, cmd)
        const l = await liveOf(id)
        assert.deepEqual({ timerOverlay: l.timerOverlay, timerCorner: l.timerCorner }, want, JSON.stringify(cmd))
        const s = await screen.next<ScreenSnapshot>('state', {
          where: (x) => x.event.live.timerOverlay === want.timerOverlay && x.event.live.timerCorner === want.timerCorner,
        })
        assert.equal(s.event.live.questionOverlay, null)
      }
    } finally {
      screen.close()
    }
  })

  test('canto inválido e tipos errados: 400 em pt-BR sem mudar o estado', async () => {
    const { id } = await setup()
    await ok(id, { op: 'timerOverlay', on: true, corner: 'top-right' })
    const before = await liveOf(id)
    assert.match(await refused(mod, id, { op: 'timerOverlay', corner: 'bottom' }, 400), /^Opção inválida/)
    for (const cmd of [{ op: 'timerOverlay', on: 'sim' }, { op: 'timerOverlay', on: 1 }, { op: 'timerOverlay', corner: null }])
      await refused(mod, id, cmd, 400)
    assert.deepEqual(await liveOf(id), before)
  })

  test('definir sem limites mantém os anteriores; com limites, aplica; fora da faixa, 400', async () => {
    const { id } = await setup()
    const base = defaultLive().timer
    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 600_000, label: 'Fala' })
    assert.deepEqual((await liveOf(id)).timer, { ...base, durationMs: 600_000, label: 'Fala' })

    const limits = { warnMs: 120_000, criticalMs: 30_000, onEnd: 'message', endText: 'Encerre a fala' } as const
    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 600_000, label: 'Fala', ...limits })
    assert.deepEqual((await liveOf(id)).timer, { ...base, durationMs: 600_000, label: 'Fala', ...limits })

    await ok(id, { op: 'timer', action: 'set', mode: 'stopwatch', durationMs: 300_000, label: 'Debate' })
    assert.deepEqual((await liveOf(id)).timer, { ...base, mode: 'stopwatch', durationMs: 300_000, label: 'Debate', ...limits })

    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 300_000, label: 'Debate', criticalMs: 0 })
    const before = await liveOf(id)
    assert.deepEqual(before.timer, { ...base, durationMs: 300_000, label: 'Debate', ...limits, criticalMs: 0 })

    const set = { op: 'timer', action: 'set', mode: 'countdown', durationMs: 60_000, label: '' }
    const cases: [unknown, RegExp][] = [
      [{ ...set, warnMs: -1 }, /^Pequeno demais/],
      [{ ...set, warnMs: 86_400_001 }, /^Grande demais/],
      [{ ...set, criticalMs: -1 }, /^Pequeno demais/],
      [{ ...set, criticalMs: 1.5 }, /número inteiro/],
      [{ ...set, criticalMs: '1000' }, /número/],
      [{ ...set, onEnd: 'explode' }, /^Opção inválida/],
      [{ ...set, endText: 'x'.repeat(121) }, /^Grande demais/],
    ]
    for (const [cmd, message] of cases) assert.match(await refused(mod, id, cmd, 400), message, JSON.stringify(cmd))
    assert.deepEqual(await liveOf(id), before)
  })
})

describe('pergunta sobre o conteúdo', () => {
  test('aprovada vai para a tela com texto, autor no formato do evento e curtidas; anônima, sem autor; null tira', async () => {
    const { id } = await setup()
    const qid = await ask(id, 'Como a escola apoia o primeiro emprego?')
    const anon = await ask(id, 'Quanto tempo dura o curso técnico?', '')
    const { phone } = await joinParticipant(mod, id)
    assert.equal((await phone.req('POST', `/api/p/${id}/questions/${qid}/like`, { on: true })).status, 200)
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next('state')
      await ok(id, { op: 'questionOverlay', questionId: qid })
      const shown = await screen.next<ScreenSnapshot>('state', { where: (s) => s.questionOverlay !== null })
      assert.deepEqual(shown.questionOverlay, { id: qid, text: 'Como a escola apoia o primeiro emprego?', author: 'Maria S.', likes: 1 })
      assert.equal(shown.event.live.questionOverlay, qid)
      assert.deepEqual(shown.questions, []) // a cena de perguntas e o "Destacar" seguem à parte

      const snap = await modSnap(id)
      assert.equal(snap.event.live.questionOverlay, qid)
      assert.ok(!('questionOverlay' in snap), 'o console calcula a pergunta pelo snapshot dele')

      await ok(id, { op: 'questionOverlay', questionId: anon })
      const hidden = await screen.next<ScreenSnapshot>('state', { where: (s) => s.questionOverlay?.id === anon })
      assert.deepEqual(hidden.questionOverlay, { id: anon, text: 'Quanto tempo dura o curso técnico?', author: null, likes: 0 })

      await ok(id, { op: 'questionOverlay', questionId: null })
      await screen.next<ScreenSnapshot>('state', { where: (s) => s.questionOverlay === null && s.event.live.questionOverlay === null })
      assert.equal((await liveOf(id)).questionOverlay, null)
    } finally {
      screen.close()
    }
  })

  test('respondida também vai; pendente e rejeitada: 400 explicando, sem mudar o estado', async () => {
    const { id } = await setup()
    const answered = await ask(id, 'Pergunta respondida')
    assert.equal((await patchQ(id, answered, { status: 'answered' })).status, 200)
    await ok(id, { op: 'questionOverlay', questionId: answered })
    assert.equal((await screenOf(id)).questionOverlay?.id, answered)

    const pending = await ask(id, 'Pergunta pendente')
    const rejected = await ask(id, 'Pergunta rejeitada')
    assert.equal((await patchQ(id, pending, { status: 'pending' })).status, 200)
    assert.equal((await patchQ(id, rejected, { status: 'rejected' })).status, 200)
    const before = await liveOf(id)
    assert.equal(
      await refused(mod, id, { op: 'questionOverlay', questionId: pending }, 400),
      'A pergunta ainda não foi aprovada. Aprove antes de mostrar sobre o conteúdo.',
    )
    assert.match(await refused(mod, id, { op: 'questionOverlay', questionId: rejected }, 400), /^A pergunta foi rejeitada\. Aprove/)
    assert.deepEqual(await liveOf(id), before)
    assert.equal((await screenOf(id)).questionOverlay?.id, answered)
  })

  test('pergunta inexistente ou de outro evento: 404; id malformado: 400', async () => {
    const { id } = await setup()
    const other = await setup()
    const foreign = await ask(other.id, 'Pergunta de outro evento')
    for (const questionId of ['nao-existe', foreign, ''])
      assert.equal(await refused(mod, id, { op: 'questionOverlay', questionId }, 404), 'Pergunta não encontrada.', questionId)
    for (const cmd of [{ op: 'questionOverlay' }, { op: 'questionOverlay', questionId: 42 }, { op: 'questionOverlay', questionId: 'x'.repeat(101) }])
      await refused(mod, id, cmd, 400)
    assert.deepEqual(await liveOf(id), defaultLive())
    assert.deepEqual(await liveOf(other.id), defaultLive())
  })
})

describe('limpeza', () => {
  test('rejeitar ou voltar a pendente (uma a uma ou em lote) e excluir tiram a pergunta de cima do conteúdo', async () => {
    const { id } = await setup()
    const other = await ask(id, 'Outra pergunta')
    const actions: [string, (qid: string) => Promise<{ status: number }>][] = [
      ['rejeitar', (qid) => patchQ(id, qid, { status: 'rejected' })],
      ['voltar a pendente', (qid) => patchQ(id, qid, { status: 'pending' })],
      ['rejeitar em lote', (qid) => bulk(id, [other, qid], 'rejected')],
      ['pendente em lote', (qid) => bulk(id, [qid], 'pending')],
      ['excluir', (qid) => mod.req('DELETE', `/api/events/${id}/questions/${qid}`)],
    ]
    for (const [label, act] of actions) {
      const qid = await ask(id, `Pergunta para ${label}`)
      await ok(id, { op: 'questionOverlay', questionId: qid })
      assert.equal((await act(qid)).status, 200, label)
      assert.equal((await liveOf(id)).questionOverlay, null, label)
      assert.equal((await screenOf(id)).questionOverlay, null, label)
      // Aprovada de novo, não volta sozinha: o operador escolhe outra vez.
      if (label !== 'excluir') {
        assert.equal((await patchQ(id, qid, { status: 'approved' })).status, 200)
        assert.equal((await liveOf(id)).questionOverlay, null, label)
      }
    }
  })

  test('mexer em outra pergunta, aprovar ou marcar como respondida mantém a pergunta sobre o conteúdo', async () => {
    const { id } = await setup()
    const qid = await ask(id, 'Pergunta em destaque')
    const other = await ask(id, 'Outra pergunta')
    const third = await ask(id, 'Terceira pergunta')
    await ok(id, { op: 'questionOverlay', questionId: qid })
    assert.equal((await patchQ(id, other, { status: 'rejected' })).status, 200)
    assert.equal((await bulk(id, [third], 'pending')).status, 200)
    assert.equal((await mod.req('DELETE', `/api/events/${id}/questions/${other}`)).status, 200)
    assert.equal((await bulk(id, [qid], 'approved')).status, 200)
    assert.equal((await bulk(id, [qid], 'answered')).status, 200)
    assert.equal((await patchQ(id, qid, { status: 'approved' })).status, 200)
    assert.equal((await liveOf(id)).questionOverlay, qid)
    assert.equal((await screenOf(id)).questionOverlay?.id, qid)
  })

  test('edição de texto e de anonimato e a rejeição chegam à tela; mexer em outra pergunta não envia nada a ela', async () => {
    const { id } = await setup()
    const qid = await ask(id, 'Texto original')
    const other = await ask(id, 'Outra pergunta')
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      await screen.next('state')
      await ok(id, { op: 'questionOverlay', questionId: qid })
      await screen.next<ScreenSnapshot>('state', { where: (s) => s.questionOverlay?.text === 'Texto original' })
      assert.equal((await patchQ(id, other, { text: 'Outra pergunta revisada' })).status, 200)
      await screen.none('state')

      assert.equal((await patchQ(id, qid, { text: '  Texto   revisado ' })).status, 200)
      const edited = await screen.next<ScreenSnapshot>('state')
      assert.deepEqual(edited.questionOverlay, { id: qid, text: 'Texto revisado', author: 'Maria S.', likes: 0 })

      assert.equal((await patchQ(id, qid, { anonymous: true })).status, 200)
      assert.equal((await screen.next<ScreenSnapshot>('state')).questionOverlay?.author, null)

      assert.equal((await patchQ(id, qid, { status: 'rejected' })).status, 200)
      const gone = await screen.next<ScreenSnapshot>('state')
      assert.deepEqual([gone.questionOverlay, gone.event.live.questionOverlay], [null, null])
    } finally {
      screen.close()
    }
  })

  test('a pergunta e o cronômetro sobre o conteúdo continuam depois de um corte e na tela de espera', async () => {
    const { id, title } = await setup()
    const qid = await ask(id, 'Pergunta que fica')
    await ok(id, { op: 'questionOverlay', questionId: qid })
    await ok(id, { op: 'timerOverlay', on: true, corner: 'top-right' })
    const want = { timerOverlay: true, timerCorner: 'top-right', questionOverlay: qid }
    await ok(id, { op: 'preview', sceneId: title.id })
    await ok(id, { op: 'take' })
    let screen = await screenOf(id)
    assert.deepEqual([screen.program?.id, screen.questionOverlay?.id], [title.id, qid])
    assert.deepEqual(overlays(screen.event.live), want)

    // Na espera o dado continua; quem esconde é o palco.
    await ok(id, { op: 'standby', on: true })
    screen = await screenOf(id)
    assert.deepEqual([screen.event.live.standby, screen.questionOverlay?.id], [true, qid])
    assert.deepEqual(overlays(screen.event.live), want)
  })
})

test('participante e cliente sem sessão não mandam os comandos novos', async () => {
  const { id } = await setup()
  const qid = await ask(id, 'Pergunta aprovada')
  const { phone } = await joinParticipant(mod, id)
  const forged = new Client()
  forged.jar.set('deck_mod', 'moderador-falso.0')
  const cmds = [
    { op: 'timerOverlay', on: true, corner: 'top-right' },
    { op: 'questionOverlay', questionId: qid },
    { op: 'timer', action: 'set', mode: 'countdown', durationMs: 60_000, label: '', warnMs: 0 },
  ]
  for (const cmd of cmds) for (const client of [new Client(), forged, phone]) await refused(client, id, cmd, 401)
  assert.deepEqual(await liveOf(id), defaultLive())
  assert.equal((await screenOf(id)).questionOverlay, null)
})
