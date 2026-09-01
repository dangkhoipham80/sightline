import { describe, expect, it } from 'vitest'
import { parseRecords } from './records.js'
import { deriveSessionSummary } from './session.js'

const line = (value: unknown): string => JSON.stringify(value)

const summarise = (lines: string[], fileSessionId = 'session-1') => {
  const { records, malformed } = parseRecords(lines)
  return deriveSessionSummary(records, { fileSessionId, malformed })
}

describe('deriveSessionSummary', () => {
  it('takes the last ai-title, since Claude rewrites it as the session evolves', () => {
    const summary = summarise([
      line({ type: 'ai-title', aiTitle: 'Investigating the bug' }),
      line({ type: 'ai-title', aiTitle: 'Fixing the auth redirect loop' }),
    ])
    expect(summary.aiTitle).toBe('Fixing the auth redirect loop')
  })

  /**
   * Trap 5. The filename is authoritative for identity; a differing `sessionId` in the
   * records means this file continues an earlier session.
   */
  it('detects a resume continuation from the filename/record mismatch', () => {
    const summary = summarise(
      [line({ type: 'user', uuid: 'u1', sessionId: 'older-session', message: { content: 'hi' } })],
      'newer-session',
    )
    expect(summary.sessionId).toBe('newer-session')
    expect(summary.continuesSessionId).toBe('older-session')
  })

  it('reports no continuation when the ids agree', () => {
    const summary = summarise(
      [line({ type: 'user', uuid: 'u1', sessionId: 'same', message: { content: 'hi' } })],
      'same',
    )
    expect(summary.continuesSessionId).toBeUndefined()
  })

  it('collects every working directory, because sessions move between them', () => {
    const summary = summarise([
      line({ type: 'user', uuid: 'u1', cwd: '/repo', message: { content: 'a' } }),
      line({ type: 'user', uuid: 'u2', cwd: '/repo/mobile', message: { content: 'b' } }),
      line({ type: 'user', uuid: 'u3', cwd: '/repo', message: { content: 'c' } }),
    ])
    expect(summary.cwds).toEqual(['/repo', '/repo/mobile'])
  })

  it('counts human turns separately from tool-result turns', () => {
    const summary = summarise([
      line({ type: 'user', uuid: 'u1', message: { content: 'do the thing' } }),
      line({
        type: 'user',
        uuid: 'u2',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      }),
    ])
    expect(summary.messageCount).toBe(2)
    expect(summary.userMessageCount).toBe(1)
  })

  it('derives file touches from tool inputs — the "what did Claude change" question', () => {
    const summary = summarise([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/src/auth.ts' } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/src/auth.ts' } },
            { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/src/auth.ts' } },
            { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ])

    expect(summary.toolCallCount).toBe(4)
    expect(summary.fileTouches).toEqual([
      { path: '/src/auth.ts', op: 'edit', count: 2, lastSeq: 0 },
      { path: '/src/auth.ts', op: 'read', count: 1, lastSeq: 0 },
    ])
  })

  it('accumulates token usage across assistant turns and tracks every model used', () => {
    const usage = (n: number) => ({
      input_tokens: n,
      output_tokens: n,
      cache_read_input_tokens: n,
      cache_creation_input_tokens: n,
    })
    const summary = summarise([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { model: 'claude-opus-5', content: [], usage: usage(10) },
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        message: { model: 'claude-haiku-4-5', content: [], usage: usage(5) },
      }),
      line({
        type: 'assistant',
        uuid: 'a3',
        message: { model: 'claude-opus-5', content: [], usage: usage(1) },
      }),
    ])

    // Three distinct responses, so all three count. They have no `message.id`, so each
    // falls back to its own record uuid — which is exactly the behaviour that keeps an
    // unidentifiable response counted once instead of dropped.
    expect(summary.usage).toEqual({
      inputTokens: 16,
      outputTokens: 16,
      cacheReadTokens: 16,
      cacheCreationTokens: 16,
      cacheCreation5mTokens: 16,
      cacheCreation1hTokens: 0,
    })
    expect(summary.models).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
  })

  /**
   * The bug this replaced: one API response is written as several `assistant` records —
   * a `thinking` block and the `tool_use` that follows it are two — and every one of them
   * repeats the same `message.usage`. Summing per record counted the same call twice.
   * Across the real corpus that inflated the total by 2.408×.
   */
  it('counts one API response once, however many records it was written as', () => {
    const summary = summarise([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'msg_01',
          model: 'claude-opus-5',
          content: [],
          usage: { input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 900 },
        },
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        message: {
          id: 'msg_01',
          model: 'claude-opus-5',
          content: [],
          // Same response, still streaming: input and cache identical, output grown.
          usage: { input_tokens: 100, output_tokens: 144, cache_read_input_tokens: 900 },
        },
      }),
    ])

    expect(summary.tokenEvents).toHaveLength(1)
    expect(summary.usage.inputTokens).toBe(100)
    expect(summary.usage.cacheReadTokens).toBe(900)
    // The final figure, not the first and not the sum of both.
    expect(summary.usage.outputTokens).toBe(144)
  })

  it('does not bill Claude Code’s own synthetic messages', () => {
    const summary = summarise([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'msg_01',
          model: '<synthetic>',
          content: [],
          usage: { input_tokens: 999, output_tokens: 999 },
        },
      }),
    ])

    expect(summary.tokenEvents).toHaveLength(0)
    expect(summary.usage.inputTokens).toBe(0)
  })

  it('captures queued prompts — what the user typed while Claude was still working', () => {
    const summary = summarise([
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'actually, point it at staging',
      }),
      line({ type: 'queue-operation', operation: 'dequeue', content: '' }),
    ])
    expect(summary.queuedPrompts).toEqual(['actually, point it at staging'])
  })

  it('links the session to the pull request it produced', () => {
    const summary = summarise([
      line({
        type: 'pr-link',
        prNumber: 2,
        prUrl: 'https://github.com/acme/example/pull/2',
        prRepository: 'acme/example',
      }),
    ])
    expect(summary.artifacts[0]).toMatchObject({ kind: 'pr-link', prNumber: 2 })
  })

  it('records turn durations from system records', () => {
    const summary = summarise([
      line({
        type: 'system',
        uuid: 's1',
        subtype: 'turn_duration',
        durationMs: 335898,
        messageCount: 68,
      }),
      line({ type: 'system', uuid: 's2', subtype: 'something_else', durationMs: 1 }),
    ])
    expect(summary.turnDurationsMs).toEqual([335898])
  })

  it('derives the time span from the earliest and latest timestamps, not file order', () => {
    const summary = summarise([
      line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-01T10:00:00.000Z',
        message: { content: 'a' },
      }),
      line({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-08-01T09:00:00.000Z',
        message: { content: 'b' },
      }),
      line({
        type: 'user',
        uuid: 'u3',
        timestamp: '2026-08-01T11:00:00.000Z',
        message: { content: 'c' },
      }),
    ])
    expect(summary.startedAt).toBe('2026-08-01T09:00:00.000Z')
    expect(summary.endedAt).toBe('2026-08-01T11:00:00.000Z')
  })

  it('carries malformed lines through so ingest can report them', () => {
    const summary = summarise(['{ broken', line({ type: 'mode', mode: 'normal' })])
    expect(summary.malformed).toHaveLength(1)
  })
})
