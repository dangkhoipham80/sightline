import type { SearchHit } from '@sightline/db'
import { countSearchResults, listProjects, search } from '@sightline/db'
import Link from 'next/link'
import { InstrumentBar } from '@/components/instrument-bar'
import { getDatabase, indexExists, indexPath } from '@/lib/db'
import { count, relativeTime, stamp } from '@/lib/format'
import { SNIPPET_MARKERS, splitSnippet } from '@/lib/snippet'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; project?: string; page?: string; prefix?: string }>
}) {
  const { q = '', project, page, prefix } = await searchParams
  const offset = Math.max(0, (Number(page ?? '1') - 1) * PAGE_SIZE)

  const ready = indexExists() && q.trim().length > 0
  const db = ready ? getDatabase() : undefined

  // Set when the palette sent us here, so this page counts what the palette counted.
  const scope = {
    ...(project !== undefined && { projectId: project }),
    ...(prefix === '1' && { prefixLastTerm: true }),
  }
  const hits =
    db === undefined
      ? []
      : search(db, q, { ...scope, limit: PAGE_SIZE, offset, markers: SNIPPET_MARKERS })
  const total = db === undefined ? 0 : countSearchResults(db, q, scope)
  const scopedProject =
    db === undefined || project === undefined
      ? undefined
      : listProjects(db, { includeArchived: true }).find((p) => p.id === project)

  // Grouped by session: a search that matched eleven messages in one session is one
  // answer, not eleven, and a flat list buries the other sessions underneath it.
  const groups = groupBySession(hits)

  return (
    <>
      <InstrumentBar indexPath={indexPath()} />

      <main className="mx-auto max-w-[1400px] px-4 pb-24 lg:px-6">
        <header className="border-b border-rule py-6">
          <p className="band-label">Search</p>
          <h1 className="mt-2 font-display text-2xl font-medium text-text">
            {q.trim().length === 0 ? 'What are you looking for?' : q}
          </h1>

          <p className="mt-3 font-mono text-[12px] text-muted">
            {q.trim().length === 0 ? (
              <>Press ⌘K anywhere, or add a query to the URL.</>
            ) : (
              <>
                {count(total)} {total === 1 ? 'match' : 'matches'} in {count(groups.length)}{' '}
                {groups.length === 1 ? 'session' : 'sessions'}
                {scopedProject !== undefined && (
                  <>
                    {' · scoped to '}
                    <Link href={`/projects/${scopedProject.id}`} className="text-signal">
                      {scopedProject.displayName}
                    </Link>
                    {' · '}
                    <Link
                      href={`/search?${new URLSearchParams({
                        q,
                        ...(prefix === '1' && { prefix }),
                      }).toString()}`}
                      className="underline decoration-rule underline-offset-2 hover:text-signal"
                    >
                      search everything
                    </Link>
                  </>
                )}
              </>
            )}
          </p>
        </header>

        {q.trim().length > 0 && groups.length === 0 && (
          <p className="py-10 text-[14px] text-muted">
            Nothing matched. Terms are combined with AND, so fewer words find more — and
            <span className="font-mono text-text"> "quoted phrases"</span> match exactly.
          </p>
        )}

        {groups.map((group) => (
          <section key={group.sessionId} className="border-b border-rule py-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link
                href={`/sessions/${group.sessionId}`}
                className="min-w-0 flex-1 truncate font-display text-[15px] font-medium text-text hover:text-signal"
              >
                {group.title ?? group.sessionId}
              </Link>
              <Link
                href={`/projects/${group.projectId}`}
                className="shrink-0 font-mono text-[11px] text-dim hover:text-signal"
              >
                {group.projectName}
              </Link>
              <span className="shrink-0 font-mono text-[11px] text-dim">
                {relativeTime(group.hits[0]?.ts ?? null)}
              </span>
            </div>

            <ul className="mt-2">
              {group.hits.map((hit) => (
                <li key={hit.messageUuid}>
                  <Link
                    href={`/sessions/${hit.sessionId}?m=${encodeURIComponent(hit.messageUuid)}`}
                    className="block border-s border-rule py-1.5 ps-3 transition-colors hover:border-s-signal"
                  >
                    <span className="flex items-baseline gap-2 font-mono text-[10px] text-dim">
                      <span>{hit.kind}</span>
                      {hit.isSidechain && <span className="text-muted">subagent</span>}
                      <span>{stamp(hit.ts)}</span>
                    </span>
                    <p className="mt-0.5 text-[13px] leading-snug text-muted">
                      {splitSnippet(hit.snippet).map((segment, index) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: a snippet run has no identity beyond position
                          key={index}
                          className={
                            segment.match ? 'rounded-[2px] bg-signal/25 text-text' : undefined
                          }
                        >
                          {segment.text}
                        </span>
                      ))}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {total > offset + PAGE_SIZE && (
          <nav className="py-6">
            <Link
              href={`/search?${new URLSearchParams({
                q,
                ...(project !== undefined && { project }),
                ...(prefix === '1' && { prefix }),
                page: String(Number(page ?? '1') + 1),
              }).toString()}`}
              className="rounded-sm border border-rule px-3 py-2 font-mono text-[12px] text-dim hover:border-signal hover:text-signal"
            >
              next {Math.min(PAGE_SIZE, total - offset - PAGE_SIZE)} →
            </Link>
          </nav>
        )}
      </main>
    </>
  )
}

interface Group {
  sessionId: string
  title: string | null
  projectId: string
  projectName: string
  hits: SearchHit[]
}

/** Preserves rank order: the first session to appear is the one with the best hit. */
function groupBySession(hits: readonly SearchHit[]): Group[] {
  const groups = new Map<string, Group>()

  for (const hit of hits) {
    const existing = groups.get(hit.sessionId)
    if (existing === undefined) {
      groups.set(hit.sessionId, {
        sessionId: hit.sessionId,
        title: hit.sessionTitle,
        projectId: hit.projectId,
        projectName: hit.projectName,
        hits: [hit],
      })
    } else existing.hits.push(hit)
  }

  return [...groups.values()]
}
