import 'server-only'

import { existsSync } from 'node:fs'
import type { TranscriptView } from '@sightline/core'
import { buildTranscriptView, parseSession } from '@sightline/core'
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
}

/**
 * Assemble everything the session page shows.
 *
 * The index deliberately stores summaries rather than message bodies, so the transcript
 * is re-read from disk on every view. That is the right trade: the file is a few hundred
 * kilobytes of local JSONL, and the alternative is a second copy of the source of truth
 * that can silently drift from it.
 */
export function loadSessionPage(sessionId: string): SessionPageData | undefined {
  const db = getDatabase()
  const session = getSession(db, sessionId)
  if (session === undefined) return undefined

  return {
    session,
    project: listProjects(db, { includeArchived: true }).find((p) => p.id === session.projectId),
    view: readView(session),
    parent: session.parentSessionId === null ? undefined : getSession(db, session.parentSessionId),
    continuations: listContinuations(db, session.id),
  }
}

function readView(session: SessionRow): TranscriptView | undefined {
  // A transcript can be deleted or cleaned up between a scan and a page view. That is a
  // missing file, not a broken page — the index row still describes what happened.
  if (!existsSync(session.filePath)) return undefined

  try {
    const { lines, subagents } = loadTranscript({
      sessionId: session.id,
      folderKey: '',
      filePath: session.filePath,
      fileSize: 0,
      fileMtimeMs: 0,
    })

    return buildTranscriptView(parseSession({ sessionId: session.id, lines, subagents }))
  } catch {
    // Parsing never throws; reading can — a permission change, a file that vanished
    // between the check and the read. Neither is worth a 500.
    return undefined
  }
}
