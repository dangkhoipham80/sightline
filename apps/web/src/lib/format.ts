const NUMBER = new Intl.NumberFormat('en-US')

export function count(value: number): string {
  return NUMBER.format(value)
}

/** Compact form for dense rows, where four digits of precision help nobody. */
export function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

export function duration(ms: number | null): string {
  if (ms === null || ms <= 0) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * "3d ago" beats a timestamp for the question this UI answers — *when did I last touch
 * this* — but only down to the day. Below that a clock time is more useful than "22h".
 */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (iso === null) return '—'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'

  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`
}

const STAMP = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

/** Absolute, unambiguous, and short. UTC so it matches what the transcript recorded. */
export function stamp(iso: string | null): string {
  if (iso === null) return '—'
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? '—' : STAMP.format(parsed)
}

/**
 * Shorten a working directory for display without lying about it.
 *
 * The home prefix becomes `~`, and a long path keeps its last three segments — the ones
 * that identify the project — rather than its first three, which identify the machine.
 */
export function shortPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0)
  if (segments.length <= 3) return path
  return `…${separator}${segments.slice(-3).join(separator)}`
}
