// Banco, com o mesmo código para três destinos:
// - DATABASE_URL (postgres://): Postgres, como o Supabase (na Vercel, pelo Transaction pooler, porta 6543);
// - TURSO_DATABASE_URL: Turso (libSQL por HTTP);
// - nenhum dos dois: arquivo SQLite em DATA_DIR/deck.db (desenvolvimento, testes e servidor próprio).
// O SQL é escrito para valer no SQLite e no Postgres; no Postgres, cada `?` vira $1, $2...
import type { Transaction as LibsqlTransaction } from '@libsql/client'
import type { TransactionSql } from 'postgres'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { schema, type Dialect } from './schema.ts'

export { newCode, newId, newPin, normalizeCode, sha256 } from './ids.ts'

export const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
export const UPLOADS_DIR = join(DATA_DIR, 'uploads')

type Value = string | number | bigint | null
export interface Statement {
  sql: string
  args: Value[]
}

interface Driver {
  exec(sql: string, args: Value[]): Promise<{ rows: unknown[]; changes: number }>
  batch(stmts: Statement[]): Promise<void>
  tx<T>(fn: () => Promise<T>): Promise<T>
}

const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL // POSTGRES_URL: nome usado pela integração Supabase/Vercel
const tursoUrl = process.env.TURSO_DATABASE_URL
export const dialect: Dialect = pgUrl ? 'postgres' : 'sqlite'
if (!process.env.VERCEL) mkdirSync(UPLOADS_DIR, { recursive: true }) // na Vercel o disco é só leitura (mídia vai para o Blob)

const driver = pgUrl ? await postgresDriver(pgUrl) : await libsqlDriver()

export const all = async <T>(sql: string, ...args: Value[]) => (await driver.exec(sql, args)).rows as T[]
export const get = async <T>(sql: string, ...args: Value[]) => (await driver.exec(sql, args)).rows[0] as T | undefined
export const run = async (sql: string, ...args: Value[]) => ({ changes: (await driver.exec(sql, args)).changes })

/** Vários comandos numa ida só ao banco, atômicos. Dentro de tx(), entram na mesma transação. */
export const batch = (stmts: Statement[]) => (stmts.length ? driver.batch(stmts) : Promise.resolve())

/**
 * Transação com o isolamento do SQLite (serializável): ler e depois gravar não perde a escrita de outra
 * requisição. No Postgres, um conflito refaz a função inteira, então ela só deve mexer no banco.
 * Cada consulta é uma ida ao banco: laços grandes vão em batch().
 */
export const tx = <T>(fn: () => Promise<T>) => driver.tx(fn)

/** Valor fixo guardado no banco, criado na primeira leitura. Instâncias simultâneas ficam com o mesmo. */
export async function metaValue(key: string, create: () => string): Promise<string> {
  await run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING', key, create())
  return (await get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key))!.value
}

// ---------- SQLite e Turso ----------

async function libsqlDriver(): Promise<Driver> {
  const { createClient } = await import('@libsql/client')
  const client = tursoUrl
    ? createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN })
    : createClient({ url: pathToFileURL(process.env.DB_PATH ?? join(DATA_DIR, 'deck.db')).href, timeout: 5000 })

  // WAL só faz sentido no arquivo local. Dois processos abrindo um arquivo novo juntos: a troca para WAL
  // não espera o busy timeout, então tenta de novo por até 2 s.
  for (let i = 0; ; i++) {
    try {
      await client.executeMultiple(tursoUrl ? schema('sqlite') : `PRAGMA journal_mode = WAL; ${schema('sqlite')}`)
      break
    } catch (e) {
      if (i >= 40 || !/SQLITE_BUSY/.test(String(e))) throw e
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  // Bancos criados antes do Vercel Blob não têm a coluna. Duas instâncias subindo juntas podem tentar as duas.
  if (!(await client.execute('PRAGMA table_info(media)')).rows.some((c) => c.name === 'blob_url'))
    await client.execute('ALTER TABLE media ADD COLUMN blob_url TEXT').catch((e: Error) => {
      if (!/duplicate column/i.test(e.message)) throw e
    })

  // Dentro de tx(), as consultas vão para a transação aberta, sem precisar passá-la de função em função.
  const current = new AsyncLocalStorage<LibsqlTransaction>()
  return {
    async exec(sql, args) {
      const r = await (current.getStore() ?? client).execute({ sql, args })
      return { rows: r.rows, changes: r.rowsAffected }
    },
    async batch(stmts) {
      const t = current.getStore()
      await (t ? t.batch(stmts) : client.batch(stmts, 'write'))
    },
    async tx(fn) {
      if (current.getStore()) return fn()
      const t = await client.transaction('write') // BEGIN IMMEDIATE: um escritor por vez
      try {
        const out = await current.run(t, fn)
        await t.commit()
        return out
      } finally {
        t.close() // sem commit, desfaz
      }
    },
  }
}

// ---------- Postgres (Supabase) ----------

/** `?` do SQL comum vira $1, $2... (texto entre aspas simples fica como está). */
const numbered = (sql: string) => {
  let i = 0
  return sql.replace(/'[^']*'|\?/g, (m) => (m === '?' ? `$${++i}` : m))
}

async function postgresDriver(raw: string): Promise<Driver> {
  const { default: postgres } = await import('postgres')
  // A integração Supabase/Vercel anexa parâmetros do próprio painel (supa=..., pgbouncer=...) que o driver
  // repassaria ao servidor como configuração desconhecida: só sslmode segue adiante.
  const parsed = new URL(raw)
  for (const key of [...parsed.searchParams.keys()]) if (key !== 'sslmode') parsed.searchParams.delete(key)
  const url = parsed.toString()
  const { hostname, searchParams } = parsed
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  const sql = postgres(url, {
    prepare: false, // o Transaction pooler do Supabase não guarda comandos preparados entre transações
    fetch_types: false,
    max: 5, // cada instância da função abre as suas; o pooler do plano gratuito aceita poucas centenas
    idle_timeout: 20,
    connect_timeout: 10,
    ...(local || searchParams.has('sslmode') ? {} : { ssl: 'require' as const }),
    // BIGINT (horários em ms, COUNT) volta como número, como no SQLite. Cabe com folga em 2^53.
    types: { bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } },
    onnotice: () => {}, // "já existe" do CREATE ... IF NOT EXISTS
  })
  type Transaction = TransactionSql<{ bigint: number }>

  // Duas instâncias subindo juntas: a trava faz uma esperar a outra terminar de criar as tabelas.
  await sql.begin(async (t) => {
    await t.unsafe('SELECT pg_advisory_xact_lock(8217364)')
    await t.unsafe(schema('postgres')).simple()
  })

  const current = new AsyncLocalStorage<Transaction>()
  const query = (s: typeof sql | Transaction, text: string, args: Value[]) => s.unsafe(numbered(text), args as never[])
  return {
    async exec(text, args) {
      const r = await query(current.getStore() ?? sql, text, args)
      return { rows: Array.from(r), changes: r.count } // array comum, não a subclasse Result do driver
    },
    async batch(stmts) {
      // Comandos disparados juntos na mesma conexão seguem em pipeline: uma ida e volta só.
      const send = (t: Transaction) => Promise.all(stmts.map((s) => query(t, s.sql, s.args)))
      const t = current.getStore()
      await (t ? send(t) : sql.begin(send))
    },
    async tx(fn) {
      if (current.getStore()) return fn()
      for (let attempt = 1; ; attempt++) {
        try {
          return (await sql.begin('isolation level serializable', (t) => current.run(t, fn))) as Awaited<ReturnType<typeof fn>>
        } catch (e) {
          // 40001: conflito de serialização; 40P01: deadlock. Refaz com o estado novo.
          if (attempt >= 5 || !['40001', '40P01'].includes((e as { code?: string }).code ?? '')) throw e
        }
      }
    },
  }
}
