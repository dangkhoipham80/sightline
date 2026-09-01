export const PRODUCT_NAME = 'Sightline'

/**
 * Bumped whenever the derived index shape changes in a way that makes previously
 * ingested rows wrong rather than merely incomplete. The indexer compares this
 * against the value stored in the database and forces a full re-ingest on mismatch,
 * which is cheap because the source of truth is always the JSONL on disk.
 */
// 3: token accounting corrected. `sessions.tokens_*` written before this are wrong in both
//    directions at once — inflated 2.4× by counting one API response once per `assistant`
//    record, and missing every subagent. Old rows are not merely incomplete, so they go.
// 4: Workflow-spawned subagents are loaded. The bump is the only thing that makes the fix
//    reach an index that already exists: `isUnchanged` compares the size and mtime of the
//    *main* transcript, and finding 177 sidechains that were always on disk changes neither.
//    Without this, every already-ingested session would keep its under-counted totals
//    forever, and the meter would look fixed while still being wrong.
export const SIGHTLINE_SCHEMA_VERSION = 4
