// Fetch Metadata contra CSRF: escrita de outra origem é recusada; leitura e clientes sem navegador passam.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { fetchMetadata } from '../security/fetch-metadata.ts'

const app = new Hono()
app.use('/api/*', fetchMetadata)
app.all('/api/thing', (c) => c.json({ ok: true }))

const call = (method: string, headers: Record<string, string> = {}, url = 'http://deck.local:3000/api/thing') =>
  app.request(url, { method, headers })

async function forbidden(res: Response, label: string) {
  assert.equal(res.status, 403, label)
  const body = (await res.json()) as { error: string; code: string }
  assert.equal(body.code, 'forbidden', label)
  assert.match(body.error, /^Pedido recusado/)
}

test('Sec-Fetch-Site: escrita só passa com same-origin', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await call(method, { 'sec-fetch-site': 'same-origin' })).status, 200, method)
    for (const site of ['cross-site', 'same-site', 'none', 'qualquer'])
      await forbidden(await call(method, { 'sec-fetch-site': site }), `${method} ${site}`)
  }
  // Sec-Fetch-Site decide sozinho: proxy que reescreve o Host não quebra o navegador moderno.
  const res = await call('POST', { 'sec-fetch-site': 'same-origin', origin: 'https://deck.exemplo.com', host: '127.0.0.1:3000' })
  assert.equal(res.status, 200)
})

test('sem Sec-Fetch-Site (navegador antigo): Origin precisa ter o host da requisição', async () => {
  assert.equal((await call('POST', { origin: 'http://deck.local:3000', host: 'deck.local:3000' })).status, 200)
  assert.equal((await call('POST', { origin: 'http://DECK.local:3000' })).status, 200, 'host vem da URL quando falta o cabeçalho')
  await forbidden(await call('POST', { origin: 'https://evil.example', host: 'deck.local:3000' }), 'outro site')
  await forbidden(await call('POST', { origin: 'http://deck.local:4000', host: 'deck.local:3000' }), 'outra porta')
  await forbidden(await call('DELETE', { origin: 'null', host: 'deck.local:3000' }), 'Origin null')
  await forbidden(await call('POST', { origin: 'nem é url' }), 'Origin inválido')
})

test('PUBLIC_URL também vale como origem (proxy que não repassa o Host)', async () => {
  process.env.PUBLIC_URL = 'https://deck.exemplo.com'
  try {
    assert.equal((await call('POST', { origin: 'https://deck.exemplo.com', host: '127.0.0.1:3000' })).status, 200)
    await forbidden(await call('POST', { origin: 'https://evil.example', host: '127.0.0.1:3000' }), 'outro site')
  } finally {
    delete process.env.PUBLIC_URL
  }
})

test('sem Sec-Fetch-Site nem Origin (curl, servidor a servidor, testes): passa', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call(method)).status, 200, method)
})

test('GET, HEAD e OPTIONS sempre passam, inclusive navegação de outro site', async () => {
  const variants: Record<string, string>[] = [{ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, { 'sec-fetch-site': 'none' }, {}]
  for (const method of ['GET', 'HEAD', 'OPTIONS'])
    for (const headers of variants)
      assert.equal((await call(method, headers)).status, 200, `${method} ${JSON.stringify(headers)}`)
})
