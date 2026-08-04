import { describe, expect, it } from 'vitest'
import { axisTicks, bucketSessions, buildRange, peak, rampStep } from './timeline'

const at = (iso: string, messageCount = 1) => ({ startedAt: iso, messageCount })

describe('buildRange', () => {
  it('snaps out to whole days so the last day gets a full bucket', () => {
    const range = buildRange([at('2026-07-01T13:20:00Z'), at('2026-07-03T09:00:00Z')])

    expect(range).toBeDefined()
    expect(new Date(range?.startMs ?? 0).toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(new Date(range?.endMs ?? 0).toISOString()).toBe('2026-07-04T00:00:00.000Z')
  })

  it('never buckets finer than a day', () => {
    const range = buildRange([at('2026-07-01T09:00:00Z'), at('2026-07-01T17:00:00Z')])
    expect(range?.bucketMs).toBe(86_400_000)
    expect(range?.bucketCount).toBe(1)
  })

  it('widens the bucket rather than the count on a long corpus', () => {
    const range = buildRange([at('2024-01-01T00:00:00Z'), at('2026-01-01T00:00:00Z')], 100)
    expect(range?.bucketCount).toBeLessThanOrEqual(101)
    expect(range?.bucketMs).toBeGreaterThan(86_400_000)
  })

  /** A corpus with no usable timestamp gets no axis, rather than one starting at 1970. */
  it('returns undefined when nothing has a parseable timestamp', () => {
    expect(buildRange([{ startedAt: null, messageCount: 4 }])).toBeUndefined()
    expect(buildRange([at('not a date')])).toBeUndefined()
    expect(buildRange([])).toBeUndefined()
  })
})

describe('bucketSessions', () => {
  it('places each session in the bucket its start falls in', () => {
    const sessions = [
      at('2026-07-01T01:00:00Z', 10),
      at('2026-07-01T23:00:00Z', 5),
      at('2026-07-03T12:00:00Z', 7),
    ]
    const range = buildRange(sessions)
    if (range === undefined) throw new Error('expected a range')

    const buckets = bucketSessions(sessions, range)

    expect(buckets).toHaveLength(3)
    expect(buckets[0]).toMatchObject({ sessions: 2, messages: 15 })
    expect(buckets[1]).toMatchObject({ sessions: 0, messages: 0 })
    expect(buckets[2]).toMatchObject({ sessions: 1, messages: 7 })
  })

  /**
   * The dashboard buckets one project's sessions against the *whole corpus's* range, so
   * out-of-range input is the normal case, not a corrupt one.
   */
  it('ignores sessions outside the range instead of clamping them to an edge', () => {
    const range = buildRange([at('2026-07-01T00:00:00Z')])
    if (range === undefined) throw new Error('expected a range')

    const buckets = bucketSessions([at('2026-06-01T00:00:00Z'), at('2026-08-01T00:00:00Z')], range)
    expect(buckets.every((b) => b.sessions === 0)).toBe(true)
  })

  it('survives a session with no timestamp', () => {
    const range = buildRange([at('2026-07-01T00:00:00Z')])
    if (range === undefined) throw new Error('expected a range')

    expect(() => bucketSessions([{ startedAt: null, messageCount: 3 }], range)).not.toThrow()
  })
})

describe('axisTicks', () => {
  it('uses month boundaries once the range is long enough to carry them', () => {
    const range = buildRange([at('2026-01-15T00:00:00Z'), at('2026-08-20T00:00:00Z')])
    if (range === undefined) throw new Error('expected a range')

    expect(axisTicks(range).map((t) => t.label)).toEqual([
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
    ])
  })

  /**
   * The case that showed up the moment this ran on real data: three weeks of transcripts
   * span exactly one month boundary, and an axis with a single label is not an axis.
   */
  it('falls back to dated ticks on a short range', () => {
    const range = buildRange([at('2026-07-17T00:00:00Z'), at('2026-08-04T00:00:00Z')])
    if (range === undefined) throw new Error('expected a range')

    const ticks = axisTicks(range)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks[0]?.label).toBe('17 Jul')
    expect(ticks[0]?.position).toBe(0)
  })

  it('keeps every tick inside the strip', () => {
    const range = buildRange([at('2026-07-01T00:00:00Z'), at('2026-07-20T00:00:00Z')])
    if (range === undefined) throw new Error('expected a range')

    expect(axisTicks(range).every((t) => t.position >= 0 && t.position < 1)).toBe(true)
  })

  it('has no ticks to place when the range is degenerate', () => {
    expect(axisTicks({ startMs: 0, endMs: 0, bucketMs: 1, bucketCount: 0 })).toEqual([])
  })
})

describe('rampStep', () => {
  it('gives an empty bucket no mark at all', () => {
    expect(rampStep(0, 100)).toBe(0)
  })

  it('rises monotonically with magnitude', () => {
    const steps = [1, 20, 50, 90].map((v) => rampStep(v, 100))
    expect(steps).toEqual([1, 2, 3, 4])
  })

  /** Before the first scan every count is zero; dividing by that peak must not produce NaN. */
  it('handles a peak of zero', () => {
    expect(rampStep(5, 0)).toBe(0)
  })
})

describe('peak', () => {
  it('is the tallest bucket, so every strip shares one ceiling', () => {
    expect(
      peak([
        { startMs: 0, sessions: 1, messages: 4 },
        { startMs: 1, sessions: 2, messages: 9 },
      ]),
    ).toBe(9)
    expect(peak([])).toBe(0)
  })
})
