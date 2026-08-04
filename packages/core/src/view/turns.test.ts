import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SubagentInput } from '../parse/subagents.js'
import { agentIdFromFilename } from '../parse/subagents.js'
import { parseSession } from '../parse/transcript.js'
import type { TranscriptRecord } from '../types.js'
import { groupTurns, indexToolResults, isUserPrompt, toolResultText } from './turns.js'

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
      subagents.push({
        agentId,
        lines: readFileSync(join(subagentDir, filename), 'utf8').split('\n'),
      })
    }
  }

  return parseSession({ sessionId: name, lines, subagents })
}

/** Hand-built records for the shapes a fixture happens not to contain. */
function user(
  uuid: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
): TranscriptRecord {
  return {
    kind: 'user',
    seq: 0,
    envelope: { uuid, ...extra },
    raw: {},
    content: content as never,
    text: '',
  } as TranscriptRecord
}

describe('isUserPrompt', () => {
  /**
   * The distinction the whole grouping rests on. Claude Code returns tool output as a
   * `user` record, so treating every user record as a prompt shreds one turn into one
   * fragment per tool call.
   */
  it('rejects a user record that only carries tool results', () => {
    const record = user('u1', [
      { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
    ])
    expect(isUserPrompt(record)).toBe(false)
  })

  it('accepts a user record with typed text', () => {
    expect(isUserPrompt(user('u1', [{ type: 'text', text: 'do the thing' }]))).toBe(true)
  })

  it('rejects a meta record even when it carries text', () => {
    const record = user('u1', [{ type: 'text', text: 'system note' }], { isMeta: true })
    expect(isUserPrompt(record)).toBe(false)
  })

  it('rejects whitespace-only text', () => {
    expect(isUserPrompt(user('u1', [{ type: 'text', text: '   \n ' }]))).toBe(false)
  })

  it('accepts a prompt that also carries a tool result', () => {
    const record = user('u1', [
      { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
      { type: 'text', text: 'now do this' },
    ])
    expect(isUserPrompt(record)).toBe(true)
  })
})

describe('groupTurns', () => {
  it('opens a turn on each prompt and keeps the work under it', () => {
    const records = [
      user('u1', [{ type: 'text', text: 'first' }]),
      {
        kind: 'assistant',
        seq: 1,
        envelope: { uuid: 'a1' },
        raw: {},
        text: '',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
      },
      user('u2', [{ type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }]),
      user('u3', [{ type: 'text', text: 'second' }]),
    ] as TranscriptRecord[]

    const turns = groupTurns(records)

    expect(turns).toHaveLength(2)
    expect(turns[0]?.records).toHaveLength(3)
    expect(turns[0]?.toolCallCount).toBe(1)
    expect(turns[0]?.toolUseIds).toEqual(['t1'])
    expect(turns[1]?.prompt?.envelope.uuid).toBe('u3')
  })

  /** A resumed file can open mid-conversation; that work still has to land somewhere. */
  it('gives records before the first prompt a turn of their own', () => {
    const records = [
      {
        kind: 'assistant',
        seq: 0,
        envelope: { uuid: 'a1' },
        raw: {},
        text: 'continuing',
        content: [],
      },
      user('u1', [{ type: 'text', text: 'now this' }]),
    ] as TranscriptRecord[]

    const turns = groupTurns(records)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.prompt).toBeUndefined()
  })

  it('ignores records that are not part of the conversation', () => {
    const records = [
      { kind: 'ai-title', seq: 0, envelope: {}, raw: {}, aiTitle: 'x' },
      user('u1', [{ type: 'text', text: 'hello' }]),
    ] as TranscriptRecord[]

    expect(groupTurns(records)[0]?.records).toHaveLength(1)
  })

  it('has no turns for an empty session', () => {
    expect(groupTurns([])).toEqual([])
  })

  it('spans a turn from its first timestamp to its last', () => {
    const records = [
      user('u1', [{ type: 'text', text: 'go' }], { timestamp: '2026-08-01T00:00:00Z' }),
      {
        kind: 'assistant',
        seq: 1,
        envelope: { uuid: 'a1', timestamp: '2026-08-01T00:05:00Z' },
        raw: {},
        text: '',
        content: [],
      },
    ] as TranscriptRecord[]

    expect(groupTurns(records)[0]).toMatchObject({
      startedAt: '2026-08-01T00:00:00Z',
      endedAt: '2026-08-01T00:05:00Z',
    })
  })

  /**
   * The claim that matters, made against a real capture rather than against my own
   * assumptions: a session's turns must be far fewer than its user records.
   */
  it('produces readable turns from a real transcript', () => {
    const parsed = loadFixture('wsl-session-with-subagent')
    const turns = groupTurns(parsed.records)
    const userRecords = parsed.records.filter((r) => r.kind === 'user').length

    expect(turns.length).toBeGreaterThan(0)
    expect(turns.length).toBeLessThanOrEqual(userRecords)
    // Every conversation record lands in exactly one turn — nothing is lost in grouping.
    const grouped = turns.reduce((sum, t) => sum + t.records.length, 0)
    const conversation = parsed.records.filter(
      (r) => r.kind === 'user' || r.kind === 'assistant' || r.kind === 'system',
    ).length
    expect(grouped).toBe(conversation)
  })
})

describe('indexToolResults', () => {
  it('finds a result by the call it answers', () => {
    const records = [
      user('u1', [{ type: 'tool_result', toolUseId: 't1', content: 'output', isError: false }]),
    ] as TranscriptRecord[]

    expect(indexToolResults(records).get('t1')).toEqual({ content: 'output', isError: false })
  })

  it('keeps the error flag, because a failed call reads very differently', () => {
    const records = [
      user('u1', [{ type: 'tool_result', toolUseId: 't1', content: 'boom', isError: true }]),
    ] as TranscriptRecord[]

    expect(indexToolResults(records).get('t1')?.isError).toBe(true)
  })
})

describe('toolResultText', () => {
  it('passes a plain string through', () => {
    expect(toolResultText('hello')).toBe('hello')
  })

  it('joins the text of a block array', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
  })

  it('stringifies a shape it does not recognise rather than dropping it', () => {
    expect(toolResultText({ weird: true })).toContain('weird')
  })

  it('renders nothing for an absent result', () => {
    expect(toolResultText(null)).toBe('')
    expect(toolResultText(undefined)).toBe('')
  })
})
