import type { TokenEvent } from '../parse/tokens.js'
import { totalUsage } from '../parse/tokens.js'
import type { TokenUsage } from '../types.js'

/**
 * Claude's usage limits reset on a rolling five-hour window that **starts with your first
 * message**, not at a fixed clock time. So a "block" here is a reconstruction: the first
 * event opens one, and it stays open for five hours.
 *
 * This is a *local model of an unobservable thing*. Anthropic does not write the window
 * boundary to disk, and nothing in the transcript names it. Everything derived from these
 * blocks is therefore `local_estimate` confidence and must be labelled as such — a block
 * boundary that is an hour off produces a number that looks exactly as authoritative as a
 * correct one.
 */
export const BLOCK_HOURS = 5

const HOUR_MS = 60 * 60 * 1000

export interface UsageBlock {
  /** Block start, floored to the hour — matching how the reset time is displayed. */
  startedAt: string
  /** `startedAt` + five hours. Not when the last event happened. */
  endsAt: string
  /** First and last event actually seen inside the window. */
  firstEventAt: string
  lastEventAt: string
  events: TokenEvent[]
  usage: TokenUsage
  /** `now` falls inside this block, so it is still accumulating. */
  isActive: boolean
}

export interface GroupIntoBlocksOptions {
  /** Injected rather than read from the clock, so the grouping stays a pure function. */
  now: Date
  blockHours?: number
}

/**
 * Group deduplicated token events into rolling windows.
 *
 * A block closes when an event arrives more than `blockHours` after the block opened, **or**
 * more than `blockHours` after the previous event. The second condition matters: an idle
 * gap longer than the window means the old window expired unused, so the next message opens
 * a fresh one rather than landing in a window that has already reset.
 *
 * Events without a timestamp are dropped. They cannot be placed in a window, and placing
 * them in the nearest one would be inventing the very thing this file refuses to invent.
 */
export function groupIntoBlocks(
  events: readonly TokenEvent[],
  options: GroupIntoBlocksOptions,
): UsageBlock[] {
  const blockMs = (options.blockHours ?? BLOCK_HOURS) * HOUR_MS
  const nowMs = options.now.getTime()

  const timed = events
    .filter((e): e is TokenEvent & { timestamp: string } => e.timestamp !== undefined)
    .map((e) => ({ event: e, ms: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms)

  const blocks: UsageBlock[] = []
  let current: { startMs: number; entries: typeof timed } | null = null

  const close = (block: { startMs: number; entries: typeof timed }): void => {
    const first = block.entries[0]
    const last = block.entries[block.entries.length - 1]
    if (first === undefined || last === undefined) return

    const endMs = block.startMs + blockMs
    const collected = block.entries.map((e) => e.event)

    blocks.push({
      startedAt: new Date(block.startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      firstEventAt: first.event.timestamp,
      lastEventAt: last.event.timestamp,
      events: collected,
      usage: totalUsage(collected),
      isActive: nowMs >= block.startMs && nowMs < endMs,
    })
  }

  for (const entry of timed) {
    const previous = current?.entries[current.entries.length - 1]
    const startsNewBlock =
      current === null ||
      entry.ms - current.startMs >= blockMs ||
      (previous !== undefined && entry.ms - previous.ms >= blockMs)

    if (startsNewBlock) {
      if (current !== null) close(current)
      current = { startMs: floorToHour(entry.ms), entries: [entry] }
    } else {
      // `current` is non-null here: `startsNewBlock` is true whenever it is null.
      ;(current as { startMs: number; entries: typeof timed }).entries.push(entry)
    }
  }

  if (current !== null) close(current)
  return blocks
}

/** The block a `now` falls inside, if any. Absent is a real answer — see `unknown`. */
export function activeBlock(blocks: readonly UsageBlock[]): UsageBlock | undefined {
  return blocks.find((b) => b.isActive)
}

function floorToHour(ms: number): number {
  return ms - (ms % HOUR_MS)
}
