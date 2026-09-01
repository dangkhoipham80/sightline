import type { MeterWindow } from '@sightline/core'
import { BLOCK_HOURS } from '@sightline/core'
import { compact } from '@/lib/format'
import type { UsageMeter } from '@/lib/usage'

/**
 * The sidebar footer: how much of the current window is gone.
 *
 * Every number here is labelled with where it came from, because the three sources look
 * identical once rendered and mean entirely different things. `official` is a percentage
 * Claude Code reported and is the only one with a real denominator; `local_estimate` is
 * tokens counted from the transcripts, which have no denominator at all; `unknown` is an
 * em dash.
 *
 * There is deliberately no progress bar on a `local_estimate`. A bar implies a fraction of
 * something, and the something is exactly what cannot be known.
 */
export function UsageMeterFooter({ meter }: { meter: UsageMeter }) {
  return (
    <footer className="sticky bottom-0 border-t border-rule bg-panel px-3 py-2.5">
      <h2 className="band-label pb-1.5">Usage</h2>
      <WindowRow label={`${BLOCK_HOURS}h`} window={meter.fiveHour} builtAt={meter.builtAt} />
      <WindowRow label="7d" window={meter.sevenDay} builtAt={meter.builtAt} />
    </footer>
  )
}

function WindowRow({
  label,
  window,
  builtAt,
}: {
  label: string
  window: MeterWindow
  builtAt: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-xs">
      <span className="font-mono text-dim">{label}</span>
      <WindowValue window={window} builtAt={builtAt} />
    </div>
  )
}

function WindowValue({ window, builtAt }: { window: MeterWindow; builtAt: string }) {
  if (window.confidence === 'unknown') {
    // An em dash, never a zero. "You have used 0%" and "we were not told" render the same
    // and claim the opposite; the reason lives in the tooltip.
    return (
      <span className="font-mono text-dim" title={window.reason}>
        —
      </span>
    )
  }

  if (window.confidence === 'official') {
    return (
      <span
        className="truncate font-mono"
        title={[
          `Reported by Claude Code, captured ${window.capturedAt}`,
          window.resetsAt === undefined ? undefined : `Resets ${window.resetsAt}`,
          staleness(window.ageMs) ?? undefined,
        ]
          .filter(Boolean)
          .join('\n')}
      >
        {Math.round(window.usedPercentage)}%
        {window.resetsAt !== undefined && (
          <span className="ps-1 text-dim">{untilReset(window.resetsAt, builtAt)}</span>
        )}
        {/* The age of the reading, not decoration: the capture only refreshes while a
            terminal with the hook installed is rendering its status line, so it can be
            hours old while looking perfectly live. */}
        {staleness(window.ageMs) !== null && (
          <span className="ps-1 text-signal" title={staleness(window.ageMs) ?? ''}>
            !
          </span>
        )}
      </span>
    )
  }

  const tokens = window.usage.inputTokens + window.usage.outputTokens
  return (
    <span
      className="truncate font-mono text-dim"
      title={[
        'Estimated from transcripts — not an official figure.',
        `Block opened ${window.block.startedAt}, ends ${window.block.endsAt}.`,
        `in ${window.usage.inputTokens} · out ${window.usage.outputTokens} · cache read ${window.usage.cacheReadTokens}`,
        window.cost.unpricedModels.length === 0
          ? undefined
          : `No price for: ${window.cost.unpricedModels.join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n')}
    >
      {/* Tokens, never a percentage: there is no denominator to divide by. */}~{compact(tokens)}
      {window.cost.usd !== undefined && <span className="ps-1">${window.cost.usd.toFixed(2)}</span>}
    </span>
  )
}

/** Above an hour old, the reading is worth flagging rather than presenting as current. */
function staleness(ageMs: number): string | null {
  const minutes = Math.round(ageMs / 60_000)
  if (minutes < 60) return null
  const hours = Math.round(minutes / 60)
  return hours < 24
    ? `Reading is ${hours}h old — the statusLine hook has not fired since`
    : `Reading is ${Math.round(hours / 24)}d old — the statusLine hook has not fired since`
}

function untilReset(resetsAt: string, from: string): string {
  const ms = Date.parse(resetsAt) - Date.parse(from)
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'resetting'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  // Days past two of them. The seven-day window resets 112 hours out, and "112h" is a
  // number the reader has to do arithmetic on before it means anything.
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
