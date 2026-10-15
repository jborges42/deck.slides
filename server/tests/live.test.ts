// Switcher ao vivo (POST /api/events/:id/live): prévia, corte, tela de espera, sobreposições,
// cronômetro e vídeo, conferidos no snapshot do console, na tela e no celular.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { asModerator, Client, createEvent, joinParticipant, live, wait } from './helpers.ts'
import {
  defaultLive,
  playbackPosition,
  timerElapsed,
  type LiveState,
  type ModeratorSnapshot,
  type ParticipantSnapshot,
  type PlaybackState,
  type ScreenSnapshot,
  type TimerState,
} from '../../shared/types.ts'

const TAKE_GAP = 450 // o servidor ignora cortes com menos de 400 ms de intervalo
const mod = await asModerator()

/** Evento novo com as cenas padrão: Abertura (título), Perguntas e Intervalo (cronômetro de 10 min). */
async function setup() {
  const snap = await createEvent(mod)
  const [title, questions, timer] = snap.scenes
  assert.deepEqual([title?.type, questions?.type, timer?.type], ['title', 'questions', 'timer'])
  return { id: snap.event.id, title: title!, questions: questions!, timer: timer! }
}

/** Estado ao vivo gravado, lido de um snapshot novo do console. */
const liveOf = async (id: string): Promise<LiveState> =>
  (await mod.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)).event.live

/** Mensagem em português do Brasil: nem inglês, nem as formas de Portugal (locale "pt" do zod). */
function assertPtBr(message: string) {
  assert.match(message, /\p{L}{3}/u)
  assert.doesNotMatch(message, /\b(invalid|expected|required|too (big|small))\b/i, `mensagem em inglês: ${message}`)
  assert.doesNotMatch(message, /demasiad|registo|ficheiro|tuplo/i, `mensagem em português de Portugal: ${message}`)
}

/** Comando aceito. Devolve o intervalo de relógio dentro do qual o servidor carimbou o comando. */
async function ok(id: string, cmd: unknown) {
  const before = Date.now()
  const r = await live(mod, id, cmd)
  assert.equal(r.status, 200, `${JSON.stringify(cmd)} -> ${r.status} ${JSON.stringify(r.data)}`)
  assert.deepEqual(r.data, { ok: true })
  return { before, after: Date.now() }
}

/** Comando recusado com `status` e mensagem de erro em pt-BR. */
async function refused(client: Client, id: string, cmd: unknown, status: number): Promise<string> {
  const r = await live(client, id, cmd)
  assert.equal(r.status, status, `${JSON.stringify(cmd)} -> ${r.status} ${JSON.stringify(r.data)}`)
  assert.equal(typeof r.data.error, 'string')
  assertPtBr(r.data.error)
  return r.data.error
}

function within(value: number, lo: number, hi: number, what: string) {
  assert.ok(value >= lo && value <= hi, `${what}: ${value} fora de [${lo}, ${hi}]`)
}

async function addScene(id: string, scene: unknown): Promise<string> {
  const r = await mod.req('POST', `/api/events/${id}/scenes`, scene)
  assert.equal(r.status, 201, JSON.stringify(r.data))
  return r.data.id
}

const video = (autoplay: boolean) => ({
  type: 'video',
  content: { src: 'https://example.com/aula.mp4', fit: 'contain', loop: false, autoplay },
})

describe('prévia', () => {
  test('escolhe e limpa a cena da prévia sem pôr nada no ar', async () => {
    const { id, title, questions } = await setup()
    await ok(id, { op: 'preview', sceneId: title.id })
    assert.deepEqual(await liveOf(id), { ...defaultLive(), preview: title.id })
    await ok(id, { op: 'preview', sceneId: questions.id })
    assert.equal((await liveOf(id)).preview, questions.id)
    await ok(id, { op: 'preview', sceneId: null })
    assert.deepEqual(await liveOf(id), defaultLive())
  })

  test('cena inexistente, de outro evento ou id vazio: 404 sem mexer na prévia', async () => {
    const { id, title } = await setup()
    const other = await setup()
    await ok(id, { op: 'preview', sceneId: title.id })
    for (const sceneId of ['nao-existe', other.title.id, '']) {
      assert.equal(await refused(mod, id, { op: 'preview', sceneId }, 404), 'Cena não encontrada.', JSON.stringify(sceneId))
    }
    assert.equal((await liveOf(id)).preview, title.id)
    assert.deepEqual(await liveOf(other.id), defaultLive())
  })
})

describe('corte', () => {
  test('com a prévia vazia: 404 "Nada na prévia" e nada vai ao ar', async () => {
    const { id } = await setup()
    assert.match(await refused(mod, id, { op: 'take' }, 404), /^Nada na prévia\. /)
    assert.deepEqual(await liveOf(id), defaultLive())
  })

  test('troca prévia e programa, registra transição e horário; o corte seguinte desfaz o anterior', async () => {
    const { id, title, questions } = await setup()
    await ok(id, { op: 'preview', sceneId: title.id })
    const first = await ok(id, { op: 'take', transition: 'fade' })
    let l = await liveOf(id)
    assert.deepEqual([l.program, l.preview, l.transition], [title.id, null, 'fade'])
    within(l.takenAt, first.before, first.after, 'takenAt do 1º corte')

    await ok(id, { op: 'preview', sceneId: questions.id })
    await wait(TAKE_GAP)
    const second = await ok(id, { op: 'take', transition: 'cut' })
    l = await liveOf(id)
    // A cena que estava no ar vai para a prévia: o corte seguinte desfaz este.
    assert.deepEqual([l.program, l.preview, l.transition], [questions.id, title.id, 'cut'])
    within(l.takenAt, second.before, second.after, 'takenAt do 2º corte')

    await wait(TAKE_GAP)
    await ok(id, { op: 'take', transition: 'fade' })
    l = await liveOf(id)
    assert.deepEqual([l.program, l.preview, l.transition], [title.id, questions.id, 'fade'])
  })

  test('dois cortes em menos de 400 ms: o segundo é ignorado', async () => {
    const { id, title, questions } = await setup()
    await ok(id, { op: 'preview', sceneId: title.id })
    const first = await ok(id, { op: 'take' })
    await ok(id, { op: 'preview', sceneId: questions.id })
    const second = await ok(id, { op: 'take', transition: 'fade' }) // toque duplo acidental
    assert.ok(second.after - first.before < 400, 'os dois cortes precisam sair em menos de 400 ms')
    const l = await liveOf(id)
    // Vale só o primeiro corte (sem transição informada, o corte é seco).
    assert.deepEqual([l.program, l.preview, l.transition], [title.id, questions.id, 'cut'])
    within(l.takenAt, first.before, first.after, 'takenAt')
  })

  test('tela de espera liga e desliga sem tirar a cena do ar; o corte sai da espera', async () => {
    const { id, title } = await setup()
    await ok(id, { op: 'standby', on: true })
    assert.deepEqual(await liveOf(id), { ...defaultLive(), standby: true })
    await ok(id, { op: 'preview', sceneId: title.id })
    await ok(id, { op: 'take' })
    let l = await liveOf(id)
    assert.deepEqual([l.program, l.standby], [title.id, false])
    await ok(id, { op: 'standby', on: true })
    l = await liveOf(id)
    assert.deepEqual([l.program, l.standby], [title.id, true]) // a cena continua no ar por trás da espera
    await ok(id, { op: 'standby', on: false })
    l = await liveOf(id)
    assert.deepEqual([l.program, l.standby], [title.id, false])
  })
})

test('sobreposições: cada uma liga e desliga sem mexer na outra; o console aberto recebe na hora', async () => {
  const { id } = await setup()
  const consoleStream = await mod.stream(`/api/events/${id}/stream`)
  try {
    const first = await consoleStream.next<ModeratorSnapshot>('state')
    assert.deepEqual(first.event.live.overlays, { join: false, reactions: true })
    const steps: [unknown, LiveState['overlays']][] = [
      [{ op: 'overlays', join: true }, { join: true, reactions: true }],
      [{ op: 'overlays', reactions: false }, { join: true, reactions: false }],
      [{ op: 'overlays' }, { join: true, reactions: false }],
      [{ op: 'overlays', join: false, reactions: true }, { join: false, reactions: true }],
    ]
    for (const [cmd, expected] of steps) {
      await ok(id, cmd)
      const snap = await consoleStream.next<ModeratorSnapshot>('state')
      assert.deepEqual(snap.event.live.overlays, expected, JSON.stringify(cmd))
    }
  } finally {
    consoleStream.close()
  }
})

describe('cronômetro', () => {
  test('definir configura e zera; iniciar, pausar e retomar acumulam o tempo de relógio', async () => {
    const { id } = await setup()
    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 90_000, label: 'Fala do reitor' })
    assert.deepEqual((await liveOf(id)).timer, { ...defaultLive().timer, durationMs: 90_000, label: 'Fala do reitor' })

    const start1 = await ok(id, { op: 'timer', action: 'start' })
    const running = (await liveOf(id)).timer
    assert.deepEqual([running.running, running.elapsedMs], [true, 0])
    within(running.startedAt, start1.before, start1.after, 'startedAt')
    await ok(id, { op: 'timer', action: 'start' }) // iniciar de novo não reinicia a contagem
    assert.deepEqual((await liveOf(id)).timer, running)

    await wait(120)
    const pause1 = await ok(id, { op: 'timer', action: 'pause' })
    const paused = (await liveOf(id)).timer
    assert.equal(paused.running, false)
    within(paused.elapsedMs, pause1.before - running.startedAt, pause1.after - running.startedAt, 'elapsedMs')
    assert.ok(paused.elapsedMs >= 100, `elapsedMs ${paused.elapsedMs}`)
    await wait(30)
    await ok(id, { op: 'timer', action: 'pause' }) // pausado, o tempo não anda
    assert.deepEqual((await liveOf(id)).timer, paused)

    const start2 = await ok(id, { op: 'timer', action: 'start' })
    const resumed = (await liveOf(id)).timer
    assert.deepEqual([resumed.running, resumed.elapsedMs], [true, paused.elapsedMs]) // continua de onde parou
    within(resumed.startedAt, start2.before, start2.after, 'startedAt ao retomar')
    await wait(60)
    const pause2 = await ok(id, { op: 'timer', action: 'pause' })
    within(
      (await liveOf(id)).timer.elapsedMs,
      paused.elapsedMs + pause2.before - resumed.startedAt,
      paused.elapsedMs + pause2.after - resumed.startedAt,
      'elapsedMs acumulado',
    )

    // Definir com o cronômetro correndo: para, zera e troca a configuração.
    await ok(id, { op: 'timer', action: 'start' })
    await ok(id, { op: 'timer', action: 'set', mode: 'stopwatch', durationMs: 0, label: 'Debate' })
    assert.deepEqual((await liveOf(id)).timer, { ...defaultLive().timer, mode: 'stopwatch', durationMs: 0, label: 'Debate' })
  })

  test('zerar para a contagem e volta a zero mantendo a configuração', async () => {
    const { id } = await setup()
    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 60_000, label: 'Fala' })
    const expected = { ...defaultLive().timer, durationMs: 60_000, label: 'Fala' }
    await ok(id, { op: 'timer', action: 'start' })
    await wait(30)
    await ok(id, { op: 'timer', action: 'reset' })
    assert.deepEqual((await liveOf(id)).timer, expected)

    await ok(id, { op: 'timer', action: 'start' })
    await wait(30)
    await ok(id, { op: 'timer', action: 'pause' })
    assert.ok((await liveOf(id)).timer.elapsedMs > 0)
    await ok(id, { op: 'timer', action: 'reset' })
    assert.deepEqual((await liveOf(id)).timer, expected)
  })

  test('somar tempo: na regressiva estende a duração; no cronômetro avança o decorrido; nunca negativo', async () => {
    const { id } = await setup()
    const clock = async () => {
      const t = (await liveOf(id)).timer
      return { durationMs: t.durationMs, elapsedMs: t.elapsedMs }
    }
    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 60_000, label: '' })
    await ok(id, { op: 'timer', action: 'add', ms: 60_000 })
    assert.deepEqual(await clock(), { durationMs: 120_000, elapsedMs: 0 })
    await ok(id, { op: 'timer', action: 'add', ms: -30_000 })
    assert.deepEqual(await clock(), { durationMs: 90_000, elapsedMs: 0 })
    await ok(id, { op: 'timer', action: 'add', ms: -86_400_000 })
    assert.deepEqual(await clock(), { durationMs: 0, elapsedMs: 0 })

    // Regressiva correndo: só a duração muda, a contagem segue igual.
    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 60_000, label: '' })
    await ok(id, { op: 'timer', action: 'start' })
    const counting = (await liveOf(id)).timer
    await ok(id, { op: 'timer', action: 'add', ms: 60_000 })
    assert.deepEqual((await liveOf(id)).timer, { ...counting, durationMs: 120_000 })

    await ok(id, { op: 'timer', action: 'set', mode: 'stopwatch', durationMs: 0, label: '' })
    await ok(id, { op: 'timer', action: 'add', ms: 60_000 })
    assert.deepEqual(await clock(), { durationMs: 0, elapsedMs: 60_000 })
    await ok(id, { op: 'timer', action: 'add', ms: -90_000 })
    assert.deepEqual(await clock(), { durationMs: 0, elapsedMs: 0 })
  })

  test('descontar tempo do cronômetro em andamento vale sobre o total decorrido', async () => {
    const { id } = await setup()
    await ok(id, { op: 'timer', action: 'set', mode: 'stopwatch', durationMs: 0, label: '' })
    await ok(id, { op: 'timer', action: 'start' })
    const { startedAt } = (await liveOf(id)).timer
    await wait(200)

    // Total em qualquer instante depois do ajuste = tempo desde o início - 150 ms.
    await ok(id, { op: 'timer', action: 'add', ms: -150 })
    let t = (await liveOf(id)).timer
    let now = Date.now()
    assert.equal(t.running, true)
    assert.equal(timerElapsed(t, now), now - startedAt - 150)

    await ok(id, { op: 'timer', action: 'add', ms: 60_000 })
    t = (await liveOf(id)).timer
    now = Date.now()
    assert.equal(timerElapsed(t, now), now - startedAt - 150 + 60_000)

    // Descontar mais que o total para em zero, e o cronômetro segue correndo.
    const cut = await ok(id, { op: 'timer', action: 'add', ms: -86_400_000 })
    t = (await liveOf(id)).timer
    assert.equal(t.running, true)
    within(timerElapsed(t, cut.after), 0, cut.after - cut.before, 'total logo depois de descontar tudo')
  })

  test('cena de cronômetro no ar carrega a configuração dela; voltar à mesma cena não zera', async () => {
    const { id, title, timer } = await setup()
    await ok(id, { op: 'preview', sceneId: timer.id })
    await ok(id, { op: 'take' })
    assert.deepEqual((await liveOf(id)).timer, {
      sceneId: timer.id,
      mode: 'countdown',
      durationMs: 600_000,
      running: false,
      startedAt: 0,
      elapsedMs: 0,
      label: 'Intervalo',
      warnMs: 120_000,
      criticalMs: 30_000,
      onEnd: 'message',
      endText: 'Retomando',
    })
    await ok(id, { op: 'timer', action: 'start' })
    const running = (await liveOf(id)).timer

    // Sai para a abertura e volta: o intervalo segue correndo de onde estava.
    await ok(id, { op: 'preview', sceneId: title.id })
    await wait(TAKE_GAP)
    await ok(id, { op: 'take' })
    assert.deepEqual((await liveOf(id)).timer, running)
    await wait(TAKE_GAP)
    await ok(id, { op: 'take' }) // o intervalo voltou para a prévia no corte anterior
    let l = await liveOf(id)
    assert.equal(l.program, timer.id)
    assert.deepEqual(l.timer, running)

    // Outra cena de cronômetro carrega a configuração dela, do zero.
    const talk = await addScene(id, {
      type: 'timer',
      name: 'Palestra',
      content: { title: 'Tempo de fala', mode: 'stopwatch', durationSec: 1800, warnSec: 300, criticalSec: 60, onEnd: 'overtime', endText: '' },
    })
    await ok(id, { op: 'preview', sceneId: talk })
    await wait(TAKE_GAP)
    await ok(id, { op: 'take' })
    l = await liveOf(id)
    assert.equal(l.program, talk)
    assert.deepEqual(l.timer, {
      sceneId: talk,
      mode: 'stopwatch',
      durationMs: 1_800_000,
      running: false,
      startedAt: 0,
      elapsedMs: 0,
      label: 'Tempo de fala',
      warnMs: 300_000,
      criticalMs: 60_000,
      onEnd: 'overtime',
      endText: '',
    })
  })

  test('valores fora da faixa e ação desconhecida: 400 em pt-BR, sem mudar o estado', async () => {
    const { id } = await setup()
    await ok(id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 60_000, label: 'Fala' })
    const before = await liveOf(id)
    const cases: [unknown, RegExp][] = [
      [{ op: 'timer', action: 'add', ms: 86_400_001 }, /^Grande demais/],
      [{ op: 'timer', action: 'add', ms: -86_400_001 }, /^Pequeno demais/],
      [{ op: 'timer', action: 'add', ms: 1.5 }, /número inteiro/],
      [{ op: 'timer', action: 'add', ms: '60000' }, /número/],
      [{ op: 'timer', action: 'set', mode: 'countdown', durationMs: -1, label: '' }, /^Pequeno demais/],
      [{ op: 'timer', action: 'set', mode: 'countdown', durationMs: 86_400_001, label: '' }, /^Grande demais/],
      [{ op: 'timer', action: 'set', mode: 'regressivo', durationMs: 1000, label: '' }, /^Opção inválida/],
      [{ op: 'timer', action: 'set', mode: 'countdown', durationMs: 1000, label: 'x'.repeat(201) }, /^Grande demais/],
      [{ op: 'timer', action: 'explode' }, /^Opção inválida/],
      [{ op: 'timer' }, /inválid/],
    ]
    for (const [cmd, message] of cases) assert.match(await refused(mod, id, cmd, 400), message, JSON.stringify(cmd))
    assert.deepEqual(await liveOf(id), before)
  })
})

describe('vídeo', () => {
  test('com autoplay entra tocando do zero; pausar acumula, tocar retoma, reiniciar zera', async () => {
    const { id } = await setup()
    const vid = await addScene(id, video(true))
    await ok(id, { op: 'preview', sceneId: vid })
    const take = await ok(id, { op: 'take' })
    const playing = (await liveOf(id)).playback
    assert.deepEqual([playing.sceneId, playing.playing, playing.positionMs], [vid, true, 0])
    within(playing.startedAt, take.before, take.after, 'startedAt')

    await wait(60)
    const pause = await ok(id, { op: 'playback', action: 'pause' })
    const paused = (await liveOf(id)).playback
    assert.equal(paused.playing, false)
    within(paused.positionMs, pause.before - playing.startedAt, pause.after - playing.startedAt, 'positionMs')
    assert.ok(paused.positionMs >= 50, `positionMs ${paused.positionMs}`)
    await ok(id, { op: 'playback', action: 'pause' }) // pausar de novo não muda nada
    assert.deepEqual((await liveOf(id)).playback, paused)

    const play = await ok(id, { op: 'playback', action: 'play' })
    const resumed = (await liveOf(id)).playback
    assert.deepEqual([resumed.playing, resumed.positionMs], [true, paused.positionMs]) // continua de onde parou
    within(resumed.startedAt, play.before, play.after, 'startedAt ao retomar')
    await ok(id, { op: 'playback', action: 'play' }) // tocar de novo não reinicia
    assert.deepEqual((await liveOf(id)).playback, resumed)

    const restart = await ok(id, { op: 'playback', action: 'restart' })
    const restarted = (await liveOf(id)).playback
    assert.deepEqual([restarted.playing, restarted.positionMs], [true, 0])
    within(restarted.startedAt, restart.before, restart.after, 'startedAt ao reiniciar')

    // Reiniciar pausado volta ao começo e continua pausado.
    await ok(id, { op: 'playback', action: 'pause' })
    await ok(id, { op: 'playback', action: 'restart' })
    const p = (await liveOf(id)).playback
    assert.deepEqual([p.sceneId, p.playing, p.positionMs], [vid, false, 0])
  })

  test('sem autoplay entra parado; sair do vídeo zera a reprodução', async () => {
    const { id, title } = await setup()
    const vid = await addScene(id, video(false))
    await ok(id, { op: 'preview', sceneId: vid })
    await ok(id, { op: 'take' })
    const p = (await liveOf(id)).playback
    assert.deepEqual([p.sceneId, p.playing, p.positionMs], [vid, false, 0])
    await ok(id, { op: 'playback', action: 'play' })
    assert.equal((await liveOf(id)).playback.playing, true)

    await ok(id, { op: 'preview', sceneId: title.id })
    await wait(TAKE_GAP)
    await ok(id, { op: 'take' })
    assert.deepEqual((await liveOf(id)).playback, defaultLive().playback)
    await ok(id, { op: 'playback', action: 'play' }) // o vídeo saiu do ar: comando sem efeito
    assert.deepEqual((await liveOf(id)).playback, defaultLive().playback)
  })

  test('apagar o vídeo no ar tira do ar e zera a reprodução; apagar a cena da prévia limpa a prévia', async () => {
    const { id, title } = await setup()
    const vid = await addScene(id, video(true))
    await ok(id, { op: 'preview', sceneId: vid })
    await ok(id, { op: 'take' })
    await ok(id, { op: 'preview', sceneId: title.id })
    assert.equal((await mod.req('DELETE', `/api/events/${id}/scenes/${vid}`)).status, 200)
    const l = await liveOf(id)
    assert.deepEqual([l.program, l.preview], [null, title.id])
    assert.deepEqual(l.playback, defaultLive().playback)
    await ok(id, { op: 'playback', action: 'pause' }) // nenhum vídeo no ar: sem efeito
    assert.deepEqual((await liveOf(id)).playback, defaultLive().playback)

    assert.equal((await mod.req('DELETE', `/api/events/${id}/scenes/${title.id}`)).status, 200)
    assert.equal((await liveOf(id)).preview, null)
    assert.match(await refused(mod, id, { op: 'take' }, 404), /^Nada na prévia/)
  })

  test('sem vídeo no ar, comandos de reprodução não fazem nada', async () => {
    const { id, title } = await setup()
    for (const action of ['play', 'pause', 'restart']) await ok(id, { op: 'playback', action })
    assert.deepEqual(await liveOf(id), defaultLive())
    await ok(id, { op: 'preview', sceneId: title.id })
    await ok(id, { op: 'take' })
    for (const action of ['play', 'pause', 'restart']) await ok(id, { op: 'playback', action })
    assert.deepEqual((await liveOf(id)).playback, defaultLive().playback)
  })
})

describe('audiências', () => {
  test('a tela recebe corte, espera, sobreposições e cronômetro, sem os dados do console', async () => {
    const { id, title } = await setup()
    const screen = await mod.stream(`/api/screen/stream?event=${id}`)
    try {
      const first = await screen.next<ScreenSnapshot>('state')
      assert.equal(first.program, null)
      assert.deepEqual(Object.keys(first).sort(), ['event', 'program', 'publicUrl', 'questions', 'serverNow'])
      assert.deepEqual(Object.keys(first.event).sort(), ['id', 'live', 'name', 'openJoin', 'pin', 'reactions', 'theme'])

      await ok(id, { op: 'preview', sceneId: title.id })
      await ok(id, { op: 'take', transition: 'fade' })
      const onAir = await screen.next<ScreenSnapshot>('state', { where: (s) => s.program !== null })
      assert.deepEqual(onAir.program, title)
      assert.deepEqual([onAir.event.live.program, onAir.event.live.transition], [title.id, 'fade'])

      await ok(id, { op: 'standby', on: true })
      const standby = await screen.next<ScreenSnapshot>('state', { where: (s) => s.event.live.standby })
      assert.equal(standby.program?.id, title.id)

      await ok(id, { op: 'overlays', join: true })
      await screen.next<ScreenSnapshot>('state', { where: (s) => s.event.live.overlays.join })

      await ok(id, { op: 'timer', action: 'start' })
      const timer = await screen.next<ScreenSnapshot>('state', { where: (s) => s.event.live.timer.running })
      assert.ok(timer.event.live.timer.startedAt > 0)
    } finally {
      screen.close()
    }
  })

  test('o celular vê a cena no ar e deixa de ver na espera; a prévia não chega a ele', async () => {
    const { id, title } = await setup()
    const { phone } = await joinParticipant(mod, id)
    const s = await phone.stream(`/api/p/${id}/stream`)
    try {
      assert.equal((await s.next<ParticipantSnapshot>('state')).now, null)
      await ok(id, { op: 'preview', sceneId: title.id })
      const fresh = await phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)
      assert.equal(fresh.now, null)
      assert.ok(!JSON.stringify(fresh).includes(title.id), 'o celular não pode saber o que está na prévia')

      await ok(id, { op: 'take' })
      const onAir = await s.next<ParticipantSnapshot>('state', { where: (p) => p.now !== null })
      assert.deepEqual(onAir.now, { sceneId: title.id, type: 'title', label: 'Aula magna', questions: [] })

      await ok(id, { op: 'standby', on: true })
      await s.next<ParticipantSnapshot>('state', { where: (p) => p.now === null })
      await ok(id, { op: 'standby', on: false })
      await s.next<ParticipantSnapshot>('state', { where: (p) => p.now?.sceneId === title.id })
    } finally {
      s.close()
    }
  })
})

describe('entrada e acesso', () => {
  test('comando inválido: 400 com mensagem em pt-BR e estado intacto', async () => {
    const { id, title } = await setup()
    await ok(id, { op: 'preview', sceneId: title.id })
    const before = await liveOf(id)
    const cases: unknown[] = [
      { op: 'explode' },
      {},
      null,
      [],
      'take',
      { op: 'take', transition: 'wipe' },
      { op: 'standby' },
      { op: 'standby', on: 'sim' },
      { op: 'overlays', join: 1 },
      { op: 'preview' },
      { op: 'preview', sceneId: 42 },
      { op: 'playback', action: 'stop' },
    ]
    for (const cmd of cases) await refused(mod, id, cmd, 400)
    assert.match(await refused(mod, id, { op: 'explode' }, 400), /^Valor de discriminação inválido/)

    const malformed = await mod.raw('POST', `/api/events/${id}/live`, {
      body: '{"op": "take"',
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(malformed.status, 400)
    assertPtBr(((await malformed.json()) as { error: string }).error)
    assert.deepEqual(await liveOf(id), before)
  })

  test('sem sessão de moderador: 401; participante não opera o switcher; evento inexistente: 404', async () => {
    const { id, title } = await setup()
    const cmd = { op: 'preview', sceneId: title.id }
    assert.match(await refused(new Client(), id, cmd, 401), /sessão/)
    const forged = new Client()
    forged.jar.set('deck_mod', 'moderador-falso.0')
    await refused(forged, id, cmd, 401)
    const { phone } = await joinParticipant(mod, id)
    await refused(phone, id, cmd, 401)
    await refused(phone, id, { op: 'standby', on: true }, 401)
    // "U" não faz parte do alfabeto dos códigos de evento: este código nunca existe.
    assert.equal(await refused(mod, 'UUUUUU', cmd, 404), 'Evento não encontrado.')
    assert.deepEqual(await liveOf(id), defaultLive())
  })

  test('comando vindo de outro site é bloqueado (CSRF)', async () => {
    const { id } = await setup()
    const res = await mod.raw('POST', `/api/events/${id}/live`, {
      body: JSON.stringify({ op: 'standby', on: true }),
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    })
    assert.equal(res.status, 403)
    assert.deepEqual(await liveOf(id), defaultLive())
  })
})

describe('funções puras do relógio (shared/types.ts)', () => {
  const timer = (t: Partial<TimerState>): TimerState => ({ ...defaultLive().timer, ...t })
  const playback = (p: Partial<PlaybackState>): PlaybackState => ({ ...defaultLive().playback, ...p })

  test('timerElapsed: parado devolve o acumulado; correndo soma o tempo desde o início', () => {
    assert.equal(timerElapsed(timer({ running: false, startedAt: 1_000, elapsedMs: 4_000 }), 50_000), 4_000)
    assert.equal(timerElapsed(timer({ running: true, startedAt: 10_000, elapsedMs: 0 }), 10_000), 0)
    assert.equal(timerElapsed(timer({ running: true, startedAt: 10_000, elapsedMs: 0 }), 12_500), 2_500)
    assert.equal(timerElapsed(timer({ running: true, startedAt: 10_000, elapsedMs: 4_000 }), 12_500), 6_500)
    // Relógio local atrás do início (offset ainda não corrigido): não desconta do acumulado.
    assert.equal(timerElapsed(timer({ running: true, startedAt: 10_000, elapsedMs: 4_000 }), 9_000), 4_000)
  })

  test('playbackPosition: pausado devolve a posição; tocando soma o tempo desde o início', () => {
    assert.equal(playbackPosition(playback({ playing: false, startedAt: 1_000, positionMs: 7_000 }), 99_000), 7_000)
    assert.equal(playbackPosition(playback({ playing: true, startedAt: 20_000, positionMs: 0 }), 21_250), 1_250)
    assert.equal(playbackPosition(playback({ playing: true, startedAt: 20_000, positionMs: 7_000 }), 21_250), 8_250)
    assert.equal(playbackPosition(playback({ playing: true, startedAt: 20_000, positionMs: 7_000 }), 19_000), 7_000)
  })
})
