import { count, stamp } from '@/lib/format'
import type { TimelineBucket, TimelineRange } from '@/lib/timeline'
import { axisTicks, rampStep } from '@/lib/timeline'

const RAMP = ['', 'bg-act-1', 'bg-act-2', 'bg-act-3', 'bg-act-4'] as const

/**
 * `bars` encodes magnitude by height — the right mark when the question is *how much*.
 *
 * `cells` encodes presence and intensity only, at full height. Project rows use it because
 * they are scaled against the whole corpus's ceiling: drawn as bars, one project's busiest
 * day is a two-pixel sliver and nine rows out of ten read as empty. The row's job is "when
 * was this alive"; the numbers beside it answer "how much". Colour still comes from the
 * shared ceiling, so a loud project stays visibly brighter than a quiet one.
 */
export type RibbonVariant = 'bars' | 'cells'

export function ActivityRibbon({
  buckets,
  range,
  highest,
  height = 72,
  variant = 'bars',
  showAxis = false,
  label,
}: {
  buckets: readonly TimelineBucket[]
  range: TimelineRange
  /** The ceiling this strip is scaled against. */
  highest: number
  height?: number
  variant?: RibbonVariant
  showAxis?: boolean
  label: string
}) {
  const ticks = showAxis ? axisTicks(range) : []

  return (
    <div>
      <div
        className="flex items-end gap-px border-b border-rule"
        style={{ height }}
        role="img"
        aria-label={label}
      >
        {buckets.map((bucket, index) => {
          const step = rampStep(bucket.messages, highest)
          const ratio = highest > 0 ? bucket.messages / highest : 0
          const markHeight = variant === 'cells' ? height : Math.max(2, ratio * height)

          return (
            <div key={bucket.startMs} className="group relative h-full min-w-px flex-1">
              {step > 0 && (
                <div
                  className={`absolute inset-x-0 bottom-0 rounded-t-[2px] ${RAMP[step]} ${
                    variant === 'bars' ? 'mark-in' : 'fade-in'
                  }`}
                  style={{
                    height: `${markHeight}px`,
                    // Left to right, the direction the axis is read. Capped so a long
                    // corpus doesn't turn the load into a wait.
                    animationDelay: `${Math.min(index * 5, 700)}ms`,
                  }}
                />
              )}
              {bucket.sessions > 0 && (
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-rule bg-raised px-2 py-1 font-mono text-[11px] text-text shadow-lg group-hover:block">
                  <span className="text-muted">
                    {stamp(new Date(bucket.startMs).toISOString())}
                  </span>
                  {'  '}
                  {bucket.sessions} {bucket.sessions === 1 ? 'session' : 'sessions'}
                  {'  '}
                  <span className="text-muted">{count(bucket.messages)} msgs</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {showAxis && (
        <div className="relative mt-1.5 h-4">
          {ticks.map((tick) => (
            <span
              key={tick.label + String(tick.position)}
              className="absolute font-mono text-[11px] text-dim"
              style={{ left: `${tick.position * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
