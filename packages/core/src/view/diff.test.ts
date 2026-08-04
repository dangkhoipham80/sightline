import { describe, expect, it } from 'vitest'
import { diffLines } from './diff.js'

const render = (before: string, after: string, context = 3) =>
  diffLines(before, after, context).hunks.flatMap((h) =>
    h.lines.map((l) => `${sign(l.kind)}${l.text}`),
  )

const sign = (kind: string) => (kind === 'add' ? '+' : kind === 'remove' ? '-' : ' ')

describe('diffLines', () => {
  it('reports a one-line change as one line changed', () => {
    expect(render('a\nb\nc\n', 'a\nB\nc\n')).toEqual([' a', '-b', '+B', ' c'])
  })

  it('counts additions and removals', () => {
    const { stat } = diffLines('a\nb\n', 'a\nB\nc\n')
    expect(stat).toEqual({ added: 2, removed: 1, truncated: false })
  })

  /** A `Write` has no before text, and every line of it is genuinely new. */
  it('treats a write as all additions', () => {
    const { hunks, stat } = diffLines('', 'one\ntwo\n')
    expect(stat).toMatchObject({ added: 2, removed: 0 })
    expect(hunks[0]?.lines.every((l) => l.kind === 'add')).toBe(true)
  })

  it('finds a deletion without shifting everything after it', () => {
    expect(render('a\nb\nc\nd\n', 'a\nc\nd\n')).toEqual([' a', '-b', ' c', ' d'])
  })

  it('numbers lines against their own side of the change', () => {
    const [hunk] = diffLines('a\nb\n', 'a\nB\n').hunks
    const removed = hunk?.lines.find((l) => l.kind === 'remove')
    const added = hunk?.lines.find((l) => l.kind === 'add')

    expect(removed).toMatchObject({ oldLine: 2 })
    expect(removed?.newLine).toBeUndefined()
    expect(added).toMatchObject({ newLine: 2 })
    expect(added?.oldLine).toBeUndefined()
  })

  /**
   * The reason hunks exist: an edit three lines into a 200-line file is unreadable without
   * the lines around it and unusable with all 200.
   */
  it('keeps context around a change and drops the rest', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 30', 'line thirty')

    const { hunks } = diffLines(before, after, 2)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]?.lines).toHaveLength(6) // 2 context + remove + add + 2 context
    expect(hunks[0]?.skippedBefore).toBe(28)
  })

  it('splits distant changes into separate hunks', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 2', 'CHANGED').replace('line 35', 'ALSO')

    expect(diffLines(before, after, 1).hunks).toHaveLength(2)
  })

  it('has nothing to show when nothing changed', () => {
    expect(diffLines('a\nb\n', 'a\nb\n').hunks).toEqual([])
  })

  it('does not invent a trailing empty line', () => {
    expect(diffLines('a\n', 'a\n').stat).toMatchObject({ added: 0, removed: 0 })
    expect(render('', 'a\n')).toEqual(['+a'])
  })

  it('treats CRLF and LF as the same text', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nb\n').stat).toMatchObject({ added: 0, removed: 0 })
  })

  /** Quadratic alignment is fine for an edit fragment and not fine for two large files. */
  it('falls back to a wholesale replacement rather than churning on a huge input', () => {
    const big = Array.from({ length: 3200 }, (_, i) => `line ${i}`).join('\n')
    const other = Array.from({ length: 3200 }, (_, i) => `other ${i}`).join('\n')

    const { stat } = diffLines(big, other)
    expect(stat.truncated).toBe(true)
    expect(stat).toMatchObject({ added: 3200, removed: 3200 })
  })
})
