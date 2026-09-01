import type { LaunchStore } from '@sightline/core'
import type { SightlineDatabase } from '@sightline/db'
import type { ClaudeStore, StoreDiscovery } from './discover.js'
import { discoverSessions, discoverStores, localStore } from './discover.js'
import type { Indexer } from './indexer.js'
import { createIndexer } from './indexer.js'
import type { SkippedDistro } from './wsl.js'

export interface ScanOptions {
  /** Which `~/.claude` to index. Defaults to this machine's own. */
  store?: ClaudeStore
  /** Re-read every transcript even if its size and mtime are unchanged. */
  force?: boolean
  onProgress?: (progress: ScanProgress) => void
  /**
   * Reuse an indexer across several scans. `scanAll` passes one so that a project worked
   * on from two stores resolves once and counts once.
   *
   * The visible consequence: `ScanResult.projects` is a property of the *indexer*, not of
   * this store — with one shared, it counts every project seen so far, so a per-store
   * reading is cumulative rather than that store's own contribution.
   */
  indexer?: Indexer
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
  const indexer = options.indexer ?? createIndexer(db)

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

/** One store's contribution to a `scanAll`, or the reason it contributed nothing. */
export interface StoreScanOutcome {
  store: LaunchStore
  root: string
  /** Absent when the store could not be read at all. */
  result?: ScanResult
  /** Present instead of `result` when reading the store threw. */
  error?: string
}

export interface ScanAllResult {
  discovered: number
  ingested: number
  skipped: number
  failed: Array<{ sessionId: string; error: string }>
  projects: number
  malformedLines: number
  durationMs: number
  /** Every store discovery offered, in the order they were read. */
  stores: StoreScanOutcome[]
  /** Distros that exist but were not read, and why. Never silently dropped. */
  skippedDistros: SkippedDistro[]
}

export interface ScanAllOptions {
  /** Re-read every transcript in every store even if its size and mtime are unchanged. */
  force?: boolean
  /**
   * Reported per store, so `total` counts that store's sessions rather than the run's.
   * A cross-store total is not knowable before the last store has been enumerated, and
   * enumerating a WSL store early — just to produce a denominator — is exactly the 9P
   * round trip this is trying not to pay twice.
   */
  onProgress?: (progress: ScanProgress, store: ClaudeStore) => void
  /** Injected so tests can supply stores without a real `~/.claude` or a real distro. */
  discover?: () => StoreDiscovery
}

/**
 * Index **every** `~/.claude` this machine can reach, not just the local one.
 *
 * The single-store `scan` above is still the primitive and still what the watcher and the
 * tests drive; this is the entry point anything user-facing should call. Indexing one store
 * on a machine that has two does not fail — it silently returns a smaller, entirely
 * plausible index, which is the failure mode ADR 0005 exists to describe.
 *
 * A store that throws mid-read is recorded and the run continues. That is not defensive
 * padding: the WSL stores are reached over a 9P share that disappears the moment the distro
 * shuts down or idles out, and the local store's ~12 s of work is already committed to the
 * database by then. Aborting the run would discard a good report over an unreachable share.
 *
 * One indexer spans every store, which is what makes `projects` a union rather than a sum:
 * `App_BlueOne_v2` lives in both stores here and is one project, not two. It also shares
 * the git-root cache, so the second store does not re-walk directories the first resolved.
 */
export function scanAll(db: SightlineDatabase, options: ScanAllOptions = {}): ScanAllResult {
  const started = Date.now()
  const discovery = (options.discover ?? discoverStores)()
  const indexer = createIndexer(db)

  const result: ScanAllResult = {
    discovered: 0,
    ingested: 0,
    skipped: 0,
    failed: [],
    projects: 0,
    malformedLines: 0,
    durationMs: 0,
    stores: [],
    skippedDistros: discovery.skipped,
  }

  for (const store of discovery.stores) {
    const outcome: StoreScanOutcome = { store: store.launch, root: store.root }

    try {
      const one = scan(db, {
        store,
        indexer,
        ...(options.force !== undefined && { force: options.force }),
        ...(options.onProgress !== undefined && {
          onProgress: (progress: ScanProgress) => options.onProgress?.(progress, store),
        }),
      })

      outcome.result = one
      result.discovered += one.discovered
      result.ingested += one.ingested
      result.skipped += one.skipped
      result.failed.push(...one.failed)
      result.malformedLines += one.malformedLines
      // Deliberately not summed. The shared indexer already deduplicates, so this reading
      // is the running union; summing would count a project worked on from two stores twice.
      result.projects = one.projects
    } catch (error) {
      outcome.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    result.stores.push(outcome)
  }

  result.durationMs = Date.now() - started
  return result
}
