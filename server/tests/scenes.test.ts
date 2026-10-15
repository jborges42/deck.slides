// Cenas: criação por tipo, validação, edição, duplicação, exclusão (prévia e programa), ordem, isolamento e acesso.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { app, asModerator, Client, createEvent, joinParticipant, live } from './helpers.ts'
import type { EventSummary, ModeratorSnapshot, SceneBody, SceneType, ScreenSnapshot } from '../../shared/types.ts'

const mod = await asModerator()
const snapshot = (id: string) => mod.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)
const scenesOf = async (id: string) => (await snapshot(id)).scenes
const create = (id: string, body: unknown) => mod.req('POST', `/api/events/${id}/scenes`, body)
const sceneUrl = (id: string, sid: string) => `/api/events/${id}/scenes/${sid}`

const VALID: SceneBody[] = [
  { type: 'title', content: { kicker: 'Bem-vindos', title: 'Aula magna', body: 'Primeiro bloco' } },
  { type: 'image', content: { src: 'https://cdn.exemplo.com/foto.jpg', fit: 'cover', caption: 'Legenda' } },
  { type: 'video', content: { src: '/media/ABC123/video_1.mp4', fit: 'contain', loop: true, autoplay: false } },
  { type: 'embed', content: { url: 'https://exemplo.com/painel?x=1' } },
  { type: 'questions', content: { title: 'Dúvidas', layout: 'grid', max: 12, showAuthor: false, showLikes: true } },
  { type: 'timer', content: { title: 'Café', mode: 'stopwatch', durationSec: 1, warnSec: 0, criticalSec: 0, onEnd: 'stop', endText: '' } },
]
const [TITLE, IMAGE, VIDEO, EMBED, QUESTIONS, TIMER] = VALID as [
  Extract<SceneBody, { type: 'title' }>,
  Extract<SceneBody, { type: 'image' }>,
  Extract<SceneBody, { type: 'video' }>,
  Extract<SceneBody, { type: 'embed' }>,
  Extract<SceneBody, { type: 'questions' }>,
  Extract<SceneBody, { type: 'timer' }>,
]
const DEFAULT_NAMES: Record<SceneType, string> = {
  title: 'Título',
  image: 'Imagem',
  video: 'Vídeo',
  embed: 'Página web',
  questions: 'Perguntas',
  timer: 'Cronômetro',
}

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

/** Põe a cena no ar (prévia + corte). */
async function takeLive(eventId: string, sceneId: string) {
  assert.equal((await live(mod, eventId, { op: 'preview', sceneId })).status, 200)
  assert.equal((await live(mod, eventId, { op: 'take' })).status, 200)
}

describe('criação', () => {
  test('cria cena de cada tipo com conteúdo válido, no fim do roteiro e com o nome padrão do tipo', async () => {
    const { event } = await createEvent(mod)
    const ids: string[] = []
    for (const body of VALID) {
      const r = await create(event.id, body)
      assert.equal(r.status, 201, `${body.type}: ${JSON.stringify(r.data)}`)
      assert.deepEqual(Object.keys(r.data), ['id'])
      ids.push(r.data.id)
    }
    const added = (await scenesOf(event.id)).slice(3)
    assert.deepEqual(
      added.map((s) => s.id),
      ids,
    )
    added.forEach((s, i) =>
      assert.deepEqual(
        { type: s.type, name: s.name, position: s.position, content: s.content },
        { type: VALID[i]!.type, name: DEFAULT_NAMES[VALID[i]!.type], position: 3 + i, content: VALID[i]!.content },
      ),
    )
  })

  test('usa o nome informado sem espaços nas pontas; nome vazio ou só com espaços vira o padrão', async () => {
    const { event } = await createEvent(mod)
    for (const body of [
      { ...TITLE, name: '  Abertura oficial  ' },
      { ...EMBED, name: '   ' },
      { ...TIMER, name: '' },
      { ...IMAGE, name: 'x'.repeat(80) },
    ])
      assert.equal((await create(event.id, body)).status, 201)
    assert.deepEqual(
      (await scenesOf(event.id)).slice(3).map((s) => s.name),
      ['Abertura oficial', 'Página web', 'Cronômetro', 'x'.repeat(80)],
    )
  })

  test('aceita mídia vazia, da biblioteca ou https e descarta campos desconhecidos; recusa http', async () => {
    const { event } = await createEvent(mod)
    const bodies = [
      { type: 'image', content: { src: '', fit: 'contain', caption: '', onerror: 'alert(1)' }, admin: true },
      { type: 'image', content: { ...IMAGE.content, src: '/media/ABC123/foto-2.webp' } },
      { type: 'video', content: { ...VIDEO.content, src: 'https://exemplo.com/v.mp4' } },
      { type: 'embed', content: { url: '' } },
    ]
    for (const body of bodies) assert.equal((await create(event.id, body)).status, 201, JSON.stringify(body))
    // http não carrega sob a CSP de produção (conteúdo misto): recusado na entrada, não descoberto no telão.
    for (const insecure of [
      { type: 'video', content: { ...VIDEO.content, src: 'http://exemplo.com/v.mp4' } },
      { type: 'embed', content: { url: 'http://exemplo.com' } },
    ])
      assert.equal((await create(event.id, insecure)).status, 400, JSON.stringify(insecure))
    const added = (await scenesOf(event.id)).slice(3)
    assert.deepEqual(added[0], { id: added[0]!.id, name: 'Imagem', position: 3, type: 'image', content: { src: '', fit: 'contain', caption: '' } })
    assert.deepEqual(
      added.slice(1).map((s) => s.content),
      bodies.slice(1).map((b) => b.content),
    )
  })

  test('recusa tipo inexistente, campos faltando, URLs perigosas e números fora da faixa', async () => {
    const { event } = await createEvent(mod)
    const bad: [string, unknown][] = [
      ['tipo inexistente', { type: 'slide', content: {} }],
      ['sem tipo', { content: TITLE.content }],
      ['sem conteúdo', { type: 'title' }],
      ['título sem corpo', { type: 'title', content: { kicker: '', title: 'x' } }],
      ['título longo demais', { type: 'title', content: { ...TITLE.content, title: 'x'.repeat(301) } }],
      ['embed javascript:', { type: 'embed', content: { url: 'javascript:alert(1)' } }],
      ['embed ftp', { type: 'embed', content: { url: 'ftp://x' } }],
      ['embed data:', { type: 'embed', content: { url: 'data:text/html,<script>alert(1)</script>' } }],
      ['embed sem esquema', { type: 'embed', content: { url: 'exemplo.com' } }],
      ['cronômetro de 0 s', { type: 'timer', content: { ...TIMER.content, durationSec: 0 } }],
      ['cronômetro fracionado', { type: 'timer', content: { ...TIMER.content, durationSec: 1.5 } }],
      ['cronômetro acima de 24 h', { type: 'timer', content: { ...TIMER.content, durationSec: 24 * 3600 + 1 } }],
      ['aviso negativo', { type: 'timer', content: { ...TIMER.content, warnSec: -1 } }],
      ['fim desconhecido', { type: 'timer', content: { ...TIMER.content, onEnd: 'explodir' } }],
      ['perguntas com max 0', { type: 'questions', content: { ...QUESTIONS.content, max: 0 } }],
      ['perguntas com max 13', { type: 'questions', content: { ...QUESTIONS.content, max: 13 } }],
      ['layout desconhecido', { type: 'questions', content: { ...QUESTIONS.content, layout: 'carrossel' } }],
      ['imagem javascript:', { type: 'image', content: { ...IMAGE.content, src: 'javascript:alert(1)' } }],
      ['imagem caminho local', { type: 'image', content: { ...IMAGE.content, src: '/etc/passwd' } }],
      ['imagem subida de pasta', { type: 'image', content: { ...IMAGE.content, src: '/media/../../etc/passwd.png' } }],
      ['ajuste desconhecido', { type: 'image', content: { ...IMAGE.content, fit: 'stretch' } }],
      ['vídeo com aspas', { type: 'video', content: { ...VIDEO.content, src: 'https://x.com/v.mp4" onerror="alert(1)' } }],
      ['vídeo com autoplay em texto', { type: 'video', content: { ...VIDEO.content, autoplay: 'sim' } }],
      ['nome longo demais', { ...EMBED, name: 'x'.repeat(81) }],
      ['corpo nulo', null],
      ['sem corpo', undefined],
    ]
    for (const [label, body] of bad) {
      const r = await create(event.id, body)
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.data)}`)
      assertError(r, 400)
    }
    const notJson = await mod.raw('POST', `/api/events/${event.id}/scenes`, { body: '{"type":', headers: { 'content-type': 'application/json' } })
    assert.equal(notJson.status, 400)
    assert.equal((await scenesOf(event.id)).length, 3)
  })
})

describe('edição', () => {
  test('altera nome e conteúdo completo; conteúdo parcial é recusado e o tipo nunca muda', async () => {
    const { event, scenes } = await createEvent(mod)
    const url = sceneUrl(event.id, scenes[0]!.id)
    assert.deepEqual((await mod.req('PATCH', url, { name: '  Boas-vindas  ' })).data, { ok: true })
    const content = { kicker: 'Agora', title: 'Novo título', body: 'Texto novo' }
    assert.equal((await mod.req('PATCH', url, { content: { ...content, script: '<script>' } })).status, 200)
    const expected = { name: 'Boas-vindas', type: 'title', position: 0, content }
    const pick = async () => {
      const s = (await scenesOf(event.id))[0]!
      return { name: s.name, type: s.type, position: s.position, content: s.content }
    }
    assert.deepEqual(await pick(), expected)

    const bad: unknown[] = [
      { content: { title: 'Só o título' } },
      { content: null },
      { content: 'texto' },
      { type: 'image', content: IMAGE.content }, // conteúdo de outro tipo: validado como título
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(81) },
      { name: 'Válido', content: { kicker: '' } }, // um campo inválido recusa o pedido inteiro
      null,
    ]
    for (const body of bad) assertError(await mod.req('PATCH', url, body), 400)
    // O tipo enviado sozinho é ignorado.
    assert.equal((await mod.req('PATCH', url, { type: 'image' })).status, 200)
    assert.deepEqual(await pick(), expected)
  })

  test('valida o conteúdo conforme o tipo da cena', async () => {
    const { event, scenes } = await createEvent(mod)
    const embed = (await create(event.id, EMBED)).data.id as string
    const [, questions, timer] = scenes
    assertError(await mod.req('PATCH', sceneUrl(event.id, embed), { content: { url: 'javascript:alert(1)' } }), 400)
    assertError(await mod.req('PATCH', sceneUrl(event.id, timer!.id), { content: { ...TIMER.content, durationSec: 0 } }), 400)
    assertError(await mod.req('PATCH', sceneUrl(event.id, questions!.id), { content: { ...QUESTIONS.content, max: 13 } }), 400)
    assert.equal((await mod.req('PATCH', sceneUrl(event.id, embed), { content: { url: 'https://exemplo.com/outra' } })).status, 200)
    assert.equal((await mod.req('PATCH', sceneUrl(event.id, timer!.id), { content: TIMER.content })).status, 200)

    const after = await scenesOf(event.id)
    assert.deepEqual(after.find((s) => s.id === embed)!.content, { url: 'https://exemplo.com/outra' })
    assert.deepEqual(after.find((s) => s.id === timer!.id)!.content, TIMER.content)
    assert.deepEqual(after.find((s) => s.id === questions!.id)!.content, questions!.content)
  })

  test('cena inexistente responde 404', async () => {
    const { event } = await createEvent(mod)
    assertError(await mod.req('PATCH', sceneUrl(event.id, 'nao-existe'), { name: 'x' }), 404, 'Cena não encontrada.')
  })

  test('editar a cena que está no ar atualiza a tela', { timeout: 10_000 }, async () => {
    const { event, scenes } = await createEvent(mod)
    await takeLive(event.id, scenes[0]!.id)
    const screen = await mod.stream(`/api/screen/stream?event=${event.id}`)
    try {
      assert.equal((await screen.next<ScreenSnapshot>('state')).program?.id, scenes[0]!.id)
      const content = { kicker: '', title: 'Ao vivo', body: '' }
      assert.equal((await mod.req('PATCH', sceneUrl(event.id, scenes[0]!.id), { content })).status, 200)
      const s = await screen.next<ScreenSnapshot>('state', { where: (d) => d.program?.type === 'title' && d.program.content.title === 'Ao vivo' })
      assert.deepEqual(s.program?.content, content)
    } finally {
      screen.close()
    }
  })

  test('PATCH com corpo lento não desfaz edição feita na mesma cena enquanto ele chegava', { timeout: 10_000 }, async () => {
    const { event, scenes } = await createEvent(mod)
    const url = sceneUrl(event.id, scenes[0]!.id)
    const slow = held(mod, 'PATCH', url, { name: 'Nome novo' })
    await slow.reading
    const content = { kicker: 'K', title: 'Conteúdo novo', body: '' }
    assert.equal((await mod.req('PATCH', url, { content })).status, 200)
    slow.release()
    assert.equal((await slow.response).status, 200)
    const s = (await scenesOf(event.id))[0]!
    assert.deepEqual({ name: s.name, content: s.content }, { name: 'Nome novo', content })
  })

  test('PATCH lento numa cena que entrou no ar enquanto ele chegava também chega à tela', { timeout: 10_000 }, async () => {
    const { event, scenes } = await createEvent(mod)
    const screen = await mod.stream(`/api/screen/stream?event=${event.id}`)
    try {
      await screen.next('state')
      const slow = held(mod, 'PATCH', sceneUrl(event.id, scenes[0]!.id), { content: { kicker: '', title: 'Atualizado', body: '' } })
      await slow.reading
      await takeLive(event.id, scenes[0]!.id)
      await screen.next<ScreenSnapshot>('state', { where: (d) => d.program?.id === scenes[0]!.id })
      slow.release()
      assert.equal((await slow.response).status, 200)
      await screen.next<ScreenSnapshot>('state', { where: (d) => d.program?.type === 'title' && d.program.content.title === 'Atualizado' })
    } finally {
      screen.close()
    }
  })
})

describe('duplicação', () => {
  test('coloca a cópia logo após a original e empurra as seguintes', async () => {
    const { event, scenes } = await createEvent(mod)
    const [a, b, c] = scenes as [(typeof scenes)[0], (typeof scenes)[0], (typeof scenes)[0]]
    const r = await mod.req('POST', `${sceneUrl(event.id, a.id)}/duplicate`)
    assert.equal(r.status, 201)
    assert.deepEqual(Object.keys(r.data), ['id'])
    let after = await scenesOf(event.id)
    assert.deepEqual(
      after.map((s) => [s.id, s.position]),
      [
        [a.id, 0],
        [r.data.id, 1],
        [b.id, 2],
        [c.id, 3],
      ],
    )
    assert.deepEqual({ type: after[1]!.type, name: after[1]!.name, content: after[1]!.content }, { type: a.type, name: 'Abertura (cópia)', content: a.content })

    // A cópia é independente da original.
    assert.equal((await mod.req('PATCH', sceneUrl(event.id, r.data.id), { content: { kicker: '', title: 'Só na cópia', body: '' } })).status, 200)
    const last = await mod.req('POST', `${sceneUrl(event.id, c.id)}/duplicate`)
    after = await scenesOf(event.id)
    assert.deepEqual(after[0]!.content, a.content)
    assert.deepEqual(
      after.map((s) => s.id),
      [a.id, r.data.id, b.id, c.id, last.data.id],
    )
    assert.deepEqual(
      after.map((s) => s.position),
      [0, 1, 2, 3, 4],
    )
  })

  test('cena inexistente responde 404 e não muda o roteiro', async () => {
    const { event, scenes } = await createEvent(mod)
    assertError(await mod.req('POST', `${sceneUrl(event.id, 'nao-existe')}/duplicate`), 404, 'Cena não encontrada.')
    assert.deepEqual(await scenesOf(event.id), scenes)
  })
})

describe('exclusão', () => {
  test('remove a cena e limpa programa e prévia que apontavam para ela', { timeout: 10_000 }, async () => {
    const { event, scenes } = await createEvent(mod)
    const [a, b, c] = scenes as [(typeof scenes)[0], (typeof scenes)[0], (typeof scenes)[0]]
    await takeLive(event.id, b.id)
    await live(mod, event.id, { op: 'preview', sceneId: c.id })
    const liveOf = async () => {
      const snap = await snapshot(event.id)
      return { program: snap.event.live.program, preview: snap.event.live.preview, scenes: snap.scenes.map((s) => s.id) }
    }
    const screen = await mod.stream(`/api/screen/stream?event=${event.id}`)
    try {
      assert.equal((await screen.next<ScreenSnapshot>('state')).program?.id, b.id)

      // Cena fora do ar e fora da prévia: estado ao vivo intacto.
      assert.deepEqual((await mod.req('DELETE', sceneUrl(event.id, a.id))).data, { ok: true })
      assert.deepEqual(await liveOf(), { program: b.id, preview: c.id, scenes: [b.id, c.id] })

      // Cena no ar: sai do ar, na tela e na lista de eventos.
      assert.equal((await mod.req('DELETE', sceneUrl(event.id, b.id))).status, 200)
      await screen.next<ScreenSnapshot>('state', { where: (d) => d.program === null })
      assert.deepEqual(await liveOf(), { program: null, preview: c.id, scenes: [c.id] })
      const summary = ((await mod.req('GET', '/api/events')).data as EventSummary[]).find((e) => e.id === event.id)!
      assert.equal(summary.live, false)

      // Cena na prévia: a prévia fica vazia e o corte passa a não ter o que pôr no ar.
      assert.equal((await mod.req('DELETE', sceneUrl(event.id, c.id))).status, 200)
      assert.deepEqual(await liveOf(), { program: null, preview: null, scenes: [] })
      assertError(await live(mod, event.id, { op: 'take' }), 404)
    } finally {
      screen.close()
    }
  })

  test('cena inexistente ou já excluída responde 404', async () => {
    const { event, scenes } = await createEvent(mod)
    assert.equal((await mod.req('DELETE', sceneUrl(event.id, scenes[0]!.id))).status, 200)
    assertError(await mod.req('DELETE', sceneUrl(event.id, scenes[0]!.id)), 404, 'Cena não encontrada.')
    assertError(await mod.req('DELETE', sceneUrl(event.id, 'nao-existe')), 404, 'Cena não encontrada.')
    assert.equal((await scenesOf(event.id)).length, 2)
  })
})

describe('ordem', () => {
  test('reordena: as posições seguem a ordem dos ids', async () => {
    const { event, scenes } = await createEvent(mod)
    const ids = scenes.map((s) => s.id).reverse()
    assert.deepEqual((await mod.req('POST', `/api/events/${event.id}/scenes/order`, { ids })).data, { ok: true })
    const after = await scenesOf(event.id)
    assert.deepEqual(
      after.map((s) => s.id),
      ids,
    )
    assert.deepEqual(
      after.map((s) => s.position),
      [0, 1, 2],
    )
  })

  test('lista desatualizada, repetida ou com ids desconhecidos não deixa posições repetidas', async () => {
    const { event, scenes } = await createEvent(mod)
    const [a, b, c] = scenes.map((s) => s.id) as [string, string, string]
    const d = (await create(event.id, TITLE)).data.id as string // criada depois que a lista foi montada
    const r = await mod.req('POST', `/api/events/${event.id}/scenes/order`, { ids: [c, 'nao-existe', a, c] })
    assert.equal(r.status, 200)
    let after = await scenesOf(event.id)
    // As listadas na ordem pedida; as que faltaram, depois, na ordem em que estavam.
    assert.deepEqual(
      after.map((s) => s.id),
      [c, a, b, d],
    )
    assert.deepEqual(
      after.map((s) => s.position),
      [0, 1, 2, 3],
    )
    // Duplicar continua pondo a cópia logo depois da original.
    const copy = (await mod.req('POST', `${sceneUrl(event.id, a)}/duplicate`)).data.id as string
    after = await scenesOf(event.id)
    assert.deepEqual(
      after.map((s) => s.id),
      [c, a, copy, b, d],
    )
    assert.deepEqual(
      after.map((s) => s.position),
      [0, 1, 2, 3, 4],
    )
  })

  test('recusa corpo inválido sem mexer na ordem', async () => {
    const { event, scenes } = await createEvent(mod)
    for (const body of [{}, { ids: 'abc' }, { ids: [1, 2] }, { ids: Array.from({ length: 1001 }, (_, i) => `id${i}`) }, null])
      assertError(await mod.req('POST', `/api/events/${event.id}/scenes/order`, body), 400)
    assert.deepEqual(await scenesOf(event.id), scenes)
  })
})

describe('isolamento entre eventos', () => {
  test('operações com cena de outro evento respondem 404 e não alteram nada', async () => {
    const { event: a, scenes: scenesA } = await createEvent(mod, 'Evento A')
    const { event: b, scenes: scenesB } = await createEvent(mod, 'Evento B')
    const foreign = scenesB[0]!.id
    assertError(await mod.req('PATCH', sceneUrl(a.id, foreign), { name: 'Invadida' }), 404, 'Cena não encontrada.')
    assertError(await mod.req('POST', `${sceneUrl(a.id, foreign)}/duplicate`), 404, 'Cena não encontrada.')
    assertError(await mod.req('DELETE', sceneUrl(a.id, foreign)), 404, 'Cena não encontrada.')
    assertError(await live(mod, a.id, { op: 'preview', sceneId: foreign }), 404, 'Cena não encontrada.')
    assert.equal((await mod.req('POST', `/api/events/${a.id}/scenes/order`, { ids: scenesB.map((s) => s.id).reverse() })).status, 200)

    assert.deepEqual(await scenesOf(b.id), scenesB)
    assert.deepEqual(await scenesOf(a.id), scenesA)
    assert.equal((await snapshot(a.id)).event.live.preview, null)
  })
})

describe('acesso', () => {
  test('visitante sem sessão e participante não criam, editam, duplicam, excluem nem reordenam cenas', async () => {
    const { event, scenes } = await createEvent(mod)
    const { phone } = await joinParticipant(mod, event.id)
    const sid = scenes[0]!.id
    const calls: [string, string, unknown][] = [
      ['POST', `/api/events/${event.id}/scenes`, TITLE],
      ['PATCH', sceneUrl(event.id, sid), { name: 'Invadida' }],
      ['POST', `${sceneUrl(event.id, sid)}/duplicate`, undefined],
      ['DELETE', sceneUrl(event.id, sid), undefined],
      ['POST', `/api/events/${event.id}/scenes/order`, { ids: scenes.map((s) => s.id).reverse() }],
    ]
    for (const c of [new Client(), phone]) for (const [method, path, body] of calls) assertError(await c.req(method, path, body), 401)
    assert.deepEqual(await scenesOf(event.id), scenes)
  })
})
