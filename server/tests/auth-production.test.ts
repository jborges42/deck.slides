// Produção: conta inicial protegida por SETUP_TOKEN, CSP nas respostas e nada do servidor exposto.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Antes de carregar a aplicação: o modo de produção é lido na importação.
process.env.NODE_ENV = 'production'
process.env.SETUP_TOKEN = 'tok-123'
const { Client } = await import('./helpers.ts')

const account = { name: 'Ana Produção', email: 'ana@producao.com', password: 'senha-de-producao-1' }
const WRONG_TOKEN = { error: 'Código de instalação incorreto. Use o valor de SETUP_TOKEN configurado no servidor.' }

test('instalação nova em produção avisa que a conta inicial exige o código', async () => {
  const r = await new Client().req('GET', '/api/auth/me')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { moderator: null, needsSetup: true, setupToken: true })
})

test('recusa a conta inicial sem código, com código errado ou sem SETUP_TOKEN no servidor', async () => {
  const c = new Client()
  for (const token of [undefined, '', 'tok-124', 'tok-1234', 'TOK-123']) {
    const r = await c.req('POST', '/api/auth/setup', { ...account, token })
    assert.equal(r.status, 403, `código ${JSON.stringify(token)}`)
    assert.deepEqual(r.data, WRONG_TOKEN)
  }
  // Sem SETUP_TOKEN configurado, nenhuma tentativa passa (falha fechada).
  delete process.env.SETUP_TOKEN
  try {
    const r = await new Client().req('POST', '/api/auth/setup', { ...account, token: 'tok-123' })
    assert.equal(r.status, 403)
  } finally {
    process.env.SETUP_TOKEN = 'tok-123'
  }
  assert.equal(c.jar.has('deck_mod'), false)
  const me = await c.req('GET', '/api/auth/me')
  assert.deepEqual(me.data, { moderator: null, needsSetup: true, setupToken: true })
})

test('com o código certo cria a conta, abre a sessão e para de pedir código', async () => {
  const c = new Client()
  const r = await c.req('POST', '/api/auth/setup', { ...account, token: 'tok-123' })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  const me = (await c.req('GET', '/api/auth/me')).data
  assert.equal(me.needsSetup, false)
  assert.equal(me.setupToken, false)
  assert.equal(me.moderator.email, account.email)
  assert.equal((await c.req('GET', '/api/events')).status, 200)
  // O código não reabre a instalação.
  const again = await new Client().req('POST', '/api/auth/setup', { ...account, email: 'outra@producao.com', token: 'tok-123' })
  assert.equal(again.status, 409)
})

test('respostas da API levam CSP restritiva e cabeçalhos de segurança, inclusive nos erros', async () => {
  const c = new Client()
  for (const path of ['/api/auth/me', '/api/events', '/api/nao-existe']) {
    const res = await c.raw('GET', path)
    await res.body?.cancel()
    const csp = res.headers.get('content-security-policy') ?? ''
    for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"])
      assert.ok(csp.includes(directive), `${path}: falta ${directive} em "${csp}"`)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path)
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', path)
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', path)
    assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=\d+/, path)
  }
})

test('rota de API desconhecida responde 404 JSON genérico, sem cair no front-end', async () => {
  const c = new Client()
  for (const [method, path] of [['GET', '/api/nao-existe'], ['POST', '/api/nao-existe'], ['GET', '/api/auth/nada'], ['DELETE', '/api/auth/me']] as const) {
    const r = await c.req(method, path)
    assert.equal(r.status, 404, `${method} ${path}`)
    assert.match(r.headers.get('content-type') ?? '', /application\/json/, `${method} ${path}`)
    assert.deepEqual(r.data, { error: 'Rota não encontrada.' })
  }
})

test('não expõe arquivos do projeto, configuração nem o banco', async () => {
  const c = new Client()
  const paths = [
    '/package.json',
    '/.env',
    '/.gitignore',
    '/CLAUDE.md',
    '/tsconfig.json',
    '/pnpm-lock.yaml',
    '/server/auth.ts',
    '/server/tests/helpers.ts',
    '/node_modules/hono/package.json',
    '/data/deck.db',
    '/deck.db',
    '/assets/../package.json',
    '/assets/..%2f..%2fpackage.json',
    '/media/%2e%2e/deck.db',
    '/media/..%2fdeck.db',
  ]
  for (const path of paths) {
    const res = await c.raw('GET', path)
    const text = await res.text()
    assert.equal(res.status, 404, path)
    assert.doesNotMatch(text, /"dependencies"|SQLite format|SESSION_SECRET|import /, path)
  }
})
