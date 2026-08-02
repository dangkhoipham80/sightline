export const PRODUCT_NAME = 'Sightline'

/**
 * Bumped whenever the derived index shape changes in a way that makes previously
 * ingested rows wrong rather than merely incomplete. The indexer compares this
 * against the value stored in the database and forces a full re-ingest on mismatch,
 * which is cheap because the source of truth is always the JSONL on disk.
 */
export const SIGHTLINE_SCHEMA_VERSION = 1
