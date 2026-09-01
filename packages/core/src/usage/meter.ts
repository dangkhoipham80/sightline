import type { TokenUsage } from '../types.js'
import type { UsageBlock } from './blocks.js'
import type { CostBreakdown } from './pricing.js'

/**
 * How much we actually know about a number before showing it.
 *
 * The ladder exists because the three cases look identical once rendered and are not
 * remotely equivalent:
 *
 * | | Source | What may be shown |
 * | --- | --- | --- |
 * | `official` | `rate_limits` captured from a statusLine hook | a percentage, its reset time, and **how old the capture is** |
 * | `local_estimate` | tokens read from the JSONL, bucketed into a five-hour block | token counts; a cost only if the user supplied prices |
 * | `unknown` | no data for this window | "—" |
 *
 * `unknown` renders as an em dash, **never as `0`**. Zero is a measurement — it says "you
 * have used nothing" — and it is the wrong answer to "we have not been told".
 */
export type Confidence = 'official' | 'local_estimate' | 'unknown'

/**
 * A percentage reported by Claude Code itself, with the age of the reading attached.
 *
 * The age is not decoration. This number is only refreshed when a statusLine hook fires,
 * which happens while the user is working in a terminal — so on a machine that has been
 * idle, or where the hook was never installed, it can be arbitrarily stale while looking
 * perfectly current. A percentage without its age is a number pretending to be live.
 */
export interface OfficialWindow {
  confidence: 'official'
  window: RateLimitWindow
  usedPercentage: number
  resetsAt?: string
  capturedAt: string
  /** Milliseconds between the capture and the moment this view was built. */
  ageMs: number
}

export interface EstimatedWindow {
  confidence: 'local_estimate'
  block: UsageBlock
  usage: TokenUsage
  cost: CostBreakdown
}

export interface UnknownWindow {
  confidence: 'unknown'
  /** Why there is nothing, so the UI can say something better than "—" on hover. */
  reason: string
}

export type MeterWindow = OfficialWindow | EstimatedWindow | UnknownWindow

/** The two windows Claude Code reports. Names match the `rate_limits` payload keys. */
export type RateLimitWindow = 'five_hour' | 'seven_day'

/**
 * One captured `rate_limits` reading.
 *
 * `usedPercentage` is validated on the way in, not on the way out — see `isPlausiblePercentage`.
 */
export interface RateLimitReading {
  window: RateLimitWindow
  usedPercentage: number
  resetsAt?: string
  capturedAt: string
}

/**
 * Claude Code has been observed writing a Unix epoch into `used_percentage`
 * (anthropics/claude-code#52326), which renders as a 1.7-billion-percent usage bar.
 *
 * The bound is 101 rather than 100 because a genuine reading can round just past the top,
 * and refusing 100.4% would throw away a true "you are at your limit" — the single most
 * important reading the meter can show.
 */
export function isPlausiblePercentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 101
}

/**
 * There is no denominator.
 *
 * Rate limits are per-account and Anthropic publishes only relative multipliers, so the
 * number of tokens a window allows is not knowable from anything on this machine. Every
 * "N tokens remaining" in a tool like this one is invented. Percentages come from
 * `rate_limits` or they do not come at all — this constant exists so that the next person
 * to reach for a denominator finds the reason instead of the gap.
 */
export const TOKEN_ALLOWANCE_IS_UNKNOWABLE = true
