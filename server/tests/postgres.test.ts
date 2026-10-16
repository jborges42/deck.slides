// O que é próprio do Postgres (Supabase). Só roda com PG_TEST_URL (`pnpm test:pg`).
import { test } from 'node:test'
import assert from 'node:assert/strict'

const skip = !process.env.PG_TEST_URL && 'sem PG_TEST_URL'
const { asModerator } = await import('./helpers.ts')
const { all, dialect } = await import('../db.ts')

test('Supabase: toda tabela do app tem RLS e nenhum privilégio para anon/authenticated (Data API fechada)', { skip }, async () => {
  assert.equal(dialect, 'postgres')
  await asModerator() // grava dados: uma tabela fechada continua fechada com linhas dentro
  const tables = await all<{ relname: string; relrowsecurity: boolean }>(
    "SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY relname",
  )
  assert.ok(tables.length >= 14)
  assert.deepEqual(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname), [])
  // O banco de teste concede tudo às tabelas novas, como o "expor tabelas novas" do painel.
  const open = await all<{ grantee: string; table_name: string; privilege_type: string }>(
    `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`,
  )
  assert.deepEqual(open, [])
})

test('Postgres: horários em ms e contagens voltam como número, como no SQLite', { skip }, async () => {
  const [row] = await all<{ now: number; n: number }>('SELECT CAST(? AS BIGINT) AS now, COUNT(*) AS n FROM moderators', Date.now())
  assert.equal(typeof row!.now, 'number')
  assert.equal(typeof row!.n, 'number')
})
