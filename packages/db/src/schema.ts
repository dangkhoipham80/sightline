/**
 * Schema migrations, applied in order and recorded in the `migrations` table.
 *
 * The database is a **derived index**: every row here except summaries, notes and
 * user-edited decisions can be rebuilt from `~/.claude/projects` in seconds. That makes
 * migrations cheap — when one would be gnarly, bumping `SIGHTLINE_SCHEMA_VERSION` and
 * re-ingesting is a legitimate answer. See `.claude/skills/add-migration/`.
 *
 * FTS5 virtual tables and their sync triggers are written by hand. There are three
 * triggers per table and all three must be updated together; missing one produces a
 * search index that is silently stale, which is worse than one that is obviously broken.
 */

export interface Migration {
  id: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001-initial',
    sql: /* sql */ `
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  -- Resolved by walking up from cwd. Null when the directory is gone or has no repo.
  git_root      TEXT,
  -- Last observed working directory: the display path, and the fallback identity.
  real_cwd      TEXT NOT NULL,
  -- JSON array. One repository routinely produces several Claude folder keys.
  folder_keys   TEXT NOT NULL DEFAULT '[]',
  display_name  TEXT NOT NULL,
  repo_url      TEXT,
  host_kind     TEXT NOT NULL,
  distro        TEXT,
  first_seen    TEXT,
  last_active   TEXT,
  -- The directory no longer exists. Keep the history and flag the row: a deleted repo's
  -- history is often exactly what someone wants to look up.
  orphaned      INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Set when this file continues an earlier session (see trap 5 in TRANSCRIPT-FORMAT.md).
  -- Deliberately not a foreign key: the parent may have been deleted by cleanup.
  parent_session_id  TEXT,

  file_path          TEXT NOT NULL,
  file_size          INTEGER NOT NULL DEFAULT 0,
  file_mtime_ms      INTEGER NOT NULL DEFAULT 0,

  ai_title           TEXT,
  agent_name         TEXT,
  slug               TEXT,
  git_branch         TEXT,
  version            TEXT,
  cwd                TEXT,
  last_prompt        TEXT,

  started_at         TEXT,
  ended_at           TEXT,
  duration_ms        INTEGER,

  record_count            INTEGER NOT NULL DEFAULT 0,
  message_count           INTEGER NOT NULL DEFAULT 0,
  user_message_count      INTEGER NOT NULL DEFAULT 0,
  assistant_message_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count         INTEGER NOT NULL DEFAULT 0,
  subagent_count          INTEGER NOT NULL DEFAULT 0,
  malformed_count         INTEGER NOT NULL DEFAULT 0,
  orphan_count            INTEGER NOT NULL DEFAULT 0,
  duplicate_uuid_count    INTEGER NOT NULL DEFAULT 0,

  models             TEXT NOT NULL DEFAULT '[]',
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  uuid         TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Not a foreign key: parentUuid can dangle, and dropping those rows would drop
  -- real conversation. See trap 4 in TRANSCRIPT-FORMAT.md.
  parent_uuid  TEXT,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  ts           TEXT,
  text         TEXT NOT NULL DEFAULT '',
  has_thinking INTEGER NOT NULL DEFAULT 0,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  agent_id     TEXT,
  model        TEXT
);

CREATE TABLE tool_calls (
  id           TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_uuid TEXT,
  name         TEXT NOT NULL,
  input_json   TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0,
  seq          INTEGER NOT NULL,
  ts           TEXT,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE file_touches (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  op         TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, path, op)
);

CREATE TABLE subagents (
  agent_id           TEXT NOT NULL,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_tool_use_id TEXT,
  agent_type         TEXT,
  description        TEXT,
  spawn_depth        INTEGER NOT NULL DEFAULT 1,
  message_count      INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT,
  ended_at           TEXT,
  -- The spawning tool_use lives in an earlier session file. Not an error; surfaced so
  -- the UI can show the work rather than hide it.
  unattached         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_sessions_project_started ON sessions(project_id, started_at DESC);
CREATE INDEX idx_sessions_parent          ON sessions(parent_session_id);
CREATE INDEX idx_messages_session_seq     ON messages(session_id, seq);
CREATE INDEX idx_messages_parent          ON messages(parent_uuid);
CREATE INDEX idx_tool_calls_session_name  ON tool_calls(session_id, name);
CREATE INDEX idx_file_touches_path        ON file_touches(project_id, path);
CREATE INDEX idx_artifacts_session        ON artifacts(session_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`,
  },
]
