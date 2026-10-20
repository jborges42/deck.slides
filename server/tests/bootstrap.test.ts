// Conta de gestor criada no deploy (ADMIN_EMAIL + ADMIN_PASSWORD) e SESSION_SECRET opcional em produção.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configErrors, configWarnings } from '../config.ts'

process.env.ADMIN_EMAIL = '  Gestor.Teste@Exemplo.com '
process.env.ADMIN_PASSWORD = 'senha-do-gestor-2026'
process.env.ADMIN_NAME = 'Gestor de teste'
const { Client } = await import('./helpers.ts')

test('cria a conta de gestor do deploy e ela entra com a senha das variáveis', async () => {
  const c = new Client()
  const me = await c.req('GET', '/api/auth/me')
  assert.equal(me.data.needsSetup, false) // a conta já existe: ninguém mais "toma" a instalação
  assert.equal((await c.req('POST', '/api/auth/login', { email: 'gestor.teste@exemplo.com', password: 'errada-123456' })).status, 401)
  assert.equal((await c.req('POST', '/api/auth/login', { email: 'gestor.teste@exemplo.com', password: 'senha-do-gestor-2026' })).status, 200)
  assert.equal((await c.req('GET', '/api/auth/me')).data.moderator.name, 'Gestor de teste')
})

test('não duplica nem sobrescreve a conta em uma nova inicialização', async () => {
  const c = new Client()
  await c.req('POST', '/api/auth/login', { email: 'gestor.teste@exemplo.com', password: 'senha-do-gestor-2026' })
  const team = await c.req('GET', '/api/moderators')
  assert.equal(team.data.filter((m: { email: string }) => m.email === 'gestor.teste@exemplo.com').length, 1)
})

test('produção sem SESSION_SECRET sobe (segredo fica no banco); curto ou senha de gestor curta são apontados', () => {
  assert.deepEqual(configErrors({ NODE_ENV: 'production' }), [])
  assert.match(configErrors({ NODE_ENV: 'production', SESSION_SECRET: 'curto' }).join(), /menos de 32 caracteres/)
  assert.match(configWarnings({ ADMIN_EMAIL: 'a@b.com', ADMIN_PASSWORD: '123' }).join(), /conta de gestor não foi criada/)
})
