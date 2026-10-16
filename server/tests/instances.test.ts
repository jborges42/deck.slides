// Várias instâncias do servidor sobre o mesmo banco, como a Vercel roda a função: o que uma instância muda
// precisa chegar às conexões abertas nas outras. Cada instância é um processo com a entrada da Vercel (vercel.ts).
// Banco: arquivo SQLite compartilhado; com PG_TEST_URL, um banco novo nesse Postgres (como o Supabase); com
// SQLD=<binário sqld>, um servidor libSQL por HTTP (como o Turso). Com BUNDLE=1 (ou SQLD), as instâncias rodam o
// pacote gerado por `pnpm build:vercel` em vez do código-fonte:
//   pnpm build:vercel && BUNDLE=1 PG_TEST_URL=postgres://... node --test --test-force-exit server/tests/instances.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModeratorSnapshot, ParticipantSnapshot, ScreenSnapshot } from '../../shared/types.ts'
import { freshPgDatabase } from './pg.ts'
import { Sse } from './sse.ts'

const SECRET = 'segredo-de-teste-com-bem-mais-de-32-caracteres'
const SETUP = 'codigo-de-instalacao-dos-testes'
const SQLD = process.env.SQLD
const BUNDLE = !!(process.env.BUNDLE || SQLD)
const ENTRY = BUNDLE
  ? pathToFileURL(join(import.meta.dirname, '../../.vercel/output/functions/api.func/index.mjs')).href
  : pathToFileURL(join(import.meta.dirname, '../vercel.ts')).href
const tmp = () => mkdtempSync(join(tmpdir(), 'deck-inst-'))
const procs: ChildProcess[] = []
after(() => procs.forEach((p) => p.kill()))

// Configuração de quem roda o teste (e o NODE_TEST_CONTEXT do executor) não vaza para os processos testados.
const CONFIG = ['NODE_TEST_CONTEXT', 'NODE_ENV', 'PORT', 'DATA_DIR', 'DB_PATH', 'PUBLIC_URL', 'TRUST_PROXY', 'MAX_UPLOAD_MB', 'SESSION_SECRET', 'SETUP_TOKEN', 'VERCEL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'STREAM_MAX_S', 'DATABASE_URL', 'POSTGRES_URL', 'BUNDLE']
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CONFIG.includes(k)))

/** Processo que imprime uma linha quando está pronto; devolve essa linha. */
function launch(args: string[], env: Record<string, string>, ready: RegExp): Promise<string> {
  const p = spawn(process.execPath, args, { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(p)
  let err = ''
  p.stderr!.on('data', (d) => (err += d))
  return new Promise((resolve, reject) => {
    let out = ''
    p.stdout!.on('data', (d) => {
      out += d
      const m = ready.exec(out)
      if (m) resolve(m[1]!)
    })
    p.once('exit', (code) => reject(new Error(`processo saiu com ${code} antes de ficar pronto: ${out}${err}`)))
  })
}

/** Banco compartilhado pelas instâncias. */
async function database(): Promise<Record<string, string>> {
  const pg = await freshPgDatabase()
  const db: Record<string, string> = pg ? { DATABASE_URL: pg } : SQLD ? { TURSO_DATABASE_URL: await startSqld() } : { DATA_DIR: tmp() }
  // Na Vercel o IP do cliente vem do cabeçalho da borda; fora dela, TRUST_PROXY=1 faz o mesmo.
  return { ...db, ...(BUNDLE ? { VERCEL: '1' } : { TRUST_PROXY: '1' }) }
}

async function startSqld(): Promise<string> {
  const port = 46_000 + Math.floor(Math.random() * 2000)
  spawnSqld(port)
  for (let i = 0; i < 100; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return `http://127.0.0.1:${port}`
}

function spawnSqld(port: number) {
  const p = spawn(SQLD!, ['--db-path', join(tmp(), 'db'), '--http-listen-addr', `127.0.0.1:${port}`, '--no-welcome'], { stdio: 'ignore' })
  procs.push(p)
}

const LAUNCHER = `
const { createServer } = await import('node:http')
const { default: handler } = await import(process.env.ENTRY)
const server = createServer(handler).listen(0, '127.0.0.1', () => console.log('porta ' + server.address().port))
`

/** Uma instância do servidor (a função da Vercel servida por http.createServer). Devolve a URL base. */
async function instance(db: Record<string, string>, extra: Record<string, string> = {}): Promise<string> {
  const env = { NODE_ENV: 'production', SESSION_SECRET: SECRET, SETUP_TOKEN: SETUP, ENTRY, ...db, ...extra }
  const port = await launch(['--input-type=module', '-e', LAUNCHER], env, /porta (\d+)/)
  return `http://127.0.0.1:${port}`
}

let ipSeq = 0

/** Navegador: os mesmos cookies valem em qualquer instância (o balanceador escolhe uma a cada requisição). */
class Browser {
  jar = new Map<string, string>()
  ip = `10.9.0.${++ipSeq}`

  async req(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        origin: base,
        'x-forwarded-for': this.ip,
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1))
    }
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }

  async stream(base: string, path: string): Promise<Sse> {
    const res = await fetch(base + path, {
      headers: { 'x-forwarded-for': this.ip, cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    })
    assert.equal(res.status, 200, `stream ${path}`)
    const s = new Sse(res)
    streams.push(s)
    return s
  }
}

const streams: Sse[] = []
after(() => streams.forEach((s) => s.close()))

let A: string
let B: string
let db: Record<string, string>
const mod = new Browser()

before(async () => {
  db = await database()
  ;[A, B] = await Promise.all([instance(db), instance(db)])
  const setup = await mod.req(A, 'POST', '/api/auth/setup', { name: 'Ana', email: 'ana@exemplo.com', password: 'senha-segura-123', token: SETUP })
  assert.equal(setup.status, 201, JSON.stringify(setup.data))
})

async function newEvent(name: string): Promise<{ id: string; pin: string }> {
  const r = await mod.req(B, 'POST', '/api/events', { name })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  const s = await mod.stream(A, `/api/events/${r.data.id}/stream`)
  const snap = await s.next<ModeratorSnapshot>('state')
  s.close()
  return { id: r.data.id, pin: snap.event.pin }
}

test('o que muda numa instância chega às conexões abertas na outra', async () => {
  const { id, pin } = await newEvent('Aula magna')
  const console_ = await mod.stream(A, `/api/events/${id}/stream`)
  await console_.next('state')

  // Cadastro feito pela instância B aparece no console aberto na A.
  assert.equal((await mod.req(B, 'POST', `/api/events/${id}/participants`, { people: [{ name: 'João Silva' }] })).status, 201)
  const withJoao = await console_.next<ModeratorSnapshot>('state', { where: (s) => s.participants.length === 1 })
  const joao = withJoao.participants[0]!

  const phone = new Browser()
  assert.equal((await phone.req(B, 'POST', `/api/invite/${joao.token}`, { pin })).status, 200)
  const ps = await phone.stream(B, `/api/p/${id}/stream`)
  await ps.next('state')

  // Presença vem do banco: a conexão aberta na B conta como online no console da A.
  const online = await console_.next<ModeratorSnapshot>('state', { where: (s) => s.presence.participants === 1 })
  assert.equal(online.participants[0]!.online, true)

  // Pergunta enviada pela B chega ao console da A; a aprovação feita na A chega ao celular na B.
  assert.equal((await phone.req(B, 'POST', `/api/p/${id}/questions`, { text: 'Como funciona a reconexão?' })).status, 201)
  const asked = await console_.next<ModeratorSnapshot>('state', { where: (s) => s.questions.length === 1 })
  const qid = asked.questions[0]!.id
  assert.equal((await mod.req(A, 'PATCH', `/api/events/${id}/questions/${qid}`, { status: 'approved' })).status, 200)
  await ps.next<ParticipantSnapshot>('state', { where: (s) => s.mine[0]?.status === 'approved' })

  // Bloqueio feito na A derruba a conexão do celular na B, e o console vê a pessoa sair.
  assert.equal((await mod.req(A, 'PATCH', `/api/events/${id}/participants/${joao.id}`, { blocked: true })).status, 200)
  await ps.next('gone')
  await console_.next<ModeratorSnapshot>('state', { where: (s) => s.presence.participants === 0 })
  // E o acesso continua negado pela outra instância.
  assert.equal((await phone.req(A, 'POST', `/api/p/${id}/questions`, { text: 'Ainda estou aqui?' })).status, 401)
})

test('tela: o código mostrado por uma instância é aceito pela outra, e só uma vez', async () => {
  const { id } = await newEvent('Telão')
  const screen = new Browser()
  const pair = await screen.req(A, 'POST', '/api/screen/pair')
  assert.equal(pair.status, 200)
  const waiting = await screen.stream(A, '/api/screen/stream')
  assert.equal((await waiting.next<{ code: string }>('pairing')).code, pair.data.code)

  const claim = await mod.req(B, 'POST', `/api/events/${id}/screens`, { code: pair.data.code })
  assert.equal(claim.status, 201, JSON.stringify(claim.data))
  await waiting.next('paired')

  // Reconecta por qualquer instância já como tela do evento.
  const live = await screen.stream(B, '/api/screen/stream')
  assert.equal((await live.next<ScreenSnapshot>('state')).event.id, id)
  assert.equal((await mod.req(A, 'POST', `/api/events/${id}/screens`, { code: pair.data.code })).status, 404)
})

test('limite de tentativas de login soma as instâncias', async () => {
  const intruder = new Browser()
  for (let i = 0; i < 10; i++) {
    const r = await intruder.req(i % 2 ? A : B, 'POST', '/api/auth/login', { email: 'ana@exemplo.com', password: `errada-${i}` })
    assert.equal(r.status, 401)
  }
  assert.equal((await intruder.req(A, 'POST', '/api/auth/login', { email: 'ana@exemplo.com', password: 'senha-segura-123' })).status, 429)
  assert.equal((await intruder.req(B, 'POST', '/api/auth/login', { email: 'ana@exemplo.com', password: 'senha-segura-123' })).status, 429)
})

test('atrás do HTTPS da Vercel, a própria origem https passa no CSRF; outra origem, não', async () => {
  // O CSRF do Hono confere a origem de requisições sem JSON (as que um formulário de outro site consegue
  // enviar), sem Sec-Fetch-Site (navegadores antigos, como o de muitas TVs e projetores).
  const base = A.replace('http://', 'https://')
  const remove = async (origin: string, proxied: boolean) => {
    const { id } = await newEvent('Para apagar')
    return (await mod.req(A, 'DELETE', `/api/events/${id}`, undefined, { origin, ...(proxied ? { 'x-forwarded-proto': 'https' } : {}) })).status
  }
  assert.equal(await remove(base, true), 200)
  assert.equal(await remove('https://outro.exemplo', true), 403)
  // Sem o cabeçalho do proxy, a URL continua http:// e a origem https não confere.
  assert.equal(await remove(base, false), 403)
})

test('perto do tempo máximo da função, a conexão avisa `reconnect` e fecha; a seguinte recebe o estado de novo', async () => {
  const short = await instance(db, { STREAM_MAX_S: '1' })
  const { id } = await newEvent('Duração')
  const s = await mod.stream(short, `/api/events/${id}/stream`)
  await s.next('state')
  await s.next('reconnect', { timeout: 3000 })
  for (let i = 0; i < 100 && !s.closed; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(s.closed, 'o servidor fecha a conexão depois do aviso')
  assert.equal((await (await mod.stream(short, `/api/events/${id}/stream`)).next<ModeratorSnapshot>('state')).event.id, id)
})
