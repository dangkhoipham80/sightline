import Link from 'next/link'
import { notFound } from 'next/navigation'
import { InstrumentBar } from '@/components/instrument-bar'
import { ResumeCommand } from '@/components/resume-command'
import { Transcript } from '@/components/transcript/transcript'
import { indexExists, indexPath } from '@/lib/db'
import { count, duration, shortPath, stamp } from '@/lib/format'
import { loadSessionPage } from '@/lib/session'

export const dynamic = 'force-dynamic'

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ m?: string }>
}) {
  const { id } = await params
  const { m } = await searchParams
  if (!indexExists()) notFound()

  const data = loadSessionPage(id, m)
  if (data === undefined) notFound()

  const { session, project, view, parent, continuations, focus } = data

  return (
    <>
      <InstrumentBar indexPath={indexPath()} />

      <main className="mx-auto max-w-[1400px] px-4 pb-24 lg:px-6">
        <nav className="flex flex-wrap items-baseline gap-x-2 pt-6 font-mono text-[11px] text-dim">
          <Link href="/" className="hover:text-signal">
            projects
          </Link>
          <span className="text-rule">/</span>
          {project === undefined ? (
            <span>unknown project</span>
          ) : (
            <Link href={`/projects/${project.id}`} className="hover:text-signal">
              {project.displayName}
            </Link>
          )}
        </nav>

        <header className="border-b border-rule py-6">
          <h1 className="font-display text-2xl font-medium text-text">
            {session.title ?? session.id}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[12px] text-muted">
            <span>{stamp(session.startedAt)}</span>
            <span className="text-rule">·</span>
            <span>{duration(session.durationMs)}</span>
            <span className="text-rule">·</span>
            <span>
              {count(session.messageCount)} <span className="text-dim">msgs</span>
            </span>
            <span className="text-rule">·</span>
            <span>
              {count(session.toolCallCount)} <span className="text-dim">tools</span>
            </span>
            {session.gitBranch !== null && (
              <>
                <span className="text-rule">·</span>
                <span>
                  <span className="text-dim">git </span>
                  {session.gitBranch}
                </span>
              </>
            )}
            {session.cwd !== null && (
              <>
                <span className="text-rule">·</span>
                <span className="text-dim" title={session.cwd}>
                  {shortPath(session.cwd)}
                </span>
              </>
            )}
            <span className="ms-auto">
              <ResumeCommand sessionId={session.id} cwd={session.cwd} />
            </span>
          </div>

          {(parent !== undefined || continuations.length > 0) && (
            <p className="mt-3 flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] text-dim">
              {/*
               * A resumed session is a separate file that carries the previous id in its
               * first record. Without these links one continuous stretch of work reads as
               * several unrelated sessions, each stopping mid-thought.
               */}
              {parent !== undefined && (
                <Link href={`/sessions/${parent.id}`} className="text-muted hover:text-signal">
                  ← continues {parent.title ?? parent.id}
                </Link>
              )}
              {continuations.map((next) => (
                <Link
                  key={next.id}
                  href={`/sessions/${next.id}`}
                  className="text-muted hover:text-signal"
                >
                  continued in {next.title ?? next.id} →
                </Link>
              ))}
            </p>
          )}
        </header>

        {view === undefined ? (
          <section className="py-10">
            <p className="text-[14px] text-muted">
              The transcript file is no longer readable at its indexed location.
            </p>
            <p className="mt-2 font-mono text-[12px] text-dim">{session.filePath}</p>
            <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-muted">
              Everything above came from the index, which outlives the file. Rescan to drop sessions
              whose transcripts are gone.
            </p>
          </section>
        ) : (
          <>
            {m !== undefined && focus === undefined && (
              <p className="border-b border-rule py-3 font-mono text-[11px] text-dim">
                The message this link points at is not in this transcript any more. Showing the
                session from the top.
              </p>
            )}
            <Transcript view={view} {...(focus !== undefined && { focusTurn: focus.turnIndex })} />
          </>
        )}
      </main>
    </>
  )
}
