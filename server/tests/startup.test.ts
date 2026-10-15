// Inicialização: o servidor recusa configuração insegura ou inválida sem mostrar segredos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dirname, '../index.ts')
const SECRET = 'segredo-de-teste-com-bem-mais-de-32-caracteres'
const tmp = () => mkdtempSync(join(tmpdir(), 'deck-ops-'))

// Configuração de quem roda o teste não pode vazar para o processo testado.
const CONFIG = ['NODE_ENV', 'PORT', 'DATA_DIR', 'DB_PATH', 'PUBLIC_URL', 'TRUST_PROXY', 'MAX_UPLOAD_MB', 'SESSION_SECRET', 'SETUP_TOKEN']
const env = (vars: Record<string, string>) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !CONFIG.includes(k))), ...vars })
const run = (file: string, vars: Record<string, string>) => spawnSync(process.execPath, [file], { env: env(vars), encoding: 'utf8', timeout: 15_000 })

test('em produção, recusa SESSION_SECRET curto sem mostrar o valor e sem criar o banco', () => {
  const dir = tmp()
  const r = run(SERVER, { NODE_ENV: 'production', SESSION_SECRET: 'curto-demais-0123', DATA_DIR: dir })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /SESSION_SECRET ausente ou com menos de 32 caracteres/)
  assert.ok(!`${r.stdout}${r.stderr}`.includes('curto-demais-0123'))
  assert.equal(existsSync(join(dir, 'deck.db')), false)
})

test('recusa porta e limite de upload que não são números maiores que zero', () => {
  const r = run(SERVER, { DATA_DIR: tmp(), PORT: 'abc', MAX_UPLOAD_MB: '' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /PORT precisa ser um número maior que zero/)
  assert.match(r.stderr, /MAX_UPLOAD_MB precisa ser um número maior que zero/)
})

test('com configuração válida sobe, avisa do PUBLIC_URL em http e responde sem mostrar o segredo', async () => {
  const port = 43_000 + Math.floor(Math.random() * 2000)
  const vars = { NODE_ENV: 'production', SESSION_SECRET: SECRET, DATA_DIR: tmp(), PORT: String(port), PUBLIC_URL: 'http://192.168.0.10' }
  const child = spawn(process.execPath, [SERVER], { env: env(vars), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve)
      child.once('exit', (code) => reject(new Error(`o servidor saiu (${code}): ${stderr}`)))
    })
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { needsSetup: boolean }).needsSetup, true)
    assert.match(stderr, /PUBLIC_URL usa http:\/\//)
    assert.ok(!stderr.includes(SECRET))
  } finally {
    child.kill()
  }
})
