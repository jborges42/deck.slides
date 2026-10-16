// Suíte contra Postgres: com PG_TEST_URL (postgres://.../postgres de um servidor de teste), cada arquivo de teste
// ganha um banco novo nesse servidor. Rodar com `PG_TEST_URL=... pnpm test:pg`.
import { randomBytes } from 'node:crypto'

/**
 * Cria um banco vazio e devolve o endereço dele; sem PG_TEST_URL, undefined (a suíte usa SQLite).
 * O banco imita um projeto Supabase com "Automatically expose new tables" ligado: os papéis da Data API
 * (anon, authenticated) recebem tudo nas tabelas novas, e o app precisa fechar o acesso sozinho.
 */
export async function freshPgDatabase(): Promise<string | undefined> {
  const server = process.env.PG_TEST_URL
  if (!server) return undefined
  const { default: postgres } = await import('postgres')
  const name = `deck_test_${randomBytes(6).toString('hex')}`
  const admin = postgres(server, { max: 1, onnotice: () => {} })
  for (const role of ['anon', 'authenticated'])
    await admin.unsafe(`CREATE ROLE ${role} NOLOGIN`).catch(() => {}) // papéis valem para o servidor todo; já pode existir
  await admin.unsafe(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(server)
  url.pathname = `/${name}`
  const db = postgres(url.href, { max: 1, onnotice: () => {} })
  await db.unsafe(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
  `).simple()
  await db.end()
  return url.href
}
