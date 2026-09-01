import 'server-only'

import { parseHostPath, resumeCommand } from '@sightline/core'
import type { SessionRow } from '@sightline/db'

/**
 * The command that reopens a session where it ran.
 *
 * Null when there is nowhere honest to send the user: the transcript never recorded a
 * working directory, or the row predates the store columns and we cannot say which
 * `claude` owns the session.
 *
 * That second case used to be papered over by deriving the store from
 * `process.platform` — sound only while ingest read exactly one store, and the placeholder
 * said so. It now comes off the session row, which is the only thing that actually knows.
 * The one answer never permitted is a guess from the working directory: a
 * `\\wsl.localhost\…` cwd is usually the *Windows* binary, and resuming that inside WSL
 * runs against a data directory that has never heard of the session. See ADR 0005.
 */
export function sessionResumeCommand(
  session: Pick<SessionRow, 'id' | 'cwd' | 'store'>,
): string | null {
  if (session.cwd === null || session.store === null) return null

  return resumeCommand({
    hostPath: parseHostPath(session.cwd),
    store: session.store,
    sessionId: session.id,
  })
}
