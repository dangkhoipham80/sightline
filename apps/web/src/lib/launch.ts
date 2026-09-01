import 'server-only'

import { type LaunchStore, parseHostPath, resumeCommand } from '@sightline/core'
import type { SessionRow } from '@sightline/db'

/**
 * Which `~/.claude` a session was written to.
 *
 * **This is a placeholder that is right today and will be wrong tomorrow.** Ingest
 * currently reads exactly one store — the one under `os.homedir()` — so every indexed
 * session came from the host Sightline is running on, and deriving the store from the
 * platform is sound. PR 14 indexes every store on the machine and adds
 * `projects.store_kind`, at which point this reads the column instead.
 *
 * What it must *not* do is guess from the working directory. A `\\wsl.localhost\…` cwd is
 * usually the Windows binary with a UNC directory, and resuming that inside WSL runs
 * against a data directory that has never heard of the session. See ADR 0005.
 */
function localStore(): LaunchStore {
  return process.platform === 'win32' ? { host: 'windows' } : { host: 'unix' }
}

/**
 * The command that reopens a session where it ran, or `null` when the transcript never
 * recorded a working directory and there is nowhere honest to send the user.
 */
export function sessionResumeCommand(session: Pick<SessionRow, 'id' | 'cwd'>): string | null {
  if (session.cwd === null) return null

  return resumeCommand({
    hostPath: parseHostPath(session.cwd),
    store: localStore(),
    sessionId: session.id,
  })
}
