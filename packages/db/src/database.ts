import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SIGHTLINE_SCHEMA_VERSION } from '@sightline/core'
import Database from 'better-sqlite3'
import { MIGRATIONS } from './schema.js'

export type SightlineDatabase = Database.Database

/**
 * Where the index lives: `~/.sightline/index.db`.
 *
 * Deliberately not under `~/.claude`. That directory is read-only to Sightline, and an
 * index written inside it would be both a rule violation and a landmine for Claude Code's
 * own 30-day cleanup.
 */
export function defaultIndexPath(): string {
  return join(homedir(), '.sightline', 'index.db')
}

export interface OpenOptions {
  /** Path to the SQLite file, or `:memory:` for tests. */
  path: string
  readonly?: boolean
}

/**
 * Open the index, applying any outstanding migrations and re-ingesting if the derived
 * shape changed.
 *
 * Pragmas are set deliberately:
 * - `journal_mode = WAL` so a running `sightline serve` can read while a scan writes.
 * - `synchronous = NORMAL` because the database is a derived index. Losing the last
 *   transaction to a power cut costs one re-scan, and re-scanning is measured in seconds.
 * - `foreign_keys = ON` so deleting a session actually removes its rows.
 */
export function openDatabase(options: OpenOptions): SightlineDatabase {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })

  const db = new Database(options.path, { readonly: options.readonly ?? false })

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  if (options.readonly !== true) migrate(db)
  return db
}

export function migrate(db: SightlineDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(
    db
      .prepare('SELECT id FROM migrations')
      .all()
      .map((row) => (row as { id: string }).id),
  )

  const record = db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)')

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      record.run(migration.id, new Date().toISOString())
    })()
  }

  // A schema-version bump means existing rows are *wrong*, not merely incomplete: some
  // column now means something it did not mean when they were written. DDL cannot fix
  // that, so the rows go and the next scan rebuilds them from the JSONL — seconds, on a
  // corpus this size. Read after migrating, so the new shape exists to be emptied.
  //
  // Undefined is a fresh database, which has nothing to discard.
  const stored = getMeta(db, 'schema_version')
  if (stored !== undefined && stored !== String(SIGHTLINE_SCHEMA_VERSION)) {
    resetDerivedTables(db)
  }

  setMeta(db, 'schema_version', String(SIGHTLINE_SCHEMA_VERSION))
}

export function getMeta(db: SightlineDatabase, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setMeta(db: SightlineDatabase, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

/**
 * Drop every derived row, keeping the schema.
 *
 * Used when `SIGHTLINE_SCHEMA_VERSION` changes: rather than migrating rows whose
 * *meaning* changed, throw them away and re-ingest. The tables holding work that cost
 * tokens or human attention — summaries, notes, edited decisions — do not exist yet, and
 * when they do they must be excluded here.
 */
export function resetDerivedTables(db: SightlineDatabase): void {
  db.transaction(() => {
    // Order matters only for readability; foreign keys cascade from sessions.
    db.exec(`
      DELETE FROM token_events;
      DELETE FROM artifacts;
      DELETE FROM file_touches;
      DELETE FROM subagents;
      DELETE FROM tool_calls;
      DELETE FROM messages;
      DELETE FROM sessions;
      DELETE FROM projects;
    `)
    // External-content FTS keeps its own copy of the index; deleting rows via the
    // triggers is enough, but a rebuild guarantees no orphaned postings survive.
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`)
  })()
}
