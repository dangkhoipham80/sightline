import type { SightlineDatabase } from './database.js'

export interface ProjectRow {
  id: string
  gitRoot: string | null
  realCwd: string
  folderKeys: string[]
  displayName: string
  repoUrl: string | null
  hostKind: string
  distro: string | null
  firstSeen: string | null
  lastActive: string | null
  orphaned: boolean
  archived: boolean
  sessionCount: number
  messageCount: number
}

export interface SessionRow {
  id: string
  projectId: string
  parentSessionId: string | null
  /**
   * Where the transcript lives. The index stores summaries, not message bodies — a viewer
   * re-reads the file. Keeping the path on the row is what makes that possible without a
   * second lookup, and it is the only pointer back to the source of truth.
   */
  filePath: string
  title: string | null
  slug: string | null
  gitBranch: string | null
  cwd: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  messageCount: number
  userMessageCount: number
  toolCallCount: number
  subagentCount: number
  models: string[]
  tokensIn: number
  tokensOut: number
}

export interface SearchHit {
  sessionId: string
  messageUuid: string
  kind: string
  ts: string | null
  projectId: string
  projectName: string
  /** FTS5 snippet with matches wrapped in the markers passed to `search`. */
  snippet: string
  rank: number
}

export function listProjects(
  db: SightlineDatabase,
  options: { includeArchived?: boolean } = {},
): ProjectRow[] {
  const rows = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
              (SELECT COALESCE(SUM(s.message_count), 0) FROM sessions s WHERE s.project_id = p.id) AS message_count
         FROM projects p
        WHERE (@includeArchived = 1 OR p.archived = 0)
        ORDER BY p.last_active DESC NULLS LAST, p.display_name ASC`,
    )
    .all({ includeArchived: options.includeArchived === true ? 1 : 0 })

  return rows.map(toProjectRow)
}

export function listSessions(
  db: SightlineDatabase,
  options: { projectId?: string; limit?: number; since?: string } = {},
): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
        WHERE (@projectId IS NULL OR project_id = @projectId)
          AND (@since IS NULL OR ended_at >= @since)
        ORDER BY started_at DESC NULLS LAST
        LIMIT @limit`,
    )
    .all({
      projectId: options.projectId ?? null,
      since: options.since ?? null,
      limit: options.limit ?? 200,
    })

  return rows.map(toSessionRow)
}

/** One session by id. Undefined rather than throwing — a stale link is not an error. */
export function getSession(db: SightlineDatabase, sessionId: string): SessionRow | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
  return row === undefined ? undefined : toSessionRow(row)
}

/**
 * The sessions that continue this one, oldest first.
 *
 * A `--resume` or a post-compaction restart writes a **new** file that carries the old
 * session's id in its first record. Without following the link in both directions, one
 * continuous stretch of work reads as several unrelated sessions that each stop mid-thought.
 */
export function listContinuations(db: SightlineDatabase, sessionId: string): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
        WHERE parent_session_id = ?
        ORDER BY started_at ASC NULLS LAST`,
    )
    .all(sessionId)

  return rows.map(toSessionRow)
}

/**
 * Full-text search across message text.
 *
 * `bm25()` returns a *lower is better* score, so it is negated into a conventional rank.
 * The query is passed to FTS5 verbatim, which means users get `AND`/`OR`/`NEAR` and
 * quoted phrases for free — but also means a stray unbalanced quote is a syntax error
 * rather than a literal. Callers should sanitise input from a search box.
 */
export function search(
  db: SightlineDatabase,
  query: string,
  options: { projectId?: string; limit?: number; markers?: [string, string] } = {},
): SearchHit[] {
  const [open, close] = options.markers ?? ['«', '»']

  const rows = db
    .prepare(
      `SELECT m.uuid          AS message_uuid,
              m.session_id    AS session_id,
              m.kind          AS kind,
              m.ts            AS ts,
              s.project_id    AS project_id,
              p.display_name  AS project_name,
              snippet(messages_fts, 0, @open, @close, '…', 24) AS snippet,
              -bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
        WHERE messages_fts MATCH @query
          AND (@projectId IS NULL OR s.project_id = @projectId)
        ORDER BY rank DESC
        LIMIT @limit`,
    )
    .all({
      query,
      open,
      close,
      projectId: options.projectId ?? null,
      limit: options.limit ?? 50,
    })

  return rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      sessionId: String(r['session_id']),
      messageUuid: String(r['message_uuid']),
      kind: String(r['kind']),
      ts: (r['ts'] as string | null) ?? null,
      projectId: String(r['project_id']),
      projectName: String(r['project_name']),
      snippet: String(r['snippet']),
      rank: Number(r['rank']),
    }
  })
}

/** Files a project has touched, most-recently-active first. Powers the change heatmap. */
export function listFileTouches(
  db: SightlineDatabase,
  projectId: string,
  limit = 100,
): Array<{ path: string; op: string; count: number; sessions: number }> {
  const rows = db
    .prepare(
      `SELECT path, op, SUM(count) AS count, COUNT(DISTINCT session_id) AS sessions
         FROM file_touches
        WHERE project_id = ?
        GROUP BY path, op
        ORDER BY count DESC
        LIMIT ?`,
    )
    .all(projectId, limit)

  return rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      path: String(r['path']),
      op: String(r['op']),
      count: Number(r['count']),
      sessions: Number(r['sessions']),
    }
  })
}

/**
 * The stored file signature, used to decide whether a transcript needs re-reading.
 * Returns undefined for a session we have never seen.
 */
export function getSessionSignature(
  db: SightlineDatabase,
  sessionId: string,
): { fileSize: number; fileMtimeMs: number } | undefined {
  const row = db
    .prepare('SELECT file_size, file_mtime_ms FROM sessions WHERE id = ?')
    .get(sessionId) as { file_size: number; file_mtime_ms: number } | undefined

  if (row === undefined) return undefined
  return { fileSize: row.file_size, fileMtimeMs: row.file_mtime_ms }
}

function toProjectRow(row: unknown): ProjectRow {
  const r = row as Record<string, unknown>
  return {
    id: String(r['id']),
    gitRoot: (r['git_root'] as string | null) ?? null,
    realCwd: String(r['real_cwd']),
    folderKeys: parseJsonArray(r['folder_keys']),
    displayName: String(r['display_name']),
    repoUrl: (r['repo_url'] as string | null) ?? null,
    hostKind: String(r['host_kind']),
    distro: (r['distro'] as string | null) ?? null,
    firstSeen: (r['first_seen'] as string | null) ?? null,
    lastActive: (r['last_active'] as string | null) ?? null,
    orphaned: r['orphaned'] === 1,
    archived: r['archived'] === 1,
    sessionCount: Number(r['session_count'] ?? 0),
    messageCount: Number(r['message_count'] ?? 0),
  }
}

function toSessionRow(row: unknown): SessionRow {
  const r = row as Record<string, unknown>
  return {
    id: String(r['id']),
    projectId: String(r['project_id']),
    parentSessionId: (r['parent_session_id'] as string | null) ?? null,
    filePath: String(r['file_path']),
    // `ai-title` is Claude's own name for the session and is usually good. Falling back
    // to the slug beats inventing something, and beats showing a bare uuid.
    title: (r['ai_title'] as string | null) ?? (r['slug'] as string | null) ?? null,
    slug: (r['slug'] as string | null) ?? null,
    gitBranch: (r['git_branch'] as string | null) ?? null,
    cwd: (r['cwd'] as string | null) ?? null,
    startedAt: (r['started_at'] as string | null) ?? null,
    endedAt: (r['ended_at'] as string | null) ?? null,
    durationMs: (r['duration_ms'] as number | null) ?? null,
    messageCount: Number(r['message_count'] ?? 0),
    userMessageCount: Number(r['user_message_count'] ?? 0),
    toolCallCount: Number(r['tool_call_count'] ?? 0),
    subagentCount: Number(r['subagent_count'] ?? 0),
    models: parseJsonArray(r['models']),
    tokensIn: Number(r['tokens_in'] ?? 0),
    tokensOut: Number(r['tokens_out'] ?? 0),
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}
