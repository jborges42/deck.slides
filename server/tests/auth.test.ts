// Contas, sessões e equipe: conta inicial, login com limite de tentativas, cookies assinados,
// troca de senha, equipe e a fronteira de autorização das rotas do moderador.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { ModeratorSnapshot } from '../../shared/types.ts'

// Segredo conhecido (antes de carregar a aplicação): permite assinar cookies e testar a validade conferida no servidor.
const SECRET = 'segredo-dos-testes-de-auth'
process.env.SESSION_SECRET = SECRET
const { Client, createEvent, joinParticipant } = await import('./helpers.ts')
const { moderator: moderatorRouter } = await import('../moderator.ts')
type Client = InstanceType<typeof Client>

const DAY = 24 * 60 * 60 * 1000
const PASSWORD = 'senha-forte-123'
const EXPIRED = { error: 'Sua sessão expirou. Entre de novo para continuar.' }

/** Valor de cookie assinado como o Hono faz: "valor.HMAC-SHA256(base64)", codificado para o cabeçalho. */
const signed = (value: string, secret = SECRET) =>
  encodeURIComponent(`${value}.${createHmac('sha256', secret).update(value).digest('base64')}`)

/** Cliente novo (IP novo) que carrega só este cookie de moderador. */
function withModCookie(value: string): Client {
  const c = new Client()
  c.jar.set('deck_mod', value)
  return c
}

const me = async (c: Client) => (await c.req('GET', '/api/auth/me')).data

async function login(email: string, password = PASSWORD, client = new Client()): Promise<Client> {
  const r = await client.req('POST', '/api/auth/login', { email, password })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(client.jar.has('deck_mod'))
  return client
}

const team = async (): Promise<{ id: string; name: string; email: string }[]> => (await owner.req('GET', '/api/moderators')).data

// Conta inicial, definida pelo teste de instalação simultânea (os testes do arquivo rodam em sequência).
let owner: Client
let ownerEmail: string
let seq = 0

/** Pessoa nova na equipe, criada pela conta inicial, já com sessão aberta. */
async function teammate(name: string) {
  const email = `pessoa${++seq}@exemplo.com`
  const r = await owner.req('POST', '/api/moderators', { name, email, password: PASSWORD })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  const id = (await team()).find((m) => m.email === email)!.id
  return { email, id, client: await login(email) }
}

describe('conta inicial', () => {
  test('instalação nova: /auth/me pede a conta inicial e não há moderador', async () => {
    const r = await new Client().req('GET', '/api/auth/me')
    assert.equal(r.status, 200)
    assert.deepEqual(r.data, { moderator: null, needsSetup: true, setupToken: false })
  })

  test('valida a conta inicial com mensagens em pt-BR e não abre sessão', async () => {
    const c = new Client()
    const cases: [unknown, string][] = [
      [{ name: 'Ana', email: 'nao-e-email', password: PASSWORD }, 'Informe um e-mail válido.'],
      [{ name: 'Ana', password: PASSWORD }, 'Informe um e-mail válido.'],
      [{ name: 'Ana', email: 'ana@exemplo.com', password: '1234567' }, 'A senha precisa de ao menos 8 caracteres.'],
      [{ email: 'ana@exemplo.com', password: PASSWORD }, 'Informe seu nome.'],
      [{ name: '   ', email: 'ana@exemplo.com', password: PASSWORD }, 'Informe seu nome.'],
    ]
    for (const [body, error] of cases) {
      const r = await c.req('POST', '/api/auth/setup', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.deepEqual(r.data, { error })
    }
    // Corpo que nem é JSON: 400 sem detalhes internos do parser.
    const broken = await c.raw('POST', '/api/auth/setup', { body: '{"name":', headers: { 'content-type': 'application/json' } })
    assert.equal(broken.status, 400)
    assert.doesNotMatch(((await broken.json()) as { error: string }).error, /SyntaxError|JSON|at \//)

    assert.equal(c.jar.size, 0)
    assert.equal((await me(c)).needsSetup, true)
  })

  test('duas instalações simultâneas criam uma única conta, com e-mail normalizado', async () => {
    const a = new Client()
    const b = new Client()
    const [ra, rb] = await Promise.all([
      a.req('POST', '/api/auth/setup', { name: 'Dona A', email: '  Dona@Exemplo.COM ', password: PASSWORD }),
      b.req('POST', '/api/auth/setup', { name: 'Dona B', email: 'OUTRA@exemplo.com ', password: PASSWORD }),
    ])
    assert.deepEqual([ra.status, rb.status].sort(), [201, 409], JSON.stringify([ra.data, rb.data]))
    const [winner, loser, lost] = ra.status === 201 ? [a, b, rb] : [b, a, ra]
    assert.deepEqual(lost.data, { error: 'A conta inicial já foi criada. Entre com seu e-mail e senha.' })
    assert.equal(loser.jar.has('deck_mod'), false)

    owner = winner
    ownerEmail = winner === a ? 'dona@exemplo.com' : 'outra@exemplo.com'
    const info = await me(owner)
    assert.equal(info.needsSetup, false)
    assert.equal(info.setupToken, false)
    assert.deepEqual(Object.keys(info.moderator).sort(), ['email', 'id', 'name'])
    assert.equal(info.moderator.email, ownerEmail)
    assert.equal((await team()).length, 1)
  })

  test('com a conta criada, nova instalação responde 409 e não abre sessão', async () => {
    const c = new Client()
    const r = await c.req('POST', '/api/auth/setup', { name: 'Intrusa', email: 'intrusa@exemplo.com', password: PASSWORD })
    assert.equal(r.status, 409)
    assert.equal(c.jar.has('deck_mod'), false)
    assert.equal((await me(c)).moderator, null)
    assert.equal((await team()).length, 1)
  })
})

describe('login e sessão', () => {
  test('login abre sessão com cookie HttpOnly, SameSite=Lax, 30 dias e Secure atrás de HTTPS', async () => {
    const body = JSON.stringify({ email: ownerEmail, password: PASSWORD })
    const c = new Client()
    const res = await c.raw('POST', '/api/auth/login', { body, headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 200)
    const cookie = res.headers.getSetCookie().find((s) => s.startsWith('deck_mod='))!
    for (const attr of ['; HttpOnly', '; SameSite=Lax', '; Path=/', '; Max-Age=2592000']) assert.ok(cookie.includes(attr), `${attr} em ${cookie}`)
    assert.ok(!cookie.includes('; Secure'))
    assert.equal((await me(c)).moderator.email, ownerEmail)

    const https = await new Client().raw('POST', '/api/auth/login', {
      body,
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    })
    assert.equal(https.status, 200)
    assert.ok(https.headers.getSetCookie().some((s) => s.startsWith('deck_mod=') && s.includes('; Secure')))
  })

  test('e-mail do login não diferencia maiúsculas e ignora espaços', async () => {
    await login(`  ${ownerEmail.toUpperCase()} `)
  })

  test('senha errada e e-mail inexistente recebem a mesma resposta genérica', async () => {
    const c = new Client()
    const wrong = await c.req('POST', '/api/auth/login', { email: ownerEmail, password: 'senha-errada-1' })
    const unknown = await c.req('POST', '/api/auth/login', { email: 'ninguem@exemplo.com', password: PASSWORD })
    assert.equal(wrong.status, 401)
    assert.equal(unknown.status, 401)
    assert.deepEqual(wrong.data, { error: 'E-mail ou senha incorretos.' })
    assert.deepEqual(unknown.data, wrong.data)
    assert.equal(c.jar.has('deck_mod'), false)
  })

  test('login com corpo inválido responde 400 sem detalhes internos e sem sessão', async () => {
    const c = new Client()
    const broken = await c.raw('POST', '/api/auth/login', { body: '{"email":', headers: { 'content-type': 'application/json' } })
    assert.equal(broken.status, 400)
    assert.doesNotMatch(((await broken.json()) as { error: string }).error, /SyntaxError|JSON|at \//)
    for (const body of [{}, { email: ownerEmail }, { email: ownerEmail, password: 12345678 }, { email: ['x'], password: PASSWORD }]) {
      const r = await c.req('POST', '/api/auth/login', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(typeof r.data.error, 'string')
    }
    assert.equal(c.jar.has('deck_mod'), false)
  })

  test('10 falhas do mesmo IP bloqueiam até a senha certa; outro IP continua entrando', async () => {
    const attacker = new Client()
    for (let i = 0; i < 10; i++) {
      const r = await attacker.req('POST', '/api/auth/login', { email: ownerEmail, password: `errada-${i}` })
      assert.equal(r.status, 401, `tentativa ${i + 1}`)
    }
    const blocked = await attacker.req('POST', '/api/auth/login', { email: ownerEmail, password: PASSWORD })
    assert.equal(blocked.status, 429)
    assert.deepEqual(blocked.data, { error: 'Muitas tentativas seguidas. Tente de novo em alguns minutos.' })
    assert.equal(attacker.jar.has('deck_mod'), false)
    await login(ownerEmail) // outro IP
  })

  test('login certo zera o contador de falhas do IP', async () => {
    const c = new Client()
    const wrong = () => c.req('POST', '/api/auth/login', { email: ownerEmail, password: 'errada' })
    for (let i = 0; i < 9; i++) assert.equal((await wrong()).status, 401)
    await login(ownerEmail, PASSWORD, c)
    for (let i = 0; i < 10; i++) assert.equal((await wrong()).status, 401, `falha ${i + 1} depois do login`)
    assert.equal((await wrong()).status, 429)
  })

  test('login por formulário vindo de outro site é bloqueado (CSRF)', async () => {
    const c = new Client()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await c.raw('POST', '/api/auth/login', {
        body: JSON.stringify({ email: ownerEmail, password: PASSWORD }),
        headers: { origin: 'http://evil.example', 'content-type': type },
      })
      assert.equal(res.status, 403, type)
    }
    assert.equal(c.jar.has('deck_mod'), false)
  })

  test('logout apaga o cookie e encerra o acesso', async () => {
    const c = await login(ownerEmail)
    const res = await c.raw('POST', '/api/auth/logout')
    assert.equal(res.status, 200)
    assert.ok(res.headers.getSetCookie().some((s) => /^deck_mod=;/.test(s) && /Max-Age=0/.test(s)))
    assert.equal(c.jar.has('deck_mod'), false)
    assert.equal((await me(c)).moderator, null)
    assert.equal((await c.req('GET', '/api/events')).status, 401)
    // Sem sessão, sair continua respondendo 200.
    assert.equal((await new Client().req('POST', '/api/auth/logout')).status, 200)
  })

  test.todo(
    'logout invalida a sessão no servidor: uma cópia do cookie feita antes de sair deixa de valer ' +
      '(hoje o cookie assinado vale até expirar; exige guardar sessões ou um epoch por sessão)',
  )

  test('cookie de sessão adulterado ou forjado é recusado', async () => {
    const c = await login(ownerEmail)
    const [id, issued, sig] = decodeURIComponent(c.jar.get('deck_mod')!).split('.') as [string, string, string]
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    const forged = {
      'id alterado': encodeURIComponent(`${flip(id, 0)}.${issued}.${sig}`),
      'data alterada': encodeURIComponent(`${id}.${Number(issued) + 1}.${sig}`),
      'assinatura alterada': encodeURIComponent(`${id}.${issued}.${flip(sig, 10)}`),
      'sem assinatura': `${id}.${issued}`,
      'assinado com outro segredo': signed(`${id}.${Date.now()}`, 'outro-segredo'),
      vazio: '',
    }
    for (const [label, value] of Object.entries(forged)) {
      const f = withModCookie(value)
      const r = await f.req('GET', '/api/events')
      assert.equal(r.status, 401, label)
      assert.deepEqual(r.data, EXPIRED)
      assert.equal((await me(f)).moderator, null, label)
    }
    assert.equal((await c.req('GET', '/api/events')).status, 200) // o cookie original continua valendo
  })

  test('validade conferida no servidor: sessão emitida há mais de 30 dias ou sem data não vale', async () => {
    const id = (await me(owner)).moderator.id
    const at = (ms: number) => withModCookie(signed(`${id}.${ms}`)).req('GET', '/api/events')
    assert.equal((await at(Date.now() - 29 * DAY)).status, 200) // o cookie assinado aqui é aceito...
    assert.equal((await at(Date.now() - 31 * DAY)).status, 401) // ...mas não depois de 30 dias
    assert.equal((await withModCookie(signed(id)).req('GET', '/api/events')).status, 401) // formato sem data
    assert.equal((await withModCookie(signed(`naoexiste123.${Date.now()}`)).req('GET', '/api/events')).status, 401)
  })

  test('cookie de participante não vale como sessão de moderador', async () => {
    const { event } = await createEvent(owner, 'Evento do participante')
    const { phone } = await joinParticipant(owner, event.id)
    const value = phone.jar.get(`deck_p_${event.id}`)!
    assert.ok(value)
    assert.equal((await withModCookie(value).req('GET', '/api/events')).status, 401) // mesmo assinado, renomeado não serve
    assert.equal((await me(phone)).moderator, null)
  })
})

describe('troca de senha', () => {
  test('exige sessão, confere a senha atual e o tamanho da nova', async () => {
    const anon = await new Client().req('POST', '/api/auth/password', { current: PASSWORD, next: 'nova-senha-123' })
    assert.equal(anon.status, 401)

    const { email, client } = await teammate('Carla Conta')
    const wrong = await client.req('POST', '/api/auth/password', { current: 'nao-e-esta', next: 'nova-senha-123' })
    assert.equal(wrong.status, 400)
    assert.deepEqual(wrong.data, { error: 'Senha atual incorreta.' })
    const short = await client.req('POST', '/api/auth/password', { current: PASSWORD, next: '1234567' })
    assert.equal(short.status, 400)
    assert.deepEqual(short.data, { error: 'A nova senha precisa de ao menos 8 caracteres.' })
    // Nada mudou: a sessão segue e a senha antiga continua valendo.
    assert.equal((await client.req('GET', '/api/events')).status, 200)
    await login(email)
  })

  test('troca a senha: a sessão atual continua, as outras caem (inclusive o console aberto)', async () => {
    const { email, client: here } = await teammate('Davi Conta')
    const elsewhere = await login(email)
    const { event } = await createEvent(owner, 'Evento da troca de senha')
    const feed = await elsewhere.stream(`/api/events/${event.id}/stream`)
    try {
      await feed.next('state')
      const before = here.jar.get('deck_mod')
      const r = await here.req('POST', '/api/auth/password', { current: PASSWORD, next: 'nova-senha-456' })
      assert.equal(r.status, 200)
      assert.notEqual(here.jar.get('deck_mod'), before) // cookie novo para esta sessão

      assert.equal((await here.req('GET', '/api/events')).status, 200)
      const again = await here.stream(`/api/events/${event.id}/stream`)
      await again.next('state')
      again.close()

      assert.equal((await elsewhere.req('GET', '/api/events')).status, 401)
      assert.equal((await me(elsewhere)).moderator, null)
      await assert.rejects(feed.next('fim', { timeout: 1000 }), /stream fechado/)

      assert.equal((await new Client().req('POST', '/api/auth/login', { email, password: PASSWORD })).status, 401)
      await login(email, 'nova-senha-456')
    } finally {
      feed.close()
    }
  })
})

describe('equipe', () => {
  test('lista a equipe sem expor senha nem hash', async () => {
    await teammate('Eva Lista')
    const r = await owner.req('GET', '/api/moderators')
    assert.equal(r.status, 200)
    assert.ok(r.data.length >= 2)
    for (const m of r.data) assert.deepEqual(Object.keys(m).sort(), ['createdAt', 'email', 'id', 'name'])
    const json = JSON.stringify(r.data)
    assert.doesNotMatch(json, /password/i)
    assert.doesNotMatch(json, /[\w-]{22}\.[\w-]{86}/) // formato "sal.hash" do scrypt
  })

  test('adiciona pessoa: valida, normaliza o e-mail e recusa repetido sem diferenciar maiúsculas', async () => {
    const cases: [unknown, string][] = [
      [{ name: 'Fábio', email: 'fabio', password: PASSWORD }, 'Informe um e-mail válido.'],
      [{ name: 'Fábio', email: 'fabio@exemplo.com', password: 'curta' }, 'A senha precisa de ao menos 8 caracteres.'],
      [{ name: '  ', email: 'fabio@exemplo.com', password: PASSWORD }, 'Informe o nome.'],
      [{ email: 'fabio@exemplo.com', password: PASSWORD }, 'Informe o nome.'],
    ]
    for (const [body, error] of cases) {
      const r = await owner.req('POST', '/api/moderators', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.deepEqual(r.data, { error })
    }

    const ok = await owner.req('POST', '/api/moderators', { name: ' Fábio Equipe ', email: '  Fabio@Exemplo.COM ', password: PASSWORD })
    assert.equal(ok.status, 201, JSON.stringify(ok.data))
    assert.equal((await team()).find((m) => m.email === 'fabio@exemplo.com')?.name, 'Fábio Equipe')

    const dup = await owner.req('POST', '/api/moderators', { name: 'Outro Fábio', email: 'FABIO@exemplo.com', password: PASSWORD })
    assert.equal(dup.status, 409)
    assert.deepEqual(dup.data, { error: 'Já existe uma conta com este e-mail.' })
    await login('fabio@exemplo.com')
  })

  test('duas criações simultâneas com o mesmo e-mail: uma conta e um 409', async () => {
    const body = { name: 'Gil Duplo', email: 'gil@exemplo.com', password: PASSWORD }
    const rs = await Promise.all([
      owner.req('POST', '/api/moderators', body),
      owner.req('POST', '/api/moderators', { ...body, email: 'GIL@exemplo.com' }),
    ])
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], JSON.stringify(rs.map((r) => r.data)))
    assert.equal((await team()).filter((m) => m.email === 'gil@exemplo.com').length, 1)
  })

  test('ninguém remove a própria conta', async () => {
    const id = (await me(owner)).moderator.id
    const r = await owner.req('DELETE', `/api/moderators/${id}`)
    assert.equal(r.status, 400)
    assert.deepEqual(r.data, { error: 'Você não pode remover a própria conta.' })
    assert.equal((await owner.req('GET', '/api/events')).status, 200)
  })

  test('remover uma pessoa encerra a sessão e o console aberto dela', async () => {
    const { email, id, client } = await teammate('Helena Saída')
    const { event } = await createEvent(owner, 'Evento da remoção')
    const feed = await client.stream(`/api/events/${event.id}/stream`)
    try {
      await feed.next('state')
      const r = await owner.req('DELETE', `/api/moderators/${id}`)
      assert.equal(r.status, 200)
      assert.ok(!(await team()).some((m) => m.id === id))

      assert.equal((await client.req('GET', '/api/events')).status, 401)
      assert.equal((await me(client)).moderator, null)
      await assert.rejects(feed.next('fim', { timeout: 1000 }), /stream fechado/)
      assert.equal((await new Client().req('POST', '/api/auth/login', { email, password: PASSWORD })).status, 401)
    } finally {
      feed.close()
    }
  })

  test('remoções cruzadas simultâneas: quem já foi removido não remove mais ninguém', async () => {
    const a = await teammate('Íris Cruzada')
    const b = await teammate('Jonas Cruzado')
    const rs = await Promise.all([
      a.client.req('DELETE', `/api/moderators/${b.id}`),
      b.client.req('DELETE', `/api/moderators/${a.id}`),
    ])
    const ids = (await team()).map((m) => m.id)
    assert.equal([a.id, b.id].filter((id) => ids.includes(id)).length, 1, 'exatamente uma das duas contas continua')
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 401])
  })
})

describe('fronteira de autorização', () => {
  test('toda rota do moderador responde 401 sem sessão ou com sessão de participante, sem efeitos', async () => {
    const created = await createEvent(owner, 'Evento protegido')
    const id = created.event.id
    assert.equal((await owner.req('POST', `/api/events/${id}/questions`, { text: 'Pergunta da moderação', author: '' })).status, 201)
    const { phone } = await joinParticipant(owner, id, 'Pedro Participante')
    const snap = await owner.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)
    const ownerId = (await me(owner)).moderator.id

    // Todas as rotas registradas no roteador do moderador, com ids reais: rota nova também entra aqui.
    const params: Record<string, string> = { id, sid: snap.scenes[0]!.id, qid: snap.questions[0]!.id, pid: snap.participants[0]!.id, mid: ownerId }
    const routes = moderatorRouter.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => [r.method, `/api${r.path.replace(/:(\w+)/g, (_, k: string) => params[k] ?? 'x')}`] as const)
    for (const expected of ['GET /api/events', 'POST /api/events', `DELETE /api/events/${id}`, `GET /api/events/${id}/stream`, 'GET /api/moderators', 'POST /api/auth/password'])
      assert.ok(routes.some(([m, p]) => `${m} ${p}` === expected), expected)

    for (const [who, client] of [['sem sessão', new Client()], ['participante', phone]] as const) {
      for (const [method, path] of routes) {
        const res = await client.raw(method, path, method === 'GET' || method === 'DELETE' ? {} : { body: '{}', headers: { 'content-type': 'application/json' } })
        if (res.status !== 401) await res.body?.cancel() // um stream aberto por engano não pode travar o teste
        assert.equal(res.status, 401, `${who}: ${method} ${path}`)
        assert.deepEqual(await res.json(), EXPIRED, `${who}: ${method} ${path}`)
      }
      const screen = await client.req('GET', `/api/screen/stream?event=${id}`) // tela aberta pelo console
      assert.equal(screen.status, 401, who)
    }

    // Nada mudou no evento nem na equipe.
    const after = await owner.snapshot<ModeratorSnapshot>(`/api/events/${id}/stream`)
    assert.equal(after.event.name, 'Evento protegido')
    assert.deepEqual(after.scenes.map((s) => s.id), snap.scenes.map((s) => s.id))
    assert.deepEqual(after.questions.map((q) => [q.id, q.status, q.screen]), snap.questions.map((q) => [q.id, q.status, q.screen]))
    assert.deepEqual(after.participants.map((p) => [p.id, p.token, p.blocked]), snap.participants.map((p) => [p.id, p.token, p.blocked]))
    assert.deepEqual(after.event.live, snap.event.live)
    assert.ok((await team()).some((m) => m.id === ownerId))
    assert.equal((await owner.req('GET', '/api/events')).data.filter((e: { name: string }) => e.name === 'Evento protegido').length, 1)
  })
})
