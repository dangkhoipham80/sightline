import 'server-only'

import type { ProjectRow } from '@sightline/db'
import { listProjects } from '@sightline/db'
import { getDatabase, indexExists } from '@/lib/db'

/**
 * One project by id, or undefined.
 *
 * A scan of `listProjects` rather than a `WHERE id = ?` query, because `store` is derived
 * by a window function over the whole sessions table and there is no single-row query that
 * produces it. At this corpus size — seventeen projects — the difference is unmeasurable,
 * and duplicating that window function for one row is how the two would drift apart.
 *
 * Archived projects included: reaching a project by URL is a deliberate act, and hiding it
 * from its own page because it is archived would be a 404 that says nothing true.
 */
export function findProject(id: string): ProjectRow | undefined {
  if (!indexExists()) return undefined
  return listProjects(getDatabase(), { includeArchived: true }).find((p) => p.id === id)
}
