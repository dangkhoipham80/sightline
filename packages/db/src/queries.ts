import type { LaunchStore } from '@sightline/core'
import { parseLaunchStore } from '@sightline/core'
import type { SightlineDatabase } from './database.js'
import { toMatchQuery } from './search-query.js'

export interface ProjectRow {
  id: string
  gitRoot: string | null
  realCwd: string
  folderKeys: string[]
  displayName: string
  repoUrl: string | null
  hostKind: string
  distro: string | null
  /**
   * Which `~/.claude` this project's most recent session came from — and so where a
   * terminal for it opens, and which group it belongs to in the sidebar.
   *
   * Distinct from `hostKind`, which describes the *shape of the path* and answers a
   * different question. They disagree for a Windows `claude` run with a UNC working
   * directory, which is four of seventeen projects on the reference machine. Grouping the
   * sidebar on `hostKind` would file those under Linux and open the wrong shell.
   *
   * Null for a project with no session carrying a store — an index that predates the
   * re-ingest, in practice.
   */
  store: LaunchStore | null
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
  /**
   * Which `~/.claude` holds this transcript, and so which `claude` can resume it.
   *
   * Null when the row predates the store columns — the resume command is then unknowable
   * rather than guessable, and saying nothing beats emitting a command that runs somewhere
   * else and reports success. See ADR 0005.
   */
  store: LaunchStore | null
  /** That store's root directory: where this session's live registry lives. */
  storeRoot: string | null
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
  /** Position in the session, so a hit can be ordered and anchored inside the transcript. */
  seq: number
  projectId: string
  projectName: string
  sessionTitle: string | null
  /** The hit is inside a subagent's transcript, not the main thread. Worth saying so. */
  isSidechain: boolean
  /** FTS5 snippet with matches wrapped in the markers passed to `search`. */
  snippet: string
  rank: number
}

export interface SearchOptions {
  projectId?: string
  sessionId?: string
  limit?: number
  offset?: number
  markers?: [string, string]
  /** Complete the final term, for search-as-you-type. See `toMatchQuery`. */
  prefixLastTerm?: boolean
}

export function listProjects(
  db: SightlineDatabase,
  options: { includeArchived?: boolean } = {},
): ProjectRow[] {
  const rows = db
    .prepare(
      // The store is *derived* here rather than denormalised onto `projects`. A project
      // can hold sessions from two stores at once, and a column would be written by
      // whichever session happened to be ingested last — stale, and silently so. The
      // window function picks the newest session's store, which is the one a "resume this
      // project" action should honour.
      `SELECT p.*,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count,
              (SELECT COALESCE(SUM(s.message_count), 0) FROM sessions s WHERE s.project_id = p.id) AS message_count,
              latest.store_kind   AS store_kind,
              latest.store_distro AS store_distro
         FROM projects p
         LEFT JOIN (
           SELECT project_id, store_kind, store_distro,
                  ROW_NUMBER() OVER (
                    PARTITION BY project_id
                    ORDER BY started_at DESC NULLS LAST, rowid DESC
                  ) AS rn
             FROM sessions
            WHERE store_kind IS NOT NULL
         ) latest ON latest.project_id = p.id AND latest.rn = 1
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
 * `query` is whatever the user typed. It goes through `toMatchQuery` rather than reaching
 * FTS5 directly — passing a search box straight to `MATCH` turns `c++` into a syntax error
 * and `a-b` into "no such column: b". An empty result from an unsearchable query is not an
 * error, so this returns `[]` rather than raising.
 *
 * `bm25()` returns a *lower is better* score, negated here into a conventional rank.
 */
export function search(
  db: SightlineDatabase,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const [open, close] = options.markers ?? ['«', '»']
  const match = toMatchQuery(query, {
    ...(options.prefixLastTerm !== undefined && { prefixLastTerm: options.prefixLastTerm }),
  })
  if (match === undefined) return []

  const rows = db
    .prepare(
      `SELECT m.uuid          AS message_uuid,
              m.session_id    AS session_id,
              m.kind          AS kind,
              m.ts            AS ts,
              m.seq           AS seq,
              m.is_sidechain  AS is_sidechain,
              s.project_id    AS project_id,
              p.display_name  AS project_name,
              COALESCE(s.ai_title, s.slug) AS session_title,
              snippet(messages_fts, 0, @open, @close, '…', 24) AS snippet,
              -bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
        WHERE messages_fts MATCH @query
          AND (@projectId IS NULL OR s.project_id = @projectId)
          AND (@sessionId IS NULL OR m.session_id = @sessionId)
        ORDER BY rank DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({
      query: match,
      open,
      close,
      projectId: options.projectId ?? null,
      sessionId: options.sessionId ?? null,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    })

  return rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      sessionId: String(r['session_id']),
      messageUuid: String(r['message_uuid']),
      kind: String(r['kind']),
      ts: (r['ts'] as string | null) ?? null,
      seq: Number(r['seq'] ?? 0),
      projectId: String(r['project_id']),
      projectName: String(r['project_name']),
      sessionTitle: (r['session_title'] as string | null) ?? null,
      isSidechain: r['is_sidechain'] === 1,
      snippet: String(r['snippet']),
      rank: Number(r['rank']),
    }
  })
}

/**
 * How many messages a query matches, for "showing 50 of 812".
 *
 * A separate count query rather than a window function over the page: bm25 ranking makes
 * the paged query non-trivial, and a bare `COUNT(*)` over the FTS index is the cheap half.
 */
export function countSearchResults(
  db: SightlineDatabase,
  query: string,
  options: Pick<SearchOptions, 'projectId' | 'sessionId' | 'prefixLastTerm'> = {},
): number {
  const match = toMatchQuery(query, {
    ...(options.prefixLastTerm !== undefined && { prefixLastTerm: options.prefixLastTerm }),
  })
  if (match === undefined) return 0

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH @query
          AND (@projectId IS NULL OR s.project_id = @projectId)
          AND (@sessionId IS NULL OR m.session_id = @sessionId)`,
    )
    .get({
      query: match,
      projectId: options.projectId ?? null,
      sessionId: options.sessionId ?? null,
    }) as { n: number }

  return row.n
}

/**
 * Sessions whose *title* matches, for navigating rather than searching.
 *
 * Half of what a command palette is for is "take me to that thing I know the name of",
 * and full-text over message bodies answers that badly — the session you want is buried
 * under every message that happens to mention the word. This is a plain prefix/substring
 * match over titles, kept separate so the palette can show it first.
 */
export function findSessionsByTitle(
  db: SightlineDatabase,
  query: string,
  options: { projectId?: string; limit?: number } = {},
): SessionRow[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  // LIKE, not FTS: titles are short, the corpus of them is small, and a user typing part
  // of a title wants a substring match rather than a stemmed token match.
  const pattern = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

  const rows = db
    .prepare(
      `SELECT * FROM sessions
        WHERE (@projectId IS NULL OR project_id = @projectId)
          AND (ai_title LIKE @pattern ESCAPE '\\' OR slug LIKE @pattern ESCAPE '\\')
        ORDER BY started_at DESC NULLS LAST
        LIMIT @limit`,
    )
    .all({ pattern, projectId: options.projectId ?? null, limit: options.limit ?? 10 })

  return rows.map(toSessionRow)
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
    store:
      parseLaunchStore(r['store_kind'] as string | null, r['store_distro'] as string | null) ??
      null,
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
    store:
      parseLaunchStore(r['store_kind'] as string | null, r['store_distro'] as string | null) ??
      null,
    storeRoot: (r['store_root'] as string | null) ?? null,
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
