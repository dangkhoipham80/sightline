import { describe, expect, it } from 'vitest'
import { linkLineages } from './lineage.js'

describe('linkLineages', () => {
  it('joins a resume chain into one lineage, oldest first', () => {
    const lineages = linkLineages([
      { sessionId: 'c', continuesSessionId: 'b', startedAt: '2026-08-03T00:00:00Z' },
      { sessionId: 'a', startedAt: '2026-08-01T00:00:00Z' },
      { sessionId: 'b', continuesSessionId: 'a', startedAt: '2026-08-02T00:00:00Z' },
    ])

    expect(lineages).toHaveLength(1)
    expect(lineages[0]?.rootSessionId).toBe('a')
    expect(lineages[0]?.sessionIds).toEqual(['a', 'b', 'c'])
    expect(lineages[0]?.truncated).toBe(false)
  })

  it('keeps unrelated sessions in separate lineages', () => {
    const lineages = linkLineages([
      { sessionId: 'a', startedAt: '2026-08-01T00:00:00Z' },
      { sessionId: 'x', startedAt: '2026-08-05T00:00:00Z' },
    ])
    expect(lineages.map((l) => l.rootSessionId)).toEqual(['a', 'x'])
  })

  /**
   * Claude Code deletes transcripts past `cleanupPeriodDays` (30 by default), so a chain
   * whose root points at a session we no longer have is normal — and worth surfacing.
   * "Your history was truncated" is a different statement from "there is no history".
   */
  it('marks a chain truncated when its parent transcript is gone', () => {
    const lineages = linkLineages([
      {
        sessionId: 'b',
        continuesSessionId: 'deleted-by-cleanup',
        startedAt: '2026-08-02T00:00:00Z',
      },
    ])
    expect(lineages).toHaveLength(1)
    expect(lineages[0]?.rootSessionId).toBe('b')
    expect(lineages[0]?.truncated).toBe(true)
  })

  it('breaks a cycle rather than looping forever', () => {
    const lineages = linkLineages([
      { sessionId: 'a', continuesSessionId: 'b' },
      { sessionId: 'b', continuesSessionId: 'a' },
    ])
    expect(lineages).toHaveLength(1)
    expect(lineages[0]?.sessionIds).toHaveLength(2)
  })

  it('is stable when timestamps are missing', () => {
    const lineages = linkLineages([{ sessionId: 'b', continuesSessionId: 'a' }, { sessionId: 'a' }])
    expect(lineages[0]?.sessionIds).toEqual(['a', 'b'])
  })

  it('ignores duplicate session ids', () => {
    const lineages = linkLineages([{ sessionId: 'a' }, { sessionId: 'a' }])
    expect(lineages).toHaveLength(1)
    expect(lineages[0]?.sessionIds).toEqual(['a'])
  })
})
