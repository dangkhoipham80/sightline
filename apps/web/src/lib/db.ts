import 'server-only'

import { existsSync } from 'node:fs'
import type { SightlineDatabase } from '@sightline/db'
import { defaultIndexPath, openDatabase } from '@sightline/db'

/**
 * The index this server reads. `SIGHTLINE_INDEX` overrides it, which is how you point the
 * UI at a scratch database instead of your real one.
 */
export function indexPath(): string {
  return process.env['SIGHTLINE_INDEX'] ?? defaultIndexPath()
}

let cached: SightlineDatabase | undefined

/**
 * Open the index once per server process.
 *
 * better-sqlite3 is synchronous and the connection is cheap to hold, but reopening it per
 * request would re-run migrations on every page view. The handle is deliberately module
 * state rather than a request-scoped resource: there is exactly one reader here, on one
 * machine, and it is this process.
 */
export function getDatabase(): SightlineDatabase {
  if (cached !== undefined) return cached
  cached = openDatabase({ path: indexPath() })
  return cached
}

/** True once a scan has produced an index. Drives the empty state, not an error page. */
export function indexExists(): boolean {
  return existsSync(indexPath())
}

/** Drop the cached handle so the next read sees a database that was just rebuilt. */
export function closeDatabase(): void {
  cached?.close()
  cached = undefined
}
