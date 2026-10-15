// Eventos: criação, listagem, código em minúsculas, nome/PIN, configurações, tema, exclusão e acesso.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, asModerator, Client, createEvent, joinParticipant, live, wait } from './helpers.ts'
import {
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  REACTIONS,
  defaultLive,
  type EventSummary,
  type ModeratorSnapshot,
  type ParticipantSnapshot,
  type ScreenSnapshot,
  type Theme,
} from '../../shared/types.ts'

// Depois de helpers.ts: o banco já aponta para o diretório temporário deste arquivo.
const { get, UPLOADS_DIR } = await import('../db.ts')

const mod = await asModerator()
const snapshot = (id: string) => mod.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)
const patch = (id: string, body: unknown) => mod.req('PATCH', `/api/events/${id}`, body)
const UNKNOWN = 'UUUUUU' // U não existe no alfabeto dos códigos: nunca colide

/** Erro em JSON só com a mensagem, em português e sem detalhes internos. */
function assertError(r: { status: number; data: any }, status: number, message?: string) {
  assert.equal(r.status, status, JSON.stringify(r.data))
  assert.deepEqual(Object.keys(r.data ?? {}), ['error'], JSON.stringify(r.data))
  assert.ok(r.data.error.length > 3)
  assert.doesNotMatch(r.data.error, /invalid|expected|required|too (small|big)|sqlite|stack/i)
  if (message) assert.equal(r.data.error, message)
}

/** Requisição cujo corpo só chega em `release()`, com Content-Length como no navegador (rede lenta). */
function held(c: Client, method: string, path: string, json: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(json))
  let release!: () => void
  let started!: () => void
  const reading = new Promise<void>((r) => (started = r))
  const body = new ReadableStream<Uint8Array>(
    {
      start: (ctrl) => {
        release = () => {
          ctrl.enqueue(bytes)
          ctrl.close()
        }
      },
      pull: () => started(), // o servidor começou a ler o corpo: já carregou o que precisava antes dele
    },
    { highWaterMark: 0 },
  )
  const response = app.request(path, {
    method,
    body,
    duplex: 'half',
    headers: {
      origin: 'http://localhost',
      'x-forwarded-for': c.ip,
      cookie: c.cookie,
      'content-type': 'application/json',
      'content-length': String(bytes.length),
    },
  })
  return { response, reading, release }
}

// PNG 1x1.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

describe('criação', () => {
  test('cria evento com código Crockford, PIN de 6 dígitos, padrões e as três cenas iniciais', async () => {
    const r = await mod.req('POST', '/api/events', { name: '  Aula magna  ' })
    assert.equal(r.status, 201, JSON.stringify(r.data))
    assert.deepEqual(Object.keys(r.data), ['id'])
    assert.match(r.data.id, /^[0-9A-HJKMNP-TV-Z]{6}$/)

    const snap = await snapshot(r.data.id)
    const { event, scenes } = snap
    assert.equal(event.id, r.data.id)
    assert.equal(event.name, 'Aula magna')
    assert.match(event.pin, /^\d{6}$/)
    assert.deepEqual(event.settings, DEFAULT_SETTINGS)
    assert.deepEqual(event.theme, DEFAULT_THEME)
    assert.deepEqual(event.live, defaultLive())
    assert.ok(Math.abs(event.createdAt - Date.now()) < 10_000)
    assert.deepEqual(
      scenes.map((s) => [s.type, s.name, s.position]),
      [
        ['title', 'Abertura', 0],
        ['questions', 'Perguntas', 1],
        ['timer', 'Intervalo', 2],
      ],
    )
    assert.deepEqual(scenes[0]!.content, { kicker: '', title: 'Aula magna', body: '' })
    assert.equal(new Set(scenes.map((s) => s.id)).size, 3)
    assert.deepEqual([snap.questions, snap.participants, snap.media, snap.screens], [[], [], [], []])
  })

  test('recusa nome vazio, só com espaços, longo demais, de outro tipo ou corpo inválido', async () => {
    const before = (await mod.req('GET', '/api/events')).data.length
    for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 42 }, {}, null, undefined])
      assertError(await mod.req('POST', '/api/events', body), 400)
    const notJson = await mod.raw('POST', '/api/events', { body: '{"name":', headers: { 'content-type': 'application/json' } })
    assert.equal(notJson.status, 400)
    assert.equal((await mod.req('GET', '/api/events')).data.length, before)

    const max = await mod.req('POST', '/api/events', { name: 'x'.repeat(120) })
    assert.equal(max.status, 201)
    assert.equal((await snapshot(max.data.id)).event.name, 'x'.repeat(120))
  })
})

describe('listagem', () => {
  test('lista resumos com totais de participantes e perguntas, se está no ar e sem dados sensíveis', async () => {
    const { event: a, scenes } = await createEvent(mod, 'Evento com público')
    await wait(5) // created_at diferente: ordem determinística
    const { event: b } = await createEvent(mod, 'Evento vazio')
    await mod.req('POST', `/api/events/${a.id}/participants`, { people: [{ name: 'Ana Souza' }, { name: 'Bruno Lima' }] })
    await mod.req('POST', `/api/events/${a.id}/questions`, { text: 'Primeira pergunta', author: '' })
    await mod.req('POST', `/api/events/${a.id}/questions`, { text: 'Segunda pergunta', author: 'Carla' })
    await live(mod, a.id, { op: 'preview', sceneId: scenes[0]!.id })
    assert.equal((await live(mod, a.id, { op: 'take' })).status, 200)

    const r = await mod.req('GET', '/api/events')
    assert.equal(r.status, 200)
    const list = r.data as EventSummary[]
    const sa = list.find((e) => e.id === a.id)!
    const sb = list.find((e) => e.id === b.id)!
    assert.deepEqual(sa, { id: a.id, name: 'Evento com público', createdAt: a.createdAt, participants: 2, questions: 2, live: true })
    assert.deepEqual(sb, { id: b.id, name: 'Evento vazio', createdAt: b.createdAt, participants: 0, questions: 0, live: false })
    assert.ok(list.indexOf(sb) < list.indexOf(sa), 'mais recente primeiro')
    // Resumo não leva PIN, configurações, tema nem estado ao vivo.
    for (const e of list) assert.deepEqual(Object.keys(e).sort(), ['createdAt', 'id', 'live', 'name', 'participants', 'questions'])
  })
})

describe('código do evento', () => {
  test('aceita o código em minúsculas no stream, no PATCH e nas cenas', async () => {
    const { event } = await createEvent(mod)
    const lower = event.id.toLowerCase()
    assert.equal((await mod.snapshot<ModeratorSnapshot>(`/api/events/${lower}/stream`)).event.id, event.id)
    assert.equal((await patch(lower, { name: 'Renomeado' })).status, 200)
    const scene = await mod.req('POST', `/api/events/${lower}/scenes`, { type: 'embed', content: { url: '' } })
    assert.equal(scene.status, 201)
    const snap = await snapshot(event.id)
    assert.equal(snap.event.name, 'Renomeado')
    assert.equal(snap.scenes.at(-1)!.id, scene.data.id)
  })
})

describe('nome e PIN', () => {
  test('altera nome e PIN: o PIN novo passa a valer para entrar e o antigo não', async () => {
    const { event } = await createEvent(mod)
    await mod.req('POST', `/api/events/${event.id}/participants`, { people: [{ name: 'Rita Lopes' }] })
    const { token } = (await snapshot(event.id)).participants[0]!

    assert.deepEqual((await patch(event.id, { name: '  Novo nome  ', pin: '4321' })).data, { ok: true })
    let snap = await snapshot(event.id)
    assert.equal(snap.event.name, 'Novo nome')
    assert.equal(snap.event.pin, '4321')

    const phone = new Client()
    assertError(await phone.req('POST', `/api/invite/${token}`, { pin: event.pin }), 401)
    assert.equal((await phone.req('POST', `/api/invite/${token}`, { pin: '4321' })).status, 200)

    assert.equal((await patch(event.id, { pin: '12345678' })).status, 200)
    snap = await snapshot(event.id)
    assert.equal(snap.event.pin, '12345678')
    assert.equal(snap.event.name, 'Novo nome')
  })

  test('recusa PIN fora de 4 a 8 dígitos e nome inválido, sem alterar nada', async () => {
    const { event } = await createEvent(mod, 'Nome original')
    for (const pin of ['abc', '123', '123456789', '12 34', '12a4', '', ' 1234', '１２３４'])
      assertError(await patch(event.id, { pin }), 400, 'O PIN deve ter de 4 a 8 dígitos.')
    assertError(await patch(event.id, { pin: 1234 }), 400)
    for (const name of ['', '   ', 'x'.repeat(121), null]) assertError(await patch(event.id, { name }), 400)
    // Um campo inválido recusa o pedido inteiro.
    assertError(await patch(event.id, { name: 'Outro nome', pin: '12' }), 400)

    const snap = await snapshot(event.id)
    assert.equal(snap.event.name, 'Nome original')
    assert.equal(snap.event.pin, event.pin)
  })
})

describe('configurações', () => {
  test('PATCH parcial muda só as chaves enviadas', async () => {
    const { event } = await createEvent(mod)
    assert.equal((await patch(event.id, { settings: { maxLength: 300, reactions: ['like', 'laugh'] } })).status, 200)
    assert.equal((await patch(event.id, { settings: { questionsOpen: false, flagWords: ['golpe'] } })).status, 200)
    assert.equal((await patch(event.id, { name: 'Só o nome' })).status, 200)

    const { event: after } = await snapshot(event.id)
    assert.deepEqual(after.settings, {
      ...DEFAULT_SETTINGS,
      maxLength: 300,
      reactions: ['like', 'laugh'],
      questionsOpen: false,
      flagWords: ['golpe'],
    })
    assert.deepEqual(after.theme, DEFAULT_THEME)
    assert.equal(after.pin, event.pin)
  })

  test('aceita os limites das faixas e descarta chaves desconhecidas', async () => {
    const { event } = await createEvent(mod)
    const words = Array.from({ length: 200 }, (_, i) => String(i).padEnd(60, 'x'))
    const r = await patch(event.id, { settings: { maxLength: 100, flagWords: words, reactions: [], identity: 'anonymous', admin: true } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    let settings = (await snapshot(event.id)).event.settings
    assert.deepEqual(
      { maxLength: settings.maxLength, flagWords: settings.flagWords, reactions: settings.reactions, identity: settings.identity },
      { maxLength: 100, flagWords: words, reactions: [], identity: 'anonymous' },
    )
    assert.equal('admin' in settings, false)

    assert.equal((await patch(event.id, { settings: { maxLength: 500, reactions: [...REACTIONS] } })).status, 200)
    settings = (await snapshot(event.id)).event.settings
    assert.deepEqual([settings.maxLength, settings.reactions], [500, [...REACTIONS]])
  })

  test('recusa configurações inválidas sem alterar nada', async () => {
    const { event } = await createEvent(mod)
    const bad: unknown[] = [
      { maxLength: 99 },
      { maxLength: 501 },
      { maxLength: 150.5 },
      { maxLength: '200' },
      { reactions: ['applause', 'fire'] },
      { reactions: 'love' },
      { reactions: [...REACTIONS, 'love'] },
      { flagWords: Array.from({ length: 201 }, (_, i) => `termo${i}`) },
      { flagWords: ['x'.repeat(61)] },
      { flagWords: ['   '] },
      { flagWords: [1] },
      { identity: 'secreto' },
      { screenName: 'apelido' },
      { questionsOpen: 'sim' },
      null,
    ]
    for (const settings of bad) {
      const r = await patch(event.id, { name: 'Não muda', settings })
      assert.equal(r.status, 400, `${JSON.stringify(settings)}: ${JSON.stringify(r.data)}`)
      assertError(r, 400)
    }
    const { event: after } = await snapshot(event.id)
    assert.deepEqual(after.settings, DEFAULT_SETTINGS)
    assert.equal(after.name, event.name)
  })
})

describe('tema', () => {
  const valid: Theme = {
    preset: 'personalizado',
    brand: '#112233',
    background: '#0a0b0c',
    mode: 'light',
    contrast: 'high',
    overrides: { accent: '#445566', fg: '#FFFFFF' },
    fonts: {
      heading: { family: 'Minha Fonte', url: '/media/ABC123/fonte-1.woff2' },
      body: { family: 'Atkinson Hyperlegible Next Variable' },
      numbers: { family: 'Chivo Mono Variable' },
      headingWeight: 700,
    },
    logo: 'https://cdn.exemplo.com/logo.png',
    logoPosition: 'bottom-right',
    logoSize: 320,
    backgroundImage: '/media/ABC123/fundo_1.jpg',
    backgroundDim: 0.95,
    aspect: '21:9',
    align: 'center',
    safe: 10,
    scale: 1.6,
    radius: 0,
    cardStyle: 'outline',
    transition: 'cut',
    transitionMs: 100,
    standby: 'black',
    reactionsStyle: 'counter',
    footer: 'Rodapé do evento',
  }
  const withFont = (family: string) => ({ ...valid, fonts: { ...valid.fonts, heading: { family } } })
  const without = (key: keyof Theme) => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key))

  test('tema válido é salvo, sem chaves desconhecidas, e aparece para moderação e tela', async () => {
    const { event } = await createEvent(mod)
    assert.equal((await patch(event.id, { theme: { ...valid, script: '<script>alert(1)</script>' } })).status, 200)
    assert.deepEqual((await snapshot(event.id)).event.theme, valid)
    const screen = await mod.snapshot<ScreenSnapshot>(`/api/screen/stream?event=${event.id}`)
    assert.deepEqual(screen.event.theme, valid)
    assert.equal('settings' in screen.event, false) // termos sensíveis e regras ficam só na moderação
  })

  test('tema parcial ou com valores inválidos é recusado e nada muda', async () => {
    const { event } = await createEvent(mod)
    const bad: [string, unknown][] = [
      ['parcial', { brand: '#112233' }],
      ['sem a cor da marca', without('brand')],
      ['sem as fontes', without('fonts')],
      ['cor curta', { ...valid, brand: '#fff' }],
      ['cor por nome', { ...valid, brand: 'red' }],
      ['fundo com dígito inválido', { ...valid, background: '#12345G' }],
      ['ajuste de token com cor inválida', { ...valid, overrides: { accent: 'red' } }],
      ['token inexistente', { ...valid, overrides: { evil: '#000000' } }],
      ['logo javascript:', { ...valid, logo: 'javascript:alert(1)' }],
      ['imagem com espaço', { ...valid, backgroundImage: 'http://x/a b' }],
      ['caminho local', { ...valid, logo: '/etc/passwd' }],
      ['subida de pasta', { ...valid, logo: '/media/../../etc/passwd.png' }],
      ['aspas e parênteses na url', { ...valid, backgroundImage: 'https://x.com/a.png") ; background:url("evil' }],
      ['fonte com aspas', withFont('Inter", serif')],
      ['fonte com ponto e vírgula', withFont('Inter; color: red')],
      ['fonte vazia', withFont('   ')],
      ['url de fonte javascript:', { ...valid, fonts: { ...valid.fonts, body: { family: 'Inter', url: 'javascript:alert(1)' } } }],
      ['peso acima de 900', { ...valid, fonts: { ...valid.fonts, headingWeight: 950 } }],
      ['peso fracionado', { ...valid, fonts: { ...valid.fonts, headingWeight: 650.5 } }],
      ['logo pequeno demais', { ...valid, logoSize: 8 }],
      ['véu acima de 0.95', { ...valid, backgroundDim: 1 }],
      ['margem acima de 10', { ...valid, safe: 11 }],
      ['escala acima de 1.6', { ...valid, scale: 2 }],
      ['escala abaixo de 0.8', { ...valid, scale: 0.5 }],
      ['raio negativo', { ...valid, radius: -1 }],
      ['raio acima de 64', { ...valid, radius: 65 }],
      ['transição curta demais', { ...valid, transitionMs: 50 }],
      ['transição longa demais', { ...valid, transitionMs: 2500 }],
      ['proporção desconhecida', { ...valid, aspect: '1:1' }],
      ['modo desconhecido', { ...valid, mode: 'neon' }],
      ['rodapé longo demais', { ...valid, footer: 'x'.repeat(121) }],
      ['nulo', null],
    ]
    for (const [label, theme] of bad) {
      const r = await patch(event.id, { name: 'Não muda', theme })
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.data)}`)
      assertError(r, 400)
    }
    assertError(await patch(event.id, { theme: { ...valid, brand: '#fff' } }), 400, 'Use uma cor no formato #RRGGBB.')
    assertError(
      await patch(event.id, { theme: { ...valid, logo: 'javascript:alert(1)' } }),
      400,
      'Use um arquivo da biblioteca ou um endereço https.',
    )
    assertError(await patch(event.id, { theme: withFont('Inter;') }), 400, 'Nome de fonte inválido.')

    const { event: after } = await snapshot(event.id)
    assert.deepEqual(after.theme, DEFAULT_THEME)
    assert.equal(after.name, event.name)
  })

  test('participante recebe só marca, contraste, logo e fontes do tema; nunca o PIN nem os termos sensíveis', async () => {
    const { event } = await createEvent(mod)
    const r = await patch(event.id, { theme: valid, settings: { flagWords: ['segredo'], maxLength: 250, identity: 'choice' } })
    assert.equal(r.status, 200)
    const { phone } = await joinParticipant(mod, event.id)
    const snap = await phone.snapshot<ParticipantSnapshot>(`/api/p/${event.id}/stream`)
    assert.deepEqual(snap.event.theme, { brand: valid.brand, contrast: valid.contrast, logo: valid.logo, fonts: valid.fonts })
    assert.deepEqual(snap.event.settings, {
      questionsOpen: true,
      reactionsOpen: true,
      identity: 'choice',
      maxLength: 250,
      reactions: DEFAULT_SETTINGS.reactions,
    })
    assert.equal('pin' in snap.event, false)
    assert.equal(JSON.stringify(snap).includes('segredo'), false)
  })
})

describe('exclusão', () => {
  test('remove o evento, cenas, perguntas, participantes, reações, telas, mídia e a pasta de uploads', async () => {
    const { event, scenes } = await createEvent(mod)
    const { phone } = await joinParticipant(mod, event.id)
    await mod.req('POST', `/api/events/${event.id}/questions`, { text: 'Pergunta da moderação', author: 'Ana' })
    assert.equal((await phone.req('POST', `/api/p/${event.id}/questions`, { text: 'Pergunta do público' })).status, 201)
    await live(mod, event.id, { op: 'preview', sceneId: scenes[0]!.id })
    await live(mod, event.id, { op: 'take' })
    assert.equal((await phone.req('POST', `/api/p/${event.id}/reactions`, { kinds: { love: 2 } })).status, 200)
    const projector = new Client()
    const { data: pair } = await projector.req('POST', '/api/screen/pair')
    assert.equal((await mod.req('POST', `/api/events/${event.id}/screens`, { code: pair.code })).status, 201)

    const up = await mod.raw('POST', `/api/events/${event.id}/media`, {
      body: PNG,
      headers: { 'content-type': 'image/png', 'x-filename': 'logo.png' },
    })
    assert.equal(up.status, 201)
    const media = (await up.json()) as { url: string }
    const dir = join(UPLOADS_DIR, event.id)
    const file = join(dir, media.url.split('/').pop()!)
    assert.ok(existsSync(file))
    assert.equal((await mod.raw('GET', media.url)).status, 200)

    const tables = ['scenes', 'questions', 'participants', 'reactions', 'screens', 'media']
    const count = (table: string) => get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ?`, event.id)!.n
    assert.deepEqual(tables.map(count), [3, 2, 1, 1, 1, 1])

    const del = await mod.req('DELETE', `/api/events/${event.id}`)
    assert.equal(del.status, 200)
    assert.deepEqual(del.data, { ok: true })
    assert.equal(get('SELECT 1 FROM events WHERE id = ?', event.id), undefined)
    assert.deepEqual(tables.map(count), [0, 0, 0, 0, 0, 0])
    assert.equal(existsSync(dir), false)
    assert.equal((await mod.raw('GET', media.url)).status, 404)
    assert.equal(((await mod.req('GET', '/api/events')).data as EventSummary[]).some((e) => e.id === event.id), false)

    // O código deixa de responder; o participante perde o acesso.
    assertError(await mod.req('GET', `/api/events/${event.id}/stream`), 404, 'Evento não encontrado.')
    assertError(await mod.req('PATCH', `/api/events/${event.id}`, { name: 'Zumbi' }), 404, 'Evento não encontrado.')
    assertError(await mod.req('DELETE', `/api/events/${event.id}`), 404, 'Evento não encontrado.')
    assertError(await phone.req('POST', `/api/p/${event.id}/questions`, { text: 'Ainda estou aqui?' }), 404)
  })

  test('streams abertos do evento recebem gone e fecham; os de outro evento continuam', { timeout: 10_000 }, async () => {
    const { event } = await createEvent(mod)
    const { event: other } = await createEvent(mod, 'Outro evento')
    const { phone } = await joinParticipant(mod, event.id)
    const streams = [
      await mod.stream(`/api/events/${event.id}/stream`),
      await mod.stream(`/api/screen/stream?event=${event.id}`),
      await phone.stream(`/api/p/${event.id}/stream`),
    ]
    const bystander = await mod.stream(`/api/events/${other.id}/stream`)
    try {
      for (const s of [...streams, bystander]) await s.next('state')
      assert.equal((await mod.req('DELETE', `/api/events/${event.id}`)).status, 200)
      for (const s of streams) {
        await s.next('gone', { timeout: 1500 })
        await assert.rejects(s.next('state', { timeout: 1500 }), /stream fechado/) // nada depois do gone
      }
      await bystander.none('gone', 300)
      assert.equal(bystander.closed, false)
    } finally {
      for (const s of [...streams, bystander]) s.close()
    }
  })
})

describe('evento inexistente', () => {
  test('responde 404 em PATCH, DELETE, stream e cenas', async () => {
    const calls: [string, string, unknown][] = [
      ['PATCH', `/api/events/${UNKNOWN}`, { name: 'x' }],
      ['DELETE', `/api/events/${UNKNOWN}`, undefined],
      ['GET', `/api/events/${UNKNOWN}/stream`, undefined],
      ['POST', `/api/events/${UNKNOWN}/scenes`, { type: 'embed', content: { url: '' } }],
    ]
    for (const [method, path, body] of calls) assertError(await mod.req(method, path, body), 404, 'Evento não encontrado.')
  })
})

describe('acesso', () => {
  test('sem sessão de moderador (visitante ou participante) as rotas de evento respondem 401 e nada muda', async () => {
    const { event } = await createEvent(mod, 'Protegido')
    const { phone } = await joinParticipant(mod, event.id)
    const calls: [string, string, unknown][] = [
      ['GET', '/api/events', undefined],
      ['POST', '/api/events', { name: 'Intruso' }],
      ['PATCH', `/api/events/${event.id}`, { name: 'Invadido', pin: '0000' }],
      ['DELETE', `/api/events/${event.id}`, undefined],
      ['GET', `/api/events/${event.id}/stream`, undefined],
      ['PATCH', `/api/events/${UNKNOWN}`, { name: 'x' }], // sem sessão não revela se o código existe
    ]
    for (const c of [new Client(), phone]) for (const [method, path, body] of calls) assertError(await c.req(method, path, body), 401)

    const snap = await snapshot(event.id)
    assert.equal(snap.event.name, 'Protegido')
    assert.equal(snap.event.pin, event.pin)
  })
})

describe('concorrência', () => {
  test('PATCH com corpo lento não desfaz alteração feita enquanto ele chegava', { timeout: 10_000 }, async () => {
    const { event } = await createEvent(mod)
    const slow = held(mod, 'PATCH', `/api/events/${event.id}`, { name: 'Nome novo' })
    await slow.reading
    assert.equal((await patch(event.id, { settings: { questionsOpen: false }, pin: '9876' })).status, 200)
    slow.release()
    assert.equal((await slow.response).status, 200)

    const { event: after } = await snapshot(event.id)
    assert.equal(after.name, 'Nome novo')
    assert.equal(after.settings.questionsOpen, false)
    assert.equal(after.pin, '9876')
  })

  test('renomear participante com corpo lento não desfaz o bloqueio feito enquanto ele chegava', { timeout: 10_000 }, async () => {
    const { event } = await createEvent(mod)
    const { phone, participant } = await joinParticipant(mod, event.id, 'Ana Souza')
    const url = `/api/events/${event.id}/participants/${participant.id}`
    const slow = held(mod, 'PATCH', url, { name: 'Ana Souza Lima' })
    await slow.reading
    assert.equal((await mod.req('PATCH', url, { blocked: true })).status, 200)
    slow.release()
    assert.equal((await slow.response).status, 200)

    const p = (await snapshot(event.id)).participants.find((x) => x.id === participant.id)!
    assert.deepEqual([p.name, p.blocked], ['Ana Souza Lima', true])
    assertError(await phone.req('POST', `/api/p/${event.id}/questions`, { text: 'Ainda consigo perguntar?' }), 401)
  })

  test('corrigir texto de pergunta com corpo lento não devolve à tela a pergunta rejeitada enquanto ele chegava', { timeout: 10_000 }, async () => {
    const { event, scenes } = await createEvent(mod)
    await mod.req('POST', `/api/events/${event.id}/questions`, { text: 'Pergunta ofensiva', author: 'Xis' })
    const q = (await snapshot(event.id)).questions[0]!
    assert.equal((await mod.req('POST', `/api/events/${event.id}/questions/${q.id}/screen`, { on: true })).status, 200)
    const url = `/api/events/${event.id}/questions/${q.id}`
    const slow = held(mod, 'PATCH', url, { text: 'Pergunta corrigida' })
    await slow.reading
    assert.equal((await mod.req('PATCH', url, { status: 'rejected' })).status, 200)
    slow.release()
    assert.equal((await slow.response).status, 200)

    const after = (await snapshot(event.id)).questions[0]!
    assert.deepEqual([after.text, after.status, after.screen], ['Pergunta corrigida', 'rejected', null])
    await live(mod, event.id, { op: 'preview', sceneId: scenes[1]!.id }) // cena de perguntas
    await live(mod, event.id, { op: 'take' })
    assert.deepEqual((await mod.snapshot<ScreenSnapshot>(`/api/screen/stream?event=${event.id}`)).questions, [])
  })
})
