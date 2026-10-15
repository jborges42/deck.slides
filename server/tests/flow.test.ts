// Teste ponta a ponta da API: sobe o servidor num diretório temporário e percorre os fluxos principais.
// Rodar com `pnpm test`.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModeratorSnapshot, ParticipantSnapshot, ScreenSnapshot } from '../../shared/types.ts'

const PORT = 39_000 + Math.floor(Math.random() * 1000)
const BASE = `http://localhost:${PORT}`
const server = spawn(process.execPath, [new URL('../index.ts', import.meta.url).pathname], {
  env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'deck-test-')), PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
})
before(() => new Promise((resolve) => server.stdout!.once('data', resolve)))
after(() => server.kill())

class Client {
  jar = new Map<string, string>()
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        origin: BASE,
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      this.jar.set(pair.slice(0, i), pair.slice(i + 1))
    }
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  /** Primeiro snapshot `state` de um stream SSE. */
  async snapshot<T>(path: string): Promise<T> {
    const ctrl = new AbortController()
    const res = await fetch(BASE + path, {
      signal: ctrl.signal,
      headers: { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    })
    assert.equal(res.status, 200, `stream ${path}`)
    const reader = res.body!.getReader()
    let buf = ''
    while (!/event: state\ndata: .*\n/.test(buf)) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`stream ${path} terminou sem snapshot: ${buf}`)
      buf += new TextDecoder().decode(value)
    }
    ctrl.abort()
    return JSON.parse(buf.match(/event: state\ndata: (.*)\n/)![1])
  }
}

const mod = new Client()
const student = new Client()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('fluxo completo: conta, evento, convite com PIN, pergunta moderada e tela', { timeout: 20_000 }, async () => {
  assert.equal((await mod.req('GET', '/api/auth/me')).data.needsSetup, true)
  assert.equal((await mod.req('POST', '/api/auth/setup', { name: 'Ana', email: 'ana@ex.com', password: 'segredo123' })).status, 201)
  assert.equal((await new Client().req('POST', '/api/auth/setup', { name: 'X', email: 'x@ex.com', password: 'segredo123' })).status, 409)

  const { data: ev } = await mod.req('POST', '/api/events', { name: 'Aula Magna' })
  await mod.req('POST', `/api/events/${ev.id}/participants`, { people: [{ name: 'João Silva' }, { name: 'Maria' }] })
  let snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${ev.id}/stream`)
  assert.match(snap.event.pin, /^\d{6}$/)
  assert.match(ev.id, /^[0-9A-HJKMNP-TV-Z]{6}$/) // código curto do evento
  assert.deepEqual(snap.scenes.map((s) => s.type), ['title', 'questions', 'timer'])
  const joao = snap.participants.find((p) => p.name === 'João Silva')!
  const [titleScene, questionsScene, timerScene] = snap.scenes

  // Convite: nome visível antes do PIN; PIN errado recusado; certo abre sessão.
  assert.equal((await student.req('GET', `/api/invite/${joao.token}`)).data.participant.name, 'João Silva')
  assert.equal((await student.req('POST', `/api/invite/${joao.token}`, { pin: '000000x' })).status, 401)
  assert.equal((await student.req('POST', `/api/p/${ev.id}/questions`, { text: 'sem sessão' })).status, 401)
  assert.equal((await student.req('POST', `/api/invite/${joao.token}`, { pin: snap.event.pin })).status, 200)

  // Pergunta: chega pendente, moderador corrige, aprova e coloca na tela.
  assert.equal((await student.req('POST', `/api/p/${ev.id}/questions`, { text: 'Qual   a difrença entre SSE e WebSocket?' })).status, 201)
  snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${ev.id}/stream`)
  const q = snap.questions[0]
  assert.equal(q.status, 'pending')
  assert.equal(q.text, 'Qual a difrença entre SSE e WebSocket?')
  await mod.req('PATCH', `/api/events/${ev.id}/questions/${q.id}`, { text: 'Qual a diferença entre SSE e WebSocket?', status: 'approved' })
  await mod.req('POST', `/api/events/${ev.id}/questions/${q.id}/screen`, { on: true, solo: true })

  let mine = await student.snapshot<ParticipantSnapshot>(`/api/p/${ev.id}/stream`)
  assert.deepEqual(
    { status: mine.mine[0].status, edited: mine.mine[0].edited, onScreen: mine.mine[0].onScreen },
    { status: 'approved', edited: true, onScreen: true },
  )

  // Corte: prévia e no ar trocam de lugar; um segundo corte desfaz o primeiro.
  assert.equal((await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'take' })).status, 404) // nada na prévia
  await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'preview', sceneId: titleScene.id })
  await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'take' })
  await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'preview', sceneId: questionsScene.id })
  await wait(450) // cortes com menos de 400 ms de intervalo são ignorados
  await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'take', transition: 'fade' })
  snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${ev.id}/stream`)
  assert.deepEqual([snap.event.live.program, snap.event.live.preview], [questionsScene.id, titleScene.id])
  assert.equal(snap.event.live.transition, 'fade')

  // Tela pareada por código: sem link secreto.
  const projector = new Client()
  const { data: pair } = await projector.req('POST', '/api/screen/pair')
  assert.match(pair.code, /^[0-9A-HJKMNP-TV-Z]{6}$/)
  assert.equal((await mod.req('POST', `/api/events/${ev.id}/screens`, { code: 'ZZZZZZ' })).status, 404)
  assert.equal((await mod.req('POST', `/api/events/${ev.id}/screens`, { code: pair.code.toLowerCase() })).status, 201)
  const screen = await projector.snapshot<ScreenSnapshot>('/api/screen/stream')
  assert.equal(screen.program?.id, questionsScene.id)
  assert.deepEqual(screen.questions, [{ id: q.id, text: 'Qual a diferença entre SSE e WebSocket?', author: 'João S.', likes: 0 }])
  assert.equal((await new Client().req('GET', '/api/screen/stream')).status, 401)
  assert.equal((await new Client().req('GET', `/api/screen/stream?event=${ev.id}`)).status, 401) // sem sessão de moderador
  assert.equal((await mod.snapshot<ScreenSnapshot>(`/api/screen/stream?event=${ev.id}`)).event.id, ev.id)

  // Curtida e reações no que está na tela.
  assert.equal((await student.req('POST', `/api/p/${ev.id}/questions/${q.id}/like`, { on: true })).status, 200)
  assert.equal((await student.req('POST', `/api/p/${ev.id}/reactions`, { kinds: { love: 3 } })).status, 200)
  mine = await student.snapshot<ParticipantSnapshot>(`/api/p/${ev.id}/stream`)
  assert.equal(mine.now?.questions[0].liked, true)

  // Anti-spam: intervalo mínimo e texto repetido.
  assert.equal((await student.req('POST', `/api/p/${ev.id}/questions`, { text: 'Outra pergunta qualquer' })).status, 429)

  // Interação fechada pelo moderador.
  await mod.req('PATCH', `/api/events/${ev.id}`, { settings: { questionsOpen: false } })
  assert.equal((await student.req('POST', `/api/p/${ev.id}/questions`, { text: 'outra pergunta' })).status, 403)

  // Cronômetro: corre enquanto iniciado, congela ao pausar.
  await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'timer', action: 'set', mode: 'countdown', durationMs: 60_000, label: 'Fala' })
  await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'timer', action: 'start' })
  await wait(120)
  await mod.req('POST', `/api/events/${ev.id}/live`, { op: 'timer', action: 'pause' })
  snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${ev.id}/stream`)
  assert.equal(snap.event.live.timer.running, false)
  assert.ok(snap.event.live.timer.elapsedMs >= 100)

  // Bloqueio derruba o acesso; CSRF e sessão protegem as rotas do moderador.
  await mod.req('PATCH', `/api/events/${ev.id}/participants/${joao.id}`, { blocked: true })
  assert.equal((await student.req('POST', `/api/p/${ev.id}/reactions`, { kinds: { love: 1 } })).status, 401)
  const forged = await mod.req('POST', '/api/events', undefined, { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' })
  assert.equal(forged.status, 403)
  assert.equal((await new Client().req('GET', '/api/events')).status, 401)
  assert.ok(timerScene)
})
