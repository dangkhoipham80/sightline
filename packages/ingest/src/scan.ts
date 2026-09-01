import type { SightlineDatabase } from '@sightline/db'
import type { ClaudeStore } from './discover.js'
import { discoverSessions, localStore } from './discover.js'
import { createIndexer } from './indexer.js'

export interface ScanOptions {
  /** Which `~/.claude` to index. Defaults to this machine's own. */
  store?: ClaudeStore
  /** Re-read every transcript even if its size and mtime are unchanged. */
  force?: boolean
  onProgress?: (progress: ScanProgress) => void
}

export interface ScanProgress {
  processed: number
  total: number
  sessionId: string
  skipped: boolean
}

export interface ScanResult {
  discovered: number
  ingested: number
  skipped: number
  failed: Array<{ sessionId: string; error: string }>
  projects: number
  malformedLines: number
  durationMs: number
}

/**
 * Index every transcript under the projects root.
 *
 * Change detection is at **file granularity**, not byte granularity: if a transcript's
 * size and mtime are unchanged, it is skipped entirely; otherwise it is reparsed in full.
 *
 * A byte-offset scheme reading only appended tails looks appealing — the files are
 * append-only — but every session aggregate (token totals, file touches, message counts,
 * title) is a function of the whole transcript, so incremental reads would have to merge
 * partial aggregates and stay correct across compaction and rewrites. Since the entire
 * 127 MB corpus reparses in under two seconds, that complexity buys nothing. Revisit if
 * someone shows up with a corpus where it matters.
 */
export function scan(db: SightlineDatabase, options: ScanOptions = {}): ScanResult {
  const started = Date.now()
  const sessions = discoverSessions(options.store ?? localStore())
  const indexer = createIndexer(db)

  const result: ScanResult = {
    discovered: sessions.length,
    ingested: 0,
    skipped: 0,
    failed: [],
    projects: 0,
    malformedLines: 0,
    durationMs: 0,
  }

  let processed = 0

  for (const session of sessions) {
    processed += 1

    if (options.force !== true && indexer.isUnchanged(session)) {
      result.skipped += 1
      options.onProgress?.({
        processed,
        total: sessions.length,
        sessionId: session.sessionId,
        skipped: true,
      })
      continue
    }

    try {
      result.malformedLines += indexer.ingest(session).malformedLines
      result.ingested += 1
    } catch (error) {
      result.failed.push({
        sessionId: session.sessionId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
    }

    options.onProgress?.({
      processed,
      total: sessions.length,
      sessionId: session.sessionId,
      skipped: false,
    })
  }

  result.projects = indexer.projectCount()
  result.durationMs = Date.now() - started
  return result
}
