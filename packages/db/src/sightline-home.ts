import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PricingTable, RateLimitReading, RateLimitWindow } from '@sightline/core'
import { isPlausiblePercentage } from '@sightline/core'

/**
 * Sightline's own directory. **Everything Sightline writes goes here and nowhere else.**
 *
 * This is rule 2 in `CLAUDE.md` made concrete: `~/.claude` is read-only to us. The usage
 * meter is the one feature with a real temptation to break it, because the official
 * quota numbers arrive through a statusLine hook and installing that hook means editing
 * `~/.claude/settings.json`. We do not edit it. `sightline statusline --install` *prints*
 * the snippet and the user pastes it.
 */
export function sightlineDir(): string {
  return join(homedir(), '.sightline')
}

export function pricingPath(): string {
  return join(sightlineDir(), 'pricing.json')
}

export function rateLimitsPath(): string {
  return join(sightlineDir(), 'rate-limits.jsonl')
}

/**
 * Load the user's own price table, or `undefined` if they have not supplied one.
 *
 * `undefined` and `{}` are different answers and both are fine: no file means the meter
 * shows tokens and no cost line at all. Sightline ships no prices — see `ModelPricing`.
 *
 * A malformed file reads as "no prices" rather than throwing. The meter is a footer; it
 * does not get to take the page down because a hand-edited JSON file has a trailing comma.
 */
export function loadPricing(path = pricingPath()): PricingTable | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  const table: PricingTable = {}
  for (const [model, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null) continue
    const v = value as Record<string, unknown>
    const num = (key: string): number | undefined =>
      typeof v[key] === 'number' && Number.isFinite(v[key]) ? (v[key] as number) : undefined

    const input = num('input')
    const output = num('output')
    if (input === undefined || output === undefined) continue

    table[model] = {
      input,
      output,
      cacheRead: num('cacheRead') ?? 0,
      // Absent multipliers fall back to the input price rather than to zero: a cache write
      // that costs nothing is a claim, and the wrong one.
      cacheWrite5m: num('cacheWrite5m') ?? input,
      cacheWrite1h: num('cacheWrite1h') ?? input,
    }
  }

  return table
}

const WINDOWS: readonly RateLimitWindow[] = ['five_hour', 'seven_day']

/**
 * Append one capture. Called by `sightline statusline`, which runs on a hot path — every
 * status-line render — so this is a bare append to a JSONL file rather than a database
 * write. A SQLite handle per render would contend with a running scan for no benefit.
 */
export function appendRateLimits(
  readings: readonly RateLimitReading[],
  path = rateLimitsPath(),
): void {
  if (readings.length === 0) return
  // The directory of the path we were actually given, not `sightlineDir()`. Creating the
  // real home directory while appending somewhere else made the function untestable and
  // gave it a side effect outside its own argument — which is precisely the shape of a
  // function that later turns out to write somewhere it should not.
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${readings.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

/**
 * The most recent capture for each window, or nothing.
 *
 * Reads the whole file and keeps the last of each window. The file grows by two short lines
 * per status-line render, so it is small; if that ever stops being true, the fix is to
 * truncate on write, not to read less carefully here.
 */
export function latestRateLimits(path = rateLimitsPath()): Map<RateLimitWindow, RateLimitReading> {
  const latest = new Map<RateLimitWindow, RateLimitReading>()

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return latest
  }

  for (const line of raw.split('\n')) {
    const reading = parseReading(line)
    if (reading === undefined) continue
    const existing = latest.get(reading.window)
    if (existing === undefined || reading.capturedAt >= existing.capturedAt) {
      latest.set(reading.window, reading)
    }
  }

  return latest
}

function parseReading(line: string): RateLimitReading | undefined {
  if (line.trim().length === 0) return undefined

  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    // A partially written last line is normal: the hook appends while we read.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined

  const v = value as Record<string, unknown>
  const window = v['window']
  if (typeof window !== 'string' || !WINDOWS.includes(window as RateLimitWindow)) return undefined
  // Drops the epoch-leak values from claude-code#52326 on read as well as on write, so a
  // file captured by an older build cannot resurrect a 1.7-billion-percent reading.
  if (!isPlausiblePercentage(v['used_percentage'] ?? v['usedPercentage'])) return undefined
  const capturedAt = v['capturedAt']
  if (typeof capturedAt !== 'string') return undefined

  const resetsAt = v['resetsAt']
  return {
    window: window as RateLimitWindow,
    usedPercentage: (v['usedPercentage'] ?? v['used_percentage']) as number,
    capturedAt,
    ...(typeof resetsAt === 'string' && { resetsAt }),
  }
}
