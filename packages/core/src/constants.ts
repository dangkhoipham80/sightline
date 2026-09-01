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
export const SIGHTLINE_SCHEMA_VERSION = 3
