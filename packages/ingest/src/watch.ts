import { statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { SightlineDatabase } from '@sightline/db'
import { watch as chokidarWatch } from 'chokidar'
import type { ClaudeStore, DiscoveredSession } from './discover.js'
import { localStore } from './discover.js'
import { createIndexer } from './indexer.js'

export interface WatchOptions {
  /** Which `~/.claude` to watch. Defaults to this machine's own. */
  store?: ClaudeStore
  /**
   * Quiet period after the last write before a transcript is re-indexed.
   * Claude Code appends a line at a time; without this every keystroke reparses the file.
   */
  debounceMs?: number
  /**
   * Upper bound on how long a continuously-appended transcript waits.
   * A long agent run never goes quiet, and "never updates while you're working" is the
   * opposite of what a live view is for.
   */
  maxDelayMs?: number
  onIndexed?: (event: IndexedEvent) => void
  onError?: (error: WatchError) => void
}

export interface IndexedEvent {
  sessionId: string
  projectId: string
  filePath: string
  malformedLines: number
}

export interface WatchError {
  /** The transcript being indexed, or undefined for a watcher-level failure. */
  sessionId?: string
  error: Error
}

export interface Watcher {
  /** Resolves once the initial filesystem walk is complete. */
  ready: Promise<void>
  /** Re-index everything currently debounced, without waiting for its timer. */
  flush(): void
  close(): Promise<void>
}

/**
 * Keep the index current while Claude Code writes.
 *
 * A delta on top of `scan`, not a replacement for it: `ignoreInitial` is on, so callers
 * scan once at startup and then watch. Everything here reads `~/.claude` and writes only
 * to the index — chokidar never touches the files it observes.
 *
 * Failures are reported through `onError` and never thrown. A watcher that dies because
 * one transcript was momentarily unreadable is worse than useless: it stops updating
 * silently, and the UI has no way to tell "nothing changed" from "I gave up".
 */
export function watch(db: SightlineDatabase, options: WatchOptions = {}): Watcher {
  const store = options.store ?? localStore()
  const root = store.projectsRoot
  const debounceMs = options.debounceMs ?? 400
  const maxDelayMs = options.maxDelayMs ?? 5_000
  const indexer = createIndexer(db)

  interface Pending {
    timer: NodeJS.Timeout
    folderKey: string
    sessionId: string
    /** When the debounce must stop being extended, so an active session still updates. */
    deadline: number
    /**
     * Re-index even if the parent transcript's signature is unchanged. Set when a subagent
     * file woke us: a sidechain write changes what the session *contains* without touching
     * the parent file at all, so the size+mtime check would skip it forever.
     */
    forced: boolean
  }

  const pending = new Map<string, Pending>()

  const watcher = chokidarWatch(root, {
    ignoreInitial: true,
    // Symlinked project directories would otherwise be walked twice, and a link pointing
    // outside the root would take the watcher with it.
    followSymlinks: false,
    ...pollingOptionsFor(store),
  })

  function queue(changedPath: string): void {
    const target = resolveWatchTarget(root, changedPath)
    if (target === undefined) return

    const existing = pending.get(target.filePath)
    if (existing !== undefined) clearTimeout(existing.timer)

    const now = Date.now()
    const deadline = existing?.deadline ?? now + maxDelayMs
    const wait = Math.max(0, Math.min(debounceMs, deadline - now))

    const timer = setTimeout(() => {
      flushOne(target.filePath)
    }, wait)
    // Never keep the process alive on our own account; chokidar already does that, and a
    // pending timer outliving `close()` would delay exit for no reason.
    timer.unref?.()

    pending.set(target.filePath, {
      timer,
      folderKey: target.folderKey,
      sessionId: target.sessionId,
      deadline,
      forced: (existing?.forced ?? false) || target.isSubagent,
    })
  }

  function flushOne(filePath: string): void {
    const entry = pending.get(filePath)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(filePath)

    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(filePath)
    } catch {
      // Deleted or renamed between the event and now. Nothing to index, and nothing to
      // report — the row we already hold stays, see the `unlink` handler.
      return
    }

    const session: DiscoveredSession = {
      sessionId: entry.sessionId,
      folderKey: entry.folderKey,
      filePath,
      fileSize: stats.size,
      fileMtimeMs: Math.floor(stats.mtimeMs),
      store: store.launch,
      storeRoot: store.root,
    }

    // Guards against chokidar reporting one write twice, and against a touch that changed
    // no bytes. `forced` opts subagent writes out — see the field's comment.
    if (!entry.forced && indexer.isUnchanged(session)) return

    try {
      const outcome = indexer.ingest(session)
      options.onIndexed?.({
        sessionId: session.sessionId,
        projectId: outcome.projectId,
        filePath,
        malformedLines: outcome.malformedLines,
      })
    } catch (error) {
      options.onError?.({
        sessionId: session.sessionId,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  watcher.on('add', queue)
  watcher.on('change', queue)

  // There is deliberately no `unlink` handler. A transcript removed from `~/.claude` keeps
  // its indexed rows: Sightline is the memory layer, Claude Code prunes its own directory,
  // and deleting our copy in sympathy would throw away the history that is the entire
  // point. `resetDerivedTables` + a fresh scan is the escape hatch for a real rebuild.
  watcher.on('error', (error) => {
    options.onError?.({ error: error instanceof Error ? error : new Error(String(error)) })
  })

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => {
      resolve()
    })
  })

  return {
    ready,
    flush() {
      for (const filePath of [...pending.keys()]) flushOne(filePath)
    },
    async close() {
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
      await watcher.close()
    },
  }
}

/** Polling interval for a 9P root. Slow enough to be cheap, fast enough to feel live. */
const WSL_POLL_INTERVAL_MS = 700

/**
 * Chokidar options a store's root demands, on top of the ones every root gets.
 *
 * A WSL store is read from Windows over the `\\wsl.localhost` 9P share, and **native
 * watching there does not merely miss events — it refuses to start.** Measured on the
 * reference machine (chokidar 5, Node 22): `fs.watch` on a 9P directory throws `EISDIR`
 * immediately — once per directory, so the real WSL store produced twelve — after which
 * the watcher reports `ready` and sits there forever having seen nothing. `watch()` routes
 * errors to `onError` and never throws, so the failure presents as a live view that is
 * simply always out of date. With `usePolling` the same store produces no errors at all,
 * and a scratch-directory trial caught 2 of 2 appends written from inside the distro.
 *
 * The Windows root must not pay for this: polling stats every watched file on an interval,
 * which is exactly the cost the native backend exists to avoid. Hence a per-store decision
 * rather than a global flag. See `docs/adr/0005-two-claude-code-data-stores.md`.
 */
export function pollingOptionsFor(store: ClaudeStore): {
  usePolling?: true
  interval?: number
} {
  if (store.launch.host !== 'wsl') return {}
  return { usePolling: true, interval: WSL_POLL_INTERVAL_MS }
}

export interface WatchTarget {
  sessionId: string
  folderKey: string
  /** The parent transcript, which is what gets re-indexed even for a subagent write. */
  filePath: string
  /** The change was to a sidechain file, not to the parent transcript itself. */
  isSubagent: boolean
}

/**
 * Map a changed path back to the transcript that owns it.
 *
 * Two shapes matter, and only two:
 *   `<root>/<folderKey>/<sessionId>.jsonl`
 *   `<root>/<folderKey>/<sessionId>/subagents/agent-<id>.jsonl` (and its `.meta.json`)
 *
 * A subagent write resolves to its **parent** session, because session aggregates are a
 * function of the transcript plus its sidechains. Treating `agent-*.jsonl` as a session
 * in its own right would create phantom sessions whose parent never learned it delegated.
 */
export function resolveWatchTarget(root: string, changedPath: string): WatchTarget | undefined {
  const rel = relative(root, changedPath)
  if (rel === '' || rel.startsWith('..')) return undefined

  const parts = rel.split(/[\\/]/).filter((part) => part.length > 0)
  const folderKey = parts[0]
  if (folderKey === undefined) return undefined

  if (parts.length === 2) {
    const name = parts[1]
    if (name === undefined || !name.endsWith('.jsonl')) return undefined
    const sessionId = name.slice(0, -'.jsonl'.length)
    return { sessionId, folderKey, filePath: join(root, folderKey, name), isSubagent: false }
  }

  if (parts.length === 4 && parts[2] === 'subagents') {
    const sessionId = parts[1]
    const name = parts[3]
    if (sessionId === undefined || name === undefined) return undefined
    if (!name.startsWith('agent-')) return undefined
    if (!name.endsWith('.jsonl') && !name.endsWith('.meta.json')) return undefined
    return {
      sessionId,
      folderKey,
      filePath: join(root, folderKey, `${sessionId}.jsonl`),
      isSubagent: true,
    }
  }

  return undefined
}
