import { listProjects, listSessions } from '@sightline/db'
import { ActivityRibbon } from '@/components/activity-ribbon'
import { EmptyState } from '@/components/empty-state'
import { InstrumentBar } from '@/components/instrument-bar'
import { ProjectRow } from '@/components/project-row'
import { getDatabase, indexExists, indexPath } from '@/lib/db'
import { compact, count } from '@/lib/format'
import { bucketSessions, buildRange, peak } from '@/lib/timeline'

// The index changes under us whenever Claude Code writes, so nothing here is cacheable.
export const dynamic = 'force-dynamic'

const WEEK_MS = 604_800_000

export default function Dashboard() {
  const path = indexPath()
  if (!indexExists()) return <EmptyState indexPath={path} />

  const db = getDatabase()
  const projects = listProjects(db)
  const sessions = listSessions(db, { limit: 10_000 })

  if (projects.length === 0) return <EmptyState indexPath={path} />

  const range = buildRange(sessions)
  const globalBuckets = range === undefined ? [] : bucketSessions(sessions, range)
  // Every strip on this page is scaled against the same ceiling. A project with a quiet
  // month should look quiet next to one that had a loud one — that comparison is the
  // entire reason the strips share an axis.
  const highest = peak(globalBuckets)

  const byProject = new Map<string, typeof sessions>()
  for (const session of sessions) {
    const list = byProject.get(session.projectId) ?? []
    list.push(session)
    byProject.set(session.projectId, list)
  }

  const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0)
  const totalTools = sessions.reduce((sum, s) => sum + s.toolCallCount, 0)
  const weeks =
    range === undefined ? 0 : Math.max(1, Math.round((range.endMs - range.startMs) / WEEK_MS))

  return (
    <>
      <InstrumentBar indexPath={path} />

      <main className="mx-auto max-w-[1400px] px-4 pb-24 lg:px-6">
        <section className="axis-grid border-b border-rule py-8">
          <div>
            <p className="band-label">Activity</p>
            <p className="mt-2 font-display text-2xl font-medium leading-tight text-text">
              {count(sessions.length)} sessions
              <br />
              across {projects.length} projects
            </p>
            <p className="mt-3 max-w-[15rem] text-[13px] leading-relaxed text-muted">
              {weeks} weeks of work, on one axis. Every project below is drawn against it, and
              colour is intensity measured against the busiest day.
            </p>
          </div>

          <div className="lg:pb-1">
            {range === undefined ? (
              <p className="font-mono text-[12px] text-dim">
                No session carries a usable timestamp, so there is no axis to draw.
              </p>
            ) : (
              <ActivityRibbon
                buckets={globalBuckets}
                range={range}
                highest={highest}
                showAxis
                label={`Session activity across ${weeks} weeks, all projects`}
              />
            )}
          </div>

          <dl className="flex gap-6 lg:block lg:space-y-3">
            <Stat label="messages" value={compact(totalMessages)} />
            <Stat label="tool calls" value={compact(totalTools)} />
          </dl>
        </section>

        <section>
          <div className="flex items-baseline justify-between px-4 py-5 lg:px-6">
            <h2 className="band-label">Projects</h2>
            <span className="font-mono text-[11px] text-dim">most recent first</span>
          </div>

          <div className="border-t border-rule">
            {projects.map((project) => {
              const own = byProject.get(project.id) ?? []
              return (
                <ProjectRow
                  key={project.id}
                  project={project}
                  buckets={range === undefined ? [] : bucketSessions(own, range)}
                  range={range ?? { startMs: 0, endMs: 1, bucketMs: 1, bucketCount: 0 }}
                  highest={highest}
                />
              )
            })}
          </div>
        </section>
      </main>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="font-mono text-lg text-text">{value}</dd>
      <dt className="band-label">{label}</dt>
    </div>
  )
}
