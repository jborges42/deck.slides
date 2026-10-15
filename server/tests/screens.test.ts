// Telas pareadas por código: pedido de código, sala de espera, vínculo ao evento, presença no console,
// renomear, desparear, limites de tentativa, expiração e isolamento entre eventos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asModerator, Client, createEvent, joinParticipant } from './helpers.ts'
import type { ModeratorSnapshot, ScreenSnapshot } from '../../shared/types.ts'

const { get, normalizeCode } = await import('../db.ts')

const CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/ // alfabeto Crockford, sem I, L, O, U
const NEVER_A_CODE = 'UUUUUU' // U não existe no alfabeto: nunca corresponde a uma tela
const PASSWORD = 'senha-das-telas-1'
const admin = await asModerator()

/** Computador da projeção pedindo um código de pareamento. */
async function pairScreen(tv = new Client()) {
  const r = await tv.req('POST', '/api/screen/pair')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.paired, false)
  return { tv, code: r.data.code as string, expiresAt: r.data.expiresAt as number, headers: r.headers }
}

const claim = (mod: Client, eventId: string, code: string, name?: string) =>
  mod.req('POST', `/api/events/${eventId}/screens`, name === undefined ? { code } : { code, name })

async function login(email: string) {
  const c = new Client()
  assert.equal((await c.req('POST', '/api/auth/login', { email, password: PASSWORD })).status, 200)
  return c
}

/** Moderador com conta própria: o limite de conexões de tela é por conta, então cada teste usa a sua. */
let accounts = 0
async function newModerator() {
  const email = `telas${++accounts}@exemplo.com`
  assert.equal((await admin.req('POST', '/api/moderators', { name: `Operador ${accounts}`, email, password: PASSWORD })).status, 201)
  return { mod: await login(email), email }
}

/** Tela já pareada a um evento. */
async function pairedScreen(mod: Client, eventId: string, name?: string) {
  const { tv, code } = await pairScreen()
  const r = await claim(mod, eventId, code, name)
  assert.equal(r.status, 201, JSON.stringify(r.data))
  return { tv, id: r.data.id as string, code }
}

test('pedido de pareamento gera código legível de 6 caracteres e cookie HttpOnly; repetir mantém o código', async () => {
  const { tv, code, expiresAt, headers } = await pairScreen()
  assert.match(code, CODE)
  const now = Date.now()
  assert.ok(expiresAt > now + 14 * 60_000 && expiresAt <= now + 15 * 60_000, 'vale 15 minutos')
  const cookie = headers.getSetCookie().find((c) => c.startsWith('deck_screen='))
  assert.ok(cookie, 'cookie da tela')
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /; SameSite=Lax/)
  // O cookie guarda um segredo assinado, não o código.
  assert.ok(!cookie.includes(code))
  const again = await tv.req('POST', '/api/screen/pair')
  assert.deepEqual(again.data, { paired: false, code, expiresAt })
  assert.equal(again.headers.getSetCookie().length, 0, 'mantém o mesmo cookie')
  // Outro computador recebe outro código.
  assert.notEqual((await pairScreen()).code, code)
})

test('stream da tela: sem cookie responde 401; com cookie e sem pareamento entrega o código', async () => {
  const anon = await new Client().req('GET', '/api/screen/stream')
  assert.equal(anon.status, 401)
  assert.deepEqual(anon.data, { error: 'Tela não pareada.' })
  const { tv, code, expiresAt } = await pairScreen()
  const waiting = await tv.stream('/api/screen/stream')
  try {
    assert.deepEqual(await waiting.next('pairing'), { code, expiresAt })
  } finally {
    waiting.close()
  }
  // Cookie adulterado (segredo trocado, assinatura antiga) não vale.
  const forged = new Client()
  forged.jar.set('deck_screen', tv.jar.get('deck_screen')!.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')))
  assert.equal((await forged.req('GET', '/api/screen/stream')).status, 401)
})

test('moderador conecta a tela pelo código (minúsculas, espaços e hífens); a tela recebe "paired" e passa a receber o evento', async () => {
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: pareamento')
  const { tv, code } = await pairScreen()
  const waiting = await tv.stream('/api/screen/stream')
  try {
    await waiting.next('pairing')
    const typed = ` ${code.slice(0, 3).toLowerCase()} - ${code.slice(3).toLowerCase()} `
    const r = await claim(mod, event.id, typed)
    assert.equal(r.status, 201, JSON.stringify(r.data))
    assert.match(r.data.id, /^[\w-]{12}$/)
    assert.deepEqual(await waiting.next('paired'), {})
    // A sala de espera fecha: a tela reconecta já pareada.
    await assert.rejects(waiting.next('pairing', { timeout: 1000 }), /stream fechado/)
  } finally {
    waiting.close()
  }
  const screen = await tv.snapshot<ScreenSnapshot>('/api/screen/stream')
  assert.equal(screen.event.id, event.id)
  assert.deepEqual(Object.keys(screen).sort(), ['event', 'program', 'publicUrl', 'questions', 'serverNow'])
  assert.deepEqual((await tv.req('POST', '/api/screen/pair')).data, { paired: true, eventId: event.id })
  // Nome padrão numerado; nome informado é usado como veio (sem espaços nas pontas).
  const named = await pairedScreen(mod, event.id, '  Palco  ')
  const third = await pairedScreen(mod, event.id)
  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
  assert.deepEqual(
    snap.screens.map((s) => s.name),
    ['Tela 1', 'Palco', 'Tela 3'],
  )
  assert.deepEqual(snap.screens.slice(1).map((s) => s.id), [named.id, third.id])
})

test('aceita O no lugar de 0 e I ou L no lugar de 1, como prevê o alfabeto Crockford', async () => {
  assert.equal(normalizeCode(' k7-qx 2m '), 'K7QX2M')
  assert.equal(normalizeCode('oO-iI lL'), '001111')
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: Crockford')
  // Códigos são aleatórios: pede até achar um com 0 ou 1 (cerca de 1 em cada 3).
  let found: Awaited<ReturnType<typeof pairScreen>> | undefined
  for (let i = 0; i < 60 && !found; i++) {
    const p = await pairScreen()
    if (/[01]/.test(p.code)) found = p
  }
  assert.ok(found, 'nenhum código com 0 ou 1 em 60 tentativas')
  let n = 0
  const typed = found.code.replace(/[01]/g, (d) => (d === '0' ? 'o' : ['I', 'l', 'L', 'i'][n++ % 4]!))
  assert.equal((await claim(mod, event.id, typed)).status, 201, `${found.code} digitado como ${typed}`)
  assert.deepEqual((await found.tv.req('POST', '/api/screen/pair')).data, { paired: true, eventId: event.id })
})

test('código errado ou já usado responde 404; dados inválidos respondem 400; sem sessão 401', async () => {
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: códigos')
  const { event: other } = await createEvent(mod, 'Telas: outro evento')
  const wrong = await claim(mod, event.id, NEVER_A_CODE)
  assert.equal(wrong.status, 404)
  assert.deepEqual(wrong.data, { error: 'Código não encontrado ou expirado. Confira o código exibido na tela.' })
  const { code } = await pairScreen()
  assert.equal((await claim(mod, event.id, code)).status, 201)
  assert.equal((await claim(mod, event.id, code)).status, 404, 'o mesmo código não conecta duas vezes')
  assert.equal((await claim(mod, other.id, code)).status, 404, 'nem em outro evento')
  for (const body of [{}, { code: 'AB1' }, { code: 'X'.repeat(21) }, { code: 123456 }, { code: 'ABCDEF', name: 'x'.repeat(61) }]) {
    const r = await mod.req('POST', `/api/events/${event.id}/screens`, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(typeof r.data.error, 'string')
  }
  const fresh = await pairScreen()
  const { phone } = await joinParticipant(mod, event.id, 'Paulo Curioso')
  for (const who of [new Client(), phone, fresh.tv]) assert.equal((await claim(who, event.id, fresh.code)).status, 401)
  assert.equal((await claim(mod, 'ZZZZZZ', fresh.code)).status, 404, 'evento inexistente')
  // Nenhuma das tentativas acima consumiu o código.
  assert.equal((await claim(mod, event.id, fresh.code)).status, 201)
})

test('limita tentativas de conexão por moderador: a 21ª em 10 minutos responde 429, mesmo com nova sessão', async () => {
  const { mod, email } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: limite de tentativas')
  for (let i = 1; i <= 20; i++) assert.equal((await claim(mod, event.id, NEVER_A_CODE)).status, 404, `tentativa ${i}`)
  const { tv, code } = await pairScreen()
  const blocked = await claim(mod, event.id, code)
  assert.equal(blocked.status, 429)
  assert.deepEqual(blocked.data, { error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' })
  // Entrar de novo (outra sessão, outro IP) não zera o limite: ele é da conta.
  assert.equal((await claim(await login(email), event.id, code)).status, 429)
  // O código não foi consumido: outro moderador ainda conecta a tela.
  const { mod: other } = await newModerator()
  assert.equal((await claim(other, event.id, code)).status, 201)
  assert.deepEqual((await tv.req('POST', '/api/screen/pair')).data, { paired: true, eventId: event.id })
})

test('limita pedidos de código por IP: o 31º em 10 minutos responde 429 sem criar cookie', async () => {
  const ip = '10.99.0.1'
  for (let i = 1; i <= 30; i++) assert.equal((await new Client(ip).req('POST', '/api/screen/pair')).status, 200, `pedido ${i}`)
  const blocked = await new Client(ip).req('POST', '/api/screen/pair')
  assert.equal(blocked.status, 429)
  assert.deepEqual(blocked.data, { error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' })
  assert.equal(blocked.headers.getSetCookie().length, 0)
  assert.equal((await new Client('10.99.0.2').req('POST', '/api/screen/pair')).status, 200, 'outro IP segue normal')
})

test('console mostra a tela online enquanto o stream está aberto e registra a última conexão ao fechar', async () => {
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: presença')
  const panel = await mod.stream(`/api/events/${event.id}/stream`)
  try {
    await panel.next('state')
    const { tv, id } = await pairedScreen(mod, event.id, 'Palco')
    const listed = await panel.next<ModeratorSnapshot>('state', { where: (s) => s.screens.some((x) => x.id === id) })
    const before = listed.screens.find((x) => x.id === id)!
    assert.deepEqual({ ...before, createdAt: 0 }, { id, name: 'Palco', online: false, createdAt: 0, lastSeen: null })
    assert.ok(before.createdAt > 0)

    const screen = await tv.stream('/api/screen/stream')
    await screen.next('state')
    const on = await panel.next<ModeratorSnapshot>('state', { where: (s) => s.screens.some((x) => x.id === id && x.online) })
    assert.equal(on.presence.screens, 1)
    assert.ok(on.screens.find((x) => x.id === id)!.lastSeen! >= before.createdAt)

    const closedAt = Date.now()
    screen.close()
    const off = await panel.next<ModeratorSnapshot>('state', { where: (s) => s.screens.some((x) => x.id === id && !x.online) })
    assert.equal(off.presence.screens, 0)
    assert.ok(off.screens.find((x) => x.id === id)!.lastSeen! >= closedAt, 'lastSeen marca o fim da conexão')
  } finally {
    panel.close()
  }
})

test('renomeia a tela e valida o nome', async () => {
  const { mod } = await newModerator()
  const { event: a } = await createEvent(mod, 'Telas: renomear A')
  const { event: b } = await createEvent(mod, 'Telas: renomear B')
  const { id } = await pairedScreen(mod, a.id)
  const nameOf = async () => (await mod.snapshot<ModeratorSnapshot>(`/api/events/${a.id}/stream`)).screens.find((s) => s.id === id)!.name
  const ok = await mod.req('PATCH', `/api/events/${a.id}/screens/${id}`, { name: '  Telão principal  ' })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.data, { ok: true })
  assert.equal(await nameOf(), 'Telão principal')
  for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(61) }, { name: 5 }, {}]) {
    const r = await mod.req('PATCH', `/api/events/${a.id}/screens/${id}`, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(typeof r.data.error, 'string')
  }
  const unknown = await mod.req('PATCH', `/api/events/${a.id}/screens/nao-existe`, { name: 'Outra' })
  assert.equal(unknown.status, 404)
  assert.deepEqual(unknown.data, { error: 'Tela não encontrada.' })
  assert.equal((await mod.req('PATCH', `/api/events/${b.id}/screens/${id}`, { name: 'Sequestrada' })).status, 404, 'tela de A pela rota de B')
  assert.equal((await new Client().req('PATCH', `/api/events/${a.id}/screens/${id}`, { name: 'Anônimo' })).status, 401)
  assert.equal(await nameOf(), 'Telão principal')
})

test('desparear derruba o stream da tela com "gone" e o próximo pedido gera código novo', async () => {
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: desparear')
  const { event: other } = await createEvent(mod, 'Telas: desparear (outro)')
  const { tv, id, code } = await pairedScreen(mod, event.id)
  const screen = await tv.stream('/api/screen/stream')
  try {
    await screen.next('state')
    // Pela rota de outro evento nada acontece com a tela.
    assert.ok((await mod.req('DELETE', `/api/events/${other.id}/screens/${id}`)).status < 500)
    await screen.none('gone', 150)
    assert.deepEqual((await tv.req('POST', '/api/screen/pair')).data, { paired: true, eventId: event.id })

    const del = await mod.req('DELETE', `/api/events/${event.id}/screens/${id}`)
    assert.equal(del.status, 200)
    assert.deepEqual(await screen.next('gone'), { reason: 'unpaired' })
    await assert.rejects(screen.next('state', { timeout: 1000 }), /stream fechado/)
  } finally {
    screen.close()
  }
  assert.deepEqual((await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)).screens, [])
  const again = await tv.req('POST', '/api/screen/pair')
  assert.equal(again.data.paired, false)
  assert.match(again.data.code, CODE)
  assert.notEqual(again.data.code, code)
  const waiting = await tv.stream('/api/screen/stream')
  try {
    assert.equal((await waiting.next('pairing')).code, again.data.code)
  } finally {
    waiting.close()
  }
  assert.equal((await claim(mod, event.id, code)).status, 404, 'o código antigo não reconecta')
})

test('tela pareada a um evento não lê outro evento nem rotas da moderação', async () => {
  const { mod } = await newModerator()
  const { event: a } = await createEvent(mod, 'Telas: evento A')
  const { event: b } = await createEvent(mod, 'Telas: evento B')
  const { tv } = await pairedScreen(mod, a.id)
  const screen = await tv.snapshot<ScreenSnapshot>('/api/screen/stream')
  assert.equal(screen.event.id, a.id)
  for (const path of [
    `/api/screen/stream?event=${b.id}`,
    `/api/screen/stream?event=${a.id}`,
    `/api/events/${b.id}/stream`,
    `/api/events/${a.id}/stream`,
    `/api/p/${b.id}/stream`,
    `/api/p/${a.id}/stream`,
    '/api/events',
  ]) {
    assert.equal((await tv.req('GET', path)).status, 401, path)
  }
  assert.equal((await tv.req('PATCH', `/api/events/${a.id}`, { name: 'Invadido' })).status, 401)
})

test('tela aberta pelo console (?event=) exige sessão de moderador e não entra na lista de telas pareadas', async () => {
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: pelo console')
  const { phone } = await joinParticipant(mod, event.id, 'Pedro Celular')
  const panel = await mod.stream(`/api/events/${event.id}/stream`)
  try {
    await panel.next('state')
    const sse = await mod.stream(`/api/screen/stream?event=${event.id.toLowerCase()}`)
    try {
      const screen = await sse.next<ScreenSnapshot>('state')
      assert.equal(screen.event.id, event.id)
      assert.deepEqual(Object.keys(screen).sort(), ['event', 'program', 'publicUrl', 'questions', 'serverNow'])
      const s = await panel.next<ModeratorSnapshot>('state', { where: (x) => x.presence.screens === 1 })
      assert.deepEqual(s.screens, [])
    } finally {
      sse.close()
    }
  } finally {
    panel.close()
  }
  for (const who of [new Client(), phone]) {
    const r = await who.req('GET', `/api/screen/stream?event=${event.id}`)
    assert.equal(r.status, 401)
    assert.deepEqual(r.data, { error: 'Entre no console para abrir a tela deste evento.' })
  }
  // Com sessão, mas evento inexistente: 404 (não é falta de login).
  const unknown = await mod.req('GET', '/api/screen/stream?event=ZZZZZZ')
  assert.equal(unknown.status, 404)
  assert.deepEqual(unknown.data, { error: 'Evento não encontrado.' })
})

test('apagar o evento derruba a tela pareada e remove o vínculo', async () => {
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: evento apagado')
  const { tv, id } = await pairedScreen(mod, event.id)
  const screen = await tv.stream('/api/screen/stream')
  try {
    await screen.next('state')
    assert.equal((await mod.req('DELETE', `/api/events/${event.id}`)).status, 200)
    assert.deepEqual(await screen.next('gone'), {})
    await assert.rejects(screen.next('state', { timeout: 1000 }), /stream fechado/)
  } finally {
    screen.close()
  }
  assert.equal(get('SELECT 1 FROM screens WHERE id = ?', id), undefined)
  // O computador volta a pedir código.
  const again = await tv.req('POST', '/api/screen/pair')
  assert.equal(again.data.paired, false)
  assert.match(again.data.code, CODE)
})

test('código de pareamento expira em 15 minutos e é trocado no pedido seguinte', async (t) => {
  const { mod } = await newModerator()
  const { event } = await createEvent(mod, 'Telas: expiração')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { tv, code, expiresAt } = await pairScreen()
  assert.equal(expiresAt, Date.now() + 15 * 60_000)
  t.mock.timers.tick(15 * 60_000 + 1)
  assert.equal((await claim(mod, event.id, code)).status, 404, 'código vencido não conecta')
  const renewed = await tv.req('POST', '/api/screen/pair')
  assert.equal(renewed.data.paired, false)
  assert.notEqual(renewed.data.code, code)
  assert.equal(renewed.data.expiresAt, Date.now() + 15 * 60_000)
  assert.equal((await claim(mod, event.id, renewed.data.code)).status, 201)
})
