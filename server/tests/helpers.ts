// Utilitários dos testes da API. Cada arquivo de teste roda em processo próprio (node --test),
// com banco e uploads num diretório temporário, e chama a aplicação em processo (app.request).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { freshPgDatabase } from './pg.ts'
import type { ModeratorSnapshot, Participant } from '../../shared/types.ts'

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'deck-test-'))
process.env.TRUST_PROXY = '1' // permite simular IPs diferentes via X-Forwarded-For
const pg = await freshPgDatabase() // com PG_TEST_URL, Postgres em vez de SQLite
if (pg) process.env.DATABASE_URL = pg

const { app } = await import('../app.ts')
export { app }

let ipSeq = 0
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export { Sse, type SseMessage } from './sse.ts'
import { Sse } from './sse.ts'

/** Cliente HTTP com cookies, como um navegador. Cada cliente tem um IP próprio. */
export class Client {
  jar = new Map<string, string>()
  ip: string

  constructor(ip?: string) {
    this.ip = ip ?? `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
  }

  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async raw(method: string, path: string, init: { body?: RequestInit['body']; headers?: Record<string, string> } = {}) {
    const res = await app.request(path, {
      method,
      body: init.body,
      headers: { origin: 'http://localhost', 'x-forwarded-for': this.ip, cookie: this.cookie, ...init.headers },
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';')
      const i = pair!.indexOf('=')
      const name = pair!.slice(0, i)
      const value = pair!.slice(i + 1)
      if (attrs.some((a) => /max-age=0/i.test(a)) || !value) this.jar.delete(name)
      else this.jar.set(name, value)
    }
    return res
  }

  /** JSON in, JSON out. */
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.raw(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    })
    const text = await res.text()
    let data: any = text
    try {
      data = JSON.parse(text)
    } catch {
      // resposta não JSON
    }
    return { status: res.status, data, headers: res.headers }
  }

  /** Abre um SSE. Falha se o servidor não responder 200 com text/event-stream. */
  async stream(path: string): Promise<Sse> {
    const res = await this.raw('GET', path)
    assert.equal(res.status, 200, `stream ${path} respondeu ${res.status}`)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    return new Sse(res)
  }

  /** Primeiro snapshot `state` de um SSE (e fecha a conexão). */
  async snapshot<T>(path: string): Promise<T> {
    const s = await this.stream(path)
    try {
      return await s.next<T>('state')
    } finally {
      s.close()
    }
  }
}

export const MOD_EMAIL = 'ana@exemplo.com'
export const MOD_PASSWORD = 'senha-segura-123'

/** Moderador logado. Cria a conta inicial na primeira chamada do processo. */
export async function asModerator(): Promise<Client> {
  const c = new Client()
  const setup = await c.req('POST', '/api/auth/setup', { name: 'Ana Moderadora', email: MOD_EMAIL, password: MOD_PASSWORD })
  if (setup.status !== 201) {
    const login = await c.req('POST', '/api/auth/login', { email: MOD_EMAIL, password: MOD_PASSWORD })
    assert.equal(login.status, 200, `login falhou: ${JSON.stringify(login.data)}`)
  }
  return c
}

/** Cria um evento e devolve o primeiro snapshot do moderador. */
export async function createEvent(mod: Client, name = 'Aula magna'): Promise<ModeratorSnapshot> {
  const r = await mod.req('POST', '/api/events', { name })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  return mod.snapshot<ModeratorSnapshot>(`/api/events/${r.data.id}/stream`)
}

/** Cadastra um participante pelo convite e confirma o PIN. Devolve o cliente (celular) já dentro do evento. */
export async function joinParticipant(mod: Client, eventId: string, name = 'João Silva'): Promise<{ phone: Client; participant: Participant }> {
  const add = await mod.req('POST', `/api/events/${eventId}/participants`, { people: [{ name }] })
  assert.equal(add.status, 201, JSON.stringify(add.data))
  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${eventId}/stream`)
  const participant = [...snap.participants].reverse().find((p) => p.name === name)!
  const phone = new Client()
  const joined = await phone.req('POST', `/api/invite/${participant.token}`, { pin: snap.event.pin })
  assert.equal(joined.status, 200, JSON.stringify(joined.data))
  return { phone, participant }
}

/** Atalho para comandos ao vivo. */
export const live = (mod: Client, eventId: string, cmd: unknown) => mod.req('POST', `/api/events/${eventId}/live`, cmd)
