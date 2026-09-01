import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasGraphIdentity } from '../types.js'
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

describe('wsl-resumed-session', () => {
  /**
   * `last-prompt` is the resume pointer. `leafUuid` is the half `--resume` needs and was
   * present on all 6,199 records across both stores; `lastPrompt` is the text beside it and
   * is absent on 17 of them, at most one per session file.
   *
   * Requiring it did not make those records safe, it made them `raw` — a resume pointer we
   * could have read, reported as a record we did not understand.
   */
  it('reads a last-prompt record that carries no lastPrompt', () => {
    const { lines } = loadFixture('wsl-resumed-session')
    const parsed = parseSession({ sessionId: 'wsl-resumed-session', lines })

    const record = parsed.records.find((r) => r.kind === 'last-prompt')
    expect(record?.kind).toBe('last-prompt')
    expect(record?.kind === 'last-prompt' && record.lastPrompt).toBeUndefined()
    expect(record?.kind === 'last-prompt' && record.leafUuid).toBeTypeOf('string')
  })

  /**
   * The regression this guards is only reachable *because* the field became optional. While
   * `lastPrompt` was required, a bare record degraded to `raw` and never reached the summary
   * at all. Two sessions in the corpus end on one — a `/clear` writes the bare form as the
   * file's last record — so passing it straight through would erase a prompt already read.
   */
  it('does not let a text-less last-prompt erase one already read', () => {
    const withText = JSON.stringify({
      type: 'last-prompt',
      lastPrompt: 'the real prompt',
      leafUuid: 'aaaaaaaa-0000-0000-0000-000000000001',
    })
    const bare = JSON.stringify({
      type: 'last-prompt',
      leafUuid: 'aaaaaaaa-0000-0000-0000-000000000002',
    })

    const parsed = parseSession({ sessionId: 'ends-on-a-clear', lines: [withText, bare] })
    expect(parsed.summary.lastPrompt).toBe('the real prompt')
  })
})

describe('wsl-artifact-records', () => {
  const NEW_AT_2_1_238 = [
    'atis-latch',
    'bridge-session',
    'frame-link',
    'artifact-comment-monitor',
    'artifact-autoreact-ledger',
  ] as const

  it('understands every record type Claude Code added at 2.1.238', () => {
    const { lines } = loadFixture('wsl-artifact-records')
    const parsed = parseSession({ sessionId: 'wsl-artifact-records', lines })

    for (const kind of NEW_AT_2_1_238) {
      expect(parsed.records.some((r) => r.kind === kind)).toBe(true)
    }
  })

  /**
   * Trap 1 asks a specific question of every new record type: does it carry a `uuid`? An
   * `attachment` does, which is why excluding it severed 1,345 records. These five do not,
   * so they were only ever a display problem — but that has to be *checked* against the
   * capture rather than assumed, because the cost of assuming wrong is invisible.
   */
  it('keeps the new types out of the conversation graph, because none carries a uuid', () => {
    const { lines } = loadFixture('wsl-artifact-records')
    const parsed = parseSession({ sessionId: 'wsl-artifact-records', lines })

    const newRecords = parsed.records.filter((r) =>
      (NEW_AT_2_1_238 as readonly string[]).includes(r.kind),
    )
    expect(newRecords.length).toBeGreaterThan(0)
    for (const record of newRecords) {
      expect(record.envelope.uuid).toBeUndefined()
      expect(hasGraphIdentity(record)).toBe(false)
    }
  })

  /**
   * `bridge-session` arrives carrying `ownerAccountUuid` and `ownerOrganizationUuid`.
   * Reading a field is a decision to be responsible for it — anything on the record ends up
   * in the database and in `sightline export`, so these stay in `raw` and nowhere else.
   */
  it('does not lift account identifiers off a bridge-session record', () => {
    const { lines } = loadFixture('wsl-artifact-records')
    const parsed = parseSession({ sessionId: 'wsl-artifact-records', lines })

    const bridge = parsed.records.find((r) => r.kind === 'bridge-session')
    expect(bridge).toBeDefined()
    expect(bridge?.raw.ownerAccountUuid).toBeTypeOf('string')
    expect(Object.keys(bridge ?? {})).not.toContain('ownerAccountUuid')
    expect(Object.keys(bridge ?? {})).not.toContain('ownerOrganizationUuid')
  })

  /**
   * Eight of the nine `frame-link` records in the source session are a bare
   * `artifactCount` + `timestamp`; only one names the artifact. Listing all of them would
   * report nine artifacts where there was one.
   */
  it('lists only the frame-link that actually names an artifact', () => {
    const { lines } = loadFixture('wsl-artifact-records')
    const parsed = parseSession({ sessionId: 'wsl-artifact-records', lines })

    const frameLinks = parsed.records.filter((r) => r.kind === 'frame-link')
    expect(frameLinks).toHaveLength(2)
    expect(frameLinks.filter((r) => r.frameUrl !== undefined)).toHaveLength(1)

    const frameArtifacts = parsed.summary.artifacts.filter((a) => a.kind === 'frame-link')
    expect(frameArtifacts).toHaveLength(1)
    expect(frameArtifacts[0]?.frameUrl).toContain('claude.ai')
  })

  it('reads the artifact ids out of both ledger types', () => {
    const { lines } = loadFixture('wsl-artifact-records')
    const parsed = parseSession({ sessionId: 'wsl-artifact-records', lines })

    for (const kind of ['artifact-comment-monitor', 'artifact-autoreact-ledger'] as const) {
      const ledger = parsed.records.find((r) => r.kind === kind)
      expect(ledger?.kind === kind && ledger.artifactIds).toHaveLength(1)
    }
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
