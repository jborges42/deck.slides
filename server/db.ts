import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

export const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
export const UPLOADS_DIR = join(DATA_DIR, 'uploads')
mkdirSync(UPLOADS_DIR, { recursive: true })

export const db = new DatabaseSync(process.env.DB_PATH ?? join(DATA_DIR, 'deck.db'), { timeout: 5000 })

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS moderators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL,
    session_epoch INTEGER NOT NULL DEFAULT 0, -- ms; sessões emitidas antes disto são inválidas
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, -- código curto e legível (newCode), usado nas URLs
    name TEXT NOT NULL,
    pin TEXT NOT NULL,
    settings TEXT NOT NULL,
    theme TEXT NOT NULL,
    live TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    grp TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'invite',
    blocked INTEGER NOT NULL DEFAULT 0,
    session_epoch INTEGER NOT NULL DEFAULT 0, -- ms; novo link de convite invalida sessões anteriores
    joined_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS participants_event ON participants(event_id);

  -- Telas pareadas por código: o segredo fica num cookie do computador da projeção; aqui, só o hash.
  CREATE TABLE IF NOT EXISTS screens (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE INDEX IF NOT EXISTS screens_event ON screens(event_id);

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS scenes_event ON scenes(event_id, position);

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
    author TEXT NOT NULL,
    anonymous INTEGER NOT NULL DEFAULT 0,
    original TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    screen INTEGER,
    flagged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS questions_event ON questions(event_id, created_at);
  CREATE INDEX IF NOT EXISTS questions_participant ON questions(participant_id);

  CREATE TABLE IF NOT EXISTS likes (
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    PRIMARY KEY (question_id, participant_id)
  );
  CREATE INDEX IF NOT EXISTS likes_participant ON likes(participant_id);

  CREATE TABLE IF NOT EXISTS reactions (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    scene_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (event_id, scene_id, kind)
  );

  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_event ON media(event_id);
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

/** Identificador aleatório url-safe. 9 bytes = 12 chars; tokens de convite usam 18. */
export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url')

// Alfabeto Crockford sem I, L, O, U: legível em voz alta e na tela, sem confusão entre 0/O e 1/I.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Código curto e legível (ex.: "K7QX2M"). 6 caracteres = ~1 bilhão de combinações. */
export function newCode(length = 6): string {
  return Array.from(randomBytes(length), (b) => CODE_ALPHABET[b % 32]).join('')
}

/** Normaliza um código digitado: maiúsculas, sem espaços/hífens, O->0 e I/L->1 (como o Crockford prevê). */
export const normalizeCode = (s: string) =>
  s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')

/** PIN numérico de 6 dígitos. */
export const newPin = () => String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0')

export function metaValue(key: string, create: () => string): string {
  const row = get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
  if (row) return row.value
  const value = create()
  run('INSERT INTO meta (key, value) VALUES (?, ?)', key, value)
  return value
}

/** Hash para guardar segredos de alta entropia (tokens de tela) sem guardar o segredo em si. */
export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')
