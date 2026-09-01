import type { HostKind, LaunchStore, ParsedSession, TranscriptRecord } from '@sightline/core'
import { hasThinking } from '@sightline/core'
import type { SightlineDatabase } from './database.js'

export interface ProjectInput {
  id: string
  gitRoot?: string | undefined
  realCwd: string
  folderKeys: string[]
  displayName: string
  repoUrl?: string | undefined
  hostKind: HostKind
  distro?: string | undefined
  orphaned: boolean
}

export interface SessionInput {
  projectId: string
  filePath: string
  fileSize: number
  fileMtimeMs: number
  /** Which `~/.claude` the transcript came from — see ADR 0005. Never inferred from `cwd`. */
  store: LaunchStore
  /** That store's root directory. */
  storeRoot: string
  parsed: ParsedSession
}

/**
 * Insert or update a project row.
 *
 * Folder keys **accumulate** rather than replace. A full scan sees every session of a
 * project and could pass the complete set, but the watcher re-indexes one session at a
 * time and only knows that session's key — replacing would shrink a three-folder project
 * to one the moment a single transcript changed. Keys only ever go away on a full rebuild
 * (`resetDerivedTables`), which is the right granularity for something this cheap.
 */
export function upsertProject(db: SightlineDatabase, project: ProjectInput): void {
  const stored = db.prepare('SELECT folder_keys FROM projects WHERE id = ?').get(project.id) as
    | { folder_keys: string }
    | undefined

  const folderKeys = [...new Set([...parseFolderKeys(stored?.folder_keys), ...project.folderKeys])]
  folderKeys.sort()

  db.prepare(
    `INSERT INTO projects (id, git_root, real_cwd, folder_keys, display_name, repo_url,
                           host_kind, distro, orphaned)
     VALUES (@id, @gitRoot, @realCwd, @folderKeys, @displayName, @repoUrl,
             @hostKind, @distro, @orphaned)
     ON CONFLICT(id) DO UPDATE SET
       git_root     = excluded.git_root,
       real_cwd     = excluded.real_cwd,
       folder_keys  = excluded.folder_keys,
       display_name = excluded.display_name,
       repo_url     = COALESCE(excluded.repo_url, projects.repo_url),
       host_kind    = excluded.host_kind,
       distro       = excluded.distro,
       orphaned     = excluded.orphaned`,
  ).run({
    id: project.id,
    gitRoot: project.gitRoot ?? null,
    realCwd: project.realCwd,
    folderKeys: JSON.stringify(folderKeys),
    displayName: project.displayName,
    repoUrl: project.repoUrl ?? null,
    hostKind: project.hostKind,
    distro: project.distro ?? null,
    orphaned: project.orphaned ? 1 : 0,
  })
}

/**
 * Write one session's derived rows, replacing whatever was there.
 *
 * Delete-then-insert rather than a diff. Session aggregates (token totals, file touches,
 * counts) are functions of the *whole* transcript, so a partial update would have to
 * merge partial aggregates for no measurable gain — the full corpus reparses in under two
 * seconds. Correctness is worth more than the microseconds.
 *
 * The whole thing runs in one transaction: a crash mid-write leaves the previous
 * `file_size`/`file_mtime_ms` in place, so the next scan simply redoes it.
 */
export function writeSession(db: SightlineDatabase, input: SessionInput): void {
  const { parsed } = input
  const summary = parsed.summary

  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(summary.sessionId)

    const durationMs =
      summary.startedAt !== undefined && summary.endedAt !== undefined
        ? Date.parse(summary.endedAt) - Date.parse(summary.startedAt)
        : null

    db.prepare(
      `INSERT INTO sessions (
         id, project_id, parent_session_id, file_path, file_size, file_mtime_ms,
         store_kind, store_distro, store_root,
         ai_title, agent_name, slug, git_branch, version, cwd, last_prompt,
         started_at, ended_at, duration_ms,
         record_count, message_count, user_message_count, assistant_message_count,
         tool_call_count, subagent_count, malformed_count, orphan_count, duplicate_uuid_count,
         models, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
       ) VALUES (
         @id, @projectId, @parentSessionId, @filePath, @fileSize, @fileMtimeMs,
         @storeKind, @storeDistro, @storeRoot,
         @aiTitle, @agentName, @slug, @gitBranch, @version, @cwd, @lastPrompt,
         @startedAt, @endedAt, @durationMs,
         @recordCount, @messageCount, @userMessageCount, @assistantMessageCount,
         @toolCallCount, @subagentCount, @malformedCount, @orphanCount, @duplicateUuidCount,
         @models, @tokensIn, @tokensOut, @tokensCacheRead, @tokensCacheWrite
       )`,
    ).run({
      id: summary.sessionId,
      projectId: input.projectId,
      parentSessionId: summary.continuesSessionId ?? null,
      filePath: input.filePath,
      fileSize: input.fileSize,
      fileMtimeMs: input.fileMtimeMs,
      storeKind: input.store.host,
      storeDistro: input.store.host === 'wsl' ? input.store.distro : null,
      storeRoot: input.storeRoot,
      aiTitle: summary.aiTitle ?? null,
      agentName: findAgentName(parsed.records),
      slug: summary.slug ?? null,
      gitBranch: summary.gitBranch ?? null,
      version: summary.version ?? null,
      cwd: summary.cwds[0] ?? null,
      lastPrompt: summary.lastPrompt ?? null,
      startedAt: summary.startedAt ?? null,
      endedAt: summary.endedAt ?? null,
      durationMs,
      recordCount: summary.recordCount,
      messageCount: summary.messageCount,
      userMessageCount: summary.userMessageCount,
      assistantMessageCount: summary.assistantMessageCount,
      toolCallCount: summary.toolCallCount,
      subagentCount: parsed.subagents.length,
      malformedCount: summary.malformed.length,
      orphanCount: parsed.tree.orphanCount,
      duplicateUuidCount: parsed.tree.duplicateUuidCount,
      models: JSON.stringify(summary.models),
      tokensIn: summary.usage.inputTokens,
      tokensOut: summary.usage.outputTokens,
      tokensCacheRead: summary.usage.cacheReadTokens,
      tokensCacheWrite: summary.usage.cacheCreationTokens,
    })

    insertMessages(db, summary.sessionId, parsed.records, null)
    insertToolCalls(db, summary.sessionId, parsed.records)

    const unattached = new Set(parsed.unattachedSubagentIds)
    const insertSubagent = db.prepare(
      `INSERT INTO subagents (agent_id, session_id, parent_tool_use_id, agent_type,
                              description, spawn_depth, message_count, started_at, ended_at, unattached)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const agent of parsed.subagents) {
      insertSubagent.run(
        agent.agentId,
        summary.sessionId,
        agent.parentToolUseId ?? null,
        agent.agentType ?? null,
        agent.description ?? null,
        agent.spawnDepth,
        agent.messageCount,
        agent.startedAt ?? null,
        agent.endedAt ?? null,
        unattached.has(agent.agentId) ? 1 : 0,
      )
      insertMessages(db, summary.sessionId, agent.records, agent.agentId)
      insertToolCalls(db, summary.sessionId, agent.records)
    }

    const insertTouch = db.prepare(
      `INSERT INTO file_touches (session_id, project_id, path, op, count, last_seq)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, path, op) DO UPDATE SET
         count    = file_touches.count + excluded.count,
         last_seq = MAX(file_touches.last_seq, excluded.last_seq)`,
    )
    for (const touch of summary.fileTouches) {
      insertTouch.run(
        summary.sessionId,
        input.projectId,
        touch.path,
        touch.op,
        touch.count,
        touch.lastSeq,
      )
    }

    // Keyed per session, so a response that legitimately appears in two transcripts is
    // stored twice and deduplicated at query time. `ON CONFLICT DO NOTHING` guards only
    // against the same key arriving twice within one session's own event list.
    const insertTokenEvent = db.prepare(
      `INSERT INTO token_events (session_id, dedupe_key, ts, model, agent_id,
                                 input_tokens, output_tokens, cache_read_tokens,
                                 cache_write_5m_tokens, cache_write_1h_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, dedupe_key) DO NOTHING`,
    )
    for (const event of summary.tokenEvents) {
      insertTokenEvent.run(
        summary.sessionId,
        event.dedupeKey,
        event.timestamp ?? null,
        event.model ?? null,
        event.agentId ?? null,
        event.usage.inputTokens,
        event.usage.outputTokens,
        event.usage.cacheReadTokens,
        event.usage.cacheCreation5mTokens,
        event.usage.cacheCreation1hTokens,
      )
    }

    const insertArtifact = db.prepare(
      'INSERT INTO artifacts (session_id, kind, payload_json, seq) VALUES (?, ?, ?, ?)',
    )
    for (const artifact of summary.artifacts) {
      insertArtifact.run(summary.sessionId, artifact.kind, JSON.stringify(artifact), artifact.seq)
    }

    // Project activity tracks its most recent session, not the scan time.
    db.prepare(
      `UPDATE projects
          SET first_seen  = MIN(COALESCE(first_seen, @startedAt), COALESCE(@startedAt, first_seen)),
              last_active = MAX(COALESCE(last_active, @endedAt), COALESCE(@endedAt, last_active))
        WHERE id = @projectId`,
    ).run({
      projectId: input.projectId,
      startedAt: summary.startedAt ?? null,
      endedAt: summary.endedAt ?? null,
    })
  })()
}

/**
 * Store every record that participates in the uuid graph, attachments included.
 *
 * Keeping attachments here is what lets `parent_uuid` chains be walked in SQL without
 * hitting holes — the same reason the in-memory graph includes them. The UI filters on
 * `kind`; the storage layer does not.
 */
function insertMessages(
  db: SightlineDatabase,
  sessionId: string,
  records: readonly TranscriptRecord[],
  agentId: string | null,
): void {
  const insert = db.prepare(
    `INSERT INTO messages (uuid, session_id, parent_uuid, seq, kind, ts, text,
                           has_thinking, is_sidechain, agent_id, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO NOTHING`,
  )

  for (const record of records) {
    const uuid = record.envelope.uuid
    if (uuid === undefined || record.kind === 'file-history-snapshot') continue

    const text = 'text' in record ? record.text : ''
    // `queue-operation` also has a `content` field, but it's a string — narrow on kind
    // rather than on shape, or the union quietly widens under you.
    const carriesBlocks = record.kind === 'user' || record.kind === 'assistant'
    const thinking = carriesBlocks && hasThinking(record.content)

    insert.run(
      uuid,
      sessionId,
      record.envelope.parentUuid ?? null,
      record.seq,
      record.kind,
      record.envelope.timestamp ?? null,
      text,
      thinking ? 1 : 0,
      record.envelope.isSidechain === true ? 1 : 0,
      agentId ?? record.envelope.agentId ?? null,
      record.kind === 'assistant' ? (record.model ?? null) : null,
    )
  }
}

function insertToolCalls(
  db: SightlineDatabase,
  sessionId: string,
  records: readonly TranscriptRecord[],
): void {
  const insert = db.prepare(
    `INSERT INTO tool_calls (id, session_id, message_uuid, name, input_json, is_error, seq, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, id) DO NOTHING`,
  )

  const errored = new Set<string>()
  for (const record of records) {
    if (record.kind !== 'user') continue
    for (const block of record.content) {
      if (block.type === 'tool_result' && block.isError) errored.add(block.toolUseId)
    }
  }

  for (const record of records) {
    if (record.kind !== 'assistant') continue
    for (const block of record.content) {
      if (block.type !== 'tool_use') continue
      insert.run(
        block.id,
        sessionId,
        record.envelope.uuid ?? null,
        block.name,
        JSON.stringify(block.input),
        errored.has(block.id) ? 1 : 0,
        record.seq,
        record.envelope.timestamp ?? null,
      )
    }
  }
}

function parseFolderKeys(value: string | undefined): string[] {
  if (value === undefined) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function findAgentName(records: readonly TranscriptRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]
    if (record?.kind === 'agent-name') return record.agentName
  }
  return null
}
