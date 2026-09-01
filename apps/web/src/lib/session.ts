import 'server-only'

import { existsSync } from 'node:fs'
import type { MessageLocation, TranscriptView } from '@sightline/core'
import { buildTranscriptView, locateMessage, parseSession } from '@sightline/core'
import type { ProjectRow, SessionRow } from '@sightline/db'
import { getSession, listContinuations, listProjects } from '@sightline/db'
import { loadTranscript } from '@sightline/ingest'
import { getDatabase } from '@/lib/db'

export interface SessionPageData {
  session: SessionRow
  project: ProjectRow | undefined
  /** Undefined when the transcript file is gone; the index row outlives the file. */
  view: TranscriptView | undefined
  /** The session this one continues, if that file is still indexed. */
  parent: SessionRow | undefined
  continuations: SessionRow[]
  /** Where an arriving search hit landed, when the URL named one. */
  focus: MessageLocation | undefined
}

/**
 * Assemble everything the session page shows.
 *
 * The index deliberately stores summaries rather than message bodies, so the transcript
 * is re-read from disk on every view. That is the right trade: the file is a few hundred
 * kilobytes of local JSONL, and the alternative is a second copy of the source of truth
 * that can silently drift from it.
 */
export function loadSessionPage(
  sessionId: string,
  focusMessageUuid?: string,
): SessionPageData | undefined {
  const db = getDatabase()
  const session = getSession(db, sessionId)
  if (session === undefined) return undefined

  const parsed = readTranscript(session)

  return {
    session,
    project: listProjects(db, { includeArchived: true }).find((p) => p.id === session.projectId),
    view: parsed === undefined ? undefined : buildTranscriptView(parsed),
    parent: session.parentSessionId === null ? undefined : getSession(db, session.parentSessionId),
    continuations: listContinuations(db, session.id),
    // Resolved here rather than in the browser: the uuid → turn mapping needs the records,
    // and shipping every message uuid to the client to avoid one server-side scan would
    // cost far more than it saves.
    focus:
      parsed === undefined || focusMessageUuid === undefined
        ? undefined
        : locateMessage(parsed, focusMessageUuid),
  }
}

function readTranscript(session: SessionRow): ReturnType<typeof parseSession> | undefined {
  // A transcript can be deleted or cleaned up between a scan and a page view. That is a
  // missing file, not a broken page — the index row still describes what happened.
  if (!existsSync(session.filePath)) return undefined

  try {
    // The path is all a read needs; everything else on a `DiscoveredSession` describes
    // where the file was found, which the index already answered.
    const { lines, subagents } = loadTranscript({ filePath: session.filePath })

    return parseSession({ sessionId: session.id, lines, subagents })
  } catch {
    // Parsing never throws; reading can — a permission change, a file that vanished
    // between the check and the read. Neither is worth a 500.
    return undefined
  }
}
