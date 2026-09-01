import { describe, expect, it } from 'vitest'
import { fixtureNames, readFixture } from '../__fixtures__/load.js'
import { hasGraphIdentity } from '../types.js'
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

const loadFixture = readFixture
const FIXTURE_NAMES = fixtureNames()

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

  /**
   * Subagent tokens are session tokens. `deriveSessionSummary` only ever sees the main
   * transcript, so before `parseSession` folded the sidechains in, a session that delegated
   * reported almost no spend — and delegating is precisely when a session spends most.
   */
  it('counts the sidechain’s tokens as part of the session', () => {
    const { lines, subagents } = loadFixture('wsl-session-with-subagent')

    const mainOnly = parseSession({ sessionId: 'wsl-session-with-subagent', lines })
    const withAgent = parseSession({ sessionId: 'wsl-session-with-subagent', lines, subagents })

    expect(withAgent.summary.tokenEvents.length).toBeGreaterThan(
      mainOnly.summary.tokenEvents.length,
    )
    expect(withAgent.summary.usage.outputTokens).toBeGreaterThan(
      mainOnly.summary.usage.outputTokens,
    )
    // Sidechain events stay attributable after the merge.
    expect(withAgent.summary.tokenEvents.some((e) => e.agentId !== undefined)).toBe(true)
  })

  it('uses Claude’s own session title rather than inventing one', () => {
    const { lines } = loadFixture('wsl-session-with-subagent')
    const parsed = parseSession({ sessionId: 'wsl-session-with-subagent', lines })
    expect(parsed.summary.aiTitle).toBeDefined()
    expect(parsed.summary.aiTitle?.length).toBeGreaterThan(0)
  })
})

/**
 * Agents spawned by the Workflow tool, which nests them one directory deeper than every
 * other sidechain. The capture keeps three workflow directories on purpose: one with two
 * agents, one with a single agent, and one holding nothing but a journal.
 */
describe('workflow-subagents', () => {
  const NAME = 'workflow-subagents'

  it('finds the agents nested under workflows/wf_<id>/', () => {
    const { lines, subagents } = loadFixture(NAME)
    const parsed = parseSession({ sessionId: NAME, lines, subagents })

    expect(parsed.subagents).toHaveLength(3)
    expect(parsed.subagents.every((a) => a.agentType === 'workflow-subagent')).toBe(true)
    expect(parsed.subagents.every((a) => a.messageCount > 0)).toBe(true)
  })

  /**
   * `journal.jsonl` is the Workflow tool's own bookkeeping — `started`/`result` records
   * with no transcript envelope (trap 11). It sits in the same directory as the agents and
   * one of its records even carries an `agentId`, so a loader that widened its glob to
   * `*.jsonl` to reach the nested files would silently ingest it as a fourth agent.
   */
  it('ignores the workflow journal sitting beside them', () => {
    const { subagents } = loadFixture(NAME)
    expect(subagents.map((a) => a.agentId).sort()).toEqual([
      'a28c2f8eb69294d78',
      'a2b84adb895396028',
      'a76ef90fbbf1b7354',
    ])
  })

  /**
   * Workflow agents carry no `toolUseId` — 177 of 177 on the reference machine, against
   * 205 of 205 `Task`-spawned agents that do. So they are unattached by construction, not
   * because anything went wrong, and the viewer has to have somewhere to put them.
   */
  it('reports every workflow agent as unattached, having no spawning call', () => {
    const { lines, subagents } = loadFixture(NAME)
    const parsed = parseSession({ sessionId: NAME, lines, subagents })

    expect(parsed.subagents.every((a) => a.parentToolUseId === undefined)).toBe(true)
    expect(parsed.unattachedSubagentIds).toHaveLength(3)
  })

  it('counts workflow spend as session spend', () => {
    const { lines, subagents } = loadFixture(NAME)

    const mainOnly = parseSession({ sessionId: NAME, lines })
    const withAgents = parseSession({ sessionId: NAME, lines, subagents })

    expect(withAgents.summary.usage.outputTokens).toBeGreaterThan(
      mainOnly.summary.usage.outputTokens,
    )
    expect(withAgents.summary.tokenEvents.filter((e) => e.agentId !== undefined).length).toBe(
      withAgents.summary.tokenEvents.length - mainOnly.summary.tokenEvents.length,
    )
  })

  /**
   * One response is written as several `assistant` records that share a `message.id` and
   * repeat the same usage. Both agents in `wf_6c8105ba-380` contain such a group, so a
   * per-record sum would double-count them here exactly as it did across the corpus.
   */
  it('bills one response once even when it spans several records', () => {
    const { lines, subagents } = loadFixture(NAME)
    const parsed = parseSession({ sessionId: NAME, lines, subagents })

    const agentRecords = parsed.subagents.flatMap((a) =>
      a.records.filter((r) => r.kind === 'assistant'),
    )
    expect(agentRecords.length).toBeGreaterThan(parsed.subagents.length)

    const events = parsed.summary.tokenEvents.filter((e) => e.agentId !== undefined)
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(events.length)
    expect(events.length).toBeLessThan(agentRecords.length)
  })
})
