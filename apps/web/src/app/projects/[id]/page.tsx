import { listProjects, listSessions } from '@sightline/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActivityRibbon } from '@/components/activity-ribbon'
import { InstrumentBar } from '@/components/instrument-bar'
import { SessionRow } from '@/components/session-row'
import { getDatabase, indexExists, indexPath } from '@/lib/db'
import { compact, relativeTime } from '@/lib/format'
import { bucketSessions, buildRange, peak } from '@/lib/timeline'

export const dynamic = 'force-dynamic'

/**
 * Below this many buckets there is no chart worth drawing — three days of work becomes
 * three slabs the width of the page, which says less than the session list underneath it
 * already does. The list is the timeline at that size.
 */
const MIN_RIBBON_BUCKETS = 10

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!indexExists()) notFound()

  const db = getDatabase()
  const project = listProjects(db, { includeArchived: true }).find((p) => p.id === id)
  if (project === undefined) notFound()

  const sessions = listSessions(db, { projectId: id, limit: 10_000 })

  // Scoped to this project's own span, unlike the dashboard. There is no cross-project
  // comparison to protect here, and stretching one repository's history across the whole
  // corpus's axis would waste most of the width showing nothing.
  const range = buildRange(sessions)
  const buckets = range === undefined ? [] : bucketSessions(sessions, range)

  return (
    <>
      <InstrumentBar indexPath={indexPath()} />

      <main className="mx-auto max-w-[1400px] px-4 pb-24 lg:px-6">
        <nav className="pt-6">
          <Link href="/" className="font-mono text-[11px] text-dim hover:text-signal">
            ← projects
          </Link>
        </nav>

        <header className="border-b border-rule py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <h1 className="font-display text-2xl font-medium text-text">{project.displayName}</h1>
            {project.orphaned && (
              <span className="rounded-sm border border-rule px-1.5 py-px font-mono text-[10px] text-dim">
                directory gone
              </span>
            )}
          </div>

          <dl className="mt-4 grid gap-2 font-mono text-[12px] sm:grid-cols-2 lg:grid-cols-4">
            <Field label="cwd" value={project.realCwd} />
            <Field label="git root" value={project.gitRoot ?? 'none found'} />
            <Field label="remote" value={project.repoUrl ?? '—'} />
            <Field
              label="host"
              value={
                project.distro === null
                  ? project.hostKind
                  : `${project.hostKind} · ${project.distro}`
              }
            />
          </dl>

          {project.folderKeys.length > 1 && (
            <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-muted">
              Claude Code filed this repository under {project.folderKeys.length} separate folders.
              They are one project here because they resolve to one git root.
            </p>
          )}
        </header>

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
      </main>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="band-label">{label}</dt>
      <dd className="mt-1 truncate text-muted" title={value}>
        {value}
      </dd>
    </div>
  )
}
