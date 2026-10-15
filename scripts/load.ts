// Teste de carga do tempo real (SSE). Sobe o servidor de verdade com banco temporário, conecta N celulares,
// telas pareadas e um console, e mede a latência de ponta a ponta (do POST até o `state` chegar em cada conexão),
// mais CPU e memória do processo do servidor (via ps).
// Uso: node scripts/load.ts [--participants 500] [--screens 2] [--profile <pasta para o .cpuprofile do servidor>]
// Sai com 1 se alguma requisição ou conexão falhar ou se algum limite de LIMITS estourar.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { subscribe } from 'node:diagnostics_channel'
import { mkdtempSync, rmSync } from 'node:fs'
import { Agent, request, type IncomingMessage } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import type { Counts, ModeratorSnapshot, ParticipantSnapshot, ScreenSnapshot } from '../shared/types.ts'

const { values: opt } = parseArgs({
  options: {
    participants: { type: 'string', default: '500' },
    screens: { type: 'string', default: '2' },
    profile: { type: 'string' },
  },
})
const N = Number(opt.participants)
const SCREENS = Number(opt.screens)
if (!(N >= 2) || !(SCREENS >= 1 && SCREENS <= 20)) throw new Error('Use --participants >= 2 e --screens entre 1 e 20.')

// Limites (ms, p95). Por quê:
// - Tela e console agrupam mudanças em 40 ms (server/hub.ts). 150 ms deixa ~110 ms para montar, serializar e entregar;
//   acima disso o operador percebe o telão atrasado em relação ao clique no console.
// - Celulares agrupam em 500 ms. 1000 ms deixa outro tanto para o envio em leque a todas as conexões.
// - Reações: lote de 250 ms no servidor; até 500 ms do toque ao telão ainda parece resposta ao toque.
// - Entrada em massa: o EventSource reconecta em 2 s (`retry`); depois de uma queda do Wi-Fi a sala inteira
//   precisa receber o primeiro estado antes do próximo ciclo de reconexão.
// - Memória: 64 KB por conexão = 320 MB para 5 mil celulares, cabe numa VPS de 1 GB.
const LIMITS = {
  joinStormP95: 2000,
  takeScreenP95: 150,
  takeParticipantP95: 1000,
  spotlightScreenP95: 150,
  spotlightParticipantP95: 1000,
  reactionScreenP95: 500,
  questionModeratorP95: 500,
  memoryPerConnKB: 64,
}

// 10 trocas x 2 telas = 20 amostras: o p95 tolera um ponto fora da curva em vez de ser o máximo.
const TAKES = 10 // par: termina com a cena de perguntas no ar (necessária para destaque e reações)
const SPOTLIGHTS = 10
const STORM_S = 20
const QUESTIONS = Math.min(300, N - 1)

// ---------- servidor ----------

const port = await new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo
    s.close(() => resolve(port))
  })
})
const BASE = `http://127.0.0.1:${port}`
const dataDir = mkdtempSync(join(tmpdir(), 'deck-load-'))
const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, PORT: String(port), TRUST_PROXY: '1' }
delete env.NODE_ENV // desenvolvimento: a conta inicial não exige SETUP_TOKEN
delete env.DB_PATH // nunca o banco de verdade
// Instrumentação carregada antes do servidor, sem tocar no código dele: SIGUSR2 força um GC completo e escreve
// process.memoryUsage() no stderr; SIGTERM vira saída normal (só assim o Node grava o --cpu-prof).
const preload = `process.on('SIGUSR2',()=>{globalThis.gc();process.stderr.write('[mem] '+JSON.stringify(process.memoryUsage())+'\\n')});process.on('SIGTERM',()=>process.exit(0))`
const flags = ['--expose-gc', '--import', `data:text/javascript,${encodeURIComponent(preload)}`]
if (opt.profile) flags.push('--cpu-prof', `--cpu-prof-dir=${opt.profile}`)
const server = spawn(process.execPath, [...flags, fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
})
const serverLog: string[] = []
server.stderr!.on('data', (d) => serverLog.push(String(d)))
let stopping = false
server.once('exit', (code) => {
  if (stopping) return
  console.error(`\nO servidor saiu no meio do teste (código ${code}).\n${serverLog.join('').slice(-4000)}`)
  process.exit(1)
})

async function stop() {
  stopping = true
  const exited = new Promise((r) => server.once('exit', r))
  server.kill('SIGTERM')
  await exited
}
// Mesmo se o gerador quebrar no meio, o servidor e o banco temporário não ficam para trás.
process.on('exit', () => {
  server.kill('SIGKILL')
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------- CPU e memória do servidor ----------
// `time` é o tempo de CPU acumulado (usuário + sistema); a diferença entre amostras dá o uso no intervalo.
// ponytail: ps a cada 200 ms (resolução de 10 ms no macOS; no Linux, segundos inteiros). /proc se precisar de Linux.

const execFileP = promisify(execFile)
interface Sample {
  t: number
  rss: number // MB
  cpu: number // s
}
const samples: Sample[] = []
async function sample(): Promise<Sample> {
  const t = performance.now() // o ps lê o processo ao iniciar; o retorno atrasa quando o gerador está ocupado
  const { stdout } = await execFileP('ps', ['-o', 'rss=,time=', '-p', String(server.pid)], { env: { ...process.env, LC_ALL: 'C' } })
  const [rss, time] = stdout.trim().split(/\s+/)
  const s = { t, rss: Number(rss) / 1024, cpu: time!.split(':').reduce((a, x) => a * 60 + Number(x), 0) }
  samples.push(s)
  return s
}
const sampler = setInterval(() => void sample().catch(() => {}), 200)

function usage(from: Sample, to: Sample) {
  const win = samples.filter((s) => s.t >= from.t && s.t <= to.t).sort((a, b) => a.t - b.t)
  let peak = 0
  for (let i = 1; i < win.length; i++) peak = Math.max(peak, ((win[i]!.cpu - win[i - 1]!.cpu) / (win[i]!.t - win[i - 1]!.t)) * 1e5)
  return { cpuAvg: ((to.cpu - from.cpu) / (to.t - from.t)) * 1e5, cpuPeak: peak, rssPeak: Math.max(...win.map((s) => s.rss)) }
}

/** Memória do servidor logo depois de um GC completo (MB): heap + external, sem o lixo da etapa anterior. */
async function memory() {
  await sleep(500) // envios agrupados pendentes terminam antes
  const line = new Promise<string>((resolve) => {
    const on = (d: Buffer) => {
      const m = /\[mem\] (.*)/.exec(String(d))
      if (!m) return
      server.stderr!.off('data', on)
      resolve(m[1]!)
    }
    server.stderr!.on('data', on)
  })
  server.kill('SIGUSR2')
  const m = JSON.parse(await line) as NodeJS.MemoryUsage
  return { heap: (m.heapUsed + m.external) / 1024 / 1024, rss: (await sample()).rss }
}

// ---------- HTTP e SSE ----------
// node:http com um Agent por cliente: cada celular mantém as próprias conexões persistentes, como um navegador
// (até 6 por origem no HTTP/1.1). Um pool único compartilhado (fetch) abre rajadas de conexões novas sempre que o
// servidor atrasa; com o backlog de 128 do macOS, isso mede retransmissão de SYN, não o servidor.

const failures: string[] = []
const fail = (msg: string) => failures.push(msg)

let ipSeq = 1
/** Cliente com cookies, conexões e IP próprios (X-Forwarded-For, com TRUST_PROXY=1): limites por IP valem por celular. */
class Peer {
  jar = new Map<string, string>()
  ip = `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`
  agent = new Agent({ keepAlive: true, maxSockets: 6 })

  /** Resposta com o corpo ainda em stream. Erro de rede volta como Error, nunca lança. */
  send(method: string, path: string, body?: string): Promise<IncomingMessage | Error> {
    const headers: Record<string, string> = { origin: BASE, 'x-forwarded-for': this.ip }
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
    return new Promise((resolve) => {
      const req = request(BASE + path, { method, agent: this.agent, headers }, (res) => {
        for (const c of res.headers['set-cookie'] ?? []) {
          const [pair] = c.split(';')
          const i = pair!.indexOf('=')
          this.jar.set(pair!.slice(0, i), pair!.slice(i + 1))
        }
        resolve(res)
      })
      req.on('error', resolve)
      req.end(body)
    })
  }

  /** JSON in, JSON out. Falha de rede vira status 0 e entra na contagem de falhas de quem chamou. */
  async req(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await this.send(method, path, body === undefined ? undefined : JSON.stringify(body))
    if (res instanceof Error) return { status: 0, data: res.message }
    let text = ''
    try {
      for await (const chunk of res.setEncoding('utf8')) text += chunk
    } catch {
      return { status: 0, data: 'conexão interrompida' }
    }
    let data: any = text
    try {
      data = JSON.parse(text)
    } catch {
      // resposta não JSON
    }
    return { status: res.statusCode!, data }
  }
}

function expectStatus(r: { status: number; data: any }, status: number, what: string) {
  if (r.status !== status) throw new Error(`${what}: esperava ${status}, veio ${r.status} ${JSON.stringify(r.data)}`)
  return r.data
}

type Kind = 'participant' | 'screen' | 'moderator'
interface Conn {
  kind: Kind
  first: number // ms da abertura até o primeiro `state`
  states: number
  bytes: number
  ended: boolean
  last?: ModeratorSnapshot // só o console: snapshot parseado (o tempo de parse estima o custo no navegador)
  parseMs: number
}
type Listener = (c: Conn, event: string, data: string, at: number) => void
let listener: Listener | null = null
const conns: Conn[] = []

/** Abre um SSE e resolve no primeiro `state`. Mensagens seguintes vão para `listener` com o instante de chegada. */
async function open(peer: Peer, path: string, kind: Kind): Promise<Conn> {
  const c: Conn = { kind, first: NaN, states: 0, bytes: 0, ended: false, parseMs: 0 }
  const t0 = performance.now()
  const res = await peer.send('GET', path)
  if (res instanceof Error) throw new Error(`stream ${path}: ${res.message}`)
  if (res.statusCode !== 200) {
    res.resume()
    throw new Error(`stream ${path} respondeu ${res.statusCode}`)
  }
  let gotFirst!: () => void
  const first = new Promise<void>((r) => (gotFirst = r))
  const timer = setTimeout(gotFirst, 15_000)
  let buf = ''
  res.setEncoding('utf8')
  res.on('data', (chunk: string) => {
    const at = performance.now()
    buf += chunk
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      c.bytes += block.length + 2
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data = line.slice(6) // JSON.stringify não gera quebras de linha
      }
      if (event === 'state') {
        c.states++
        if (kind === 'moderator') {
          const p = performance.now()
          c.last = JSON.parse(data)
          c.parseMs = performance.now() - p
        }
        if (Number.isNaN(c.first)) {
          c.first = at - t0
          gotFirst()
        }
      }
      listener?.(c, event, data, at)
    }
  })
  res.on('error', () => {}) // 'close' vem em seguida
  res.on('close', () => {
    c.ended = true
    gotFirst()
  })
  await first
  clearTimeout(timer)
  if (Number.isNaN(c.first)) throw new Error(`stream ${path} não enviou o primeiro estado`)
  conns.push(c)
  return c
}

interface Preds {
  screen: (s: ScreenSnapshot) => boolean
  participant: (s: ParticipantSnapshot) => boolean
}

/** Dispara `action` e mede, em cada tela e celular, quanto tempo leva até chegar um `state` que satisfaça o predicado. */
async function measure(preds: Preds, action: () => Promise<unknown>, timeout = 5000) {
  const want = new Set(conns.filter((c) => !c.ended && c.kind !== 'moderator'))
  const lat: Record<'screen' | 'participant', number[]> = { screen: [], participant: [] }
  const seen = new Set<Conn>()
  let serverNow = 0 // relógio do servidor ao montar o primeiro snapshot de celular que satisfez o predicado
  let done!: () => void
  const all = new Promise<void>((r) => (done = r))
  const t0 = performance.now()
  listener = (c, event, data, at) => {
    if (event !== 'state' || c.kind === 'moderator' || !want.has(c) || seen.has(c)) return
    const s = JSON.parse(data)
    if (!(c.kind === 'screen' ? preds.screen(s) : preds.participant(s))) return
    seen.add(c)
    lat[c.kind].push(at - t0)
    if (c.kind === 'participant') serverNow ||= s.serverNow
    if (seen.size === want.size) done()
  }
  const timer = setTimeout(done, timeout)
  await action()
  await all
  clearTimeout(timer)
  listener = null
  return { ...lat, missing: want.size - seen.size, t0, serverNow }
}

// ---------- estatística e saída ----------

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => (s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)]! : NaN)
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.length ? s[s.length - 1]! : NaN }
}
const fmt = (x: number, digits = 0) => (Number.isFinite(x) ? x.toFixed(digits) : '-').padStart(6)
function line(label: string, xs: number[]) {
  const s = stats(xs)
  console.log(`  ${label.padEnd(34)} n=${String(s.n).padEnd(6)} p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  máx ${fmt(s.max)} ms`)
  return s
}
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const report: Record<string, unknown> = { participants: N, screens: SCREENS, node: process.version }
const checks: { name: string; value: number; limit: number }[] = []
const check = (name: string, value: number, limit: number) => checks.push({ name, value, limit })

let tcpConnects = 0
subscribe('net.client.socket', () => tcpConnects++)
const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()
let modConn: Conn | undefined

/** Executa uma etapa e anota CPU/memória do servidor, tráfego do console e a folga do próprio gerador de carga. */
async function phase<T extends object>(key: string, title: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n${title}`)
  lag.reset()
  const cpu0 = process.cpuUsage()
  const mod0 = { states: modConn?.states ?? 0, bytes: modConn?.bytes ?? 0 }
  const tcp0 = tcpConnects
  const from = await sample()
  const out = await fn()
  const to = await sample()
  const u = usage(from, to)
  const gen = process.cpuUsage(cpu0)
  const genCpu = (gen.user + gen.system) / 10 / (to.t - from.t)
  const console_ = { snapshots: (modConn?.states ?? 0) - mod0.states, bytes: (modConn?.bytes ?? 0) - mod0.bytes }
  console.log(
    `  servidor: CPU média ${fmt(u.cpuAvg).trim()}%, pico ${fmt(u.cpuPeak).trim()}% · RSS máx ${u.rssPeak.toFixed(0)} MB · ` +
      `console: ${console_.snapshots} snapshots, ${mb(console_.bytes)} · gerador: CPU ${genCpu.toFixed(0)}%, ` +
      `atraso do loop p99 ${(lag.percentile(99) / 1e6).toFixed(0)} ms, ${tcpConnects - tcp0} conexões TCP novas`,
  )
  report[key] = { ...out, server: u, console: console_, generator: { cpu: genCpu, lagP99: lag.percentile(99) / 1e6, lagMax: lag.max / 1e6 } }
  return out
}

/** Executa `fn` sobre os itens com no máximo `limit` em paralelo. */
async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) await fn(items[i++]!)
    }),
  )
}
const sleepUntil = (t: number) => sleep(Math.max(0, t - performance.now()))

// ---------- cenário ----------

let exitCode = 1
try {
  for (const end = Date.now() + 15_000; (await new Peer().req('GET', '/api/auth/me')).status !== 200; await sleep(100))
    if (Date.now() > end) throw new Error(`o servidor não respondeu em 15 s\n${serverLog.join('')}`)
  // Gerador e servidor dividem a máquina com o que mais estiver rodando: a carga entra no relatório.
  const machine = { cpu: cpus()[0]?.model, cores: cpus().length, load1: loadavg()[0]! }
  report.machine = machine
  console.log(`deck.slides em ${BASE} (pid ${server.pid}) · ${N} celulares, ${SCREENS} telas · Node ${process.version}`)
  console.log(`${machine.cpu}, ${machine.cores} núcleos, carga média ${machine.load1.toFixed(1)}`)
  if (machine.load1 > machine.cores / 2) console.log('Atenção: máquina já ocupada por outros processos; latências podem refletir disputa de CPU.')

  const mod = new Peer()
  expectStatus(await mod.req('POST', '/api/auth/setup', { name: 'Teste de carga', email: 'carga@exemplo.com', password: randomUUID() }), 201, 'criar a conta inicial')
  const { id: eventId } = expectStatus(await mod.req('POST', '/api/events', { name: 'Teste de carga' }), 201, 'criar o evento')
  for (let i = 0; i < N; i += 5000) {
    // Nome, e-mail e turma com tamanhos realistas: o snapshot do console carrega a lista inteira.
    const people = Array.from({ length: Math.min(5000, N - i) }, (_, j) => ({
      name: `Participante ${i + j + 1} Souza`,
      email: `participante.${i + j + 1}@exemplo.com.br`,
      group: `Turma ${String.fromCharCode(65 + ((i + j) % 6))}`,
    }))
    expectStatus(await mod.req('POST', `/api/events/${eventId}/participants`, { people }), 201, 'importar participantes')
  }
  modConn = await open(mod, `/api/events/${eventId}/stream`, 'moderator')
  const snap0 = modConn.last!
  const titleScene = snap0.scenes.find((s) => s.type === 'title')!
  const qScene = snap0.scenes.find((s) => s.type === 'questions')!
  const live = (cmd: object) => mod.req('POST', `/api/events/${eventId}/live`, cmd)

  for (let i = 0; i < SCREENS; i++) {
    const projector = new Peer()
    const { code } = expectStatus(await projector.req('POST', '/api/screen/pair'), 200, 'pedir o código de pareamento')
    expectStatus(await mod.req('POST', `/api/events/${eventId}/screens`, { code }), 201, 'parear a tela')
    await open(projector, '/api/screen/stream', 'screen')
  }

  const phones = snap0.participants.map((p) => ({ peer: new Peer(), token: p.token, conn: undefined as Conn | undefined }))
  await phase('invites', `Preparação: ${N} celulares confirmam o PIN (POST /api/invite/:token, 32 em paralelo)`, async () => {
    const lat: number[] = []
    await pool(phones, 32, async (ph) => {
      const t = performance.now()
      expectStatus(await ph.peer.req('POST', `/api/invite/${ph.token}`, { pin: snap0.event.pin }), 200, 'confirmar o PIN')
      lat.push(performance.now() - t)
    })
    return { post: line('POST convite + PIN', lat) }
  })

  // [1] Todos abrem o stream ao mesmo tempo: o pior caso é a volta do Wi-Fi do auditório, quando o
  // EventSource de cada celular reconecta junto, cada um com uma conexão TCP nova.
  const idle = await memory()
  await phase('joinStorm', `[1] Entrada em massa: ${N} streams de celular abertos ao mesmo tempo`, async () => {
    for (const ph of phones) ph.peer.agent.destroy() // descarta as conexões que sobraram do PIN
    const t = performance.now()
    const res = await Promise.allSettled(phones.map(async (ph) => (ph.conn = await open(ph.peer, `/api/p/${eventId}/stream`, 'participant'))))
    const wall = performance.now() - t
    const rejected = res.filter((r) => r.status === 'rejected')
    for (const r of rejected) fail(`[1] ${String(r.reason).slice(0, 200)}`)
    const first = line('primeiro estado', phones.flatMap((p) => (p.conn ? [p.conn.first] : [])))
    console.log(`  todos conectados em ${wall.toFixed(0)} ms; falhas: ${rejected.length}`)
    check('[1] entrada em massa, p95 do primeiro estado', first.p95, LIMITS.joinStormP95)
    return { firstState: first, wallMs: wall }
  })
  const connected = await memory()
  const online = modConn.last!.presence.participants
  if (online !== N) fail(`[1] o console mostra ${online} celulares online, esperava ${N}`)

  // RSS também conta a memória nativa dos sockets, mas oscila com o que o V8 devolve ao sistema; heap é o número estável.
  const perConnKB = ((connected.heap - idle.heap) * 1024) / N
  const rssPerConnKB = ((connected.rss - idle.rss) * 1024) / N
  console.log(
    `\n[6] Memória por conexão SSE (depois de GC): heap+external ${idle.heap.toFixed(1)} -> ${connected.heap.toFixed(1)} MB = ` +
      `${perConnKB.toFixed(1)} KB por celular · RSS ${idle.rss.toFixed(0)} -> ${connected.rss.toFixed(0)} MB = ${rssPerConnKB.toFixed(1)} KB`,
  )
  report.memory = { idle, connected, perConnKB, rssPerConnKB }
  check('[6] memória por conexão (KB de heap)', perConnKB, LIMITS.memoryPerConnKB)

  // [2] Corte: prévia e no ar trocam de lugar. Alterna título e perguntas, terminando com perguntas no ar.
  await phase('take', `[2] Corte (take): ${TAKES} trocas de cena`, async () => {
    const screen: number[] = []
    const participant: number[] = []
    const queue: number[] = []
    const build: number[] = []
    const spread: number[] = []
    for (let k = 0; k < TAKES; k++) {
      const target = k % 2 ? qScene : titleScene
      expectStatus(await live({ op: 'preview', sceneId: target.id }), 200, 'prévia')
      await sleep(100) // a prévia também vai para a tela; o corte é medido sozinho
      const r = await measure(
        { screen: (s) => s.program?.id === target.id, participant: (s) => s.now?.sceneId === target.id },
        async () => expectStatus(await live({ op: 'take' }), 200, 'corte'),
      )
      if (r.missing) fail(`[2] ${r.missing} conexões não receberam o corte ${k + 1} em 5 s`)
      screen.push(...r.screen)
      participant.push(...r.participant)
      // Fila = espera do agrupamento de 500 ms; montagem = do início do envio em leque até o 1º celular receber
      // (o laço do hub é síncrono: nada sai antes de todos os snapshots ficarem prontos); entrega = 1º ao último.
      if (r.participant.length) {
        const t0 = performance.timeOrigin + r.t0
        const firstAt = Math.min(...r.participant)
        queue.push(r.serverNow - t0)
        build.push(t0 + firstAt - r.serverNow)
        spread.push(Math.max(...r.participant) - firstAt)
      }
      await sleep(100)
    }
    const s = line('telas', screen)
    const p = line('celulares', participant)
    line('celulares: espera do agrupamento', queue)
    line('celulares: montagem do leque', build)
    line('celulares: entrega 1º -> último', spread)
    check('[2] corte, p95 nas telas', s.p95, LIMITS.takeScreenP95)
    check('[2] corte, p95 nos celulares', p.p95, LIMITS.takeParticipantP95)
    return { screen: s, participant: p, queue: stats(queue), build: stats(build), spread: stats(spread) }
  })

  // [3] Destaque de pergunta com a cena de perguntas no ar.
  await phase('spotlight', `[3] Destaque de pergunta: ${SPOTLIGHTS} trocas com a cena de perguntas no ar`, async () => {
    if (modConn!.last!.event.live.program !== qScene.id) throw new Error('a cena de perguntas deveria estar no ar')
    for (let i = 0; i < SPOTLIGHTS; i++) {
      const text = `Pergunta destacada ${i + 1}: qual o plano para levar o sistema a eventos com milhares de pessoas?`
      expectStatus(await mod.req('POST', `/api/events/${eventId}/questions`, { text, author: 'Moderação' }), 201, 'criar pergunta')
    }
    await sleep(200)
    const picks = modConn!.last!.questions.filter((q) => q.text.startsWith('Pergunta destacada'))
    const screen: number[] = []
    const participant: number[] = []
    for (const q of picks) {
      const r = await measure(
        { screen: (s) => s.questions[0]?.id === q.id, participant: (s) => s.now?.questions[0]?.id === q.id },
        async () => expectStatus(await mod.req('POST', `/api/events/${eventId}/questions/${q.id}/screen`, { on: true, solo: true }), 200, 'destacar'),
      )
      if (r.missing) fail(`[3] ${r.missing} conexões não receberam o destaque em 5 s`)
      screen.push(...r.screen)
      participant.push(...r.participant)
      await sleep(100)
    }
    const s = line('telas', screen)
    const p = line('celulares', participant)
    check('[3] destaque, p95 nas telas', s.p95, LIMITS.spotlightScreenP95)
    check('[3] destaque, p95 nos celulares', p.p95, LIMITS.spotlightParticipantP95)
    return { screen: s, participant: p }
  })

  // [4] Metade da plateia manda um lote de reações por segundo. Uma sonda (só ela usa "love") mede o caminho
  // toque -> telão: o total de "love" na tela diz exatamente quando cada lote dela apareceu.
  const senders = phones.slice(1, 1 + Math.floor(N / 2))
  await phase('reactions', `[4] Chuva de reações: ${senders.length} celulares, 1 lote/s durante ${STORM_S} s`, async () => {
    const KINDS = ['applause', 'insight', 'doubt'] as const
    const probeAt: number[] = []
    const probeLat: number[] = []
    const seenLove = new Map<Conn, number>()
    const post: number[] = []
    const inflight: Promise<void>[] = []
    let accepted = 0
    let screenMsgs = 0
    let phoneMsgs = 0
    let countsBytes = 0
    let shown = 0
    listener = (c, event, data, at) => {
      if (event !== 'counts') return
      if (c.kind === 'participant') phoneMsgs++
      if (c.kind !== 'screen') return
      screenMsgs++
      countsBytes = data.length
      const r = (JSON.parse(data) as Counts).reactions[qScene.id] ?? {}
      const love = r.love ?? 0
      for (let k = seenLove.get(c) ?? 0; k < love; k++) if (probeAt[k] !== undefined) probeLat.push(at - probeAt[k]!)
      seenLove.set(c, love)
      shown = Object.values(r).reduce((a, b) => a + (b ?? 0), 0)
    }
    const t0 = performance.now() + 50
    const send = (ph: (typeof phones)[number], kinds: object, n: number) => {
      const t = performance.now()
      return ph.peer.req('POST', `/api/p/${eventId}/reactions`, { kinds }).then((r) => {
        post.push(performance.now() - t)
        if (r.status === 200) accepted += n
        else fail(`[4] reação respondeu ${r.status} ${JSON.stringify(r.data)}`)
      })
    }
    // A sonda espera 1 s depois de cada resposta: o limite por celular nunca descarta um lote dela,
    // então o k-ésimo "love" na tela é exatamente o k-ésimo envio.
    const probe = (async () => {
      await sleepUntil(t0 + 500)
      for (let k = 0; k < STORM_S; k++, await sleep(1000)) {
        probeAt[k] = performance.now()
        await send(phones[0]!, { love: 1 }, 1)
      }
    })()
    await Promise.all(
      senders.map(async (ph, i) => {
        for (let k = 0; k < STORM_S; k++) {
          // Fases espalhadas no segundo: chegada uniforme, como numa plateia de verdade.
          await sleepUntil(t0 + k * 1000 + (i / senders.length) * 1000)
          const n = 1 + ((i + k) % 3)
          inflight.push(send(ph, { [KINDS[(i + k) % 3]!]: n }, n)) // sem esperar: mantém 1 lote/s mesmo se o servidor atrasar
        }
      }),
    )
    await probe
    await Promise.all(inflight)
    const elapsed = (performance.now() - t0) / 1000
    for (const end = performance.now() + 3000; shown < accepted && performance.now() < end; ) await sleep(50)
    listener = null
    // O servidor responde 200 mesmo quando o limite por celular (3 lotes em 2 s) descarta o lote: se ele atrasa,
    // lotes enviados a 1/s chegam juntos e somem em silêncio.
    if (shown !== accepted) fail(`[4] a tela mostra ${shown} reações, o servidor confirmou ${accepted}: lotes descartados sob atraso`)
    const p = line('POST de reação', post)
    const s = line('toque -> telão (sonda)', probeLat)
    const screenRate = screenMsgs / SCREENS / elapsed
    const phoneRate = phoneMsgs / elapsed
    console.log(
      `  ${(post.length / elapsed).toFixed(0)} POST/s · ${accepted} reações aceitas, ${shown} na tela · counts: ` +
        `${screenRate.toFixed(1)}/s por tela, ${phoneRate.toFixed(0)}/s somando os celulares (${kb(countsBytes)} cada)`,
    )
    check('[4] reações, p95 toque -> telão', s.p95, LIMITS.reactionScreenP95)
    return { post: p, probe: s, accepted, shown, countsPerSecPerScreen: screenRate, countsPerSecAllPhones: phoneRate, countsBytes }
  })

  // [5] Perguntas de celulares diferentes (cada um tem limite de 1 a cada 15 s), espalhadas em 10 s.
  await phase('questions', `[5] Enxurrada de perguntas: ${QUESTIONS} perguntas de celulares diferentes em 10 s`, async () => {
    const askers = phones.filter((p) => p.conn).slice(-QUESTIONS)
    const sentAt = new Map<string, number>()
    const waitMod = new Set<string>()
    const waitMine = new Map<Conn, string>()
    const modLat: number[] = []
    const mineLat: number[] = []
    const post: number[] = []
    const sizes: number[] = []
    const parse: number[] = []
    listener = (c, event, data, at) => {
      if (event !== 'state') return
      if (c.kind === 'moderator') {
        sizes.push(data.length)
        parse.push(c.parseMs)
        for (const q of c.last!.questions) if (waitMod.delete(q.text)) modLat.push(at - sentAt.get(q.text)!)
      } else if (c.kind === 'participant') {
        const text = waitMine.get(c)
        if (text && (JSON.parse(data) as ParticipantSnapshot).mine.some((m) => m.text === text)) {
          mineLat.push(at - sentAt.get(text)!)
          waitMine.delete(c)
        }
      }
    }
    const t0 = performance.now()
    await Promise.all(
      askers.map(async (ph, i) => {
        await sleepUntil(t0 + (i * 10_000) / QUESTIONS)
        const text = `Pergunta ${i + 1} da plateia: como o sistema se comporta quando centenas de pessoas enviam perguntas juntas?`
        sentAt.set(text, performance.now())
        waitMod.add(text)
        waitMine.set(ph.conn!, text)
        const r = await ph.peer.req('POST', `/api/p/${eventId}/questions`, { text })
        post.push(performance.now() - sentAt.get(text)!)
        if (r.status !== 201) {
          fail(`[5] pergunta respondeu ${r.status} ${JSON.stringify(r.data)}`)
          waitMod.delete(text)
          waitMine.delete(ph.conn!)
        }
      }),
    )
    for (const end = performance.now() + 5000; (waitMod.size || waitMine.size) && performance.now() < end; ) await sleep(50)
    listener = null
    if (waitMod.size) fail(`[5] ${waitMod.size} perguntas não apareceram no console em 5 s`)
    if (waitMine.size) fail(`[5] ${waitMine.size} autores não viram a própria pergunta em 5 s`)
    line('POST de pergunta', post)
    const m = line('pergunta -> console', modLat)
    line('pergunta -> celular do autor', mineLat)
    const size = stats(sizes)
    const parsed = stats(parse)
    console.log(
      `  snapshot do console: ${sizes.length} envios, ${kb(size.p50)} (mediana), ${kb(size.max)} (máx), ` +
        `${mb(sizes.reduce((a, b) => a + b, 0))} no total · JSON.parse no cliente: p50 ${parsed.p50.toFixed(1)} ms, máx ${parsed.max.toFixed(1)} ms`,
    )
    check('[5] perguntas, p95 até o console', m.p95, LIMITS.questionModeratorP95)
    return { post: stats(post), moderator: m, author: stats(mineLat), snapshotBytes: size, snapshots: sizes.length, parseMs: parsed }
  })

  const dropped = conns.filter((c) => c.ended).length
  if (dropped) fail(`${dropped} conexões SSE caíram durante o teste`)
  exitCode = 0
} catch (e) {
  fail(String(e instanceof Error ? e.message : e))
  console.error(`\nErro: ${e instanceof Error ? e.message : e}`)
  if (serverLog.length) console.error(`Log do servidor:\n${serverLog.join('').slice(-4000)}`)
}

clearInterval(sampler)
lag.disable()
await stop()
if (opt.profile) console.log(`\nPerfil de CPU do servidor em ${opt.profile}`)

console.log('\nLimites')
for (const c of checks) {
  const ok = c.value <= c.limit
  if (!ok) exitCode = 1
  console.log(`  ${ok ? 'ok   ' : 'FALHA'} ${c.name.padEnd(46)} ${fmt(c.value, 1)} (limite ${c.limit})`)
}
if (failures.length) {
  exitCode = 1
  console.log(`  FALHA ${failures.length} erros de requisição ou conexão:`)
  for (const f of failures.slice(0, 10)) console.log(`        ${f}`)
}
report.failures = failures.length
console.log(`\n${JSON.stringify(report)}`)
process.exit(exitCode)
