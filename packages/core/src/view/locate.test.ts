import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SubagentInput } from '../parse/subagents.js'
import { agentIdFromFilename } from '../parse/subagents.js'
import type { ParsedSession } from '../parse/transcript.js'
import { parseSession } from '../parse/transcript.js'
import { locateMessage } from './locate.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__')

function loadFixture(name: string): ParsedSession {
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

  return parseSession({ sessionId: name, lines, subagents })
}

const line = (value: unknown): string => JSON.stringify(value)

describe('locateMessage', () => {
  it('finds a message in the main thread and names its turn', () => {
    const parsed = parseSession({
      sessionId: 's1',
      lines: [
        line({ type: 'user', uuid: 'u1', message: { content: 'first' } }),
        line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [] } }),
        line({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'second' } }),
        line({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: [] } }),
      ],
    })

    expect(locateMessage(parsed, 'u1')).toEqual({ turnIndex: 0 })
    expect(locateMessage(parsed, 'a1')).toEqual({ turnIndex: 0 })
    expect(locateMessage(parsed, 'a2')).toEqual({ turnIndex: 1 })
  })

  it('returns undefined for a uuid this file does not contain', () => {
    const parsed = parseSession({
      sessionId: 's1',
      lines: [line({ type: 'user', uuid: 'u1', message: { content: 'x' } })],
    })
    // The index outlives the transcript, so a stale link is expected, not exceptional.
    expect(locateMessage(parsed, 'gone')).toBeUndefined()
  })

  /**
   * The case that matters. Subagent records live in a sibling file and have no anchor of
   * their own, so a hit inside one has to resolve to the turn that spawned the agent.
   */
  it('resolves a hit inside a subagent to the turn that spawned it', () => {
    const parsed = loadFixture('wsl-session-with-subagent')
    const subagent = parsed.subagents[0]
    expect(subagent).toBeDefined()

    const inner = subagent?.records.find((r) => r.envelope.uuid !== undefined)
    expect(inner?.envelope.uuid).toBeDefined()

    const located = locateMessage(parsed, inner?.envelope.uuid ?? '')
    expect(located?.agentId).toBe(subagent?.agentId)
    expect(located?.turnIndex).toBeGreaterThanOrEqual(0)
  })

  it('still points somewhere when the spawning call is in an earlier file', () => {
    const parsed = loadFixture('wsl-session-with-subagent')
    const subagent = parsed.subagents[0]
    const inner = subagent?.records.find((r) => r.envelope.uuid !== undefined)

    // Same session with the link to the spawning call severed, as happens on a resume.
    const orphaned: ParsedSession = {
      ...parsed,
      subagents: parsed.subagents.map((a) => {
        const { parentToolUseId: _drop, ...rest } = a
        return rest
      }),
    }

    const located = locateMessage(orphaned, inner?.envelope.uuid ?? '')
    expect(located?.agentId).toBe(subagent?.agentId)
    expect(located).toHaveProperty('turnIndex')
  })

  it('prefers the main thread when a uuid somehow appears in both', () => {
    const parsed = loadFixture('wsl-session-with-subagent')
    const mainUuid = parsed.records.find((r) => r.envelope.uuid !== undefined)?.envelope.uuid
    expect(locateMessage(parsed, mainUuid ?? '')?.agentId).toBeUndefined()
  })
})
