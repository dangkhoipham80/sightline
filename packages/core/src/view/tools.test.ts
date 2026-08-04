import { describe, expect, it } from 'vitest'
import { editPreviews, summariseTool, truncateMiddle } from './tools.js'

describe('summariseTool', () => {
  it.each([
    ['Read', { file_path: '/a/b.ts' }, { kind: 'read', target: '/a/b.ts' }],
    ['Edit', { file_path: '/a/b.ts' }, { kind: 'edit', target: '/a/b.ts' }],
    ['Write', { file_path: '/a/b.ts' }, { kind: 'write', target: '/a/b.ts' }],
    [
      'Bash',
      { command: 'pnpm test', description: 'Run tests' },
      { kind: 'run', target: 'pnpm test', detail: 'Run tests' },
    ],
    ['Grep', { pattern: 'TODO', path: 'src' }, { kind: 'search', target: 'TODO', detail: 'src' }],
    [
      'Task',
      { description: 'Find bugs', subagent_type: 'Explore' },
      { kind: 'task', target: 'Find bugs', detail: 'Explore' },
    ],
    ['TodoWrite', { todos: [1, 2, 3] }, { kind: 'todo', target: '3 items' }],
    ['Skill', { skill: 'ship-pr', args: '--draft' }, { kind: 'task', target: 'ship-pr' }],
    ['ToolSearch', { query: 'select:Read' }, { kind: 'search', target: 'select:Read' }],
    ['TaskCreate', { subject: 'Wire the viewer' }, { kind: 'todo', target: 'Wire the viewer' }],
    [
      'TaskUpdate',
      { taskId: '3', status: 'completed' },
      { kind: 'todo', target: '3', detail: 'completed' },
    ],
  ])('summarises %s', (name, input, expected) => {
    expect(summariseTool(name, input as never)).toMatchObject(expected)
  })

  /**
   * The name of the subagent-spawning tool changed: `Task` in older transcripts, `Agent`
   * at 2.1.198. Across 8,800 real tool calls on this machine, `Agent` appears 54 times and
   * `Task` never. Falling through to `other` would strip the description and the glyph
   * from the one row that heads an entire sub-thread.
   */
  it.each(['Agent', 'Task'])('recognises %s as the tool that spawns a subagent', (name) => {
    expect(
      summariseTool(name, { description: 'Find bugs', subagent_type: 'Explore' } as never),
    ).toMatchObject({ kind: 'task', target: 'Find bugs', detail: 'Explore' })
  })

  it('summarises AskUserQuestion by its first question', () => {
    const input = {
      questions: [{ question: 'Which approach?', header: 'Approach' }, { question: 'Second?' }],
    }
    expect(summariseTool('AskUserQuestion', input as never)).toMatchObject({
      target: 'Which approach?',
    })
  })

  it('falls back to the header when a question has no text', () => {
    expect(
      summariseTool('AskUserQuestion', { questions: [{ header: 'Fixtures' }] } as never),
    ).toMatchObject({ target: 'Fixtures' })
  })

  it('does not throw on an AskUserQuestion with no questions', () => {
    expect(summariseTool('AskUserQuestion', { questions: [] } as never)).toEqual({
      name: 'AskUserQuestion',
      kind: 'other',
    })
  })

  /** An unfamiliar tool is one we have not met yet, not an error — same stance as the parser. */
  it('falls back to the bare name for a tool it does not know', () => {
    expect(summariseTool('SomeFutureTool', { wat: 1 } as never)).toEqual({
      name: 'SomeFutureTool',
      kind: 'other',
    })
  })

  it('still finds a path in an unfamiliar tool that has one', () => {
    expect(summariseTool('FutureEdit', { file_path: '/x.ts' } as never)).toMatchObject({
      target: '/x.ts',
    })
  })

  it('survives input that is not an object at all', () => {
    expect(() => summariseTool('Read', null)).not.toThrow()
    expect(() => summariseTool('Read', 'a string' as never)).not.toThrow()
    expect(summariseTool('Read', null)).toEqual({ name: 'Read', kind: 'read' })
  })

  it('omits a field rather than showing an empty one', () => {
    expect(summariseTool('Bash', { command: '', description: '' } as never)).toEqual({
      name: 'Bash',
      kind: 'run',
    })
  })
})

describe('editPreviews', () => {
  it('pairs an edit before and after', () => {
    expect(
      editPreviews('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' } as never),
    ).toEqual([{ filePath: '/a.ts', before: 'x', after: 'y' }])
  })

  it('diffs a write against nothing, because all of it is new', () => {
    expect(editPreviews('Write', { file_path: '/a.ts', content: 'hello' } as never)).toEqual([
      { filePath: '/a.ts', before: '', after: 'hello' },
    ])
  })

  it('labels each edit of a MultiEdit so they can be told apart', () => {
    const previews = editPreviews('MultiEdit', {
      file_path: '/a.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    } as never)

    expect(previews).toHaveLength(2)
    expect(previews?.[0]?.label).toBe('edit 1 of 2')
    expect(previews?.[1]).toMatchObject({ before: 'c', after: 'd' })
  })

  it('skips a malformed edit inside an otherwise usable MultiEdit', () => {
    const previews = editPreviews('MultiEdit', {
      file_path: '/a.ts',
      edits: [{ old_string: 'a' }, { old_string: 'c', new_string: 'd' }],
    } as never)

    expect(previews).toHaveLength(1)
  })

  it('has no preview for a tool that changes no file', () => {
    expect(editPreviews('Bash', { command: 'ls' } as never)).toBeUndefined()
    expect(editPreviews('Edit', { file_path: '/a.ts' } as never)).toBeUndefined()
  })
})

describe('truncateMiddle', () => {
  it('leaves a short value alone', () => {
    expect(truncateMiddle('pnpm test')).toBe('pnpm test')
  })

  it('keeps both ends, because the informative part of a path is the end', () => {
    const result = truncateMiddle('a'.repeat(60) + '/the/interesting/part.ts', 40)
    expect(result).toHaveLength(40)
    expect(result).toContain('…')
    expect(result.endsWith('part.ts')).toBe(true)
  })

  it('collapses a multi-line command onto one line', () => {
    expect(truncateMiddle('one\n  two\n  three')).toBe('one two three')
  })
})
