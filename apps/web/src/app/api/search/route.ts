import { countSearchResults, findSessionsByTitle, search } from '@sightline/db'
import { type NextRequest, NextResponse } from 'next/server'
import { getDatabase, indexExists } from '@/lib/db'
import { SNIPPET_MARKERS } from '@/lib/snippet'

export const dynamic = 'force-dynamic'

/**
 * The palette's query endpoint.
 *
 * A route handler rather than a server action because this fires on every keystroke:
 * actions are POSTs that participate in the router's revalidation, which is the wrong
 * shape for a read that should be cancellable and cacheable by nothing at all.
 *
 * `prefixLastTerm` is on, so `redirec` finds `redirect` while the user is still typing.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams
  const query = params.get('q') ?? ''
  const projectId = params.get('project') ?? undefined
  const limit = Math.min(Number(params.get('limit') ?? 20), 50)

  if (!indexExists() || query.trim().length === 0) {
    return NextResponse.json({ sessions: [], hits: [], total: 0 })
  }

  const db = getDatabase()
  const scope = projectId === undefined ? {} : { projectId }

  // Titles first: half of what a palette is for is "take me to the thing I can name", and
  // full-text over message bodies answers that badly — the session you want is buried
  // under every message that happens to mention the word.
  const sessions = findSessionsByTitle(db, query, { ...scope, limit: 5 }).map((session) => ({
    id: session.id,
    title: session.title,
    projectId: session.projectId,
    startedAt: session.startedAt,
    messageCount: session.messageCount,
  }))

  const hits = search(db, query, {
    ...scope,
    limit,
    prefixLastTerm: true,
    markers: SNIPPET_MARKERS,
  })

  return NextResponse.json({
    sessions,
    hits,
    total: countSearchResults(db, query, { ...scope, prefixLastTerm: true }),
  })
}
