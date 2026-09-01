import { listSessions } from '@sightline/db'
import { notFound } from 'next/navigation'
import { ActivityRibbon } from '@/components/activity-ribbon'
import { SessionRow } from '@/components/session-row'
import { getDatabase } from '@/lib/db'
import { compact, relativeTime } from '@/lib/format'
import { findProject } from '@/lib/project'
import { bucketSessions, buildRange, peak } from '@/lib/timeline'

export const dynamic = 'force-dynamic'

/**
 * Below this many buckets there is no chart worth drawing — three days of work becomes
 * three slabs the width of the page, which says less than the session list underneath it
 * already does. The list is the timeline at that size.
 */
const MIN_RIBBON_BUCKETS = 10

/** The REVIEW tab. Breadcrumb, identity and the tab strip live in the layout above this. */
export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = findProject(id)
  if (project === undefined) notFound()

  const sessions = listSessions(getDatabase(), { projectId: id, limit: 10_000 })

  // Scoped to this project's own span, unlike the dashboard. There is no cross-project
  // comparison to protect here, and stretching one repository's history across the whole
  // corpus's axis would waste most of the width showing nothing.
  const range = buildRange(sessions)
  const buckets = range === undefined ? [] : bucketSessions(sessions, range)

  return (
    <>
      {range !== undefined && range.bucketCount >= MIN_RIBBON_BUCKETS && (
        <section className="border-b border-rule py-6">
          <p className="band-label">Activity</p>
          <div className="mt-3">
            <ActivityRibbon
              buckets={buckets}
              range={range}
              highest={peak(buckets)}
              height={56}
              showAxis
              label={`Session activity in ${project.displayName}`}
            />
          </div>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-5 lg:px-6">
          <h2 className="band-label">Sessions</h2>
          <span className="font-mono text-[11px] text-dim">
            {compact(sessions.length)} · last active {relativeTime(project.lastActive)}
          </span>
        </div>

        {sessions.length === 0 ? (
          <p className="border-t border-rule px-4 py-8 text-[14px] text-muted lg:px-6">
            This project has no indexed sessions. Rescan if you expected some.
          </p>
        ) : (
          <ul className="border-t border-rule">
            {sessions.map((session) => (
              <SessionRow key={session.id} session={session} />
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
