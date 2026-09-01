import 'server-only'

import type { MeterWindow, RateLimitWindow, TokenUsage } from '@sightline/core'
import { activeBlock, BLOCK_HOURS, costByModel, groupIntoBlocks } from '@sightline/core'
import { hasTokenEvents, latestRateLimits, listTokenEvents, loadPricing } from '@sightline/db'
import { getDatabase, indexExists } from '@/lib/db'

export interface UsageMeter {
  /** The rolling five-hour window: official if captured, otherwise a local estimate. */
  fiveHour: MeterWindow
  /** The seven-day window. Only ever `official` or `unknown` — see below. */
  sevenDay: MeterWindow
  /** When this view was built, so the client can age the countdowns without refetching. */
  builtAt: string
}

/**
 * How far back to read events. Two five-hour windows is enough to place `now` inside a
 * block even if the block opened just before the cutoff, without scanning the whole index.
 */
const LOOKBACK_MS = BLOCK_HOURS * 2 * 60 * 60 * 1000

/**
 * Build the sidebar's usage view, on the confidence ladder and never off it.
 *
 * The three rungs are not interchangeable and the UI must be able to tell them apart:
 * `official` is a percentage Claude Code reported, `local_estimate` is tokens we counted
 * ourselves, and `unknown` means we have nothing — which renders as an em dash, never a
 * zero. "You have used 0%" and "we have not been told" look identical at a glance and are
 * opposite claims.
 */
export function buildUsageMeter(now = new Date()): UsageMeter {
  const captured = safely(() => latestRateLimits(), new Map())
  const builtAt = now.toISOString()

  return {
    fiveHour: fiveHourWindow(captured.get('five_hour'), now),
    sevenDay: officialOrUnknown(
      captured.get('seven_day'),
      now,
      // A seven-day figure cannot be estimated locally at any useful confidence: the window
      // is far longer than the 30-day transcript retention is reliable for, and weekly
      // limits are weighted per model in ways Anthropic does not publish. Better to show
      // nothing than to show a number we would have to caveat into meaninglessness.
      'no statusLine capture — weekly usage is not derivable from transcripts',
    ),
    builtAt,
  }
}

function fiveHourWindow(
  reading: ReturnType<typeof latestRateLimits> extends Map<RateLimitWindow, infer R>
    ? R | undefined
    : never,
  now: Date,
): MeterWindow {
  // Official wins whenever we have it: it is the only number with a real denominator.
  if (reading !== undefined) {
    return {
      confidence: 'official',
      window: 'five_hour',
      usedPercentage: reading.usedPercentage,
      capturedAt: reading.capturedAt,
      ageMs: Math.max(0, now.getTime() - Date.parse(reading.capturedAt)),
      ...(reading.resetsAt !== undefined && { resetsAt: reading.resetsAt }),
    }
  }

  if (!indexExists()) {
    return { confidence: 'unknown', reason: 'no index yet — run a scan' }
  }

  const db = getDatabase()
  if (!safely(() => hasTokenEvents(db), false)) {
    return {
      confidence: 'unknown',
      reason: 'index predates token accounting — rescan to populate it',
    }
  }

  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString()
  const events = safely(() => listTokenEvents(db, { since }), [])
  const block = activeBlock(groupIntoBlocks(events, { now }))

  // No active block is a real answer, not an empty one: the last window expired and nothing
  // has opened a new one. Reporting 0% would claim a measurement we did not take.
  if (block === undefined) {
    return { confidence: 'unknown', reason: `no activity in the last ${BLOCK_HOURS} hours` }
  }

  const prices = safely(() => loadPricing(), undefined)

  return {
    confidence: 'local_estimate',
    block,
    usage: block.usage,
    // With no price file there is no cost line at all — Sightline ships no prices.
    cost: prices === undefined ? { unpricedModels: [] } : costByModel(usageByModel(block), prices),
  }
}

function officialOrUnknown(
  reading: ReturnType<typeof latestRateLimits> extends Map<RateLimitWindow, infer R>
    ? R | undefined
    : never,
  now: Date,
  reason: string,
): MeterWindow {
  if (reading === undefined) return { confidence: 'unknown', reason }
  return {
    confidence: 'official',
    window: 'seven_day',
    usedPercentage: reading.usedPercentage,
    capturedAt: reading.capturedAt,
    ageMs: Math.max(0, now.getTime() - Date.parse(reading.capturedAt)),
    ...(reading.resetsAt !== undefined && { resetsAt: reading.resetsAt }),
  }
}

function usageByModel(block: { events: readonly { model?: string; usage: TokenUsage }[] }) {
  const byModel = new Map<string, TokenUsage>()

  for (const event of block.events) {
    // Unnamed models are grouped under a key no price file will match, so they surface as
    // `unpricedModels` rather than vanishing from the total.
    const key = event.model ?? 'unknown'
    const existing = byModel.get(key)
    if (existing === undefined) {
      byModel.set(key, { ...event.usage })
      continue
    }
    existing.inputTokens += event.usage.inputTokens
    existing.outputTokens += event.usage.outputTokens
    existing.cacheReadTokens += event.usage.cacheReadTokens
    existing.cacheCreationTokens += event.usage.cacheCreationTokens
    existing.cacheCreation5mTokens += event.usage.cacheCreation5mTokens
    existing.cacheCreation1hTokens += event.usage.cacheCreation1hTokens
  }

  return byModel
}

/**
 * The meter is a footer. A missing file or a database mid-rebuild must degrade it to
 * `unknown`, not take down every page that renders the shell.
 */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}
