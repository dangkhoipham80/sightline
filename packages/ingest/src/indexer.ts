import type { LaunchStore } from '@sightline/core'
import { parseSession } from '@sightline/core'
import type { SightlineDatabase } from '@sightline/db'
import { getSessionSignature, upsertProject, writeSession } from '@sightline/db'
import type { DiscoveredSession } from './discover.js'
import { loadTranscript } from './discover.js'
import type { ProjectIdentity } from './grouping.js'
import { resolveProject } from './grouping.js'

export interface IngestOutcome {
  projectId: string
  displayName: string
  malformedLines: number
}

export interface Indexer {
  /** Parse one transcript and write its derived rows. Throws if the file is unreadable. */
  ingest(session: DiscoveredSession): IngestOutcome
  /** True when the stored size and mtime match — the transcript needs no re-reading. */
  isUnchanged(session: DiscoveredSession): boolean
  /** Distinct projects this indexer has resolved so far. */
  projectCount(): number
}

/**
 * Shared ingest path for the scanner and the watcher.
 *
 * The state worth keeping between sessions is the project cache: resolving a working
 * directory stats the filesystem and walks up looking for `.git`, and dozens of sessions
 * routinely share one directory. A long-lived watcher gets the same benefit as a scan.
 */
export function createIndexer(db: SightlineDatabase): Indexer {
  const projectCache = new Map<string, ProjectIdentity>()
  const projectIds = new Set<string>()

  return {
    isUnchanged(session) {
      const stored = getSessionSignature(db, session.sessionId)
      return (
        stored !== undefined &&
        stored.fileSize === session.fileSize &&
        stored.fileMtimeMs === session.fileMtimeMs
      )
    },

    ingest(session) {
      const { lines, subagents } = loadTranscript(session)
      const parsed = parseSession({ sessionId: session.sessionId, lines, subagents })

      // The working directory comes from the records, never from the folder name — that
      // encoding is lossy. A transcript with no cwd at all (possible for a session that
      // never got past bookkeeping) falls back to the folder key purely so it has a home.
      const identity = chooseProject(
        projectCache,
        session.store,
        parsed.summary.cwds,
        session.folderKey,
      )
      projectIds.add(identity.id)

      upsertProject(db, {
        id: identity.id,
        gitRoot: identity.gitRoot,
        realCwd: identity.realCwd,
        folderKeys: [session.folderKey],
        displayName: identity.displayName,
        repoUrl: identity.repoUrl,
        hostKind: identity.hostPath.kind,
        distro: identity.hostPath.distro,
        orphaned: identity.orphaned,
      })

      writeSession(db, {
        projectId: identity.id,
        filePath: session.filePath,
        fileSize: session.fileSize,
        fileMtimeMs: session.fileMtimeMs,
        // The store rides on the *session*, not the project: one project can be worked on
        // from two stores, and the answer to "which `claude` reopens this" differs per
        // session. Denormalising it onto `projects` would go stale the first time it did.
        store: session.store,
        storeRoot: session.storeRoot,
        parsed,
      })

      return {
        projectId: identity.id,
        displayName: identity.displayName,
        malformedLines: parsed.summary.malformed.length,
      }
    },

    projectCount() {
      return projectIds.size
    },
  }
}

/**
 * Pick which of a session's working directories defines its project.
 *
 * A session that starts in a container directory and `cd`s into the repository inside it
 * is about the repository, not the container — and on real data that is not hypothetical:
 * `~/code/App_BlueOne_v2` holds no `.git` at all, while `App_BlueOne_v2/blueone-v1` does.
 * Taking the first cwd unconditionally filed that session under the empty container.
 *
 * So: prefer the first directory that resolves to a git root; fall back to the first
 * directory seen. Resolution is cached, so the extra lookups cost nothing after the
 * first session in a given directory.
 */
function chooseProject(
  cache: Map<string, ProjectIdentity>,
  store: LaunchStore,
  cwds: readonly string[],
  fallback: string,
): ProjectIdentity {
  const candidates = cwds.length > 0 ? cwds : [fallback]

  for (const cwd of candidates) {
    const identity = cachedProject(cache, store, cwd)
    if (identity.gitRoot !== undefined) return identity
  }

  return cachedProject(cache, store, candidates[0] ?? fallback)
}

/**
 * Resolving a project stats the filesystem, so cache per run — many sessions share one.
 *
 * Keyed on the store as well as the path, because they are not independent: `/home/me/app`
 * out of a WSL store and `/home/me/app` out of the Windows store are different directories
 * on different filesystems, and a path-only key would hand the second one the first one's
 * answer.
 */
function cachedProject(
  cache: Map<string, ProjectIdentity>,
  store: LaunchStore,
  cwd: string,
): ProjectIdentity {
  // NUL as the separator, spelled as an escape rather than embedded raw: a literal NUL
  // in the source makes git treat the file as binary and stops showing its diff.
  const key = [store.host, store.host === 'wsl' ? store.distro : '', cwd].join('\u0000')
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const identity = resolveProject(cwd, store)
  cache.set(key, identity)
  return identity
}
