import { describe, expect, it } from 'vitest'
import { readFixture } from '../__fixtures__/load.js'
import type { ParsedSession } from '../parse/transcript.js'
import { parseSession } from '../parse/transcript.js'
import type { StepView } from './model.js'
import { buildTranscriptView, DIFF_LINE_LIMIT, RESULT_LIMIT } from './model.js'

function loadFixture(name: string): ParsedSession {
  return parseSession({ sessionId: name, ...readFixture(name) })
}

function toolSteps(steps: readonly StepView[]): Extract<StepView, { type: 'tool' }>[] {
  return steps.filter((s): s is Extract<StepView, { type: 'tool' }> => s.type === 'tool')
}

/** A minimal ParsedSession, for the shapes the fixtures happen not to contain. */
function synthetic(records: unknown[], overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    summary: { sessionId: 's1', cwds: [], malformed: [] } as never,
    records: records as never,
    tree: { roots: [], byUuid: new Map(), orphans: [], duplicateUuids: [] } as never,
    subagents: [],
    unattachedSubagentIds: [],
    ...overrides,
  }
}

function assistant(uuid: string, content: unknown[]): unknown {
  return { kind: 'assistant', seq: 0, envelope: { uuid }, raw: {}, content, text: '' }
}

function user(uuid: string, content: unknown[]): unknown {
  return { kind: 'user', seq: 1, envelope: { uuid }, raw: {}, content, text: '' }
}

describe('buildTranscriptView', () => {
  it('groups a real transcript into turns that each open on a typed prompt', () => {
    const view = buildTranscriptView(loadFixture('wsl-session-with-subagent'))

    expect(view.turns.length).toBeGreaterThan(0)
    expect(view.turns.map((t) => t.index)).toEqual(view.turns.map((_, i) => i))

    // Every turn after the first exists because a human said something.
    for (const turn of view.turns.slice(1)) {
      expect(turn.prompt?.text.length ?? 0).toBeGreaterThan(0)
    }
  })

  /**
   * The load-bearing join. Results arrive in a later record than the call they answer, so
   * a renderer that walks forward shows every tool call as if it never returned.
   *
   * Synthetic, reluctantly: neither committed fixture contains a single `tool_result`
   * block, so there is no real data to assert against yet. `anonymise-fixture.ts` does
   * not scrub `old_string`/`new_string`, which is what stands between us and capturing
   * a tool-rich session — fix that first, then rewrite this against a fixture.
   */
  it('attaches a tool result that arrived in a later record to the call it answers', () => {
    const view = buildTranscriptView(
      synthetic([
        user('u1', [{ type: 'text', text: 'read it' }]),
        assistant('a1', [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        ]),
        user('u2', [
          { type: 'tool_result', toolUseId: 't1', content: 'file body', isError: false },
        ]),
      ]),
    )

    const steps = view.turns[0]?.steps ?? []
    // The result record must not become a second turn, and must not render as a step.
    expect(view.turns).toHaveLength(1)
    expect(steps).toHaveLength(1)
    expect(toolSteps(steps)[0]?.result).toEqual({
      body: { text: 'file body', clipped: 0 },
      isError: false,
    })
  })

  it('marks a failed tool call as an error rather than as output', () => {
    const view = buildTranscriptView(
      synthetic([
        assistant('a1', [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'exit 1' } },
        ]),
        user('u2', [{ type: 'tool_result', toolUseId: 't1', content: 'boom', isError: true }]),
      ]),
    )

    expect(toolSteps(view.turns[0]?.steps ?? [])[0]?.result?.isError).toBe(true)
  })

  it('nests a subagent under the Task call that spawned it', () => {
    const parsed = loadFixture('wsl-session-with-subagent')
    expect(parsed.subagents.length).toBeGreaterThan(0)

    const view = buildTranscriptView(parsed)
    const spawning = view.turns
      .flatMap((t) => toolSteps(t.steps))
      .filter((t) => t.subagents !== undefined)

    expect(spawning.length).toBeGreaterThan(0)
    const [nested] = spawning[0]?.subagents ?? []
    expect(nested?.agentId).toBe(parsed.subagents[0]?.agentId)
    // The point of loading sidechains at all: the work has to come with them.
    expect(nested?.steps.length).toBeGreaterThan(0)
    expect(view.unattachedSubagents).toHaveLength(0)
  })

  it('surfaces a subagent whose spawning call is in an earlier file instead of dropping it', () => {
    const parsed = loadFixture('wsl-session-with-subagent')
    const orphaned: ParsedSession = {
      ...parsed,
      unattachedSubagentIds: parsed.subagents.map((a) => a.agentId),
    }

    const view = buildTranscriptView(orphaned)
    expect(view.unattachedSubagents).toHaveLength(parsed.subagents.length)
    expect(
      view.turns.flatMap((t) => toolSteps(t.steps)).every((t) => t.subagents === undefined),
    ).toBe(true)
    // It *had* a spawning call — the file simply does not contain it.
    expect(view.unattachedSubagents.every((a) => a.reason === 'spawning-call-elsewhere')).toBe(true)
  })

  /**
   * Two unrelated reasons produce an unattached subagent, and they used to share one
   * sentence in the UI claiming the session had been resumed. A workflow agent has no
   * `toolUseId` at all and was never attached to anything, so that explanation is not a
   * simplification of its case — it is a wrong answer about it.
   */
  it('separates an agent that never had a spawning call from one whose call is elsewhere', () => {
    const parsed = loadFixture('workflow-subagents')
    const view = buildTranscriptView(parsed)

    expect(view.unattachedSubagents).toHaveLength(3)
    expect(view.unattachedSubagents.every((a) => a.reason === 'no-spawning-call')).toBe(true)
    expect(view.unattachedSubagents.every((a) => a.agentType === 'workflow-subagent')).toBe(true)
  })

  it('renders an Edit as a diff and lists the file on its turn', () => {
    const view = buildTranscriptView(
      synthetic([
        user('u1', [{ type: 'text', text: 'fix the typo' }]),
        assistant('a1', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Edit',
            input: {
              file_path: '/repo/src/a.ts',
              old_string: 'const a = 1\n',
              new_string: 'const a = 2\n',
            },
          },
        ]),
      ]),
    )

    const [tool] = toolSteps(view.turns[0]?.steps ?? [])
    expect(tool?.diffs).toHaveLength(1)
    expect(tool?.diffs?.[0]?.diff.stat).toMatchObject({ added: 1, removed: 1 })
    expect(view.turns[0]?.filesTouched).toEqual(['/repo/src/a.ts'])
  })

  it('diffs a Write against nothing, so a new file reads as all additions', () => {
    const view = buildTranscriptView(
      synthetic([
        assistant('a1', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Write',
            input: { file_path: '/repo/new.ts', content: 'one\ntwo\n' },
          },
        ]),
      ]),
    )

    const [tool] = toolSteps(view.turns[0]?.steps ?? [])
    expect(tool?.diffs?.[0]?.diff.stat).toMatchObject({ added: 2, removed: 0 })
  })

  it('drops hunks past the diff limit but keeps the stat honest', () => {
    const after = Array.from({ length: DIFF_LINE_LIMIT * 2 }, (_, i) => `line ${i}`).join('\n')
    const view = buildTranscriptView(
      synthetic([
        assistant('a1', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Write',
            input: { file_path: '/f.ts', content: after },
          },
        ]),
      ]),
    )

    const diff = toolSteps(view.turns[0]?.steps ?? [])[0]?.diffs?.[0]
    expect(diff?.clipped).toBe(true)
    expect(diff?.diff.stat.added).toBe(DIFF_LINE_LIMIT * 2)
  })

  it('clips an oversized tool result and reports how much it dropped', () => {
    const body = 'x'.repeat(RESULT_LIMIT + 500)
    const view = buildTranscriptView(
      synthetic([
        assistant('a1', [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/big' } },
        ]),
        user('u2', [{ type: 'tool_result', toolUseId: 't1', content: body, isError: false }]),
      ]),
    )

    const result = toolSteps(view.turns[0]?.steps ?? [])[0]?.result
    expect(result?.body.text).toHaveLength(RESULT_LIMIT)
    expect(result?.body.clipped).toBe(500)
  })

  it('shows a slash command by name rather than as its expansion tags', () => {
    const view = buildTranscriptView(
      synthetic([
        user('u1', [
          {
            type: 'text',
            text: '<command-name>/ship-pr</command-name>\n<command-args>--draft</command-args>',
          },
        ]),
      ]),
    )

    expect(view.turns[0]?.prompt?.text).toBe('/ship-pr --draft')
  })

  it('does not repeat the prompt as a step inside its own turn', () => {
    const view = buildTranscriptView(
      synthetic([
        user('u1', [{ type: 'text', text: 'do the thing' }]),
        assistant('a1', [{ type: 'text', text: 'done' }]),
      ]),
    )

    expect(view.turns[0]?.prompt?.text).toBe('do the thing')
    expect(view.turns[0]?.steps).toHaveLength(1)
    expect(view.turns[0]?.steps[0]).toMatchObject({ type: 'prose', body: { text: 'done' } })
  })

  it('produces a view that survives a JSON round trip', () => {
    const view = buildTranscriptView(loadFixture('wsl-session-with-subagent'))
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
  })
})
