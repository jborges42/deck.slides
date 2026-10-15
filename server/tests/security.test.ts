// Segurança HTTP: CSRF, limites de corpo, erros sem detalhes internos, cabeçalhos, cookies e isolamento
// do que cada audiência recebe (moderação, tela, participante) e entre eventos.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { app, asModerator, Client, createEvent, joinParticipant, live, MOD_EMAIL, MOD_PASSWORD } from './helpers.ts'
import type { Media, ModeratorSnapshot, ParticipantSnapshot, ScreenSnapshot } from '../../shared/types.ts'

const { DATA_DIR, get } = await import('../db.ts')

// Rota só deste processo, para provocar um erro inesperado cuja mensagem tem detalhes internos.
// Registrada antes da primeira requisição: depois disso o roteador não aceita rotas novas.
app.get('/__teste/erro-interno', () => {
  throw new Error(`SQLITE_ERROR: SELECT password FROM moderators em ${DATA_DIR}/deck.db`)
})

type Result = { status: number; data: any; headers: Headers }
const toResult = async (res: Response): Promise<Result> => {
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {
    // resposta não JSON
  }
  return { status: res.status, data, headers: res.headers }
}

/** Requisição sem os cabeçalhos automáticos do Client (Origin, Content-Type), como um site de terceiros montaria. */
const forge = async (c: Client, method: string, path: string, headers: Record<string, string>, body?: string | Uint8Array) =>
  toResult(await app.request(path, { method, body, headers: { cookie: c.cookie, 'x-forwarded-for': c.ip, ...headers } }))

const rawJson = (c: Client, method: string, path: string, body: string, headers: Record<string, string> = {}) =>
  c.raw(method, path, { body, headers: { 'content-type': 'application/json', ...headers } }).then(toResult)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('CSRF', () => {
  test('bloqueia formulários e requisições simples de outra origem (403) sem executar nada', async () => {
    const mod = await asModerator()
    const { event } = await createEvent(mod, 'Alvo de CSRF')
    const { phone } = await joinParticipant(mod, event.id, 'Clara Alvo')
    const countEvents = async () => (await mod.req('GET', '/api/events')).data.length as number
    const before = await countEvents()
    const evil = 'http://evil.example'
    const form = 'name=Evento+forjado'
    const json = '{"name":"Evento forjado"}'
    const multipart = '--x\r\nContent-Disposition: form-data; name="name"\r\n\r\nEvento forjado\r\n--x--\r\n'
    const attempts: [string, Client, string, string, Record<string, string>, (string | Uint8Array)?][] = [
      ['formulário urlencoded', mod, 'POST', '/api/events', { origin: evil, 'content-type': 'application/x-www-form-urlencoded' }, form],
      ['formulário multipart', mod, 'POST', '/api/events', { origin: evil, 'content-type': 'multipart/form-data; boundary=x' }, multipart],
      ['JSON disfarçado de text/plain', mod, 'POST', '/api/events', { origin: evil, 'content-type': 'text/plain' }, json],
      ['corpo sem Content-Type', mod, 'POST', '/api/events', { origin: evil }, new TextEncoder().encode(json)],
      ['Origin nula (iframe em sandbox)', mod, 'POST', '/api/events', { origin: 'null', 'content-type': 'text/plain' }, json],
      ['só Sec-Fetch-Site cross-site', mod, 'POST', '/api/events', { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, json],
      ['sem Origin nem Sec-Fetch-Site', mod, 'POST', '/api/events', { 'content-type': 'text/plain' }, json],
      ['origem com prefixo parecido', mod, 'POST', '/api/events', { origin: 'http://localhost.evil.example', 'content-type': 'text/plain' }, json],
      ['mesmo host com outro esquema', mod, 'POST', '/api/events', { origin: 'https://localhost', 'content-type': 'text/plain' }, json],
      ['apagar evento', mod, 'DELETE', `/api/events/${event.id}`, { origin: evil }],
      ['renomear evento', mod, 'PATCH', `/api/events/${event.id}`, { origin: evil, 'content-type': 'text/plain' }, '{"name":"Invadido"}'],
      ['sair da conta', mod, 'POST', '/api/auth/logout', { origin: evil }],
      ['login forçado', new Client(), 'POST', '/api/auth/login', { origin: evil, 'content-type': 'text/plain' }, `{"email":"${MOD_EMAIL}","password":"${MOD_PASSWORD}"}`],
      ['pergunta do participante', phone, 'POST', `/api/p/${event.id}/questions`, { origin: evil, 'content-type': 'text/plain' }, '{"text":"Pergunta forjada"}'],
      ['reação do participante', phone, 'POST', `/api/p/${event.id}/reactions`, { origin: evil, 'content-type': 'text/plain' }, '{"kinds":{"love":5}}'],
    ]
    for (const [label, who, method, path, headers, body] of attempts) {
      const r = await forge(who, method, path, headers, body)
      assert.equal(r.status, 403, label)
      assert.equal(r.headers.getSetCookie().length, 0, `${label}: não mexe em cookies`)
    }
    // Nada mudou: nem evento novo, nem renomeado/apagado, nem pergunta, e a sessão continua valendo.
    assert.equal(await countEvents(), before)
    const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
    assert.equal(snap.event.name, 'Alvo de CSRF')
    assert.deepEqual(snap.questions, [])
    // Controle: a mesma requisição vinda da própria origem passa pela proteção.
    const same = await forge(mod, 'POST', '/api/events', { origin: 'http://localhost', 'content-type': 'text/plain' }, '{"name":"Evento legítimo"}')
    assert.equal(same.status, 201)
    const fetchSite = await forge(mod, 'POST', '/api/events', { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }, '{"name":"Evento legítimo 2"}')
    assert.equal(fetchSite.status, 201)
  })

  // A URL interna chega como http atrás de proxy que termina o TLS, então a comparação de Origin falha e só
  // Sec-Fetch-Site (navegadores atuais) deixa passar. Corrigir exige decidir as origens públicas confiáveis
  // (X-Forwarded-Proto/Host com TRUST_PROXY, PUBLIC_URL).
  test.todo('atrás de proxy HTTPS (TRUST_PROXY=1) aceita a própria origem https em DELETE/POST sem Content-Type de navegador sem Sec-Fetch-Site (hoje 403)')

  test('não libera CORS para outras origens', async () => {
    const mod = await asModerator()
    const preflight = await forge(mod, 'OPTIONS', '/api/events', {
      origin: 'http://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    })
    const read = await forge(mod, 'GET', '/api/events', { origin: 'http://evil.example' })
    for (const r of [preflight, read]) {
      assert.equal(r.headers.get('access-control-allow-origin'), null)
      assert.equal(r.headers.get('access-control-allow-credentials'), null)
    }
  })
})

describe('corpo das requisições', () => {
  test('recusa JSON acima de 2 MB com 413, com ou sem Content-Length', async () => {
    const mod = await asModerator()
    const { event } = await createEvent(mod, 'Corpo grande')
    const { phone } = await joinParticipant(mod, event.id, 'Gil Grande')
    const big = JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024 + 1) })
    const cases: [Client, string, string][] = [
      [mod, 'POST', '/api/events'],
      [mod, 'PATCH', `/api/events/${event.id}`],
      [mod, 'POST', `/api/events/${event.id}/participants`],
      [phone, 'POST', `/api/p/${event.id}/questions`],
      [new Client(), 'POST', '/api/auth/login'],
    ]
    for (const [who, method, path] of cases) {
      const streamed = await rawJson(who, method, path, big)
      assert.equal(streamed.status, 413, `${method} ${path}`)
      assert.deepEqual(streamed.data, { error: 'Requisição grande demais.' })
      // Tamanho declarado: recusado antes de ler o corpo.
      const declared = await rawJson(who, method, path, '{}', { 'content-length': String(50 * 1024 * 1024) })
      assert.equal(declared.status, 413, `${method} ${path} (Content-Length)`)
    }
    assert.equal((await mod.req('GET', '/api/events')).data.some((e: { name: string }) => e.name.startsWith('xxx')), false)
  })

  test('JSON malformado ou com formato errado responde 400 com mensagem em português', async () => {
    const mod = await asModerator()
    const { event } = await createEvent(mod, 'JSON inválido')
    const bodies = ['{"name":', "{'name':'x'}", '{name: "x"}', 'null', '[]', '"texto"', '42', '', '\u0000']
    for (const path of ['/api/events', `/api/events/${event.id}/live`, `/api/events/${event.id}/participants`]) {
      for (const body of bodies) {
        const r = await rawJson(mod, 'POST', path, body)
        assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`)
        assert.match(r.data.error, /^Entrada inválida: esperava um objeto/, `${path} ${JSON.stringify(body)}`)
      }
    }
  })
})

describe('erros', () => {
  const LEAK = new RegExp(
    [
      String.raw`\bat\s+\S+\s+\(`, // linha de pilha "at fn (arquivo:linha)"
      String.raw`\bat\s+(file|node):`,
      'node:internal',
      'node_modules',
      String.raw`\.[jt]s:\d+`,
      '/Users/',
      '/home/',
      '/private/',
      '/var/folders/',
      escape(DATA_DIR),
      'deck\\.db',
      'SQLITE',
      String.raw`\bSELECT\b`,
      String.raw`\bINSERT\b`,
      String.raw`\bUPDATE\s+\w+\s+SET\b`,
      'DELETE FROM',
      'Error:',
      'TypeError',
      'SyntaxError',
      'ZodError',
      '"stack"',
      '"issues"',
    ].join('|'),
  )
  const ENGLISH = /\b(invalid|expected|required|received|must|cannot|unauthorized|forbidden|not found|too large|payload)\b/i

  test('respostas de erro não expõem pilha, caminhos, SQL nem detalhes internos', async () => {
    const mod = await asModerator()
    const { event } = await createEvent(mod, 'Erros')
    const id = event.id
    const anon = new Client()
    const cases: [string, () => Promise<Result>][] = [
      ['JSON truncado', () => rawJson(mod, 'POST', '/api/events', '{"name":')],
      ['JSON com aspas simples', () => rawJson(mod, 'POST', '/api/events', "{'name':'x'}")],
      ['tipo errado', () => mod.req('POST', '/api/events', { name: 42 })],
      ['texto longo demais', () => mod.req('POST', '/api/events', { name: 'x'.repeat(500) })],
      ['PIN inválido', () => mod.req('PATCH', `/api/events/${id}`, { pin: 'abc' })],
      ['tema incompleto', () => mod.req('PATCH', `/api/events/${id}`, { theme: { brand: 'red' } })],
      ['comando ao vivo desconhecido', () => mod.req('POST', `/api/events/${id}/live`, { op: 'explodir' })],
      ['URL javascript: em página web', () => mod.req('POST', `/api/events/${id}/scenes`, { type: 'embed', content: { url: 'javascript:alert(1)' } })],
      ['mídia fora da biblioteca', () => mod.req('POST', `/api/events/${id}/scenes`, { type: 'image', content: { src: '/media/../deck.db', fit: 'cover', caption: '' } })],
      ['evento inexistente', () => mod.req('PATCH', '/api/events/ZZZZZZ', { name: 'x' })],
      ['pergunta inexistente', () => mod.req('PATCH', `/api/events/${id}/questions/nao-existe`, { status: 'approved' })],
      ['cena inexistente', () => mod.req('PATCH', `/api/events/${id}/scenes/nao-existe`, { name: 'x' })],
      ['participante inexistente', () => mod.req('PATCH', `/api/events/${id}/participants/nao-existe`, { name: 'x' })],
      ['mídia inexistente', () => mod.req('DELETE', `/api/events/${id}/media/nao-existe`)],
      ['tela inexistente', () => mod.req('PATCH', `/api/events/${id}/screens/nao-existe`, { name: 'Tela' })],
      ['código de tela com tipo errado', () => mod.req('POST', `/api/events/${id}/screens`, { code: 7 })],
      ['convite inexistente', () => anon.req('GET', '/api/invite/nao-existe')],
      ['escape inválido no caminho', () => mod.req('GET', '/api/events/%E0%A4%A/stream')],
      ['escape inválido no convite', () => anon.req('GET', '/api/invite/%ZZ')],
      ['cookie malformado', () => anon.req('GET', '/api/events', undefined, { cookie: 'deck_mod=%E0%A4%A; deck_screen=%' })],
      ['cookie com assinatura falsa', () => anon.req('GET', '/api/events', undefined, { cookie: `deck_mod=abc.123.${'A'.repeat(43)}%3D` })],
      ['sem sessão de moderador', () => anon.req('GET', `/api/events/${id}/stream`)],
      ['sem sessão de participante', () => anon.req('POST', `/api/p/${id}/questions`, { text: 'Oi?' })],
      ['login com tipos errados', () => anon.req('POST', '/api/auth/login', { email: ['x'], password: { a: 1 } })],
      ['envio de mídia sem tipo', () => mod.raw('POST', `/api/events/${id}/media`, { body: new Uint8Array(4) }).then(toResult)],
      ['tela sem pareamento', () => anon.req('GET', '/api/screen/stream')],
      ['rota inexistente', () => anon.req('GET', '/api/nao-existe')],
      ['corpo grande demais', () => rawJson(mod, 'POST', '/api/events', JSON.stringify({ name: 'x'.repeat(3 * 1024 * 1024) }))],
    ]
    for (const [label, run] of cases) {
      const r = await run()
      assert.ok(r.status >= 400 && r.status < 500, `${label}: status ${r.status}`)
      assert.match(r.headers.get('content-type') ?? '', /application\/json/, label)
      assert.equal(typeof r.data.error, 'string', label)
      assert.ok(r.data.error.length > 0, label)
      assert.deepEqual(Object.keys(r.data), ['error'], `${label}: só a mensagem`)
      assert.doesNotMatch(JSON.stringify(r.data), LEAK, label)
      assert.doesNotMatch(r.data.error, ENGLISH, `${label}: mensagem em português`)
    }
  })

  test('rota desconhecida da API responde 404 JSON, inclusive depois de passar pela sessão do moderador', async () => {
    const mod = await asModerator()
    const { event } = await createEvent(mod, 'Rotas')
    const cases: [Client, string, string][] = [
      [new Client(), 'GET', '/api/nao-existe'],
      [new Client(), 'POST', '/api/nao-existe'],
      [mod, 'GET', `/api/events/${event.id}/nao-existe`],
      [mod, 'POST', `/api/events/${event.id}/scenes/x/nao-existe`],
      [mod, 'PUT', `/api/events/${event.id}`],
    ]
    for (const [who, method, path] of cases) {
      const r = await who.req(method, path)
      assert.equal(r.status, 404, `${method} ${path}`)
      assert.deepEqual(r.data, { error: 'Rota não encontrada.' }, `${method} ${path}`)
    }
  })

  test('erro inesperado responde 500 genérico; o detalhe fica só no log do servidor', async (t) => {
    const logged: unknown[][] = []
    t.mock.method(console, 'error', (...args: unknown[]) => void logged.push(args))
    const r = await new Client().req('GET', '/__teste/erro-interno')
    assert.equal(r.status, 500)
    assert.deepEqual(r.data, { error: 'Erro interno. Tente novamente.' })
    assert.doesNotMatch(JSON.stringify(r.data), LEAK)
    assert.equal(logged.length, 1)
    assert.match(String(logged[0]![1]), /SQLITE_ERROR/)
  })
})

describe('cabeçalhos', () => {
  test('API, stream, mídia e 404 levam os cabeçalhos de segurança', async () => {
    const mod = await asModerator()
    const { event } = await createEvent(mod, 'Cabeçalhos')
    const anon = new Client()
    const upload = await mod.raw('POST', `/api/events/${event.id}/media`, {
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      headers: { 'content-type': 'image/png', 'x-filename': 'logo.png' },
    })
    const media = (await upload.json()) as Media
    const responses: [string, () => Promise<Response>][] = [
      ['API 200', () => anon.raw('GET', '/api/auth/me')],
      ['API 401', () => anon.raw('GET', '/api/events')],
      ['API 404', () => anon.raw('GET', '/api/nao-existe')],
      ['API 400', () => mod.raw('POST', '/api/events', { body: '{', headers: { 'content-type': 'application/json' } })],
      ['CSRF 403', () => mod.raw('POST', '/api/events', { body: 'a=1', headers: { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' } })],
      ['mídia 200', () => anon.raw('GET', media.url)],
      ['mídia 404', () => anon.raw('GET', `/media/${event.id}/nao-existe.png`)],
      ['página 404', () => anon.raw('GET', '/qualquer-coisa')],
    ]
    for (const [label, run] of responses) {
      const res = await run()
      await res.body?.cancel()
      assertSecurityHeaders(label, res.headers)
    }
    const sse = await mod.stream(`/api/events/${event.id}/stream`)
    try {
      assertSecurityHeaders('SSE', sse.response.headers)
      assert.equal(sse.response.headers.get('cache-control'), 'no-cache')
    } finally {
      sse.close()
    }
  })
})

function assertSecurityHeaders(label: string, headers: Headers) {
  const expected = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'SAMEORIGIN',
    'x-robots-tag': 'noindex, nofollow',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
  }
  for (const [name, value] of Object.entries(expected)) assert.equal(headers.get(name), value, `${label}: ${name}`)
  assert.match(headers.get('permissions-policy') ?? '', /camera=\(\).*microphone=\(\)/, `${label}: permissions-policy`)
  assert.equal(headers.get('x-powered-by'), null, label)
}

describe('cookies', () => {
  function cookieOf(headers: Headers, name: string) {
    const raw = headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
    assert.ok(raw, `sem cookie ${name}`)
    const attrs = raw.split(';').slice(1).map((a) => a.trim().toLowerCase())
    for (const attr of ['httponly', 'samesite=lax', 'path=/']) assert.ok(attrs.includes(attr), `${name} sem ${attr}: ${raw}`)
    return attrs
  }

  test('sessões de moderador, participante e tela são HttpOnly e SameSite=Lax; Secure atrás de proxy HTTPS', async () => {
    const mod = await asModerator()
    const { event } = await createEvent(mod, 'Cookies')
    await mod.req('POST', `/api/events/${event.id}/participants`, { people: [{ name: 'Rui Http' }, { name: 'Sara Https' }] })
    const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
    const token = (name: string) => snap.participants.find((p) => p.name === name)!.token
    const https = { 'x-forwarded-proto': 'https' }
    for (const [proto, extra] of [['http', {}], ['https', https]] as const) {
      const secure = proto === 'https'
      const login = await new Client().req('POST', '/api/auth/login', { email: MOD_EMAIL, password: MOD_PASSWORD }, extra)
      assert.equal(login.status, 200)
      const modAttrs = cookieOf(login.headers, 'deck_mod')
      assert.equal(modAttrs.includes('secure'), secure, `deck_mod (${proto})`)
      assert.ok(modAttrs.includes(`max-age=${60 * 60 * 24 * 30}`), 'sessão do moderador dura 30 dias')

      const join = await new Client().req('POST', `/api/invite/${token(secure ? 'Sara Https' : 'Rui Http')}`, { pin: snap.event.pin }, extra)
      assert.equal(join.status, 200)
      assert.equal(cookieOf(join.headers, `deck_p_${event.id}`).includes('secure'), secure, `participante (${proto})`)

      const pair = await new Client().req('POST', '/api/screen/pair', undefined, extra)
      assert.equal(pair.status, 200)
      const screenAttrs = cookieOf(pair.headers, 'deck_screen')
      assert.equal(screenAttrs.includes('secure'), secure, `deck_screen (${proto})`)
      assert.ok(screenAttrs.includes(`max-age=${60 * 60 * 24 * 360}`), 'a tela fica pareada por um ano')
    }
  })
})

describe('isolamento de dados', () => {
  /** Falha se algum dos valores aparecer em qualquer ponto do JSON (inclusive dentro de outro texto). */
  function assertHidden(label: string, data: unknown, secrets: Record<string, string>) {
    const json = JSON.stringify(data)
    for (const [what, value] of Object.entries(secrets)) assert.ok(!json.includes(value), `${label} expõe ${what}`)
  }
  /** Todas as chaves de objetos, em qualquer profundidade. */
  function keys(data: unknown, out = new Set<string>()): Set<string> {
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (!Array.isArray(data)) out.add(k)
        keys(v, out)
      }
    }
    return out
  }
  const PRIVATE_KEYS = ['token', 'email', 'participants', 'participantId', 'password', 'flagWords', 'original', 'flagged', 'group', 'grp', 'secret']

  test('tela e celulares nunca recebem tokens, e-mails, PIN (celular), dados de outros participantes ou da moderação', async () => {
    const mod = await asModerator()
    const created = await createEvent(mod, 'Isolamento')
    const id = created.event.id
    const PIN = '48151623'
    assert.equal(
      (await mod.req('PATCH', `/api/events/${id}`, { pin: PIN, settings: { flagWords: ['segredointerno'], screenName: 'first-initial' } })).status,
      200,
    )
    const people = [
      { name: 'Ana Pereira', email: 'ana.pereira@exemplo.com', group: 'Turma Sigilosa' },
      { name: 'Bruno Costa', email: 'bruno.costa@exemplo.com', group: 'Turma Reservada' },
    ]
    assert.equal((await mod.req('POST', `/api/events/${id}/participants`, { people })).status, 201)
    let snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)
    const ana = snap.participants.find((p) => p.name === 'Ana Pereira')!
    const bruno = snap.participants.find((p) => p.name === 'Bruno Costa')!
    // O console vê tokens e e-mails: é ele que distribui os convites.
    assert.equal(ana.email, 'ana.pereira@exemplo.com')
    assert.match(ana.token, /^[\w-]{24}$/)
    assert.match(bruno.token, /^[\w-]{24}$/)

    const anaPhone = new Client()
    const brunoPhone = new Client()
    assert.equal((await anaPhone.req('POST', `/api/invite/${ana.token}`, { pin: PIN })).status, 200)
    assert.equal((await brunoPhone.req('POST', `/api/invite/${bruno.token}`, { pin: PIN })).status, 200)
    // Bruno pergunta com um termo sensível; a moderação corrige, aprova e põe na tela. Ana deixa uma pendente.
    assert.equal((await brunoPhone.req('POST', `/api/p/${id}/questions`, { text: 'Pergunta original com segredointerno do Bruno' })).status, 201)
    assert.equal((await anaPhone.req('POST', `/api/p/${id}/questions`, { text: 'Pergunta pendente reservada da Ana' })).status, 201)
    snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)
    const q = snap.questions.find((x) => x.participantId === bruno.id)!
    assert.equal(q.flagged, true)
    assert.equal((await mod.req('PATCH', `/api/events/${id}/questions/${q.id}`, { text: 'Pergunta editada do Bruno', status: 'approved' })).status, 200)
    assert.equal((await mod.req('POST', `/api/events/${id}/questions/${q.id}/screen`, { on: true })).status, 200)
    const questionsScene = snap.scenes.find((s) => s.type === 'questions')!
    assert.equal((await live(mod, id, { op: 'preview', sceneId: questionsScene.id })).status, 200)
    assert.equal((await live(mod, id, { op: 'take' })).status, 200)

    const tv = new Client()
    const { data: pair } = await tv.req('POST', '/api/screen/pair')
    assert.equal((await mod.req('POST', `/api/events/${id}/screens`, { code: pair.code })).status, 201)
    const screen = await tv.snapshot<ScreenSnapshot>('/api/screen/stream')
    const anaSnap = await anaPhone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)
    const brunoSnap = await brunoPhone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)

    // O que é público aparece: a pergunta corrigida, com o nome no formato da tela.
    const shown = { id: q.id, text: 'Pergunta editada do Bruno', author: 'Bruno C.', likes: 0 }
    assert.deepEqual(screen.questions, [shown])
    assert.deepEqual(anaSnap.now?.questions, [{ ...shown, liked: false }])
    assert.deepEqual(
      brunoSnap.mine.map(({ text, status, onScreen, edited }) => ({ text, status, onScreen, edited })),
      [{ text: 'Pergunta editada do Bruno', status: 'approved', onScreen: true, edited: true }],
    )
    assert.deepEqual(anaSnap.me, { id: ana.id, name: 'Ana Pereira' })

    const me = ((await mod.req('GET', '/api/moderators')).data as { id: string; email: string }[]).find((m) => m.email === MOD_EMAIL)!
    const password = get<{ password: string }>('SELECT password FROM moderators WHERE email = ?', MOD_EMAIL)!.password
    const sessionSecret = get<{ value: string }>("SELECT value FROM meta WHERE key = 'session_secret'")!.value
    const everyone = {
      'token da Ana': ana.token,
      'token do Bruno': bruno.token,
      'e-mail da Ana': ana.email,
      'e-mail do Bruno': bruno.email,
      'grupo da Ana': 'Turma Sigilosa',
      'grupo do Bruno': 'Turma Reservada',
      'e-mail da moderação': MOD_EMAIL,
      'id da moderação': me.id,
      'nome da moderação': 'Ana Moderadora',
      'hash da senha': password,
      'parte do hash da senha': password.split('.')[1]!,
      'segredo das sessões': sessionSecret,
      'texto original editado pela moderação': 'segredointerno',
      'código de pareamento': pair.code,
    }
    assertHidden('tela', screen, {
      ...everyone,
      'id da Ana': ana.id,
      'id do Bruno': bruno.id,
      'nome completo do Bruno': 'Bruno Costa',
      'pergunta pendente': 'pendente reservada',
    })
    assertHidden('celular da Ana', anaSnap, {
      ...everyone,
      'id do Bruno': bruno.id,
      'nome completo do Bruno': 'Bruno Costa',
    })
    assertHidden('celular do Bruno', brunoSnap, {
      ...everyone,
      'id da Ana': ana.id,
      'nome completo da Ana': 'Ana Pereira',
      'pergunta pendente da Ana': 'pendente reservada',
    })
    for (const [label, data] of [['tela', screen], ['celular da Ana', anaSnap], ['celular do Bruno', brunoSnap]] as const) {
      const found = keys(data)
      for (const k of PRIVATE_KEYS) assert.equal(found.has(k), false, `${label} tem a chave "${k}"`)
    }
    // O PIN aparece na tela (é como o público entra), mas nunca no celular.
    assert.equal(screen.event.pin, PIN)
    for (const [label, data] of [['celular da Ana', anaSnap], ['celular do Bruno', brunoSnap]] as const) {
      assert.equal(keys(data).has('pin'), false, label)
      assert.ok(!JSON.stringify(data).includes(PIN), `${label} expõe o PIN`)
    }
  })

  test('sessão de um evento não abre outro evento nem as rotas da moderação', async () => {
    const mod = await asModerator()
    const { event: a } = await createEvent(mod, 'Evento A')
    const { event: b } = await createEvent(mod, 'Evento B')
    const { phone } = await joinParticipant(mod, a.id, 'Carla Dias')
    const pCookie = phone.jar.get(`deck_p_${a.id}`)!
    const modCookie = mod.jar.get('deck_mod')!
    const withCookie = (name: string, value: string) => {
      const c = new Client()
      c.jar.set(name, value)
      return c
    }
    // O mesmo celular no evento B: sem sessão lá.
    assert.equal((await phone.req('GET', `/api/p/${b.id}/stream`)).status, 401)
    assert.equal((await phone.req('POST', `/api/p/${b.id}/questions`, { text: 'Pergunta no evento errado' })).status, 401)
    assert.equal((await phone.req('POST', `/api/p/${b.id}/reactions`, { kinds: { love: 1 } })).status, 401)
    // Cookie copiado com o nome do evento B: a assinatura confere, mas o participante não é de B.
    assert.equal((await withCookie(`deck_p_${b.id}`, pCookie).req('GET', `/api/p/${b.id}/stream`)).status, 401)
    // Sessão de participante não vira sessão de moderador, e vice-versa.
    assert.equal((await withCookie('deck_mod', pCookie).req('GET', '/api/events')).status, 401)
    assert.equal((await withCookie(`deck_p_${a.id}`, modCookie).req('GET', `/api/p/${a.id}/stream`)).status, 401)
    // Cookie adulterado (id trocado, assinatura antiga).
    const tampered = pCookie.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'))
    assert.equal((await withCookie(`deck_p_${a.id}`, tampered).req('GET', `/api/p/${a.id}/stream`)).status, 401)
    // O participante não usa rotas da moderação nem do próprio evento.
    assert.equal((await phone.req('GET', `/api/events/${a.id}/stream`)).status, 401)
    assert.equal((await phone.req('PATCH', `/api/events/${a.id}`, { name: 'Invadido' })).status, 401)
    assert.equal((await phone.req('GET', `/api/screen/stream?event=${a.id}`)).status, 401)
    // Controle: no próprio evento o acesso continua.
    const own = await phone.snapshot<ParticipantSnapshot>(`/api/p/${a.id}/stream`)
    assert.equal(own.event.id, a.id)
  })
})
