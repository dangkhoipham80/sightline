import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SubagentInput } from './subagents.js'
import { agentIdFromFilename } from './subagents.js'
import { parseSession } from './transcript.js'

/**
 * Golden tests over anonymised captures of real transcripts.
 *
 * These are the tests that matter most. Hand-written JSON tests the parser against the
 * author's assumptions, and the author's assumptions are exactly what turns out to be
 * wrong — every trap in `docs/TRANSCRIPT-FORMAT.md` was found in real data, not reasoned
 * about in advance.
 *
 * Fixtures are byte-exact and marked `-text` in `.gitattributes`. If one of these fails,
 * the parser is wrong, or Claude Code changed its format — in which case *add* a
 * version-tagged fixture rather than editing this one. See `.claude/skills/parse-transcript/`.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__')

function loadFixture(name: string) {
  const dir = join(FIXTURES_DIR, name)
  const lines = readFileSync(join(dir, 'transcript.jsonl'), 'utf8').split('\n')

  const subagents: SubagentInput[] = []
  const subagentDir = join(dir, 'subagents')
  if (existsSync(subagentDir)) {
    for (const filename of readdirSync(subagentDir)) {
      const agentId = agentIdFromFilename(filename)
      if (agentId === null) continue
      const metaPath = join(subagentDir, `agent-${agentId}.meta.json`)
      subagents.push({
        agentId,
        lines: readFileSync(join(subagentDir, filename), 'utf8').split('\n'),
        ...(existsSync(metaPath) && { meta: JSON.parse(readFileSync(metaPath, 'utf8')) }),
      })
    }
  }

  return { lines, subagents }
}

const FIXTURE_NAMES = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

describe('every fixture', () => {
  it('has at least one fixture to test against', () => {
    expect(FIXTURE_NAMES.length).toBeGreaterThan(0)
  })

  it.each(FIXTURE_NAMES)('parses %s without throwing or losing a line', (name) => {
    const { lines, subagents } = loadFixture(name)
    const nonEmpty = lines.filter((l) => l.trim().length > 0).length

    const parsed = parseSession({ sessionId: name, lines, subagents })

    expect(parsed.summary.malformed).toHaveLength(0)
    expect(parsed.records).toHaveLength(nonEmpty)
    // Nothing degraded to `raw`: every record type in a real transcript should be one we
    // understand. A failure here means Claude Code shipped a type we haven't handled.
    expect(parsed.records.filter((r) => r.kind === 'raw')).toHaveLength(0)
  })
})

describe('wsl-snapshot-collision', () => {
  /**
   * Real evidence for trap 3: this capture contains a `file-history-snapshot` whose
   * `messageId` is also the `uuid` of a real `user` record in the same file. This is not
   * a constructed edge case — it is what a five-line transcript looks like.
   */
  it('has a snapshot messageId that collides with a real message uuid', () => {
    const { lines } = loadFixture('wsl-snapshot-collision')
    const records = lines
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)

    const snapshotIds = new Set(
      records.filter((r) => r.type === 'file-history-snapshot').map((r) => r.messageId as string),
    )
    const messageUuids = new Set(
      records.filter((r) => r.type === 'user').map((r) => r.uuid as string),
    )

    const collisions = [...snapshotIds].filter((id) => messageUuids.has(id))
    expect(collisions.length).toBeGreaterThan(0)
  })

  it('still indexes the real message, not the snapshot', () => {
    const { lines } = loadFixture('wsl-snapshot-collision')
    const parsed = parseSession({ sessionId: 'wsl-snapshot-collision', lines })

    for (const node of parsed.tree.byUuid.values()) {
      expect(node.record.kind).not.toBe('file-history-snapshot')
    }
    expect(parsed.tree.duplicateUuidCount).toBe(0)
  })

  it('reads the working directory from the record, never from a folder name', () => {
    const { lines } = loadFixture('wsl-snapshot-collision')
    const parsed = parseSession({ sessionId: 'wsl-snapshot-collision', lines })
    expect(parsed.summary.cwds[0]).toContain('\\\\wsl.localhost\\Ubuntu-24.04\\')
  })
})

describe('wsl-session-with-subagent', () => {
  it('loads the sidechain transcript from its sibling file', () => {
    const { lines, subagents } = loadFixture('wsl-session-with-subagent')
    const parsed = parseSession({ sessionId: 'wsl-session-with-subagent', lines, subagents })

    expect(parsed.subagents).toHaveLength(1)
    const agent = parsed.subagents[0]
    expect(agent?.agentType).toBe('Explore')
    expect(agent?.spawnDepth).toBe(1)
    expect(agent?.messageCount).toBeGreaterThan(0)
  })

  it('attaches the subagent to the tool_use block that spawned it', () => {
    const { lines, subagents } = loadFixture('wsl-session-with-subagent')
    const parsed = parseSession({ sessionId: 'wsl-session-with-subagent', lines, subagents })

    expect(parsed.subagents[0]?.parentToolUseId).toBeDefined()
    expect(parsed.unattachedSubagentIds).toEqual([])
  })

  it('marks every sidechain line as such, and no main-transcript line', () => {
    const { lines, subagents } = loadFixture('wsl-session-with-subagent')
    const parsed = parseSession({ sessionId: 'wsl-session-with-subagent', lines, subagents })

    expect(parsed.records.every((r) => r.envelope.isSidechain !== true)).toBe(true)
    const agentRecords = parsed.subagents[0]?.records ?? []
    expect(agentRecords.some((r) => r.envelope.isSidechain === true)).toBe(true)
  })

  it('uses Claude’s own session title rather than inventing one', () => {
    const { lines } = loadFixture('wsl-session-with-subagent')
    const parsed = parseSession({ sessionId: 'wsl-session-with-subagent', lines })
    expect(parsed.summary.aiTitle).toBeDefined()
    expect(parsed.summary.aiTitle?.length).toBeGreaterThan(0)
  })
})
