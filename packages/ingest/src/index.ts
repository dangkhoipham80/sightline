/**
 * `@sightline/ingest` — filesystem discovery and indexing.
 *
 * This is the only package that reads `~/.claude`, and it only ever reads. See
 * `docs/ARCHITECTURE.md`.
 */

export type {
  ClaudeStore,
  DiscoveredSession,
  LoadedTranscript,
  StoreDiscovery,
} from './discover.js'
export {
  defaultProjectsRoot,
  discoverSessions,
  discoverStores,
  loadTranscript,
  localLaunchStore,
  localStore,
  storeAt,
} from './discover.js'
export type { ProjectIdentity } from './grouping.js'
export { findGitRoot, hostAccessPath, hostPathForStore, resolveProject } from './grouping.js'
export type { Indexer, IngestOutcome } from './indexer.js'
export { createIndexer } from './indexer.js'
export type { ScanOptions, ScanProgress, ScanResult } from './scan.js'
export { scan } from './scan.js'
export type { IndexedEvent, WatchError, Watcher, WatchOptions, WatchTarget } from './watch.js'
export { pollingOptionsFor, resolveWatchTarget, watch } from './watch.js'
export type {
  SkippedDistro,
  SkipReason,
  WslDiscovery,
  WslDiscoveryOptions,
  WslResult,
  WslRunner,
} from './wsl.js'
export {
  decodeWslText,
  discoverWslStores,
  distroHome,
  listDistros,
  wslStoreRoot,
} from './wsl.js'
