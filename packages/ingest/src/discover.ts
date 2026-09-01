import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LaunchStore, SubagentInput } from '@sightline/core'
import { agentIdFromFilename } from '@sightline/core'
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

/** The store rooted at a `~/.claude` directory. */
export function storeAt(root: string, launch: LaunchStore = localLaunchStore()): ClaudeStore {
  return { launch, root, projectsRoot: join(root, 'projects') }
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
 */
export function discoverStores(options: WslDiscoveryOptions = {}): StoreDiscovery {
  const wsl = discoverWslStores(options)
  return { stores: [localStore(), ...wsl.stores], skipped: wsl.skipped }
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
 * Read a transcript and its sidechain files.
 *
 * Subagent transcripts live in `<session>/subagents/`, not inline. Loading them is not
 * optional — they contain most of the work in any session that delegated.
 */
export function loadTranscript(session: Pick<DiscoveredSession, 'filePath'>): LoadedTranscript {
  const lines = readFileSync(session.filePath, 'utf8').split('\n')

  const subagentDir = join(session.filePath.slice(0, -'.jsonl'.length), 'subagents')
  const subagents: SubagentInput[] = []

  if (existsSync(subagentDir)) {
    for (const name of readdirSync(subagentDir)) {
      const agentId = agentIdFromFilename(name)
      if (agentId === null) continue
      const metaPath = join(subagentDir, `agent-${agentId}.meta.json`)
      subagents.push({
        agentId,
        lines: readFileSync(join(subagentDir, name), 'utf8').split('\n'),
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
