import type { SessionRow as Session } from '@sightline/db'
import Link from 'next/link'
import { ResumeCommand } from '@/components/resume-command'
import { count, duration, stamp } from '@/lib/format'
import { sessionResumeCommand } from '@/lib/launch'

/** Anything the transcript did not name gets its id, never an invented title. */
function title(session: Session): string {
  return session.title ?? session.id
}

export function SessionRow({ session }: { session: Session }) {
  const resume = sessionResumeCommand(session)
  const facts: Array<[string, string]> = [
    [count(session.messageCount), 'msgs'],
    [count(session.toolCallCount), 'tools'],
  ]
  if (session.subagentCount > 0) {
    facts.push([
      count(session.subagentCount),
      session.subagentCount === 1 ? 'subagent' : 'subagents',
    ])
  }

  return (
    <li className="border-b border-rule px-4 py-4 lg:px-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="shrink-0 font-mono text-[11px] text-dim">{stamp(session.startedAt)}</span>
        <h3 className="min-w-0 flex-1 font-display text-[15px] font-medium text-text">
          <Link href={`/sessions/${session.id}`} className="hover:text-signal">
            {title(session)}
          </Link>
        </h3>
        {session.gitBranch !== null && (
          <span className="shrink-0 font-mono text-[11px] text-muted">
            <span className="text-dim">git </span>
            {session.gitBranch}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-[12px] text-muted">{duration(session.durationMs)}</span>
        <span className="text-rule">·</span>
        {facts.map(([value, unit], index) => (
          <span key={unit} className="font-mono text-[12px] text-muted">
            {index > 0 && <span className="mr-3 text-rule">·</span>}
            {value} <span className="text-dim">{unit}</span>
          </span>
        ))}
        {session.models.length > 0 && (
          <>
            <span className="text-rule">·</span>
            <span className="font-mono text-[12px] text-dim">{session.models.join(' ')}</span>
          </>
        )}
        {/* A session whose transcript never recorded a cwd has nowhere honest to send
            you, so it gets no button rather than a command that lands anywhere. */}
        {resume !== null && (
          <div className="ms-auto">
            <ResumeCommand command={resume} />
          </div>
        )}
      </div>
    </li>
  )
}
