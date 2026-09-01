import { beforeEach, describe, expect, it } from 'vitest'
import type { SightlineDatabase } from './database.js'
import { openDatabase } from './database.js'
import { listTokenEvents } from './usage-queries.js'

let db: SightlineDatabase

beforeEach(() => {
  db = openDatabase({ path: ':memory:' })
  db.prepare(
    `INSERT INTO projects (id, real_cwd, display_name, host_kind) VALUES ('p', '/p', 'p', 'unix')`,
  ).run()
  for (const id of ['s1', 's2']) {
    db.prepare(
      `INSERT INTO sessions (id, project_id, file_path) VALUES (?, 'p', '/p/' || ? || '.jsonl')`,
    ).run(id, id)
  }
})

function insert(sessionId: string, dedupeKey: string, ts: string, input = 100): void {
  db.prepare(
    `INSERT INTO token_events (session_id, dedupe_key, ts, model, input_tokens, output_tokens,
                               cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
     VALUES (?, ?, ?, 'claude-opus-5', ?, 10, 20, 30, 40)`,
  ).run(sessionId, dedupeKey, ts, input)
}

describe('token_events', () => {
  /**
   * The constraint is `(session_id, dedupe_key)` and **not** `dedupe_key` alone. Resuming a
   * session copies earlier turns into the new file, so the same API response genuinely lives
   * in two transcripts — 476 of them on the reference machine. A global unique would let one
   * session own the row and then destroy it on that session's next re-ingest, taking spend
   * the other session still accounts for.
   */
  it('lets two sessions each hold the same API response', () => {
    insert('s1', 'msg_01', '2026-09-01T10:00:00.000Z')
    expect(() => insert('s2', 'msg_01', '2026-09-01T10:00:00.000Z')).not.toThrow()

    const stored = db.prepare('SELECT COUNT(*) AS n FROM token_events').get() as { n: number }
    expect(stored.n).toBe(2)
  })

  it('still refuses the same response twice within one session', () => {
    insert('s1', 'msg_01', '2026-09-01T10:00:00.000Z')
    const before = db.prepare('SELECT COUNT(*) AS n FROM token_events').get() as { n: number }
    // The writer uses ON CONFLICT DO NOTHING; the constraint is what makes that a no-op.
    db.prepare(
      `INSERT INTO token_events (session_id, dedupe_key, ts) VALUES ('s1', 'msg_01', 'x')
       ON CONFLICT(session_id, dedupe_key) DO NOTHING`,
    ).run()
    const after = db.prepare('SELECT COUNT(*) AS n FROM token_events').get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  /**
   * This is the other half of the same decision: because the table stores both copies, the
   * query has to collapse them, or every resumed session double-bills.
   */
  it('counts a response held by two sessions exactly once', () => {
    insert('s1', 'msg_01', '2026-09-01T10:00:00.000Z')
    insert('s2', 'msg_01', '2026-09-01T10:00:00.000Z')
    insert('s2', 'msg_02', '2026-09-01T10:05:00.000Z')

    const events = listTokenEvents(db, { since: '2026-09-01T00:00:00.000Z' })
    expect(events.map((e) => e.dedupeKey).sort()).toEqual(['msg_01', 'msg_02'])
    expect(events.reduce((n, e) => n + e.usage.inputTokens, 0)).toBe(200)
  })

  it('deletes a session’s events with the session', () => {
    insert('s1', 'msg_01', '2026-09-01T10:00:00.000Z')
    insert('s2', 'msg_01', '2026-09-01T10:00:00.000Z')

    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')

    // s2's copy survives, which is the whole point of the per-session key.
    const events = listTokenEvents(db, { since: '2026-09-01T00:00:00.000Z' })
    expect(events).toHaveLength(1)
    expect(events[0]?.usage.inputTokens).toBe(100)
  })

  it('excludes events older than the window and events with no timestamp', () => {
    insert('s1', 'old', '2026-08-01T10:00:00.000Z')
    insert('s1', 'recent', '2026-09-01T10:00:00.000Z')
    db.prepare(`INSERT INTO token_events (session_id, dedupe_key) VALUES ('s1', 'undated')`).run()

    const events = listTokenEvents(db, { since: '2026-09-01T00:00:00.000Z' })
    expect(events.map((e) => e.dedupeKey)).toEqual(['recent'])
  })

  it('reconstructs the cache split and the total that follows from it', () => {
    insert('s1', 'msg_01', '2026-09-01T10:00:00.000Z')
    const event = listTokenEvents(db, { since: '2026-09-01T00:00:00.000Z' })[0]
    expect(event?.usage.cacheCreation5mTokens).toBe(30)
    expect(event?.usage.cacheCreation1hTokens).toBe(40)
    expect(event?.usage.cacheCreationTokens).toBe(70)
  })
})
