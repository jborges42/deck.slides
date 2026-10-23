// Participantes e convites: importação, convite com PIN, bloqueio, novo link, remoção, entrada aberta e stream.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Client, Sse, asModerator, createEvent, live, wait } from './helpers.ts'
import { DEFAULT_SETTINGS, DEFAULT_THEME, defaultLive } from '../../shared/types.ts'
import type { Counts, EventSettings, ModeratorSnapshot, Participant, ParticipantSnapshot } from '../../shared/types.ts'

const { run } = await import('../db.ts')
const mod = await asModerator()

const modSnap = (eventId: string) => mod.snapshot<ModeratorSnapshot>(`/api/events/${eventId}/stream`)
const settings = (eventId: string, s: Partial<EventSettings>) => mod.req('PATCH', `/api/events/${eventId}`, { settings: s })
const participantOf = async (eventId: string, pid: string) => (await modSnap(eventId)).participants.find((p) => p.id === pid)
const wrongPin = (pin: string) => String((Number(pin) + 1) % 1_000_000).padStart(6, '0')
const TOKEN = /^[\w-]{24}$/

/** Evento novo com os convidados `names`, devolvidos na mesma ordem. */
async function eventWith(...names: string[]): Promise<{ id: string; pin: string; people: Participant[] }> {
  const snap = await createEvent(mod)
  const id = snap.event.id
  if (names.length) {
    const r = await mod.req('POST', `/api/events/${id}/participants`, { people: names.map((name) => ({ name })) })
    assert.equal(r.status, 201, JSON.stringify(r.data))
  }
  const { participants } = await modSnap(id)
  return { id, pin: snap.event.pin, people: names.map((n) => participants.find((p) => p.name === n)!) }
}

/** Confirma o PIN do convite num aparelho (novo, por padrão). */
async function join(token: string, pin: string, phone = new Client()): Promise<Client> {
  const r = await phone.req('POST', `/api/invite/${token}`, { pin })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return phone
}

/** 400 com mensagem em português, sem detalhes internos. */
function assertBadRequest(r: { status: number; data: any }, label = '') {
  assert.equal(r.status, 400, `${label} -> ${r.status} ${JSON.stringify(r.data)}`)
  assert.equal(typeof r.data?.error, 'string', label)
  assert.doesNotMatch(r.data.error, /^(Invalid|Too (small|big)|Expected|Required)|zod|sqlite|stack|\n\s+at /i, label)
}

/** Nenhuma rota do participante aceita este aparelho no evento. */
async function assertNoAccess(phone: Client, eventId: string) {
  const routes: [string, string][] = [
    ['GET', `/api/p/${eventId}/stream`],
    ['POST', `/api/p/${eventId}/leave`],
    ['POST', `/api/p/${eventId}/questions`],
    ['POST', `/api/p/${eventId}/questions/qualquer/like`],
    ['POST', `/api/p/${eventId}/reactions`],
  ]
  for (const [method, path] of routes) {
    const res = await phone.raw(method, path, method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {})
    if (res.status !== 401) await res.body?.cancel()
    assert.equal(res.status, 401, `${method} ${path}`)
    assert.deepEqual(await res.json(), { error: 'Seu acesso a este evento foi encerrado.' })
  }
}

/** Espera o servidor encerrar o stream. */
async function closed(s: Sse) {
  for (let i = 0; i < 100 && !s.closed; i++) await wait(10)
  assert.ok(s.closed, 'o servidor não encerrou o stream')
}

/** Abre um stream assim que o servidor liberar a vaga (após fechar outro). */
async function openStream(phone: Client, path: string): Promise<Sse> {
  for (let i = 0; i < 50; i++) {
    const res = await phone.raw('GET', path)
    if (res.status === 200) return new Sse(res)
    await res.body?.cancel()
    await wait(10)
  }
  assert.fail(`${path} não liberou a conexão`)
}

describe('importação de participantes', () => {
  test('importa em lote: limpa espaços, preenche padrões e gera tokens únicos de 24 caracteres', async () => {
    const { id } = await eventWith()
    const people = [
      { name: '  Ana Souza  ', email: ' ana@exemplo.com ', group: ' Turma A ' },
      { name: 'Bruno Lima' },
      ...Array.from({ length: 298 }, (_, i) => ({ name: `Pessoa ${i}` })),
    ]
    const r = await mod.req('POST', `/api/events/${id}/participants`, { people })
    assert.equal(r.status, 201)
    assert.deepEqual(r.data, { created: 300 })

    const { participants } = await modSnap(id)
    assert.equal(participants.length, 300)
    const ana = participants.find((p) => p.name === 'Ana Souza')!
    assert.deepEqual(
      { email: ana.email, group: ana.group, source: ana.source, blocked: ana.blocked, joinedAt: ana.joinedAt, online: ana.online },
      { email: 'ana@exemplo.com', group: 'Turma A', source: 'invite', blocked: false, joinedAt: null, online: false },
    )
    const bruno = participants.find((p) => p.name === 'Bruno Lima')!
    assert.deepEqual([bruno.email, bruno.group], ['', ''])
    for (const p of participants) assert.match(p.token, TOKEN)
    assert.equal(new Set(participants.map((p) => p.token)).size, 300)
    assert.equal(new Set(participants.map((p) => p.id)).size, 300)
  })

  test('rejeita lista vazia, nome em branco, mais de 5000 pessoas e tipos errados, sem gravar ninguém', async () => {
    const { id } = await eventWith()
    const cases: unknown[] = [
      {},
      null,
      { people: [] },
      { people: 'Ana Souza' },
      { people: [{ name: '   ' }] },
      { people: [{ name: 42 }] },
      { people: [{ email: 'sem-nome@exemplo.com' }] },
      { people: [{ name: 'Ana', email: 123 }] },
      { people: [{ name: 'Ana', group: ['T1'] }] },
      { people: [{ name: 'a'.repeat(121) }] },
      { people: [{ name: 'Válido' }, { name: '' }] }, // um item inválido derruba o lote inteiro
      { people: Array.from({ length: 5001 }, (_, i) => ({ name: `P${i}` })) },
    ]
    for (const body of cases) assertBadRequest(await mod.req('POST', `/api/events/${id}/participants`, body), JSON.stringify(body)?.slice(0, 60))

    const notJson = await mod.raw('POST', `/api/events/${id}/participants`, { body: 'nome;email', headers: { 'content-type': 'application/json' } })
    assert.equal(notJson.status, 400)
    assert.equal((await modSnap(id)).participants.length, 0)
  })

  test('lista acima de 2 MB responde 413 sem gravar ninguém', async () => {
    const { id } = await eventWith()
    const people = Array.from({ length: 5000 }, (_, i) => ({ name: `Pessoa ${i}`.padEnd(120, '.'), email: 'e'.repeat(200), group: 'g'.repeat(120) }))
    const r = await mod.req('POST', `/api/events/${id}/participants`, { people })
    assert.equal(r.status, 413)
    assert.deepEqual(r.data, { error: 'Requisição grande demais.' })
    assert.equal((await modSnap(id)).participants.length, 0)
  })

  test('exige sessão de moderador e evento existente', async () => {
    const { id } = await eventWith()
    const body = { people: [{ name: 'Intruso' }] }
    const anonymous = await new Client().req('POST', `/api/events/${id}/participants`, body)
    assert.equal(anonymous.status, 401)
    assert.deepEqual(anonymous.data, { error: 'Sua sessão expirou. Entre de novo para continuar.' })
    const missing = await mod.req('POST', '/api/events/ZZZZZZ/participants', body)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.data, { error: 'Evento não encontrado.' })
    assert.equal((await modSnap(id)).participants.length, 0)
  })
})

describe('convite', () => {
  test('mostra marca do evento, nome do convidado e se este aparelho já entrou, sem expor PIN nem tokens', async () => {
    const { id, pin, people: [ana, bia] } = await eventWith('Ana Souza', 'Bia Lima')
    const phone = new Client()
    const before = await phone.req('GET', `/api/invite/${ana!.token}`)
    assert.equal(before.status, 200)
    // pinLength (só o número de dígitos) dimensiona o campo do PIN no celular; o PIN em si nunca sai.
    assert.deepEqual(Object.keys(before.data.event).sort(), ['brand', 'contrast', 'fonts', 'id', 'logo', 'name', 'pinLength'])
    assert.equal(before.data.event.pinLength, pin.length)
    assert.deepEqual([before.data.event.id, before.data.event.name], [id, 'Aula magna'])
    assert.deepEqual(before.data.participant, { name: 'Ana Souza' })
    assert.equal(before.data.joined, false)
    const raw = JSON.stringify(before.data)
    for (const secret of ['"pin"', ana!.token, ana!.id, bia!.token, 'Bia Lima']) assert.ok(!raw.includes(secret), secret)

    await join(ana!.token, pin, phone)
    assert.equal((await phone.req('GET', `/api/invite/${ana!.token}`)).data.joined, true)
    assert.equal((await phone.req('GET', `/api/invite/${bia!.token}`)).data.joined, false) // sessão é da Ana, não da Bia
    assert.equal((await new Client().req('GET', `/api/invite/${ana!.token}`)).data.joined, false) // outro aparelho
  })

  test('token desconhecido responde 404 genérico', async () => {
    for (const token of ['inexistente', 'x'.repeat(24), encodeURIComponent("' OR 1=1 --")]) {
      const seen = await new Client().req('GET', `/api/invite/${token}`)
      assert.equal(seen.status, 404, token)
      assert.deepEqual(seen.data, { error: 'Convite inválido ou desativado.' })
      const confirm = await new Client().req('POST', `/api/invite/${token}`, { pin: '123456' })
      assert.equal(confirm.status, 404, token)
      assert.deepEqual(confirm.data, { error: 'Convite inválido ou desativado.' })
    }
  })

  test('PIN errado responde 401 sem sessão; PIN certo abre sessão, marca a entrada e aparece para a moderação', async () => {
    const { id, pin, people: [ana] } = await eventWith('Ana Souza')
    const ms = await mod.stream(`/api/events/${id}/stream`)
    try {
      await ms.next('state')
      const phone = new Client()
      const wrong = await phone.req('POST', `/api/invite/${ana!.token}`, { pin: wrongPin(pin) })
      assert.equal(wrong.status, 401)
      assert.deepEqual(wrong.data, { error: 'PIN incorreto. Confira os números com a organização do evento.' })
      assert.deepEqual(wrong.headers.getSetCookie(), [])
      assert.equal((await participantOf(id, ana!.id))!.joinedAt, null)

      const t0 = Date.now()
      const ok = await phone.req('POST', `/api/invite/${ana!.token}`, { pin })
      assert.equal(ok.status, 200)
      assert.deepEqual(ok.data, { eventId: id })
      const cookie = ok.headers.getSetCookie().find((c) => c.startsWith(`deck_p_${id}=`))
      assert.ok(cookie, 'cookie de sessão do evento')
      assert.match(cookie, /HttpOnly/i)
      assert.match(cookie, /SameSite=Lax/i)
      assert.match(cookie, /Path=\//)

      const joined = await ms.next<ModeratorSnapshot>('state', {
        where: (s) => s.participants.some((p) => p.id === ana!.id && p.joinedAt !== null),
      })
      const joinedAt = joined.participants.find((p) => p.id === ana!.id)!.joinedAt!
      assert.ok(joinedAt >= t0)

      // Presença: online enquanto o stream do celular estiver aberto.
      const ps = await phone.stream(`/api/p/${id}/stream`)
      const online = await ms.next<ModeratorSnapshot>('state', { where: (s) => s.presence.participants === 1 })
      assert.equal(online.participants.find((p) => p.id === ana!.id)!.online, true)
      ps.close()
      const offline = await ms.next<ModeratorSnapshot>('state', { where: (s) => s.presence.participants === 0 })
      assert.equal(offline.participants.find((p) => p.id === ana!.id)!.online, false)

      // Entrar de novo (outro aparelho) não muda o horário da primeira entrada.
      await join(ana!.token, pin)
      assert.equal((await participantOf(id, ana!.id))!.joinedAt, joinedAt)
    } finally {
      ms.close()
    }
  })

  test('aceita PIN com espaços nas pontas e recusa formatos inválidos com 400', async () => {
    const { pin, people: [ana] } = await eventWith('Ana Souza')
    const phone = new Client()
    assert.equal((await phone.req('POST', `/api/invite/${ana!.token}`, { pin: `  ${pin}  ` })).status, 200)
    for (const body of [{}, null, { pin: 123456 }, { pin: '1'.repeat(13) }])
      assertBadRequest(await new Client().req('POST', `/api/invite/${ana!.token}`, body), JSON.stringify(body))
  })

  test('após 10 PINs errados recusa até o PIN certo naquele IP; outro IP e outro convite seguem liberados', async () => {
    const { pin, people: [ana, bia] } = await eventWith('Ana Souza', 'Bia Lima')
    const attacker = new Client()
    for (let i = 0; i < 10; i++) assert.equal((await attacker.req('POST', `/api/invite/${ana!.token}`, { pin: wrongPin(pin) })).status, 401)
    const locked = await attacker.req('POST', `/api/invite/${ana!.token}`, { pin })
    assert.equal(locked.status, 429)
    assert.deepEqual(locked.data, { error: 'Muitas tentativas. Aguarde alguns minutos.' })
    assert.deepEqual(locked.headers.getSetCookie(), [])

    await join(ana!.token, pin) // outro IP
    await join(bia!.token, pin, attacker) // o limite é por convite
  })
})

describe('bloqueio, novo link e remoção', () => {
  test('bloqueado perde o convite e todas as rotas, o stream aberto recebe "gone"; desbloquear devolve o acesso', async () => {
    const { id, pin, people: [ana] } = await eventWith('Ana Souza')
    const phone = await join(ana!.token, pin)
    const ps = await phone.stream(`/api/p/${id}/stream`)
    await ps.next('state')

    assert.equal((await mod.req('PATCH', `/api/events/${id}/participants/${ana!.id}`, { blocked: true })).status, 200)
    await ps.next('gone', { timeout: 1000 })
    await closed(ps)
    assert.equal((await participantOf(id, ana!.id))!.blocked, true)
    assert.equal((await phone.req('GET', `/api/invite/${ana!.token}`)).status, 404)
    assert.equal((await new Client().req('POST', `/api/invite/${ana!.token}`, { pin })).status, 404)
    await assertNoAccess(phone, id)

    assert.equal((await mod.req('PATCH', `/api/events/${id}/participants/${ana!.id}`, { blocked: false })).status, 200)
    assert.equal((await phone.req('GET', `/api/invite/${ana!.token}`)).data.joined, true)
    assert.equal((await phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)).me.id, ana!.id)
  })

  test('novo link invalida o token e a sessão anteriores, mantém o cadastro e o novo token funciona', async () => {
    const { id, pin, people: [ana] } = await eventWith('Ana Souza')
    const phone = await join(ana!.token, pin)
    const ps = await phone.stream(`/api/p/${id}/stream`)
    await ps.next('state')

    const r = await mod.req('POST', `/api/events/${id}/participants/${ana!.id}/link`)
    assert.equal(r.status, 200)
    await ps.next('gone', { timeout: 1000 })
    await closed(ps)

    const renewed = (await participantOf(id, ana!.id))!
    assert.ok(renewed, 'o participante continua cadastrado')
    assert.notEqual(renewed.token, ana!.token)
    assert.match(renewed.token, TOKEN)
    assert.equal(renewed.joinedAt, null)
    assert.equal((await new Client().req('GET', `/api/invite/${ana!.token}`)).status, 404)
    assert.equal((await new Client().req('POST', `/api/invite/${ana!.token}`, { pin })).status, 404)
    await assertNoAccess(phone, id) // o cookie antigo não vale mais

    const fresh = await phone.req('GET', `/api/invite/${renewed.token}`)
    assert.deepEqual([fresh.status, fresh.data.joined, fresh.data.participant.name], [200, false, 'Ana Souza'])
    await join(renewed.token, pin, phone)
    assert.equal((await phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)).me.id, ana!.id)
  })

  test('novo link para participante inexistente ou de outro evento responde 404 sem alterar nada', async () => {
    const a = await eventWith()
    const b = await eventWith('Bia Lima')
    const bia = b.people[0]!
    assert.equal((await mod.req('POST', `/api/events/${a.id}/participants/inexistente/link`)).status, 404)
    const cross = await mod.req('POST', `/api/events/${a.id}/participants/${bia.id}/link`)
    assert.equal(cross.status, 404)
    assert.deepEqual(cross.data, { error: 'Participante não encontrado.' })
    assert.equal((await participantOf(b.id, bia.id))!.token, bia.token)
  })

  test('remover participante encerra as sessões, derruba o stream e mantém as perguntas sem vínculo', async () => {
    const { id, pin, people: [ana] } = await eventWith('Ana Souza')
    const phone = await join(ana!.token, pin)
    assert.equal((await phone.req('POST', `/api/p/${id}/questions`, { text: 'Pergunta antes de sair' })).status, 201)
    const ps = await phone.stream(`/api/p/${id}/stream`)
    await ps.next('state')

    assert.equal((await mod.req('DELETE', `/api/events/${id}/participants/${ana!.id}`)).status, 200)
    await ps.next('gone', { timeout: 1000 })
    await closed(ps)
    await assertNoAccess(phone, id)
    assert.equal((await new Client().req('GET', `/api/invite/${ana!.token}`)).status, 404)

    const snap = await modSnap(id)
    assert.equal(snap.participants.length, 0)
    const q = snap.questions.find((x) => x.text === 'Pergunta antes de sair')!
    assert.deepEqual([q.participantId, q.author], [null, 'Ana Souza'])
  })

  test('rotas de participante de outro evento não removem nem editam ninguém', async () => {
    const a = await eventWith()
    const b = await eventWith('Bia Lima')
    const bia = b.people[0]!
    const phone = await join(bia.token, b.pin)
    assert.equal((await mod.req('PATCH', `/api/events/${a.id}/participants/${bia.id}`, { blocked: true })).status, 404)
    assert.equal((await mod.req('DELETE', `/api/events/${a.id}/participants/${bia.id}`)).status, 200) // idempotente, sem efeito
    assert.equal((await participantOf(b.id, bia.id))!.blocked, false)
    assert.equal((await phone.snapshot<ParticipantSnapshot>(`/api/p/${b.id}/stream`)).me.id, bia.id)
  })

  test('edição parcial mantém e-mail e grupo quando omitidos e valida os campos', async () => {
    const { id, pin } = await eventWith()
    await mod.req('POST', `/api/events/${id}/participants`, { people: [{ name: 'Ana Souza', email: 'ana@exemplo.com', group: 'T1' }] })
    const ana = (await modSnap(id)).participants[0]!
    const phone = await join(ana.token, pin)
    const ps = await phone.stream(`/api/p/${id}/stream`)
    try {
      await ps.next('state')
      const patch = (body: unknown) => mod.req('PATCH', `/api/events/${id}/participants/${ana.id}`, body)
      const fields = async () => {
        const p = (await participantOf(id, ana.id))!
        return [p.name, p.email, p.group, p.blocked]
      }

      assert.equal((await patch({ name: '  Ana Clara Souza  ' })).status, 200)
      assert.deepEqual(await fields(), ['Ana Clara Souza', 'ana@exemplo.com', 'T1', false])
      await ps.next<ParticipantSnapshot>('state', { where: (s) => s.me.name === 'Ana Clara Souza' }) // o celular vê o nome novo

      assert.equal((await patch({ group: 'T2' })).status, 200)
      assert.deepEqual(await fields(), ['Ana Clara Souza', 'ana@exemplo.com', 'T2', false])
      assert.equal((await patch({ email: '' })).status, 200)
      assert.deepEqual(await fields(), ['Ana Clara Souza', '', 'T2', false])
      assert.equal((await patch({})).status, 200)
      assert.deepEqual(await fields(), ['Ana Clara Souza', '', 'T2', false])

      for (const body of [{ name: '' }, { name: '   ' }, { name: 'a'.repeat(121) }, { email: 5 }, { group: 'g'.repeat(121) }, { blocked: 'sim' }, null])
        assertBadRequest(await patch(body), JSON.stringify(body))
      assert.deepEqual(await fields(), ['Ana Clara Souza', '', 'T2', false])

      const missing = await mod.req('PATCH', `/api/events/${id}/participants/inexistente`, { name: 'X' })
      assert.equal(missing.status, 404)
      assert.deepEqual(missing.data, { error: 'Participante não encontrado.' })
    } finally {
      ps.close()
    }
  })
})

describe('entrada aberta', () => {
  test('evento só com convidados não revela nome nem marca a quem ainda não entrou', async () => {
    const { id, pin, people: [ana] } = await eventWith('Ana Souza')
    const stranger = new Client()
    const hidden = { event: null, openJoin: false, joined: false }
    assert.deepEqual((await stranger.req('GET', `/api/open/${id}`)).data, hidden)
    assert.deepEqual((await stranger.req('GET', `/api/open/${id.toLowerCase()}`)).data, hidden)

    const phone = await join(ana!.token, pin)
    const seen = await phone.req('GET', `/api/open/${id}`)
    assert.deepEqual([seen.data.event.name, seen.data.openJoin, seen.data.joined], ['Aula magna', false, true])

    const missing = await stranger.req('GET', '/api/open/ZZZZZZ')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.data, { error: 'Evento não encontrado. Confira o código do evento.' })
  })

  test('com entrada aberta mostra a marca, valida nome e PIN e cria participante com origem "open"', async () => {
    const { id, pin } = await eventWith()
    assert.equal((await settings(id, { openJoin: true })).status, 200)
    const phone = new Client()
    const info = await phone.req('GET', `/api/open/${id}`)
    assert.deepEqual([info.data.event.name, info.data.openJoin, info.data.joined], ['Aula magna', true, false])
    assert.ok(!JSON.stringify(info.data).includes('"pin"'))

    const short = await phone.req('POST', `/api/open/${id}`, { name: ' A ', pin })
    assert.equal(short.status, 400)
    assert.deepEqual(short.data, { error: 'Informe seu nome.' })
    assertBadRequest(await phone.req('POST', `/api/open/${id}`, { name: 'N'.repeat(81), pin }))
    assertBadRequest(await phone.req('POST', `/api/open/${id}`, { name: 'Carla Dias' }))
    const wrong = await phone.req('POST', `/api/open/${id}`, { name: 'Carla Dias', pin: wrongPin(pin) })
    assert.equal(wrong.status, 401)
    assert.deepEqual(wrong.data, { error: 'PIN incorreto. Confira os números com a organização do evento.' })
    assert.equal((await modSnap(id)).participants.length, 0)

    const ok = await phone.req('POST', `/api/open/${id}`, { name: '  Carla Dias  ', pin: ` ${pin} ` })
    assert.equal(ok.status, 201)
    assert.deepEqual(ok.data, { eventId: id })
    assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith(`deck_p_${id}=`)))

    const [carla, ...others] = (await modSnap(id)).participants
    assert.equal(others.length, 0)
    assert.deepEqual([carla!.name, carla!.source, carla!.blocked], ['Carla Dias', 'open', false])
    assert.ok(carla!.joinedAt)
    assert.match(carla!.token, TOKEN)
    assert.equal((await phone.req('GET', `/api/open/${id}`)).data.joined, true)
    assert.equal((await phone.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)).me.name, 'Carla Dias')
  })

  test('código digitado em minúsculas, com hífen, espaço ou O, I e L no lugar de 0 e 1 leva ao mesmo evento', async () => {
    // Quem digita o endereço da tela confunde 0 com O e 1 com I ou L; o código nunca tem O, I nem L. Código fixo
    // com 0 e 1, gravado direto no banco, para a troca acontecer em toda execução.
    const id = '0A1B2C'
    await run(
      'INSERT INTO events (id, name, pin, settings, theme, live, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      'Aula magna',
      '482913',
      JSON.stringify({ ...DEFAULT_SETTINGS, openJoin: true }),
      JSON.stringify(DEFAULT_THEME),
      JSON.stringify(defaultLive()),
      Date.now(),
    )
    for (const typed of ['oa-ib2c', 'OALB2C', ' 0a1b2c ', 'oa1b-2c'])
      assert.equal((await new Client().req('GET', `/api/open/${encodeURIComponent(typed)}`)).data.event?.id, id, typed)
    const phone = new Client()
    assert.deepEqual((await phone.req('POST', '/api/open/oa-ib2c', { name: 'Carla Dias', pin: '482913' })).data, { eventId: id })
    assert.equal((await phone.snapshot<ParticipantSnapshot>('/api/p/OALB2C/stream')).me.name, 'Carla Dias')
    assert.equal((await new Client().req('GET', '/api/open/0A1B2U')).status, 404)
  })

  test('entrada aberta desligada responde 403 mesmo com PIN certo; evento inexistente, 404', async () => {
    const { id, pin } = await eventWith()
    const r = await new Client().req('POST', `/api/open/${id}`, { name: 'Carla Dias', pin })
    assert.equal(r.status, 403)
    assert.deepEqual(r.data, { error: 'Este evento aceita apenas convidados.' })
    assert.equal((await modSnap(id)).participants.length, 0)
    assert.equal((await new Client().req('POST', '/api/open/ZZZZZZ', { name: 'Carla Dias', pin })).status, 404)
  })

  test('após 300 PINs errados na entrada aberta recusa até o PIN certo naquele IP; acertos não contam', async () => {
    const { id, pin } = await eventWith()
    await settings(id, { openJoin: true })
    // Uma sala atrás do mesmo roteador: muitos acertos seguidos não esbarram no limite.
    for (let i = 0; i < 40; i++)
      assert.equal((await new Client('10.9.9.9').req('POST', `/api/open/${id}`, { name: `Pessoa ${i + 1}`, pin })).status, 201)
    const attacker = new Client()
    for (let i = 0; i < 300; i++)
      assert.equal((await attacker.req('POST', `/api/open/${id}`, { name: 'Carla Dias', pin: wrongPin(pin) })).status, 401)
    const locked = await attacker.req('POST', `/api/open/${id}`, { name: 'Carla Dias', pin })
    assert.equal(locked.status, 429)
    assert.deepEqual(locked.data, { error: 'Muitas tentativas seguidas. Aguarde alguns minutos.' })
    assert.equal((await new Client().req('POST', `/api/open/${id}`, { name: 'Davi Reis', pin })).status, 201)
    const names = (await modSnap(id)).participants.map((p) => p.name)
    assert.ok(names.includes('Davi Reis') && !names.includes('Carla Dias'))
  })

  test('aparelho que já entrou pela entrada aberta não cria outro participante', async () => {
    const { id, pin } = await eventWith()
    await settings(id, { openJoin: true })
    const phone = new Client()
    assert.equal((await phone.req('POST', `/api/open/${id}`, { name: 'Elisa Prado', pin })).status, 201)
    for (let i = 0; i < 3; i++) assert.equal((await phone.req('POST', `/api/open/${id}`, { name: 'Outro Nome', pin })).status, 200)
    assert.deepEqual((await modSnap(id)).participants.map((p) => p.name), ['Elisa Prado'])
  })

  test('quem entra pelo QR só com nome e PIN já pergunta, curte e reage', async () => {
    const { id, pin } = await eventWith()
    await settings(id, { openJoin: true })
    const phone = new Client()
    assert.equal((await phone.req('POST', `/api/open/${id}`, { name: 'Bruno Lima', pin })).status, 201)
    const [bruno] = (await modSnap(id)).participants

    assert.equal((await phone.req('POST', `/api/p/${id}/questions`, { text: 'Como montar o primeiro orçamento?' })).status, 201)
    const [q] = (await modSnap(id)).questions
    assert.deepEqual([q!.participantId, q!.author, q!.status], [bruno!.id, 'Bruno Lima', 'pending'])
    assert.equal((await mod.req('PATCH', `/api/events/${id}/questions/${q!.id}`, { status: 'approved' })).status, 200)
    assert.equal((await phone.req('POST', `/api/p/${id}/questions/${q!.id}/like`, { on: true })).status, 200)

    // Reação conta para a cena no ar.
    const scene = (await modSnap(id)).scenes[0]!.id
    await live(mod, id, { op: 'preview', sceneId: scene })
    assert.equal((await live(mod, id, { op: 'take' })).status, 200)
    assert.equal((await phone.req('POST', `/api/p/${id}/reactions`, { kinds: { applause: 2 } })).status, 200)

    const s = await mod.stream(`/api/events/${id}/stream`)
    try {
      await s.next('state')
      const counts = await s.next<Counts>('counts')
      assert.deepEqual([counts.likes[q!.id], counts.reactions[scene]?.applause], [1, 2])
    } finally {
      s.close()
    }
  })

  test('consultas de convite e de entrada aberta somam até 1000 por minuto por IP; a 1001ª responde 429', async () => {
    const { id, people: [ana] } = await eventWith('Ana Souza')
    const c = new Client()
    const paths = [`/api/invite/${ana!.token}`, `/api/open/${id}`, '/api/invite/inexistente']
    for (let i = 0; i < 1000; i++) {
      const r = await c.req('GET', paths[i % 3]!)
      assert.notEqual(r.status, 429, `consulta ${i + 1}`)
    }
    for (const path of paths) {
      const over = await c.req('GET', path)
      assert.equal(over.status, 429, path)
      assert.deepEqual(over.data, { error: 'Muitas tentativas seguidas. Aguarde um minuto.' })
    }
    assert.equal((await new Client().req('GET', paths[0]!)).status, 200) // outro IP
  })
})

describe('sessão do participante', () => {
  test('aceita no máximo 4 streams simultâneos por participante', async () => {
    const { id, pin, people: [ana, bia] } = await eventWith('Ana Souza', 'Bia Lima')
    const phone = await join(ana!.token, pin)
    const path = `/api/p/${id}/stream`
    const streams: Sse[] = []
    try {
      for (let i = 0; i < 4; i++) {
        streams.push(await phone.stream(path))
        await streams.at(-1)!.next('state')
      }
      const fifth = await phone.req('GET', path)
      assert.equal(fifth.status, 429)
      assert.deepEqual(fifth.data, { error: 'Este evento já está aberto em várias abas. Feche as outras e tente de novo.' })

      const other = await join(bia!.token, pin) // o limite é por participante
      streams.push(await other.stream(path))

      streams.shift()!.close()
      streams.push(await openStream(phone, path)) // a vaga liberada pode ser usada
      await streams.at(-1)!.next('state')
    } finally {
      streams.forEach((s) => s.close())
    }
  })

  test('sair do evento apaga o cookie e encerra o acesso só deste aparelho', async () => {
    const { id, pin, people: [ana] } = await eventWith('Ana Souza')
    const phone = await join(ana!.token, pin)
    const laptop = await join(ana!.token, pin)
    const r = await phone.req('POST', `/api/p/${id}/leave`)
    assert.equal(r.status, 200)
    assert.deepEqual(r.data, { ok: true })
    const cleared = r.headers.getSetCookie().find((c) => c.startsWith(`deck_p_${id}=`))
    assert.ok(cleared)
    assert.match(cleared, /Max-Age=0/i)
    assert.equal(phone.jar.has(`deck_p_${id}`), false)
    await assertNoAccess(phone, id)
    assert.equal((await phone.req('GET', `/api/invite/${ana!.token}`)).data.joined, false)
    assert.equal((await laptop.snapshot<ParticipantSnapshot>(`/api/p/${id}/stream`)).me.id, ana!.id)
  })

  test('cookie de um evento não abre outro evento, e cookie adulterado é recusado', async () => {
    const a = await eventWith('Ana Souza')
    const b = await eventWith('Bia Lima')
    const phone = await join(a.people[0]!.token, a.pin)
    const value = phone.jar.get(`deck_p_${a.id}`)!

    const moved = new Client()
    moved.jar.set(`deck_p_${b.id}`, value)
    await assertNoAccess(moved, b.id)

    const tampered = new Client()
    tampered.jar.set(`deck_p_${a.id}`, value.replace(/^[^.]+/, b.people[0]!.id))
    await assertNoAccess(tampered, a.id)

    const missing = await phone.req('POST', '/api/p/ZZZZZZ/leave')
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.data, { error: 'Evento não encontrado.' })
  })

  test('participante não usa as rotas da moderação', async () => {
    const { id, pin, people: [ana] } = await eventWith('Ana Souza')
    const phone = await join(ana!.token, pin)
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/events'],
      ['GET', `/api/events/${id}/stream`],
      ['PATCH', `/api/events/${id}`, { settings: { openJoin: true } }],
      ['POST', `/api/events/${id}/participants`, { people: [{ name: 'Intruso' }] }],
      ['PATCH', `/api/events/${id}/participants/${ana!.id}`, { name: 'Outro Nome' }],
      ['POST', `/api/events/${id}/participants/${ana!.id}/link`],
      ['DELETE', `/api/events/${id}/participants/${ana!.id}`],
    ]
    for (const [method, path, body] of routes) assert.equal((await phone.req(method, path, body)).status, 401, `${method} ${path}`)
    const snap = await modSnap(id)
    assert.deepEqual(snap.participants.map((p) => [p.name, p.token]), [['Ana Souza', ana!.token]])
    assert.equal(snap.event.settings.openJoin, false)
  })
})
