import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LaunchStore, SubagentInput } from '@sightline/core'
import { agentIdFromFilename, parseHostPath } from '@sightline/core'
import type { SkippedDistro, WslDiscoveryOptions } from './wsl.js'
import { discoverWslStores } from './wsl.js'

/**
 * One `~/.claude` on this machine.
 *
 * A machine has more than one — a Windows box running WSL has a Windows store and a store
 * per distro, with separate settings, separate cleanup schedules and separate histories.
 * See `docs/adr/0005-two-claude-code-data-stores.md`.
 *
 * `launch` is the load-bearing field and the reason this type exists at all: it says which
 * `claude` binary can resume the sessions found here. It is **not** derivable from the
 * `cwd` recorded inside them — the Windows store is full of `\\wsl.localhost\…` working
 * directories that only the Windows binary can reopen.
 */
export interface ClaudeStore {
  launch: LaunchStore
  /** The store directory itself: `C:\Users\khoi\.claude`, `/home/me/.claude`. */
  root: string
  /**
   * Where transcripts live. Normally `<root>/projects`, kept explicit because a store
   * reached from another host is opened through a path that does not compose that way.
   */
  projectsRoot: string
}

/**
 * The store shape of the machine Sightline is running on.
 *
 * Never `wsl`: that variant describes a distro's store as seen *from Windows*, reached
 * over `\\wsl.localhost\…`. A Sightline running inside the distro is plainly `unix`, and
 * saying otherwise would emit `wsl.exe` commands on a host that has no `wsl.exe`.
 */
export function localLaunchStore(): LaunchStore {
  return process.platform === 'win32' ? { host: 'windows' } : { host: 'unix' }
}

/**
 * The store rooted at a `~/.claude` directory.
 *
 * `projectsRoot` is composed with the separator the **root itself** uses, not the one this
 * host happens to prefer. Plain `join` follows the host, which silently produces
 * `\\wsl.localhost\Ubuntu-24.04\home\me\.claude/projects` for a UNC root on Linux — the
 * same mixed-separator corruption `nativePath` in `grouping.ts` exists to prevent, and one
 * that already reached the index once. It survives because it is still an openable path on
 * Windows, so nothing errors; only string comparison against a properly-spelled path fails,
 * and that is what project grouping is made of.
 *
 * Appended by hand rather than with `path.win32.join` / `path.posix.join`. Importing those
 * two sub-namespaces — `import { posix, win32 } from 'node:path'` — breaks `next build`
 * (15.5.22) in a way that names nothing involved: the flight-client-entry plugin dies with
 * `Cannot read properties of undefined (reading 'client')`, preceded by `The "path"
 * argument must be of type string. Received function` from `Object.join [as then]` — a
 * namespace object being taken for a thenable. `tsc` and `vitest` are perfectly happy with
 * it either way. Appending one known segment needs no normalisation anyway.
 */
export function storeAt(root: string, launch: LaunchStore = localLaunchStore()): ClaudeStore {
  const separator = parseHostPath(root).kind === 'unix' ? '/' : '\\'
  const base = root.endsWith(separator) ? root.slice(0, -1) : root
  return { launch, root, projectsRoot: `${base}${separator}projects` }
}

/** This machine's own `~/.claude`. */
export function localStore(): ClaudeStore {
  return storeAt(join(homedir(), '.claude'))
}

export interface StoreDiscovery {
  stores: ClaudeStore[]
  /** Distros that exist but contributed nothing, and why. Never silently dropped. */
  skipped: SkippedDistro[]
}

/**
 * Every `~/.claude` this machine can reach.
 *
 * The local store always comes first — it is the one that certainly exists and needs no
 * subprocess to find. WSL stores follow, and only for distros that were already running:
 * see `discoverWslStores` for why booting one to read it is not an acceptable side effect
 * of a scan.
 *
 * The dependency runs one way on purpose: `wsl.ts` reports bare `{distro, root}` locations
 * and this module turns them into stores. Having `wsl.ts` import `storeAt` reads more
 * naturally and is what this was written as first, but it made the two modules mutually
 * dependent for no gain — `wsl.ts`'s job is talking to `wsl.exe`, and assembling a store
 * is this module's. Keeping it a leaf costs one `map` here.
 */
export function discoverStores(options: WslDiscoveryOptions = {}): StoreDiscovery {
  const wsl = discoverWslStores(options)
  return {
    stores: [
      localStore(),
      ...wsl.found.map((location) =>
        storeAt(location.root, { host: 'wsl', distro: location.distro }),
      ),
    ],
    skipped: wsl.skipped,
  }
}

export interface DiscoveredSession {
  sessionId: string
  folderKey: string
  filePath: string
  fileSize: number
  fileMtimeMs: number
  /** Which `claude` can resume this session. A property of the store, never of the `cwd`. */
  store: LaunchStore
  /** The `~/.claude` this came out of — also where its live-session registry lives. */
  storeRoot: string
}

export function defaultProjectsRoot(): string {
  return localStore().projectsRoot
}

/**
 * Enumerate every transcript in a store.
 *
 * Cheap by design — `stat` only. Deciding whether a session needs re-reading is the
 * caller's job, and it only needs size and mtime to make that call.
 */
export function discoverSessions(store: ClaudeStore = localStore()): DiscoveredSession[] {
  const root = store.projectsRoot
  if (!existsSync(root)) return []

  const found: DiscoveredSession[] = []

  for (const projectDir of readdirSync(root, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue
    const projectPath = join(root, projectDir.name)

    let entries: Dirent[]
    try {
      entries = readdirSync(projectPath, { withFileTypes: true })
    } catch {
      // A project directory that vanished or became unreadable mid-scan is skipped,
      // not fatal — a scan over a live `~/.claude` races with Claude Code itself.
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const filePath = join(projectPath, entry.name)
      try {
        const stats = statSync(filePath)
        found.push({
          sessionId: entry.name.slice(0, -'.jsonl'.length),
          folderKey: projectDir.name,
          filePath,
          fileSize: stats.size,
          fileMtimeMs: Math.floor(stats.mtimeMs),
          store: store.launch,
          storeRoot: store.root,
        })
      } catch {
        // Disappeared between readdir and stat. Nothing to index.
      }
    }
  }

  return found
}

export interface LoadedTranscript {
  lines: string[]
  subagents: SubagentInput[]
}

/**
 * How far below `subagents/` to look for transcripts.
 *
 * Agents spawned by the Workflow tool do not sit beside the others — they are nested a
 * directory deeper, under `subagents/workflows/wf_<id>/`. A top-level-only read finds none
 * of them: 177 transcripts on the reference machine, whose tokens were therefore missing
 * from every session total that used a workflow.
 *
 * This is trap 1 in a second costume. The narrow read does not fail, it under-reports, and
 * an under-reported session looks exactly like a cheap one.
 *
 * Bounded rather than unbounded, and selected by the `agent-*.jsonl` filename rather than
 * by the `workflows/` directory name. The filename is what keeps the Workflow tool's own
 * `journal.jsonl` out — it is not a transcript and has no envelope (trap 11) — and it goes
 * on doing that at any depth, whereas matching the directory name would go blind again the
 * day some other spawner picks a different one.
 */
const MAX_SUBAGENT_DEPTH = 4

/**
 * Read a transcript and its sidechain files.
 *
 * Subagent transcripts live under `<session>/subagents/`, not inline. Loading them is not
 * optional — they contain most of the work in any session that delegated.
 */
export function loadTranscript(session: Pick<DiscoveredSession, 'filePath'>): LoadedTranscript {
  const lines = readFileSync(session.filePath, 'utf8').split('\n')

  const subagentDir = join(session.filePath.slice(0, -'.jsonl'.length), 'subagents')
  const subagents: SubagentInput[] = []

  // First occurrence of an id wins, matching how duplicate uuids are handled (trap 6).
  // `subagents` is keyed `(session_id, agent_id)` and inserted without an upsert, so a
  // collision would abort the whole session's ingest. None exists — 382 agent files across
  // both stores on the reference machine yield 382 distinct ids per session, and the one
  // globally repeated id belongs to two different sessions, which the composite key already
  // separates. The guard is here so that a future collision costs one sidechain rather than
  // the entire session.
  const seen = new Set<string>()

  // Breadth-first over sorted names: agents that sit directly in `subagents/` are visited
  // before any nested ones, and the order does not depend on how the filesystem enumerates.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: subagentDir, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (!existsSync(current.dir)) continue

    let entries: Dirent[]
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      // Vanished or unreadable mid-scan. A sidechain we cannot read is work we cannot
      // show; it is not a reason to lose the session it belongs to.
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (current.depth < MAX_SUBAGENT_DEPTH) {
          queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
        }
        continue
      }

      const agentId = agentIdFromFilename(entry.name)
      if (agentId === null || seen.has(agentId)) continue

      let contents: string
      try {
        contents = readFileSync(join(current.dir, entry.name), 'utf8')
      } catch {
        continue
      }
      seen.add(agentId)

      const metaPath = join(current.dir, `agent-${agentId}.meta.json`)
      subagents.push({
        agentId,
        lines: contents.split('\n'),
        ...(existsSync(metaPath) && { meta: readJson(metaPath) }),
      })
    }
  }

  return { lines, subagents }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
