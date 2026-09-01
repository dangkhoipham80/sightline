import { describe, expect, it } from 'vitest'
import { fixtureNames, readFixture } from '../__fixtures__/load.js'
import { parseSession } from '../parse/transcript.js'
import { renderMarkdown } from './markdown.js'
import type { TranscriptView } from './model.js'
import { buildTranscriptView } from './model.js'

function loadView(name: string): TranscriptView {
  return buildTranscriptView(parseSession({ sessionId: name, ...readFixture(name) }))
}

describe('renderMarkdown', () => {
  it('renders every fixture without throwing and always ends in a single newline', () => {
    for (const name of fixtureNames()) {
      const markdown = renderMarkdown(loadView(name))

      expect(markdown.endsWith('\n'), name).toBe(true)
      expect(markdown.endsWith('\n\n'), name).toBe(false)
      expect(markdown, name).toContain('# ')
    }
  })

  it('opens with front matter naming the session', () => {
    const view = loadView('wsl-session-with-subagent')
    const markdown = renderMarkdown(view, { title: 'A title: with a colon' })

    expect(markdown.startsWith('---\n')).toBe(true)
    expect(markdown).toContain(`session_id: "${view.sessionId}"`)
    // Quoted unconditionally — an unquoted colon makes this a nested mapping.
    expect(markdown).toContain('title: "A title: with a colon"')
  })

  it('escapes a Windows path in front matter rather than emitting invalid YAML', () => {
    const markdown = renderMarkdown(loadView('wsl-session-with-subagent'), {
      cwd: 'D:\\Management_Vibe_Coding',
    })

    expect(markdown).toContain('cwd: "D:\\\\Management_Vibe_Coding"')
  })

  it('emits one turn heading per turn', () => {
    const view = loadView('wsl-session-with-subagent')
    const headings = renderMarkdown(view).match(/^## Turn \d+/gm) ?? []

    expect(headings).toHaveLength(view.turns.length)
  })

  it('renders the subagents that a workflow session has no spawning call for', () => {
    // 177 of these existed unindexed until #20. An export that dropped them would look
    // complete and be missing most of the session.
    const view = loadView('workflow-subagents')
    expect(view.unattachedSubagents.length).toBeGreaterThan(0)

    const markdown = renderMarkdown(view)
    expect(markdown).toContain('## Subagents with no spawning call')
    for (const agent of view.unattachedSubagents) {
      expect(markdown).toContain(`Subagent \`${agent.agentId}\``)
    }
  })

  // Synthetic rather than fixture-backed: no committed fixture carries a thinking block,
  // and asserting over a fixture that happens not to contain one would pass vacuously.
  it('omits thinking by default and includes it on request', () => {
    const view: TranscriptView = {
      sessionId: 's1',
      turns: [
        {
          index: 0,
          steps: [{ id: 'k1', type: 'thinking', body: { text: 'weighing it up', clipped: 0 } }],
          toolCallCount: 0,
          filesTouched: [],
          subagentCount: 0,
        },
      ],
      unattachedSubagents: [],
      toolCallCount: 0,
      malformedCount: 0,
    }

    expect(renderMarkdown(view)).not.toContain('weighing it up')
    expect(renderMarkdown(view, {}, { includeThinking: true })).toContain('weighing it up')
  })

  it('says how much text it dropped instead of trailing off', () => {
    const markdown = renderMarkdown(
      {
        sessionId: 's1',
        turns: [
          {
            index: 0,
            prompt: { text: 'do the thing', clipped: 4200 },
            steps: [],
            toolCallCount: 0,
            filesTouched: [],
            subagentCount: 0,
          },
        ],
        unattachedSubagents: [],
        toolCallCount: 0,
        malformedCount: 0,
      },
      {},
    )

    expect(markdown).toContain('4,200 more characters not shown')
  })

  it('widens the fence when a tool result contains one', () => {
    const body = 'here is code:\n```ts\nconst a = 1\n```\ndone'
    const markdown = renderMarkdown({
      sessionId: 's1',
      turns: [
        {
          index: 0,
          steps: [
            {
              id: 't1',
              type: 'tool',
              summary: { name: 'Bash', kind: 'run', target: 'echo hi' },
              input: { text: '{}', clipped: 0 },
              result: { body: { text: body, clipped: 0 }, isError: false },
            },
          ],
          toolCallCount: 1,
          filesTouched: [],
          subagentCount: 0,
        },
      ],
      unattachedSubagents: [],
      toolCallCount: 1,
      malformedCount: 0,
    })

    // A three-backtick fence would close on the body's own fence and mangle everything
    // after it — the kind of breakage that reads as a parser bug.
    expect(markdown).toContain('````text')
    expect(markdown).toContain(body)
  })

  it('renders a diff as a diff fence carrying the whole-change stat', () => {
    const markdown = renderMarkdown({
      sessionId: 's1',
      turns: [
        {
          index: 0,
          steps: [
            {
              id: 't1',
              type: 'tool',
              summary: { name: 'Edit', kind: 'edit', target: 'a.ts' },
              input: { text: '{}', clipped: 0 },
              diffs: [
                {
                  filePath: 'a.ts',
                  clipped: true,
                  diff: {
                    hunks: [
                      {
                        skippedBefore: 12,
                        lines: [
                          { kind: 'remove', text: 'old', oldLine: 1 },
                          { kind: 'add', text: 'new', newLine: 1 },
                        ],
                      },
                    ],
                    stat: { added: 40, removed: 9, truncated: false },
                  },
                },
              ],
            },
          ],
          toolCallCount: 1,
          filesTouched: ['a.ts'],
          subagentCount: 0,
        },
      ],
      unattachedSubagents: [],
      toolCallCount: 1,
      malformedCount: 0,
    })

    expect(markdown).toContain('```diff')
    expect(markdown).toContain('-old')
    expect(markdown).toContain('+new')
    expect(markdown).toContain('@@ 12 unchanged lines @@')
    // The stat describes the change, not the excerpt.
    expect(markdown).toContain('+40 −9')
    expect(markdown).toContain('Diff truncated')
  })

  it('reports malformed lines rather than hiding them', () => {
    const markdown = renderMarkdown({
      sessionId: 's1',
      turns: [],
      unattachedSubagents: [],
      toolCallCount: 0,
      malformedCount: 3,
    })

    expect(markdown).toContain('3 lines in the transcript could not be parsed')
  })
})
