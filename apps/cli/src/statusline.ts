import type { RateLimitReading, RateLimitWindow } from '@sightline/core'
import { isPlausiblePercentage } from '@sightline/core'

/**
 * The statusLine hook payload, as far as we care about it.
 *
 * Claude Code pipes a JSON object to the configured command on stdin and prints whatever
 * the command writes to stdout as the status line. `rate_limits` is the **only** place the
 * official quota percentages are exposed — they are never written to disk, and there is no
 * `claude usage --json` on the versions we have seen. If the hook is not installed, the
 * meter has no `official` data. That is a real state, not a failure.
 */
export interface StatusLinePayload {
  rate_limits?: {
    five_hour?: RateLimitWindowPayload
    seven_day?: RateLimitWindowPayload
  }
}

interface RateLimitWindowPayload {
  used_percentage?: unknown
  resets_at?: unknown
}

const WINDOWS: readonly RateLimitWindow[] = ['five_hour', 'seven_day']

/**
 * Extract the readings worth keeping.
 *
 * `used_percentage` is validated rather than trusted: Claude Code has been observed leaking
 * a Unix epoch into it (anthropics/claude-code#52326), and a meter that renders
 * "1,700,000,000% used" has destroyed its own credibility permanently. A rejected value is
 * dropped, not clamped — clamping a 1.7-billion to 100 would report "at your limit", which
 * is a far more alarming lie than showing nothing.
 */
export function readRateLimits(payload: unknown, capturedAt: string): RateLimitReading[] {
  if (typeof payload !== 'object' || payload === null) return []
  const limits = (payload as { rate_limits?: unknown }).rate_limits
  if (typeof limits !== 'object' || limits === null) return []

  const readings: RateLimitReading[] = []

  for (const window of WINDOWS) {
    const entry = (limits as Record<string, unknown>)[window]
    if (typeof entry !== 'object' || entry === null) continue

    const used = (entry as RateLimitWindowPayload).used_percentage
    if (!isPlausiblePercentage(used)) continue

    const resetsAt = (entry as RateLimitWindowPayload).resets_at
    readings.push({
      window,
      usedPercentage: used,
      capturedAt,
      ...(typeof resetsAt === 'string' && { resetsAt }),
    })
  }

  return readings
}

/**
 * The one line printed back to Claude Code, which becomes the status line.
 *
 * Only percentages. There is deliberately no "N tokens left" here and there never can be:
 * the denominator is per-account and unpublished, so any remaining-token figure would be
 * invented. See `TOKEN_ALLOWANCE_IS_UNKNOWABLE` in core.
 */
export function renderStatusLine(readings: readonly RateLimitReading[], now: Date): string {
  if (readings.length === 0) return 'sightline: no rate limit data'

  const parts = readings.map((r) => {
    const label = r.window === 'five_hour' ? '5h' : '7d'
    const pct = `${Math.round(r.usedPercentage)}%`
    const reset = r.resetsAt === undefined ? '' : ` (${untilReset(r.resetsAt, now)})`
    return `${label} ${pct}${reset}`
  })

  return `sightline ${parts.join('  ')}`
}

function untilReset(resetsAt: string, now: Date): string {
  const ms = Date.parse(resetsAt) - now.getTime()
  if (!Number.isFinite(ms)) return 'resets ?'
  if (ms <= 0) return 'resetting'

  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * What the user has to paste into `~/.claude/settings.json` themselves.
 *
 * **Printed, never written.** `~/.claude` is read-only to Sightline — rule 2 in CLAUDE.md —
 * and the usage meter is the one feature with a genuine reason to want to break that. It
 * does not get an exception. The cost is one manual paste, once.
 */
export function settingsSnippet(command: string): string {
  const snippet = JSON.stringify({ statusLine: { type: 'command', command } }, null, 2)

  return [
    'Sightline never writes to ~/.claude, so this is yours to install.',
    '',
    'Add to ~/.claude/settings.json:',
    '',
    snippet,
    '',
    'If you already have a statusLine command, chain it — this one passes stdin through',
    'unchanged and prints its own line, so it will replace rather than merge with yours.',
    '',
    'Nothing is captured until you do this. Without it the meter still shows token',
    'estimates from the transcripts; it just has no official percentages to show.',
  ].join('\n')
}
