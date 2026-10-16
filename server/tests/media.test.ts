// Biblioteca de mídia: envio em corpo bruto, extensão pelo tipo (nunca pelo nome), limite de tamanho,
// entrega segura em /media e proteção contra travessia de caminho. No fim, o cache dos arquivos do front-end.
// Roda em modo de produção: é a configuração publicada (CSP da aplicação ativa), e a CSP da mídia precisa prevalecer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client as HttpClient } from './helpers.ts'
import type { Media, ModeratorSnapshot } from '../../shared/types.ts'

// Lidos quando a aplicação carrega: precisam vir antes do import dos helpers.
process.env.NODE_ENV = 'production'
process.env.SETUP_TOKEN = 'token-da-midia'
process.env.MAX_UPLOAD_MB = '1'
const { Client, createEvent, joinParticipant } = await import('./helpers.ts')
const { DATA_DIR, UPLOADS_DIR, get } = await import('../db.ts')

const MB = 1024 * 1024
const LIMIT_ERROR = 'Arquivo acima do limite de envio.'
const anon = new Client()

/** Moderador logado. Em produção a conta inicial exige SETUP_TOKEN. */
async function moderator(): Promise<HttpClient> {
  const c = new Client()
  const account = { name: 'Mara Mídia', email: 'mara@exemplo.com', password: 'senha-da-midia-1' }
  const setup = await c.req('POST', '/api/auth/setup', { ...account, token: process.env.SETUP_TOKEN })
  if (setup.status !== 201) assert.equal((await c.req('POST', '/api/auth/login', account)).status, 200)
  return c
}

/** Conteúdo determinístico de `n` bytes. */
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255)

async function upload(c: HttpClient, eventId: string, body?: Uint8Array, type?: string, name?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra }
  if (type !== undefined) headers['content-type'] = type
  if (name !== undefined) headers['x-filename'] = encodeURIComponent(name)
  const res = await c.raw('POST', `/api/events/${eventId}/media`, { body, headers })
  return { status: res.status, data: (await res.json()) as Media & { error?: string } }
}

/** Arquivos gravados na pasta do evento. */
const files = (eventId: string) => (existsSync(join(UPLOADS_DIR, eventId)) ? readdirSync(join(UPLOADS_DIR, eventId)).sort() : [])
const fileOf = (m: Media) => m.url.split('/').pop()!

async function fetchMedia(url: string, headers: Record<string, string> = {}) {
  const res = await anon.raw('GET', url, { headers })
  return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) }
}

const KINDS = [
  { type: 'image/png', name: 'foto.png', kind: 'image', ext: 'png', served: 'image/png' },
  { type: 'image/jpeg', name: 'foto.jpeg', kind: 'image', ext: 'jpg', served: 'image/jpeg' },
  { type: 'image/gif', name: 'anim.gif', kind: 'image', ext: 'gif', served: 'image/gif' },
  { type: 'image/webp', name: 'foto.webp', kind: 'image', ext: 'webp', served: 'image/webp' },
  { type: 'image/avif', name: 'foto.avif', kind: 'image', ext: 'avif', served: 'image/avif' },
  { type: 'image/svg+xml', name: 'logo.svg', kind: 'image', ext: 'svg', served: 'image/svg+xml' },
  { type: 'video/mp4', name: 'abertura.mp4', kind: 'video', ext: 'mp4', served: 'video/mp4' },
  { type: 'video/webm', name: 'clipe.webm', kind: 'video', ext: 'webm', served: 'video/webm' },
  { type: 'video/ogg', name: 'clipe.ogv', kind: 'video', ext: 'ogv', served: 'video/ogg' },
  { type: 'video/quicktime', name: 'gravação do iPhone.mov', kind: 'video', ext: 'mov', served: 'video/quicktime' },
  // Fontes: o tipo declarado pelos navegadores varia; vale a extensão do nome, dentro da lista permitida.
  { type: 'font/woff2', name: 'Marca.woff2', kind: 'font', ext: 'woff2', served: 'font/woff2' },
  { type: 'application/octet-stream', name: 'Marca.woff', kind: 'font', ext: 'woff', served: 'font/woff' },
  { type: '', name: 'Marca.TTF', kind: 'font', ext: 'ttf', served: 'font/ttf' },
  { type: 'font/otf', name: 'Marca.otf', kind: 'font', ext: 'otf', served: 'font/otf' },
] as const

test('aceita imagem, vídeo e fonte, grava com a extensão do tipo e entrega os mesmos bytes', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: formatos')
  const sent: Media[] = []
  for (const [i, k] of KINDS.entries()) {
    const content = bytes(64 + i, i)
    const { status, data } = await upload(mod, event.id, content, k.type, k.name)
    assert.equal(status, 201, `${k.name}: ${JSON.stringify(data)}`)
    assert.equal(data.kind, k.kind, k.name)
    assert.equal(data.name, k.name)
    assert.equal(data.size, content.length)
    assert.match(data.url, new RegExp(`^/media/${event.id}/[\\w-]{12}\\.${k.ext}$`), k.name)
    assert.deepEqual(new Uint8Array(readFileSync(join(UPLOADS_DIR, event.id, fileOf(data)))), content, `${k.name} no disco`)
    const got = await fetchMedia(data.url)
    assert.equal(got.status, 200, data.url)
    assert.equal(got.headers.get('content-type')?.split(';')[0], k.served, `${k.name}: tipo servido`)
    assert.deepEqual(got.body, content, `${k.name}: bytes servidos`)
    sent.push(data)
  }
  // O console recebe exatamente o que a resposta do envio descreveu.
  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
  const byId = new Map(snap.media.map((m) => [m.id, m]))
  for (const m of sent) assert.deepEqual(byId.get(m.id), m, `${m.name} no snapshot`)
  assert.equal(snap.media.length, KINDS.length)
})

test('a extensão gravada vem do tipo validado, nunca do nome enviado', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: extensão')
  const cases = [
    ['foto.html', 'image/png', 'png'],
    ['x.svg.html', 'image/svg+xml', 'svg'],
    ['pagina.php', 'image/jpeg', 'jpg'],
    ['sem-extensao', 'video/mp4', 'mp4'],
    ['../../../etc/passwd', 'image/png', 'png'],
    ['<img src=x onerror=alert(1)>.png', 'image/webp', 'webp'],
    ['fonte.woff2', 'IMAGE/PNG; charset=binary', 'woff2'], // nome de fonte da lista vale como fonte
    ['FOTO.PNG', 'IMAGE/PNG; charset=binary', 'png'],
  ] as const
  for (const [name, type, ext] of cases) {
    const { status, data } = await upload(mod, event.id, bytes(32), type, name)
    assert.equal(status, 201, `${name}: ${JSON.stringify(data)}`)
    assert.equal(data.name, name, 'o nome original fica só para exibição')
    assert.match(fileOf(data), new RegExp(`^[\\w-]{12}\\.${ext}$`), `${name} (${type})`)
  }
  // No disco só existem nomes aleatórios com extensões da lista, nada derivado do nome enviado.
  for (const f of files(event.id)) assert.match(f, /^[\w-]{12}\.(png|svg|jpg|mp4|webp|woff2)$/)
  assert.equal(files(event.id).length, cases.length)
})

test('recusa formatos não suportados com 415, sem gravar nada', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: recusas')
  const cases: [string | undefined, string][] = [
    ['text/html', 'pagina.html'],
    ['application/zip', 'pacote.zip'],
    ['image/x-icon', 'favicon.ico'],
    ['image/bmp', 'foto.bmp'],
    ['application/javascript', 'app.js'],
    ['text/plain', 'notas.txt'],
    ['application/pdf', 'slides.pdf'],
    ['application/octet-stream', 'programa.exe'],
    ['text/html', 'fonte.woff2.html'], // extensão final não é de fonte
    ['image/svg', 'logo.svg'], // tipo inexistente, mesmo com nome de imagem
    [undefined, 'foto.png'], // sem Content-Type
  ]
  for (const [type, name] of cases) {
    const { status, data } = await upload(mod, event.id, bytes(16), type, name)
    assert.equal(status, 415, `${type} ${name}`)
    assert.match(data.error ?? '', /^Formato não suportado\. Envie imagem/)
  }
  assert.deepEqual(files(event.id), [])
  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
  assert.deepEqual(snap.media, [])
})

test('nome malformado ou perigoso em X-Filename não derruba o envio', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: nomes')
  const raw = async (header: string | undefined) => {
    const res = await mod.raw('POST', `/api/events/${event.id}/media`, {
      body: bytes(8),
      headers: header === undefined ? { 'content-type': 'image/png' } : { 'content-type': 'image/png', 'x-filename': header },
    })
    const data = (await res.json()) as Media
    assert.equal(res.status, 201, `${header}: ${JSON.stringify(data)}`)
    return data.name
  }
  assert.equal(await raw('%E0%A4%A'), 'arquivo') // escape inválido
  assert.equal(await raw('%'), 'arquivo')
  assert.equal(await raw(undefined), 'arquivo')
  assert.equal(await raw(''), 'arquivo')
  assert.equal(await raw(encodeURIComponent('\u0000\u001f')), 'arquivo') // só caracteres de controle
  assert.equal(await raw(encodeURIComponent('a\u0000b\nc\u001f.png')), 'abc.png')
  assert.equal(await raw(encodeURIComponent('Relatório 2026 — versão final ✓.png')), 'Relatório 2026 — versão final ✓.png')
  assert.equal((await raw(encodeURIComponent(`${'x'.repeat(300)}.png`))).length, 200)
})

test('serve o arquivo com nosniff, CSP com sandbox e cache longo', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: entrega')
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>')
  const { data } = await upload(mod, event.id, svg, 'image/svg+xml', 'logo.svg')
  const got = await fetchMedia(data.url)
  assert.equal(got.status, 200)
  assert.deepEqual(got.body, svg)
  assert.match(got.headers.get('content-type') ?? '', /^image\/svg\+xml/)
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  // A CSP da mídia (sem scripts, em sandbox) substitui a da aplicação, mesmo em produção.
  const csp = got.headers.get('content-security-policy') ?? ''
  assert.match(csp, /\bsandbox\b/, csp)
  assert.match(csp, /default-src 'none'/, csp)
  assert.doesNotMatch(csp, /script-src/, csp)
  const cache = got.headers.get('cache-control') ?? ''
  assert.match(cache, /max-age=31536000/)
  assert.match(cache, /immutable/)
  assert.equal(got.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal(got.headers.get('referrer-policy'), 'same-origin')
  // Arquivo inexistente: 404 sem cache de longo prazo (não pode "grudar" no navegador).
  const missing = await fetchMedia(`/media/${event.id}/naoexiste000.png`)
  assert.equal(missing.status, 404)
  assert.doesNotMatch(missing.headers.get('cache-control') ?? '', /immutable/)
})

test('responde a pedidos parciais (Range) com 206 e com 416 fora do arquivo', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: Range')
  const content = bytes(100, 7)
  const { data } = await upload(mod, event.id, content, 'video/mp4', 'abertura.mp4')
  const part = await fetchMedia(data.url, { range: 'bytes=10-19' })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/100')
  assert.equal(part.headers.get('content-length'), '10')
  assert.equal(part.headers.get('accept-ranges'), 'bytes')
  assert.equal(part.headers.get('content-type'), 'video/mp4')
  assert.match(part.headers.get('content-security-policy') ?? '', /\bsandbox\b/)
  assert.deepEqual(part.body, content.slice(10, 20))
  const tail = await fetchMedia(data.url, { range: 'bytes=-5' })
  assert.equal(tail.status, 206)
  assert.deepEqual(tail.body, content.slice(95))
  const open = await fetchMedia(data.url, { range: 'bytes=90-' })
  assert.equal(open.status, 206)
  assert.equal(open.headers.get('content-range'), 'bytes 90-99/100')
  assert.deepEqual(open.body, content.slice(90))
  const outside = await fetchMedia(data.url, { range: 'bytes=200-300' })
  assert.equal(outside.status, 416)
  assert.equal(outside.headers.get('content-range'), 'bytes */100')
  assert.equal(outside.body.length, 0)
})

test('recusa arquivo acima do limite com 413, com ou sem Content-Length, sem deixar arquivo', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: limite')
  const big = bytes(1.5 * MB)
  // Tamanho declarado acima do limite: recusa antes de ler o corpo.
  const declared = await upload(mod, event.id, bytes(10), 'image/png', 'grande.png', { 'content-length': String(5 * 1024 * MB) })
  assert.equal(declared.status, 413)
  assert.equal(declared.data.error, LIMIT_ERROR)
  // Corpo sem Content-Length (streaming): o limite é contado durante a gravação.
  const streamed = await upload(mod, event.id, big, 'image/png', 'grande.png')
  assert.equal(streamed.status, 413)
  assert.equal(streamed.data.error, LIMIT_ERROR)
  assert.deepEqual(files(event.id), [], 'o arquivo parcial é apagado')
  // Exatamente no limite ainda passa.
  const edge = await upload(mod, event.id, bytes(MB), 'image/png', 'no-limite.png')
  assert.equal(edge.status, 201, JSON.stringify(edge.data))
  assert.equal(edge.data.size, MB)
  assert.deepEqual(files(event.id), [fileOf(edge.data)])
  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
  assert.deepEqual(snap.media.map((m) => m.id), [edge.data.id])
})

test('recusa envio vazio com 400 e não grava arquivo de 0 byte', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: vazio')
  const none = await upload(mod, event.id, undefined, 'image/png', 'vazio.png')
  assert.equal(none.status, 400)
  assert.equal(none.data.error, 'Arquivo vazio.')
  const empty = await upload(mod, event.id, new Uint8Array(0), 'image/png', 'vazio.png')
  assert.equal(empty.status, 400, JSON.stringify(empty.data))
  assert.equal(empty.data.error, 'Arquivo vazio.')
  assert.deepEqual(files(event.id), [])
  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
  assert.deepEqual(snap.media, [])
})

test('apagar mídia remove o registro e o arquivo', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: apagar')
  const { data: keep } = await upload(mod, event.id, bytes(20, 1), 'image/png', 'fica.png')
  const { data: gone } = await upload(mod, event.id, bytes(20, 2), 'image/png', 'sai.png')
  const del = await mod.req('DELETE', `/api/events/${event.id}/media/${gone.id}`)
  assert.equal(del.status, 200)
  assert.deepEqual(del.data, { ok: true })
  assert.deepEqual(files(event.id), [fileOf(keep)])
  assert.equal((await fetchMedia(gone.url)).status, 404)
  assert.equal((await fetchMedia(keep.url)).status, 200)
  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${event.id}/stream`)
  assert.deepEqual(snap.media.map((m) => m.id), [keep.id])
  // Segunda remoção: não há mais o que apagar.
  const again = await mod.req('DELETE', `/api/events/${event.id}/media/${gone.id}`)
  assert.equal(again.status, 404)
  assert.equal(again.data.error, 'Arquivo não encontrado.')
})

test('só o moderador envia ou apaga mídia, e só pela rota do próprio evento', async () => {
  const mod = await moderator()
  const { event: a } = await createEvent(mod, 'Mídia: evento A')
  const { event: b } = await createEvent(mod, 'Mídia: evento B')
  const { data: media } = await upload(mod, a.id, bytes(12), 'image/png', 'de-a.png')
  const { phone } = await joinParticipant(mod, a.id, 'Paula Participante')
  for (const who of [anon, phone]) {
    const up = await upload(who, a.id, bytes(12), 'image/png', 'intruso.png')
    assert.equal(up.status, 401)
    assert.equal(up.data.error, 'Sua sessão expirou. Entre de novo para continuar.')
    assert.equal((await who.req('DELETE', `/api/events/${a.id}/media/${media.id}`)).status, 401)
  }
  // Mídia do evento A não é apagada pela rota do evento B.
  const cross = await mod.req('DELETE', `/api/events/${b.id}/media/${media.id}`)
  assert.equal(cross.status, 404)
  assert.deepEqual(files(a.id), [fileOf(media)])
  assert.equal((await fetchMedia(media.url)).status, 200)
  // Evento inexistente.
  const unknown = await upload(mod, 'ZZZZZZ', bytes(12), 'image/png', 'x.png')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.data.error, 'Evento não encontrado.')
})

test('apagar o evento apaga a pasta de uploads e os registros de mídia', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: evento apagado')
  const { data: one } = await upload(mod, event.id, bytes(10, 1), 'image/png', 'um.png')
  const { data: two } = await upload(mod, event.id, bytes(10, 2), 'video/mp4', 'dois.mp4')
  assert.equal(files(event.id).length, 2)
  assert.equal((await mod.req('DELETE', `/api/events/${event.id}`)).status, 200)
  assert.equal(existsSync(join(UPLOADS_DIR, event.id)), false)
  assert.equal((await fetchMedia(one.url)).status, 404)
  assert.equal((await fetchMedia(two.url)).status, 404)
  assert.equal((await get<{ n: number }>('SELECT COUNT(*) AS n FROM media WHERE event_id = ?', event.id))?.n, 0)
})

test('caminhos com travessia em /media respondem 404 e nunca entregam o banco ou arquivos fora de uploads', async () => {
  const mod = await moderator()
  const { event } = await createEvent(mod, 'Mídia: travessia')
  const { data: legit } = await upload(mod, event.id, bytes(10), 'image/png', 'ok.png')
  writeFileSync(join(DATA_DIR, 'segredo.txt'), 'CANARIO-FORA-DE-UPLOADS')
  const ev = event.id
  const paths = [
    '/media/../deck.db',
    '/media/../../package.json',
    '/media/%2e%2e/deck.db',
    '/media/%2E%2E/%2E%2E/package.json',
    '/media/..%2fdeck.db',
    '/media/..%2Fsegredo.txt',
    '/media/%2e%2e%2fdeck.db',
    '/media/..%5cdeck.db',
    '/media/..\\segredo.txt',
    '/media/%252e%252e%252fdeck.db',
    `/media/${ev}/../../deck.db`,
    `/media/${ev}/..%2f..%2fdeck.db`,
    `/media/${ev}/%2e%2e%2f%2e%2e%2fsegredo.txt`,
    `/media/${ev}/..%252f..%252fdeck.db`,
    '/media//etc/passwd',
    '/media/%2fetc%2fpasswd',
    `/media/${DATA_DIR}/deck.db`,
    `/media/${encodeURIComponent(join(DATA_DIR, 'deck.db'))}`,
    '/media/deck.db',
    '/media/deck.db-wal',
    '/media/segredo.txt',
    '/media/uploads/../deck.db',
    '/media/x%00.png',
    '/media/',
    `/media/${ev}`,
    `/media/${ev}/`,
    `/media/${ev}/${fileOf(legit)}/`,
  ]
  for (const path of paths) {
    const res = await anon.raw('GET', path)
    const text = await res.text()
    assert.equal(res.status, 404, path)
    assert.doesNotMatch(text, /SQLite format|CANARIO|"dependencies"|root:/, path)
  }
  // Controle: o arquivo legítimo continua acessível.
  assert.equal((await fetchMedia(legit.url)).status, 200)
})

// Depende do build (pnpm build); sem dist/ não há o que servir.
const DIST = fileURLToPath(new URL('../../dist', import.meta.url))
const builtAsset = () => (existsSync(join(DIST, 'assets')) ? readdirSync(join(DIST, 'assets')).find((f) => f.endsWith('.js')) : undefined)

test('em produção, assets com hash ficam em cache longo e a página sempre revalida', { skip: !builtAsset() && 'sem build em dist/' }, async () => {
  const js = await anon.raw('GET', `/assets/${builtAsset()}`)
  await js.body?.cancel()
  assert.equal(js.status, 200)
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  // "/" e as rotas da SPA entregam index.html, que não pode ficar em cache: o próximo deploy troca os assets.
  for (const path of ['/', '/m', '/tela', '/e/ABC123']) {
    const page = await anon.raw('GET', path)
    await page.body?.cancel()
    assert.equal(page.status, 200, path)
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/, path)
    assert.equal(page.headers.get('cache-control'), 'no-cache', path)
  }
  // Inexistentes: 404 sem cache longo.
  for (const path of ['/assets/nao-existe.js', '/nao-existe.js']) {
    const res = await anon.raw('GET', path)
    await res.body?.cancel()
    assert.equal(res.status, 404, path)
    assert.doesNotMatch(res.headers.get('cache-control') ?? '', /immutable/, path)
  }
})
