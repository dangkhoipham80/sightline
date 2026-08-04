import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubagentInput } from '@sightline/core'
import { agentIdFromFilename } from '@sightline/core'

export interface DiscoveredSession {
  sessionId: string
  folderKey: string
  filePath: string
  fileSize: number
  fileMtimeMs: number
}

export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/**
 * Enumerate every transcript under a projects root.
 *
 * Cheap by design — `stat` only. Deciding whether a session needs re-reading is the
 * caller's job, and it only needs size and mtime to make that call.
 */
export function discoverSessions(root: string = defaultProjectsRoot()): DiscoveredSession[] {
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
export function loadTranscript(session: DiscoveredSession): LoadedTranscript {
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
