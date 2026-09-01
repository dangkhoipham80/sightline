import type { TokenEvent } from '@sightline/core'
import type { SightlineDatabase } from './database.js'

export interface TokenEventQuery {
  /** ISO timestamp; events at or after this are returned. */
  since: string
  projectId?: string
}

/**
 * Every token event since `since`, **deduplicated across sessions**.
 *
 * The dedupe belongs here rather than in the table's constraints. `token_events` is unique
 * on `(session_id, dedupe_key)` so that two sessions can each hold their own copy of a
 * response that genuinely appears in both transcripts — resuming a session copies earlier
 * turns forward, and 476 responses on the reference machine live in two files at once. A
 * global unique constraint would instead let one session own the row and then delete it on
 * that session's next re-ingest, taking spend the other session still accounts for with it.
 *
 * `MIN(session_id)` picks a stable winner so the same response is attributed to the same
 * session between calls; the usage numbers are identical either way, since it is the same
 * API response.
 */
export function listTokenEvents(db: SightlineDatabase, query: TokenEventQuery): TokenEvent[] {
  const where = ['te.ts IS NOT NULL', 'te.ts >= @since']
  if (query.projectId !== undefined) where.push('s.project_id = @projectId')

  const rows = db
    .prepare(
      `SELECT te.dedupe_key                AS dedupe_key,
              MIN(te.ts)                   AS ts,
              MIN(te.model)                AS model,
              MIN(te.agent_id)             AS agent_id,
              MAX(te.input_tokens)         AS input_tokens,
              MAX(te.output_tokens)        AS output_tokens,
              MAX(te.cache_read_tokens)    AS cache_read_tokens,
              MAX(te.cache_write_5m_tokens) AS cache_write_5m_tokens,
              MAX(te.cache_write_1h_tokens) AS cache_write_1h_tokens
         FROM token_events te
         JOIN sessions s ON s.id = te.session_id
        WHERE ${where.join(' AND ')}
        GROUP BY te.dedupe_key
        ORDER BY ts ASC`,
    )
    .all({
      since: query.since,
      ...(query.projectId !== undefined && { projectId: query.projectId }),
    }) as Array<Record<string, unknown>>

  return rows.map((r) => ({
    dedupeKey: String(r['dedupe_key']),
    ...(r['ts'] !== null && { timestamp: String(r['ts']) }),
    ...(r['model'] !== null && { model: String(r['model']) }),
    ...(r['agent_id'] !== null && { agentId: String(r['agent_id']) }),
    usage: {
      inputTokens: Number(r['input_tokens'] ?? 0),
      outputTokens: Number(r['output_tokens'] ?? 0),
      cacheReadTokens: Number(r['cache_read_tokens'] ?? 0),
      cacheCreationTokens:
        Number(r['cache_write_5m_tokens'] ?? 0) + Number(r['cache_write_1h_tokens'] ?? 0),
      cacheCreation5mTokens: Number(r['cache_write_5m_tokens'] ?? 0),
      cacheCreation1hTokens: Number(r['cache_write_1h_tokens'] ?? 0),
    },
  }))
}

/** Whether the index holds any token events at all — the difference between 0 and "—". */
export function hasTokenEvents(db: SightlineDatabase): boolean {
  const row = db.prepare('SELECT 1 AS present FROM token_events LIMIT 1').get() as
    | { present: number }
    | undefined
  return row !== undefined
}
