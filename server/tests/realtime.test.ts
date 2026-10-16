// Propagação em tempo real: tudo o que a moderação faz chega à tela do evento, aos outros consoles e aos
// celulares dentro dos limites (consoles e tela em até 300 ms; celulares em até 1,5 s), sem acordar quem não é alvo.
// Cada teste cria o próprio evento com quatro conexões abertas: console da Ana, console da Bia, tela pareada e um celular.
import { before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { asModerator, Client, createEvent, joinParticipant, live, wait, type Sse } from './helpers.ts'
import {
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  onScreen,
  playbackPosition,
  timerElapsed,
  type Counts,
  type LiveState,
  type ModeratorSnapshot,
  type ParticipantSnapshot,
  type PublicQuestion,
  type Question,
  type ScreenSnapshot,
} from '../../shared/types.ts'

const FAST = 300 // consoles e tela (o servidor agrupa em 40 ms)
const SLOW = 1500 // celulares (agrupados em 500 ms)
const QUIET = 700 // janela em que quem não é alvo não pode receber estado novo
const COUNTS = 400 // contadores de reações e curtidas (no máximo 4 envios por segundo)

type WithLive = { event: { live: LiveState } }

/**
 * Marca o instante de uma ação: dali em diante só contam mensagens novas e os prazos correm da marca.
 * O cursor do leitor (helpers.ts) vai para o fim, então `next` só enxerga o que chegar depois.
 */
function mark(...streams: Sse[]) {
  const t0 = performance.now()
  const from = new Map(streams.map((s) => [s, s.messages.length]))
  for (const s of streams) s['cursor'] = s.messages.length
  const fresh = (s: Sse, event: string) => s.messages.slice(from.get(s) ?? 0).filter((m) => m.event === event)
  return {
    t0,
    /** Quantas mensagens `event` chegaram desde a marca. */
    count: (s: Sse, event: string) => fresh(s, event).length,
    /** Próxima mensagem nova `event` que satisfaz `where`; falha se não chegar em `ms` desde a marca. Devolve a latência. */
    async arrives<T>(s: Sse, event: string, where: (data: T) => boolean, ms: number): Promise<{ data: T; ms: number }> {
      try {
        const data = await s.next<T>(event, { where, timeout: Math.max(1, t0 + ms - performance.now()) })
        return { data, ms: performance.now() - t0 }
      } catch (e) {
        assert.fail(`"${event}" esperado não chegou em ${ms} ms (${fresh(s, event).length} novas): ${(e as Error).message}`)
      }
    },
    /** Nenhuma mensagem nova `event` em `ms` desde a marca. */
    async silent(s: Sse, event: string, ms: number) {
      await wait(Math.max(0, t0 + ms - performance.now()))
      const extra = fresh(s, event)
      assert.equal(extra.length, 0, `"${event}" inesperado: ${extra.map((m) => m.data.slice(0, 160)).join(' | ')}`)
    },
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!

let ana: Client // moderadora principal
let bia: Client // segunda moderadora, com o console aberto ao mesmo tempo
let claims = 0
/** Quem digita o código da tela. Alterna porque cada moderador pareia no máximo 20 telas a cada 10 min. */
const claimer = () => (claims++ % 2 ? bia : ana)

before(async () => {
  ana = await asModerator()
  const account = { name: 'Bia Moderadora', email: 'bia@exemplo.com', password: 'outra-senha-123' }
  assert.equal((await ana.req('POST', '/api/moderators', account)).status, 201)
  bia = new Client()
  assert.equal((await bia.req('POST', '/api/auth/login', { email: account.email, password: account.password })).status, 200)
})

/** Pareia um computador de projeção novo ao evento, como na página /tela. */
async function pairScreen(eventId: string) {
  const projector = new Client()
  const { data } = await projector.req('POST', '/api/screen/pair')
  const claim = await claimer().req('POST', `/api/events/${eventId}/screens`, { code: data.code })
  assert.equal(claim.status, 201, JSON.stringify(claim.data))
  return { projector, screenId: claim.data.id as string }
}

/** Evento novo com tudo aberto: consoles da Ana e da Bia, tela pareada e o celular de um participante. */
async function stage(name: string) {
  const first = await createEvent(ana, name)
  const id = first.event.id
  const [title, questions, timer] = first.scenes
  const { phone, participant } = await joinParticipant(ana, id)
  const { projector, screenId } = await pairScreen(id)
  const screen = await projector.stream('/api/screen/stream')
  const phoneS = await phone.stream(`/api/p/${id}/stream`)
  const modA = await ana.stream(`/api/events/${id}/stream`)
  const modB = await bia.stream(`/api/events/${id}/stream`)
  const streams = [modA, modB, screen, phoneS]
  // Estado inicial de cada audiência; os consoles também precisam já ver a tela e o celular conectados.
  const present = { where: (m: ModeratorSnapshot) => m.presence.screens === 1 && m.presence.participants === 1 }
  await Promise.all([screen.next('state'), phoneS.next('state'), modA.next('state', present), modB.next('state', present)])
  return {
    id,
    title: title!,
    questions: questions!,
    timer: timer!,
    phone,
    participant,
    projector,
    screenId,
    modA,
    modB,
    screen,
    phoneS,
    mark: () => mark(...streams),
    close: () => streams.forEach((s) => s.close()),
  }
}

type Stage = Awaited<ReturnType<typeof stage>>

const withStage = (name: string, fn: (s: Stage) => Promise<void>) => async () => {
  const s = await stage(name)
  try {
    await fn(s)
  } finally {
    s.close()
  }
}

/** Põe a cena no ar (prévia + corte) e espera todas as audiências verem o corte. */
async function onAir(s: Stage, sceneId: string) {
  const t = s.mark()
  assert.equal((await live(ana, s.id, { op: 'preview', sceneId })).status, 200)
  assert.equal((await live(ana, s.id, { op: 'take' })).status, 200)
  await Promise.all([
    t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.program?.id === sceneId, FAST),
    t.arrives<ModeratorSnapshot>(s.modA, 'state', (m) => m.event.live.program === sceneId, FAST),
    t.arrives<ModeratorSnapshot>(s.modB, 'state', (m) => m.event.live.program === sceneId, FAST),
    t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.sceneId === sceneId, SLOW),
  ])
}

/** Cria perguntas já aprovadas pela moderação e devolve-as na ordem dos textos. */
async function moderatorQuestions(s: Stage, items: [text: string, author: string][]): Promise<Question[]> {
  for (const [text, author] of items) assert.equal((await ana.req('POST', `/api/events/${s.id}/questions`, { text, author })).status, 201)
  const snap = await s.modA.next<ModeratorSnapshot>('state', { where: (m) => items.every(([text]) => m.questions.some((q) => q.text === text)) })
  return items.map(([text]) => snap.questions.find((q) => q.text === text)!)
}

const reactions = (s: Stage, phone: Client, kinds: Record<string, number>) => phone.req('POST', `/api/p/${s.id}/reactions`, { kinds })

// Quatro por vez: com todos juntos, dezenas de conexões no mesmo processo distorcem as medições de tempo.
describe('cada ação da moderação chega em tempo real às audiências certas', { concurrency: 4 }, () => {
  test(
    'prévia: consoles e tela recebem a cena escolhida; celulares não recebem estado novo',
    withStage('Prévia', async (s) => {
      const t = s.mark()
      assert.deepEqual((await live(ana, s.id, { op: 'preview', sceneId: s.questions.id })).data, { ok: true })
      const inPreview = (m: WithLive) => m.event.live.preview === s.questions.id
      const [screen] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', inPreview, FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', inPreview, FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', inPreview, FAST),
        t.silent(s.phoneS, 'state', QUIET),
      ])
      assert.equal(screen.data.program, null) // prévia não vai ao ar

      // Comando recusado não publica nada.
      const t2 = s.mark()
      const bad = await live(ana, s.id, { op: 'preview', sceneId: 'cena-que-nao-existe' })
      assert.deepEqual([bad.status, bad.data], [404, { error: 'Cena não encontrada.' }])
      await t2.silent(s.screen, 'state', FAST)
    }),
  )

  test(
    'corte: a tela troca o programa na hora e o celular passa a mostrar a cena no ar',
    withStage('Aula aberta', async (s) => {
      await live(ana, s.id, { op: 'preview', sceneId: s.title.id })
      let t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'take', transition: 'fade' })).status, 200)
      const taken = performance.now()
      const program = (id: string) => (m: WithLive) => m.event.live.program === id
      const [screen, , , phone] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.program?.id === s.title.id, FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', program(s.title.id), FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', program(s.title.id), FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.sceneId === s.title.id, SLOW),
      ])
      const { live: onAirNow } = screen.data.event
      assert.deepEqual(
        { program: onAirNow.program, preview: onAirNow.preview, transition: onAirNow.transition, content: screen.data.program?.content },
        { program: s.title.id, preview: null, transition: 'fade', content: { kicker: '', title: 'Aula aberta', body: '' } },
      )
      assert.deepEqual(phone.data.now, { sceneId: s.title.id, type: 'title', label: 'Aula aberta', questions: [] })

      // Segundo corte (passada a proteção de 400 ms contra toque duplo): perguntas entram, o título volta à prévia.
      await live(ana, s.id, { op: 'preview', sceneId: s.questions.id })
      await wait(Math.max(0, taken + 420 - performance.now()))
      t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'take' })).status, 200)
      const [screen2, phone2] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.program?.id === s.questions.id, FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.sceneId === s.questions.id, SLOW),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', program(s.questions.id), FAST),
      ])
      assert.equal(screen2.data.event.live.preview, s.title.id)
      assert.equal(screen2.data.event.live.transition, 'cut')
      assert.deepEqual(phone2.data.now, { sceneId: s.questions.id, type: 'questions', label: 'Perguntas', questions: [] })
    }),
  )

  test(
    'tela de espera: a tela recebe a espera na hora e o celular deixa de ver a cena; ao sair, ela volta',
    withStage('Espera', async (s) => {
      await onAir(s, s.title.id)
      let t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'standby', on: true })).status, 200)
      const standby = (on: boolean) => (m: WithLive) => m.event.live.standby === on
      const [screen] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', standby(true), FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', standby(true), FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', standby(true), FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now === null, SLOW),
      ])
      assert.equal(screen.data.program?.id, s.title.id) // a cena segue escolhida; a tela é que mostra a espera

      t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'standby', on: false })).status, 200)
      await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', standby(false), FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.sceneId === s.title.id, SLOW),
      ])
    }),
  )

  test(
    'sobreposições: QR de entrada e reações chegam à tela sem acordar os celulares',
    withStage('Sobreposições', async (s) => {
      let t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'overlays', join: true })).status, 200)
      const join = (m: WithLive) => m.event.live.overlays.join
      const [screen] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', join, FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', join, FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', join, FAST),
        t.silent(s.phoneS, 'state', QUIET),
      ])
      assert.deepEqual(screen.data.event.live.overlays, { join: true, reactions: true })

      t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'overlays', reactions: false })).status, 200)
      const off = await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => !m.event.live.overlays.reactions, FAST)
      assert.deepEqual(off.data.event.live.overlays, { join: true, reactions: false }) // o campo omitido mantém o valor
    }),
  )

  test(
    'cronômetro: definir, iniciar e pausar chegam à tela com o relógio do servidor; celulares não são acordados',
    withStage('Cronômetro', async (s) => {
      let t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 90_000, label: 'Fala do convidado' })).status, 200)
      const set = await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.event.live.timer.label === 'Fala do convidado', FAST)
      const { mode, durationMs, running, elapsedMs, sceneId } = set.data.event.live.timer
      assert.deepEqual({ mode, durationMs, running, elapsedMs, sceneId }, { mode: 'countdown', durationMs: 90_000, running: false, elapsedMs: 0, sceneId: null })

      t = s.mark()
      const before = Date.now()
      assert.equal((await live(ana, s.id, { op: 'timer', action: 'start' })).status, 200)
      const after = Date.now()
      const isRunning = (on: boolean) => (m: WithLive) => m.event.live.timer.running === on
      const [started] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', isRunning(true), FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', isRunning(true), FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', isRunning(true), FAST),
        t.silent(s.phoneS, 'state', QUIET),
      ])
      const { startedAt } = started.data.event.live.timer
      assert.ok(startedAt >= before && startedAt <= after, 'início carimbado com o relógio do servidor')

      t = s.mark()
      const pausing = Date.now()
      assert.equal((await live(ana, s.id, { op: 'timer', action: 'pause' })).status, 200)
      const paused = (await t.arrives<ScreenSnapshot>(s.screen, 'state', isRunning(false), FAST)).data.event.live.timer
      assert.ok(paused.elapsedMs >= pausing - after && paused.elapsedMs <= Date.now() - before, `decorrido ${paused.elapsedMs} ms`)
      assert.equal(timerElapsed(paused, Date.now() + 60_000), paused.elapsedMs) // pausado, o relógio não anda
    }),
  )

  test(
    'vídeo: tocar, pausar e reiniciar chegam à tela sem acordar os celulares',
    withStage('Vídeo', async (s) => {
      const content = { src: 'https://example.com/vinheta.mp4', fit: 'cover', loop: false, autoplay: false }
      const created = await ana.req('POST', `/api/events/${s.id}/scenes`, { type: 'video', name: 'Vinheta', content })
      assert.equal(created.status, 201)
      const video: string = created.data.id
      await onAir(s, video)

      let t = s.mark()
      const before = Date.now()
      assert.equal((await live(ana, s.id, { op: 'playback', action: 'play' })).status, 200)
      const after = Date.now()
      const isPlaying = (on: boolean) => (m: WithLive) => m.event.live.playback.playing === on
      const [playing] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', isPlaying(true), FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', isPlaying(true), FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', isPlaying(true), FAST),
        t.silent(s.phoneS, 'state', QUIET),
      ])
      const p = playing.data.event.live.playback
      assert.equal(p.sceneId, video)
      assert.ok(p.startedAt >= before && p.startedAt <= after)

      t = s.mark()
      const pausing = Date.now()
      assert.equal((await live(ana, s.id, { op: 'playback', action: 'pause' })).status, 200)
      const paused = (await t.arrives<ScreenSnapshot>(s.screen, 'state', isPlaying(false), FAST)).data.event.live.playback
      assert.ok(paused.positionMs >= pausing - after && paused.positionMs <= Date.now() - before, `posição ${paused.positionMs} ms`)
      assert.equal(playbackPosition(paused, Date.now() + 10_000), paused.positionMs) // pausado, o vídeo não anda

      t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'playback', action: 'restart' })).status, 200)
      const restarted = await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.event.live.playback.positionMs === 0, FAST)
      assert.equal(restarted.data.event.live.playback.playing, false)
    }),
  )

  test(
    'perguntas na tela: destacar, acrescentar, limite, ordem e limpar chegam à tela e ao celular, iguais ao monitor do console',
    withStage('Perguntas', async (s) => {
      const fila = await ana.req('POST', `/api/events/${s.id}/scenes`, {
        type: 'questions',
        name: 'Fila',
        content: { title: 'Perguntas do público', layout: 'list', max: 3, showAuthor: true, showLikes: true },
      })
      assert.equal(fila.status, 201)
      const sceneId: string = fila.data.id
      const [maria, anon, pedro] = await moderatorQuestions(s, [
        ['Como funciona o SSE?', 'Maria Clara Souza'],
        ['E o WebSocket?', ''],
        ['Qual a latência na rede local?', 'Pedro'],
      ])
      // Pergunta do celular: chega pendente.
      assert.equal((await s.phone.req('POST', `/api/p/${s.id}/questions`, { text: 'Dá para usar no celular?' })).status, 201)
      const mine = (
        await s.modA.next<ModeratorSnapshot>('state', { where: (m) => m.questions.some((q) => q.participantId === s.participant.id) })
      ).questions.find((q) => q.participantId === s.participant.id)!
      assert.equal(mine.status, 'pending')
      await onAir(s, sceneId)

      const pub = (q: Question, author: string | null): PublicQuestion => ({ id: q.id, text: q.text, author, likes: 0 })
      /** Um comando da fila: tela em até 300 ms (igual ao que o console calcula com onScreen); celular quando pedido. */
      const step = async (path: string, body: unknown, want: PublicQuestion[], phone = false) => {
        const t = s.mark()
        assert.equal((await ana.req('POST', `/api/events/${s.id}/questions/${path}`, body)).status, 200)
        const [screen, mod, own] = await Promise.all([
          t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => isDeepStrictEqual(m.questions, want), FAST),
          t.arrives<ModeratorSnapshot>(s.modB, 'state', (m) => isDeepStrictEqual(onScreen(m.questions, 3, m.event.settings.screenName), want), FAST),
          phone &&
            t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => isDeepStrictEqual(m.now?.questions, want.map((q) => ({ ...q, liked: false }))), SLOW),
        ])
        return { screen: screen.data, mod: mod.data, phone: own ? own.data : null }
      }

      // Destaque: só ela na tela. A tela recebe o formato público (sem participante, original, status ou marcação).
      const first = await step(`${maria.id}/screen`, { on: true, solo: true }, [pub(maria, 'Maria S.')], true)
      assert.deepEqual(Object.keys(first.screen).sort(), ['event', 'program', 'publicUrl', 'questions', 'serverNow'])
      // Acrescentar: entra no fim da fila; anônima aparece sem autor.
      await step(`${anon.id}/screen`, { on: true }, [pub(maria, 'Maria S.'), pub(anon, null)])
      // Pendente do celular: exibir já aprova, e o autor vê a própria pergunta na tela.
      const approved = await step(`${mine.id}/screen`, { on: true }, [pub(maria, 'Maria S.'), pub(anon, null), pub(mine, 'João S.')], true)
      assert.equal(approved.mod.questions.find((q) => q.id === mine.id)?.status, 'approved')
      const own = approved.phone!.mine[0]
      assert.deepEqual([own?.id, own?.status, own?.onScreen], [mine.id, 'approved', true])
      // Acima do limite da cena (3): a quarta entra na fila do console, fora da tela.
      const full = await step(`${pedro.id}/screen`, { on: true }, [pub(maria, 'Maria S.'), pub(anon, null), pub(mine, 'João S.')])
      assert.notEqual(full.mod.questions.find((q) => q.id === pedro.id)?.screen, null)
      // Tirar a primeira: as outras sobem na ordem de exibição.
      await step(`${maria.id}/screen`, { on: false }, [pub(anon, null), pub(mine, 'João S.'), pub(pedro, 'Pedro')])
      // Destacar outra com resposta automática: as que estavam na tela viram "respondidas".
      const solo = await step(`${pedro.id}/screen`, { on: true, solo: true }, [pub(pedro, 'Pedro')], true)
      const status = Object.fromEntries(solo.mod.questions.map((q) => [q.text, q.status]))
      assert.deepEqual(status, {
        'Como funciona o SSE?': 'approved',
        'E o WebSocket?': 'answered',
        'Qual a latência na rede local?': 'approved',
        'Dá para usar no celular?': 'answered',
      })
      // Limpar: some da tela e do celular.
      await step('screen/clear', {}, [], true)
    }),
  )

  test(
    'edição de pergunta no ar: tela e celular veem o texto novo; editar fora da tela não acorda a tela',
    withStage('Edição de pergunta', async (s) => {
      const [q, other] = await moderatorQuestions(s, [
        ['Como o SSE reconeta?', 'Ana Souza'],
        ['Pergunta guardada', 'Lia'],
      ])
      await onAir(s, s.questions.id)
      let t = s.mark()
      assert.equal((await ana.req('POST', `/api/events/${s.id}/questions/${q.id}/screen`, { on: true, solo: true })).status, 200)
      await t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.questions[0]?.id === q.id, SLOW)

      t = s.mark()
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}/questions/${q.id}`, { text: '  Como o   SSE reconecta?  ' })).status, 200)
      const fixed = 'Como o SSE reconecta?'
      const [, mod] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.questions[0]?.text === fixed, FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', (m) => m.questions.some((x) => x.id === q.id && x.text === fixed), FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.questions[0]?.text === fixed, SLOW),
      ])
      assert.equal(mod.data.questions.find((x) => x.id === q.id)?.original, 'Como o SSE reconeta?') // o original fica para a moderação

      // Tornar anônima no ar: o nome sai da tela e do celular.
      t = s.mark()
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}/questions/${q.id}`, { anonymous: true })).status, 200)
      await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.questions[0]?.id === q.id && m.questions[0]?.author === null, FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.questions[0]?.author === null, SLOW),
      ])

      // Fora da tela: só os consoles recebem.
      t = s.mark()
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}/questions/${other.id}`, { text: 'Pergunta guardada, revisada' })).status, 200)
      await Promise.all([
        t.arrives<ModeratorSnapshot>(s.modA, 'state', (m) => m.questions.some((x) => x.text === 'Pergunta guardada, revisada'), FAST),
        t.silent(s.screen, 'state', 400),
        t.silent(s.phoneS, 'state', QUIET),
      ])
    }),
  )

  test(
    'edição de cena: a cena no ar muda na tela na hora, inclusive o cronômetro correndo; fora do ar, só os consoles recebem',
    withStage('Edição de cena', async (s) => {
      await onAir(s, s.title.id)
      let t = s.mark()
      const content = { kicker: 'Agora', title: 'Painel: o futuro do SSE', body: 'Com convidados' }
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}/scenes/${s.title.id}`, { content })).status, 200)
      await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => isDeepStrictEqual(m.program?.content, content), FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', (m) => isDeepStrictEqual(m.scenes.find((x) => x.id === s.title.id)?.content, content), FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.now?.label === content.title, SLOW),
      ])

      t = s.mark()
      const other = { title: 'Dúvidas', layout: 'grid', max: 4, showAuthor: false, showLikes: true }
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}/scenes/${s.questions.id}`, { name: 'Dúvidas', content: other })).status, 200)
      const edited = (m: ModeratorSnapshot) => m.scenes.some((x) => x.id === s.questions.id && x.name === 'Dúvidas' && isDeepStrictEqual(x.content, other))
      await Promise.all([
        t.arrives<ModeratorSnapshot>(s.modA, 'state', edited, FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', edited, FAST),
        t.silent(s.screen, 'state', 400),
        t.silent(s.phoneS, 'state', QUIET),
      ])

      // Cronômetro no ar e correndo: a nova duração chega à tela sem zerar o tempo decorrido.
      await onAir(s, s.timer.id)
      t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'timer', action: 'start' })).status, 200)
      const started = (await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.event.live.timer.running, FAST)).data.event.live.timer
      assert.deepEqual([started.sceneId, started.durationMs], [s.timer.id, 600_000])
      t = s.mark()
      const longer = { title: 'Intervalo', mode: 'countdown', durationSec: 900, warnSec: 120, criticalSec: 30, onEnd: 'message', endText: 'Retomando' }
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}/scenes/${s.timer.id}`, { content: longer })).status, 200)
      const after = (await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.event.live.timer.durationMs === 900_000, FAST)).data
      assert.deepEqual([after.event.live.timer.running, after.event.live.timer.startedAt], [true, started.startedAt])
      assert.equal(after.program?.type === 'timer' && after.program.content.durationSec, 900)
    }),
  )

  test(
    'aparência: o tema salvo chega inteiro à tela e o recorte de marca ao celular; o tema padrão passa na validação',
    withStage('Aparência', async (s) => {
      const theme = { ...DEFAULT_THEME, brand: '#2277D3', mode: 'light', footer: 'Transmissão ao vivo', overrides: { accent: '#1155AA' } }
      let t = s.mark()
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}`, { theme })).status, 200)
      const saved = (m: { event: { theme: unknown } }) => isDeepStrictEqual(m.event.theme, theme)
      const brand = { brand: theme.brand, contrast: theme.contrast, logo: theme.logo, fonts: theme.fonts }
      await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', saved, FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', saved, FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', saved, FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => isDeepStrictEqual(m.event.theme, brand), SLOW),
      ])

      // O tema padrão do contrato (ponto de partida do editor) é aceito como está.
      t = s.mark()
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}`, { theme: DEFAULT_THEME })).status, 200)
      await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => isDeepStrictEqual(m.event.theme, DEFAULT_THEME), FAST)

      // Tema inválido: 400 em pt-BR e nada é publicado.
      t = s.mark()
      const bad = await ana.req('PATCH', `/api/events/${s.id}`, { theme: { ...DEFAULT_THEME, brand: 'azul' } })
      assert.deepEqual([bad.status, bad.data], [400, { error: 'Use uma cor no formato #RRGGBB.' }])
      await t.silent(s.screen, 'state', FAST)
    }),
  )

  test(
    'configurações: perguntas e reações fechadas chegam ao celular e valem na hora; termos sensíveis nunca saem da moderação',
    withStage('Configurações', async (s) => {
      await onAir(s, s.title.id)
      let t = s.mark()
      const closed = { questionsOpen: false, reactionsOpen: false }
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}`, { settings: closed })).status, 200)
      await Promise.all([
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => !m.event.settings.questionsOpen && !m.event.settings.reactionsOpen, SLOW),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', (m) => !m.event.settings.questionsOpen && !m.event.settings.reactionsOpen, FAST),
      ])
      const ask = await s.phone.req('POST', `/api/p/${s.id}/questions`, { text: 'Ainda dá para perguntar?' })
      assert.deepEqual([ask.status, ask.data], [403, { error: 'O envio de perguntas está fechado.' }])
      const clap = await reactions(s, s.phone, { applause: 1 })
      assert.deepEqual([clap.status, clap.data], [403, { error: 'Reações pausadas pela moderação.' }])

      // As configurações padrão do contrato são aceitas inteiras; entrada aberta e reações escolhidas chegam à tela.
      t = s.mark()
      const settings = { ...DEFAULT_SETTINGS, openJoin: true, reactions: ['love', 'laugh'], flagWords: ['golpe'] }
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}`, { settings })).status, 200)
      const [screen, phone] = await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.event.openJoin && isDeepStrictEqual(m.event.reactions, ['love', 'laugh']), FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', (m) => m.event.settings.questionsOpen, SLOW),
      ])
      assert.deepEqual(phone.data.event.settings, { questionsOpen: true, reactionsOpen: true, identity: 'name', maxLength: 200, reactions: ['love', 'laugh'] })
      assert.deepEqual(Object.keys(screen.data.event).sort(), ['id', 'live', 'name', 'openJoin', 'pin', 'reactions', 'theme'])
      assert.ok(!JSON.stringify(screen.data).includes('golpe') && !JSON.stringify(phone.data).includes('golpe'))
    }),
  )

  test(
    'renomear o evento: o nome novo chega a consoles, tela e celular; nome vazio é recusado sem publicar',
    withStage('Nome antigo', async (s) => {
      let t = s.mark()
      assert.equal((await ana.req('PATCH', `/api/events/${s.id}`, { name: '  Semana de Tecnologia 2026  ' })).status, 200)
      const named = (m: { event: { name: string } }) => m.event.name === 'Semana de Tecnologia 2026'
      await Promise.all([
        t.arrives<ScreenSnapshot>(s.screen, 'state', named, FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', named, FAST),
        t.arrives<ModeratorSnapshot>(s.modB, 'state', named, FAST),
        t.arrives<ParticipantSnapshot>(s.phoneS, 'state', named, SLOW),
      ])

      t = s.mark()
      const bad = await ana.req('PATCH', `/api/events/${s.id}`, { name: '   ' })
      assert.equal(bad.status, 400)
      assert.match(bad.data.error, /pequeno|caracter/i)
      await t.silent(s.screen, 'state', FAST)
    }),
  )

  test(
    'contadores: reações e curtidas chegam à tela e aos consoles em até ~400 ms, agrupadas, com totais exatos',
    withStage('Contadores', async (s) => {
      await onAir(s, s.title.id)
      // Sete celulares para a rajada (cada um envia no máximo 3 lotes a cada 2 s).
      const crowd: Client[] = []
      for (let i = 1; i <= 7; i++) crowd.push((await joinParticipant(ana, s.id, `Pessoa ${i}`)).phone)

      // Primeiro toque: mede o caminho até a tela e os consoles.
      let t = s.mark()
      assert.equal((await reactions(s, s.phone, { love: 2 })).status, 200)
      const first = (c: Counts) => c.reactions[s.title.id]?.love === 2
      await Promise.all([s.screen, s.modA, s.modB].map((x) => t.arrives<Counts>(x, 'counts', first, COUNTS)))

      // Rajada: 20 lotes de 7 celulares ao longo de ~0,5 s. Um lote traz reação desligada no evento (ignorada).
      const expected = { love: 2, applause: 0 }
      t = s.mark()
      for (let j = 0; j < 20; j++) {
        const kinds = { applause: 1 + (j % 3), love: 1, ...(j === 7 ? { laugh: 5 } : {}) }
        expected.applause += kinds.applause
        expected.love += kinds.love
        assert.equal((await reactions(s, crowd[j % 7]!, kinds)).status, 200)
        await wait(25)
      }
      const burst = performance.now() - t.t0
      const exact = (c: Counts) => isDeepStrictEqual(c.reactions[s.title.id], expected)
      await Promise.all([s.screen, s.modA, s.modB].map((x) => t.arrives<Counts>(x, 'counts', exact, burst + COUNTS)))
      const sent = t.count(s.screen, 'counts')
      assert.ok(sent <= Math.ceil(burst / 250) + 1 && sent <= 5, `${sent} envios de contadores para 20 lotes em ${burst.toFixed(0)} ms`)

      // Curtidas: total por pergunta; desfazer desconta; curtir de novo não conta em dobro.
      const [q] = await moderatorQuestions(s, [['Vale curtir?', 'Ana']])
      t = s.mark()
      for (const phone of crowd.slice(0, 3)) assert.equal((await phone.req('POST', `/api/p/${s.id}/questions/${q!.id}/like`, { on: true })).status, 200)
      await Promise.all([s.screen, s.modA].map((x) => t.arrives<Counts>(x, 'counts', (c) => c.likes[q!.id] === 3, COUNTS)))
      t = s.mark()
      assert.equal((await crowd[0]!.req('POST', `/api/p/${s.id}/questions/${q!.id}/like`, { on: false })).status, 200)
      assert.equal((await crowd[1]!.req('POST', `/api/p/${s.id}/questions/${q!.id}/like`, { on: true })).status, 200)
      const likes = await t.arrives<Counts>(s.screen, 'counts', () => true, COUNTS)
      assert.equal(likes.data.likes[q!.id], 2)
    }),
  )

  test(
    'zerar reações: a tela e os consoles recebem os contadores zerados na hora',
    withStage('Zerar reações', async (s) => {
      await onAir(s, s.title.id)
      let t = s.mark()
      assert.equal((await reactions(s, s.phone, { applause: 4 })).status, 200)
      await t.arrives<Counts>(s.screen, 'counts', (c) => c.reactions[s.title.id]?.applause === 4, COUNTS)

      t = s.mark()
      assert.equal((await ana.req('POST', `/api/events/${s.id}/reactions/reset`)).status, 200)
      const zero = (c: Counts) => isDeepStrictEqual(c.reactions, {})
      await Promise.all([s.screen, s.modA, s.modB].map((x) => t.arrives<Counts>(x, 'counts', zero, COUNTS)))
    }),
  )

  test('presença: o console conta celulares e telas conectados e atualiza quando saem', async () => {
    const first = await createEvent(ana, 'Presença')
    const id = first.event.id
    const { phone, participant } = await joinParticipant(ana, id, 'Rita Lima')
    const { projector } = await pairScreen(id)
    const desk = await ana.stream(`/api/events/${id}/stream`)
    try {
      const initial = await desk.next<ModeratorSnapshot>('state')
      assert.deepEqual([initial.presence.participants, initial.presence.screens], [0, 0])
      assert.deepEqual([initial.participants[0]?.online, initial.screens[0]?.online], [false, false])
      const online = (m: ModeratorSnapshot) => m.participants.find((p) => p.id === participant.id)!.online

      // Consoles: o próprio conta, e os outros veem quando mais alguém da moderação entra e sai.
      await desk.next<ModeratorSnapshot>('state', { where: (x) => x.presence.moderators === 1, timeout: FAST })
      let t = mark(desk)
      const other = await bia.stream(`/api/events/${id}/stream`)
      await t.arrives<ModeratorSnapshot>(desk, 'state', (x) => x.presence.moderators === 2, FAST)
      t = mark(desk)
      other.close()
      await t.arrives<ModeratorSnapshot>(desk, 'state', (x) => x.presence.moderators === 1, FAST)

      t = mark(desk)
      const tab1 = await phone.stream(`/api/p/${id}/stream`)
      let m = (await t.arrives<ModeratorSnapshot>(desk, 'state', (x) => x.presence.participants === 1, FAST)).data
      assert.equal(online(m), true)

      // Segunda aba do mesmo celular continua sendo uma pessoa.
      t = mark(desk)
      const tab2 = await phone.stream(`/api/p/${id}/stream`)
      m = (await t.arrives<ModeratorSnapshot>(desk, 'state', () => true, FAST)).data
      assert.deepEqual(m.presence, { participants: 1, screens: 0, moderators: 1 })

      t = mark(desk)
      const opened = Date.now()
      const screen = await projector.stream('/api/screen/stream')
      m = (await t.arrives<ModeratorSnapshot>(desk, 'state', (x) => x.presence.screens === 1, FAST)).data
      assert.equal(m.screens[0]?.online, true)
      assert.ok(m.screens[0]!.lastSeen! >= opened)

      // Fechar uma aba: a outra mantém a pessoa online; fechar a última tira.
      t = mark(desk)
      tab1.close()
      m = (await t.arrives<ModeratorSnapshot>(desk, 'state', () => true, FAST)).data
      assert.deepEqual([m.presence.participants, online(m)], [1, true])
      t = mark(desk)
      tab2.close()
      m = (await t.arrives<ModeratorSnapshot>(desk, 'state', (x) => x.presence.participants === 0, FAST)).data
      assert.equal(online(m), false)

      t = mark(desk)
      const closing = Date.now()
      screen.close()
      m = (await t.arrives<ModeratorSnapshot>(desk, 'state', (x) => x.presence.screens === 0, FAST)).data
      assert.equal(m.screens[0]?.online, false)
      assert.ok(m.screens[0]!.lastSeen! >= closing) // "visto por último" marca a saída
    } finally {
      desk.close()
    }
  })

  test(
    'excluir o evento: todas as audiências recebem "gone" e as conexões fecham',
    withStage('Exclusão', async (s) => {
      const t = s.mark()
      assert.equal((await ana.req('DELETE', `/api/events/${s.id}`)).status, 200)
      await Promise.all([s.modA, s.modB, s.screen, s.phoneS].map((x) => t.arrives(x, 'gone', () => true, FAST)))
      for (let i = 0; i < 50 && ![s.modA, s.modB, s.screen, s.phoneS].every((x) => x.closed); i++) await wait(10)
      assert.ok([s.modA, s.modB, s.screen, s.phoneS].every((x) => x.closed), 'conexões encerradas')

      // Ao reconectar: console e celular recebem 404; a tela volta a pedir um código de pareamento.
      assert.equal((await ana.req('GET', `/api/events/${s.id}/stream`)).status, 404)
      assert.equal((await s.phone.req('GET', `/api/p/${s.id}/stream`)).status, 404)
      const again = await s.projector.stream('/api/screen/stream')
      try {
        assert.match((await again.next<{ code: string }>('pairing')).code, /^[0-9A-HJKMNP-TV-Z]{6}$/)
      } finally {
        again.close()
      }
    }),
  )

  test(
    'desparear a tela: ela recebe "gone" (unpaired) na hora e o console vê a tela sair',
    withStage('Despareamento', async (s) => {
      const t = s.mark()
      assert.equal((await ana.req('DELETE', `/api/events/${s.id}/screens/${s.screenId}`)).status, 200)
      const [gone] = await Promise.all([
        t.arrives<{ reason?: string }>(s.screen, 'gone', () => true, FAST),
        t.arrives<ModeratorSnapshot>(s.modA, 'state', (m) => m.screens.length === 0 && m.presence.screens === 0, FAST),
        t.silent(s.phoneS, 'state', QUIET),
      ])
      assert.deepEqual(gone.data, { reason: 'unpaired' })
      const again = await s.projector.stream('/api/screen/stream')
      try {
        assert.match((await again.next<{ code: string }>('pairing')).code, /^[0-9A-HJKMNP-TV-Z]{6}$/)
      } finally {
        again.close()
      }
    }),
  )

  test('parear: a tela em espera recebe "paired" assim que a moderação digita o código e reconecta já no evento', async () => {
    const { event } = await createEvent(ana, 'Pareamento')
    const projector = new Client()
    assert.equal((await projector.req('POST', '/api/screen/pair')).status, 200)
    const waiting = await projector.stream('/api/screen/stream')
    try {
      const { code } = await waiting.next<{ code: string }>('pairing')
      const t = mark(waiting)
      assert.equal((await claimer().req('POST', `/api/events/${event.id}/screens`, { code })).status, 201)
      await t.arrives(waiting, 'paired', () => true, FAST)
      const screen = await projector.stream('/api/screen/stream')
      try {
        assert.equal((await screen.next<ScreenSnapshot>('state')).event.id, event.id)
      } finally {
        screen.close()
      }
    } finally {
      waiting.close()
    }
  })
})

test('latência até a tela: mediana do corte e do destaque de pergunta', async () => {
  const s = await stage('Medição')
  try {
    const qs = await moderatorQuestions(s, [
      ['Primeira pergunta medida', 'Ana'],
      ['Segunda pergunta medida', 'Bia'],
    ])
    // Cortes alternam perguntas e título (prévia e programa trocam de lugar a cada corte).
    const takes: number[] = []
    await live(ana, s.id, { op: 'preview', sceneId: s.questions.id })
    for (let i = 0; i < 5; i++) {
      if (i === 1) await live(ana, s.id, { op: 'preview', sceneId: s.title.id })
      const expected = i % 2 ? s.title.id : s.questions.id
      const t = s.mark()
      assert.equal((await live(ana, s.id, { op: 'take' })).status, 200)
      const done = performance.now()
      takes.push((await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.program?.id === expected, FAST)).ms)
      await wait(Math.max(0, done + 420 - performance.now())) // proteção contra toque duplo (400 ms)
    }
    // A cena de perguntas termina no ar: destaque alterna entre as duas.
    const spots: number[] = []
    for (let i = 0; i < 5; i++) {
      const q = qs[i % 2]!
      const t = s.mark()
      assert.equal((await ana.req('POST', `/api/events/${s.id}/questions/${q.id}/screen`, { on: true, solo: true })).status, 200)
      spots.push((await t.arrives<ScreenSnapshot>(s.screen, 'state', (m) => m.questions[0]?.id === q.id, FAST)).ms)
    }
    console.log(`latência até a tela (mediana de 5): corte ${median(takes).toFixed(0)} ms; destaque de pergunta ${median(spots).toFixed(0)} ms`)
    assert.ok(median(takes) <= FAST && median(spots) <= FAST)
  } finally {
    s.close()
  }
})

test('ping: o batimento leva o relógio do servidor como número', async () => {
  const { event } = await createEvent(ana, 'Batimento')
  // O batimento real é a cada 15 s: o relógio de timers é simulado só durante este teste.
  // Entre um avanço e outro, espera em tempo real: o banco pode estar na rede (Postgres) e responde no tempo dele.
  const realTimeout = globalThis.setTimeout
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const desk = await ana.stream(`/api/events/${event.id}/stream`)
    const before = Date.now()
    for (let i = 0; i < 100 && !desk.messages.some((m) => m.event === 'ping'); i++) {
      mock.timers.tick(15_000)
      await new Promise((r) => realTimeout(r, 10))
    }
    desk.close()
    mock.timers.tick(1_000) // roda o que a desconexão agendou antes de devolver os timers reais
    assert.deepEqual(desk.messages.slice(0, 2).map((m) => m.event), ['state', 'counts']) // ping só depois do intervalo
    const ping = desk.messages.find((m) => m.event === 'ping')
    assert.ok(ping, 'ping não chegou')
    assert.match(ping.data, /^\d+$/)
    assert.ok(Number(ping.data) >= before && Number(ping.data) <= Date.now())
  } finally {
    mock.timers.reset()
  }
})
