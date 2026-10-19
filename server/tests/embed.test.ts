// Verificação da cena "Página web": bloqueio de exibição dentro de outra página e proteção contra SSRF.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { asModerator, Client, createEvent } from './helpers.ts'
import { checkEmbed, framingBlocked, guardedLookup, isPrivate } from '../embed.ts'

describe('cabeçalhos', () => {
  test('X-Frame-Options e frame-ancestors restritos bloqueiam; sem eles ou com * passa', () => {
    assert.ok(framingBlocked({ 'x-frame-options': 'SAMEORIGIN' }))
    assert.ok(framingBlocked({ 'x-frame-options': 'deny' }))
    assert.ok(framingBlocked({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self' https://*.globo.com" }))
    assert.ok(framingBlocked({ 'content-security-policy': ["img-src *", "frame-ancestors 'none'"] }))
    assert.ok(!framingBlocked({}))
    assert.ok(!framingBlocked({ 'content-security-policy': 'frame-ancestors *' }))
    assert.ok(!framingBlocked({ 'content-security-policy': "default-src 'self'" }))
    assert.ok(!framingBlocked({ 'x-frame-options': 'ALLOWALL' }))
  })
})

describe('rede interna', () => {
  test('endereços locais, privados, de metadados e IPv4 dentro de IPv6 são internos', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'abc'])
      assert.ok(isPrivate(ip), ip)
    for (const ip of ['8.8.8.8', '200.147.67.142', '2001:4860:4860::8888']) assert.ok(!isPrivate(ip), ip)
  })

  test('o DNS que aponta para dentro é recusado na conexão', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((done) => guardedLookup('localhost', {}, (e) => done(e)))
    assert.equal(err?.code, 'EPRIVATE')
  })

  test('IP interno digitado, http e credenciais na URL nem chegam a conectar', async () => {
    for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data/', 'http://exemplo.com/', 'https://a:b@exemplo.com/', 'nada'])
      assert.deepEqual(await checkEmbed(url, 1000), { embeddable: null }, url)
  })
})

const mod = await asModerator()

describe('rota', () => {
  test('responde a verificação para quem modera; recusa http e endereço inválido com mensagem em pt-BR', async () => {
    const { event } = await createEvent(mod)
    const path = `/api/events/${event.id}/embed-check`
    const local = await mod.req('POST', path, { url: 'https://127.0.0.1/' })
    assert.equal(local.status, 200)
    assert.deepEqual(local.data, { embeddable: null })
    for (const url of ['http://exemplo.com', 'javascript:alert(1)', '']) {
      const r = await mod.req('POST', path, { url })
      assert.equal(r.status, 400, url)
      assert.equal(typeof r.data.error, 'string')
    }
  })

  test('sem sessão de moderação: 401', async () => {
    const { event } = await createEvent(mod)
    const r = await new Client().req('POST', `/api/events/${event.id}/embed-check`, { url: 'https://exemplo.com' })
    assert.equal(r.status, 401)
  })
})
