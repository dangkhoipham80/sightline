/**
 * `@sightline/db` — the derived index.
 *
 * SQLite via better-sqlite3, with hand-written migrations and FTS5. Everything here can
 * be rebuilt from `~/.claude/projects`; nothing here is a source of truth. See
 * `docs/DATA-MODEL.md` and `docs/adr/0002-raw-sql-over-an-orm.md`.
 */

export type { OpenOptions, SightlineDatabase } from './database.js'
export {
  defaultIndexPath,
  getMeta,
  migrate,
  openDatabase,
  resetDerivedTables,
  setMeta,
} from './database.js'
export type { ProjectRow, SearchHit, SearchOptions, SessionRow } from './queries.js'
export {
  countSearchResults,
  findSessionsByTitle,
  getSession,
  getSessionSignature,
  listContinuations,
  listFileTouches,
  listProjects,
  listSessions,
  search,
} from './queries.js'
export type { Migration } from './schema.js'
export { MIGRATIONS } from './schema.js'
export type { MatchQueryOptions } from './search-query.js'
export { toMatchQuery } from './search-query.js'
export {
  appendRateLimits,
  latestRateLimits,
  loadPricing,
  pricingPath,
  rateLimitsPath,
  sightlineDir,
} from './sightline-home.js'
export type { TokenEventQuery } from './usage-queries.js'
export { hasTokenEvents, listTokenEvents } from './usage-queries.js'
export type { ProjectInput, SessionInput } from './writer.js'
export { upsertProject, writeSession } from './writer.js'
