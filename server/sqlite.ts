// SQLite síncrono (node:sqlite) usado só por server/security/, que ainda não está ligado às rotas.
// ponytail: só funciona com o arquivo local; ao ligar server/security às rotas, trocar pelas funções assíncronas
// de db.ts (que também falam com o Turso na Vercel).
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { schema } from './schema.ts'

export { newCode, newId, newPin, normalizeCode, sha256 } from './ids.ts'

export const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(process.env.DB_PATH ?? join(DATA_DIR, 'deck.db'), { timeout: 5000 })

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  ${schema('sqlite')}
`)

const cache = new Map<string, StatementSync>()
function stmt(sql: string): StatementSync {
  let s = cache.get(sql)
  if (!s) cache.set(sql, (s = db.prepare(sql)))
  return s
}

export const all = <T>(sql: string, ...params: SQLInputValue[]) => stmt(sql).all(...params) as T[]
export const get = <T>(sql: string, ...params: SQLInputValue[]) => stmt(sql).get(...params) as T | undefined
export const run = (sql: string, ...params: SQLInputValue[]) => stmt(sql).run(...params)

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function metaValue(key: string, create: () => string): string {
  const row = get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
  if (row) return row.value
  const value = create()
  run('INSERT INTO meta (key, value) VALUES (?, ?)', key, value)
  return value
}
