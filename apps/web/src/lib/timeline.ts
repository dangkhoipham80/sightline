/**
 * The shared time axis.
 *
 * One range is computed from every session in the index, and the global ribbon *and* every
 * per-project strip are bucketed against it. That is the whole point of the dashboard:
 * `claude --resume` scopes to the directory you are standing in, so work that was actually
 * interleaved across five repositories shows up as five unrelated lists. Drawing every
 * project against one axis puts the interleaving back.
 *
 * Pure functions on plain data — no React, no database — so the bucketing can be tested
 * without either.
 */

const DAY_MS = 86_400_000

export interface TimelineInput {
  startedAt: string | null
  messageCount: number
}

export interface TimelineRange {
  startMs: number
  endMs: number
  bucketMs: number
  bucketCount: number
}

export interface TimelineBucket {
  startMs: number
  sessions: number
  messages: number
}

export interface AxisTick {
  label: string
  /** 0 at the left edge of the range, 1 at the right. */
  position: number
}

/**
 * Span every session, snapped out to whole days.
 *
 * Returns undefined when nothing has a usable timestamp — a corpus that old or that
 * broken gets no axis rather than a fabricated one.
 */
export function buildRange(
  sessions: readonly TimelineInput[],
  targetBuckets = 120,
): TimelineRange | undefined {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const session of sessions) {
    if (session.startedAt === null) continue
    const at = Date.parse(session.startedAt)
    if (Number.isNaN(at)) continue
    if (at < min) min = at
    if (at > max) max = at
  }

  if (min === Number.POSITIVE_INFINITY) return undefined

  const startMs = Math.floor(min / DAY_MS) * DAY_MS
  // The right edge is the end of the last active day, so today's work fills its bucket
  // instead of sitting exactly on the boundary.
  const endMs = Math.floor(max / DAY_MS) * DAY_MS + DAY_MS

  // Never finer than a day: below that the marks are noise, and a corpus spanning one
  // afternoon would otherwise get 120 buckets of nothing.
  const span = endMs - startMs
  const bucketMs = Math.max(DAY_MS, Math.ceil(span / targetBuckets / DAY_MS) * DAY_MS)
  const bucketCount = Math.max(1, Math.ceil(span / bucketMs))

  return { startMs, endMs, bucketMs, bucketCount }
}

/**
 * Drop sessions into buckets by their **start**.
 *
 * A session that runs past midnight is counted where it began. Splitting its messages
 * across buckets would be more precise and less true: the work belongs to the sitting it
 * started in, and sessions long enough for the distinction to matter are rare.
 */
export function bucketSessions(
  sessions: readonly TimelineInput[],
  range: TimelineRange,
): TimelineBucket[] {
  const buckets: TimelineBucket[] = Array.from({ length: range.bucketCount }, (_, index) => ({
    startMs: range.startMs + index * range.bucketMs,
    sessions: 0,
    messages: 0,
  }))

  for (const session of sessions) {
    if (session.startedAt === null) continue
    const at = Date.parse(session.startedAt)
    if (Number.isNaN(at) || at < range.startMs || at >= range.endMs) continue

    const index = Math.min(range.bucketCount - 1, Math.floor((at - range.startMs) / range.bucketMs))
    const bucket = buckets[index]
    if (bucket === undefined) continue
    bucket.sessions += 1
    bucket.messages += session.messageCount
  }

  return buckets
}

/** The tallest bucket, used to scale every strip against the same ceiling. */
export function peak(buckets: readonly TimelineBucket[]): number {
  let highest = 0
  for (const bucket of buckets) if (bucket.messages > highest) highest = bucket.messages
  return highest
}

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Below this, month boundaries are too sparse to be an axis — a fortnight of work gets one label. */
const MONTH_TICK_THRESHOLD_MS = 120 * DAY_MS

/**
 * Label the axis at the granularity the range can actually carry.
 *
 * A long corpus gets month boundaries, because "was that July or August?" is the question
 * someone asks of their own history. A short one gets dated ticks instead: three weeks of
 * work spans one month boundary, and an axis with a single label is not an axis.
 */
export function axisTicks(range: TimelineRange): AxisTick[] {
  const span = range.endMs - range.startMs
  if (span <= 0) return []

  return span >= MONTH_TICK_THRESHOLD_MS ? monthTicks(range, span) : dayTicks(range, span)
}

function monthTicks(range: TimelineRange, span: number): AxisTick[] {
  const ticks: AxisTick[] = []
  const cursor = new Date(range.startMs)
  cursor.setUTCDate(1)
  cursor.setUTCHours(0, 0, 0, 0)

  // Guard the loop on a bound rather than on the date arithmetic: a range spanning years
  // is fine, a range spanning a corrupt timestamp should not spin.
  for (let guard = 0; guard < 600; guard += 1) {
    const at = cursor.getTime()
    if (at >= range.endMs) break
    if (at >= range.startMs) {
      ticks.push({ label: MONTH.format(at), position: (at - range.startMs) / span })
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }

  return ticks
}

/** Evenly spaced dated ticks, aiming for five or six — enough to read, few enough to fit. */
function dayTicks(range: TimelineRange, span: number): AxisTick[] {
  const days = Math.max(1, Math.round(span / DAY_MS))
  const step = Math.max(1, Math.ceil(days / 5))

  const ticks: AxisTick[] = []
  for (let day = 0; day < days; day += step) {
    const at = range.startMs + day * DAY_MS
    // Drop a tick that would land within a step of the right edge, where its label would
    // overflow the strip.
    if (at > range.endMs - DAY_MS) break
    ticks.push({ label: DAY.format(at), position: (at - range.startMs) / span })
  }

  return ticks
}

/**
 * Which step of the activity ramp a bucket sits on.
 *
 * Four steps of one hue, rising in lightness — activity is a magnitude, so it gets a
 * sequential ramp rather than colours that would imply identity. Returns 0 for an empty
 * bucket, which renders as the baseline rule rather than as a mark.
 */
export function rampStep(messages: number, highest: number): 0 | 1 | 2 | 3 | 4 {
  if (messages <= 0 || highest <= 0) return 0
  const ratio = messages / highest
  if (ratio > 0.66) return 4
  if (ratio > 0.33) return 3
  if (ratio > 0.12) return 2
  return 1
}
