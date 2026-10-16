// Mídia no Vercel Blob (BLOB_READ_WRITE_TOKEN): o navegador envia direto ao Blob com um token preso ao arquivo
// (ticket) e o servidor confere tipo e tamanho reais antes de registrar (complete). A API do Blob é um dublê
// local (VERCEL_BLOB_API_URL), e o envio do navegador é simulado gravando no dublê.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getPayloadFromClientToken } from '@vercel/blob/client'
import type { Media, ModeratorSnapshot } from '../../shared/types.ts'

const TOKEN = 'vercel_blob_rw_teststore_segredo0123456789'
const HOST = 'https://teststore.public.blob.vercel-storage.com'

interface Stored {
  url: string
  pathname: string
  contentType: string
  size: number
}
const blobs = new Map<string, Stored>()
const deleted: string[] = []

const api = createServer((req, res) => {
  const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(403, { error: { code: 'forbidden', message: 'token' } })
  const url = new URL(req.url!, 'http://dublê')
  if (req.method === 'GET') {
    const key = url.searchParams.get('url')!
    const b = [...blobs.values()].find((x) => x.pathname === key || x.url === key)
    if (!b) return reply(404, { error: { code: 'not_found', message: 'The requested blob does not exist' } })
    return reply(200, { ...b, downloadUrl: `${b.url}?download=1`, contentDisposition: 'inline', cacheControl: 'public, max-age=2592000', uploadedAt: new Date().toISOString(), etag: '"1"' })
  }
  if (req.method === 'POST' && url.pathname === '/delete') {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      for (const u of JSON.parse(raw).urls as string[]) {
        deleted.push(u)
        for (const [k, b] of blobs) if (b.url === u) blobs.delete(k)
      }
      reply(200, {})
    })
    return
  }
  reply(404, { error: { code: 'not_found', message: req.url } })
})
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
after(() => api.close())

process.env.BLOB_READ_WRITE_TOKEN = TOKEN
process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
const { asModerator, Client, createEvent } = await import('./helpers.ts')

let mod: InstanceType<typeof Client>
let eventId: string
before(async () => {
  mod = await asModerator()
  eventId = (await createEvent(mod, 'Mídia no Blob')).event.id
})

/** O que o navegador faria com o token: grava o arquivo no Blob. */
const upload = (pathname: string, contentType: string, size: number): Stored => {
  const b = { url: `${HOST}/${pathname}`, pathname, contentType, size }
  blobs.set(pathname, b)
  return b
}

const ticket = (body: unknown) => mod.req('POST', `/api/events/${eventId}/media/ticket`, body)

test('ticket: token só para este arquivo, com caminho do evento, extensão do tipo, tipo e tamanho máximo', async () => {
  const r = await ticket({ name: 'palco.html', type: 'image/png', size: 2048 })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.match(r.data.pathname, new RegExp(`^media/${eventId}/[\\w-]+\\.png$`))
  assert.equal(r.data.contentType, 'image/png')
  const payload = getPayloadFromClientToken(r.data.token)
  assert.equal(payload.pathname, r.data.pathname)
  assert.deepEqual(payload.allowedContentTypes, ['image/png'])
  assert.equal(payload.maximumSizeInBytes, 1024 * 1024 * 1024)
  assert.ok(payload.validUntil > Date.now())

  // Fonte: o navegador costuma mandar tipo vazio; o tipo gravado vem da extensão.
  const font = await ticket({ name: 'Marca Bold.woff2', type: '', size: 30_000 })
  assert.equal(font.data.contentType, 'font/woff2')
  assert.match(font.data.pathname, /\.woff2$/)
})

test('ticket recusa formato, tamanho e arquivo vazio antes de emitir token', async () => {
  for (const [body, status] of [
    [{ name: 'script.js', type: 'text/javascript', size: 10 }, 415],
    [{ name: 'filme.mp4', type: 'video/mp4', size: 1024 * 1024 * 1024 + 1 }, 413],
    [{ name: 'vazio.png', type: 'image/png', size: 0 }, 400],
  ] as const) {
    const r = await ticket(body)
    assert.equal(r.status, status, JSON.stringify(body))
    assert.equal(r.data.token, undefined)
  }
})

test('complete registra o arquivo conferido no Blob, e /media redireciona para ele', async () => {
  const t = await ticket({ name: 'Logo da turma.png', type: 'image/png', size: 4096 })
  const stored = upload(t.data.pathname, 'image/png', 4096)
  const done = await mod.req('POST', `/api/events/${eventId}/media/complete`, { pathname: t.data.pathname, name: 'Logo da turma.png' })
  assert.equal(done.status, 201, JSON.stringify(done.data))
  const media = done.data as Media
  assert.deepEqual([media.kind, media.name, media.mime, media.size], ['image', 'Logo da turma.png', 'image/png', 4096])
  assert.equal(media.url, `/media/${eventId}/${t.data.pathname.split('/').pop()}`)

  const snap = await mod.snapshot<ModeratorSnapshot>(`/api/events/${eventId}/stream`)
  assert.ok(snap.media.some((m) => m.id === media.id))

  const res = await mod.raw('GET', media.url)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), stored.url)
  assert.match(res.headers.get('cache-control') ?? '', /immutable/)
})

test('complete recusa tipo real diferente do token (e apaga o arquivo), caminho de outro evento e envio que não existe', async () => {
  const t = await ticket({ name: 'foto.png', type: 'image/png', size: 100 })
  const sneaky = upload(t.data.pathname, 'text/html', 100)
  const r = await mod.req('POST', `/api/events/${eventId}/media/complete`, { pathname: t.data.pathname, name: 'foto.png' })
  assert.equal(r.status, 415)
  assert.ok(deleted.includes(sneaky.url))
  assert.equal(blobs.has(t.data.pathname), false)

  const other = await createEvent(mod, 'Outro evento')
  const foreign = await mod.req('POST', `/api/events/${other.event.id}/media/complete`, { pathname: t.data.pathname, name: 'x.png' })
  assert.equal(foreign.status, 400)
  const missing = await mod.req('POST', `/api/events/${eventId}/media/complete`, { pathname: `media/${eventId}/naoexiste.png`, name: 'x.png' })
  assert.equal(missing.status, 404)
})

test('com Blob, o envio pelo corpo da requisição é recusado (a função da Vercel não aceita arquivos grandes)', async () => {
  const r = await mod.raw('POST', `/api/events/${eventId}/media`, { body: 'x', headers: { 'content-type': 'image/png', 'x-filename': 'a.png' } })
  assert.equal(r.status, 409)
})

test('apagar a mídia ou o evento apaga os arquivos no Blob', async () => {
  const add = async (name: string) => {
    const t = await ticket({ name, type: 'image/webp', size: 10 })
    const stored = upload(t.data.pathname, 'image/webp', 10)
    const done = await mod.req('POST', `/api/events/${eventId}/media/complete`, { pathname: t.data.pathname, name })
    return { media: done.data as Media, stored }
  }
  const one = await add('um.webp')
  assert.equal((await mod.req('DELETE', `/api/events/${eventId}/media/${one.media.id}`)).status, 200)
  assert.ok(deleted.includes(one.stored.url))
  assert.equal((await mod.raw('GET', one.media.url)).status, 404)

  const two = await add('dois.webp')
  assert.equal((await mod.req('DELETE', `/api/events/${eventId}`)).status, 200)
  assert.ok(deleted.includes(two.stored.url))
})
