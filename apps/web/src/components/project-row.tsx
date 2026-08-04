import type { ProjectRow as Project } from '@sightline/db'
import Link from 'next/link'
import { ActivityRibbon } from '@/components/activity-ribbon'
import { compact, relativeTime, shortPath } from '@/lib/format'
import type { TimelineBucket, TimelineRange } from '@/lib/timeline'

export function ProjectRow({
  project,
  buckets,
  range,
  highest,
}: {
  project: Project
  buckets: readonly TimelineBucket[]
  range: TimelineRange
  highest: number
}) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="axis-grid group border-b border-rule px-4 py-4 transition-colors hover:bg-panel lg:px-6"
    >
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate font-display text-[15px] font-medium text-text">
            {project.displayName}
          </h3>
          {project.orphaned && (
            <span
              className="shrink-0 rounded-sm border border-rule px-1.5 py-px font-mono text-[10px] text-dim"
              title="The working directory no longer exists on this machine."
            >
              gone
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-dim" title={project.realCwd}>
          {shortPath(project.realCwd)}
        </p>
      </div>

      {/* The strip is the row's real content; below lg there is no room to keep the
          shared axis honest, so it is dropped rather than squashed. */}
      <div className="hidden lg:block">
        <ActivityRibbon
          buckets={buckets}
          range={range}
          highest={highest}
          height={18}
          variant="cells"
          label={`Activity in ${project.displayName}`}
        />
      </div>

      <div className="flex items-baseline gap-4 lg:justify-end lg:gap-0 lg:text-right">
        <div className="lg:w-full">
          <div className="font-mono text-[13px] text-text">
            {compact(project.sessionCount)}
            <span className="text-dim"> ses</span>
            <span className="mx-1.5 text-rule">·</span>
            {compact(project.messageCount)}
            <span className="text-dim"> msg</span>
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-dim group-hover:text-signal">
            {relativeTime(project.lastActive)}
          </div>
        </div>
      </div>
    </Link>
  )
}
