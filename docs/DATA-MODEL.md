# Data model

SQLite (`better-sqlite3`) + Drizzle ORM, stored at `~/.sightline/index.db` by default.
`WAL` mode, `foreign_keys = ON`.

**The index is derived.** Everything below can be rebuilt from `~/.claude/projects/**`
*except* the three tables marked 🔒 — those hold work that cost tokens or human attention
and must survive every migration.

---

## Tables

### `projects`

One row per real repository, **not** per Claude Code folder key.

| Column | Notes |
| --- | --- |
| `id` | stable hash of `git_root` (or of `real_cwd` when there's no git root) |
| `git_root` | resolved by walking up from `cwd`; nullable |
| `real_cwd` | last observed working directory — the display path |
| `folder_keys` | JSON array; several Claude folder keys map to one project |
| `display_name` | derived from repo name, user-overridable |
| `repo_url` | from `git remote` or from `pr-link` records |
| `host_kind` | `wsl` \| `windows` \| `unix` — drives resume-command generation |
| `first_seen`, `last_active` | |
| `orphaned` | directory no longer exists; keep the history, flag the row |
| `archived` | user-hidden |

### `sessions`

| Column | Notes |
| --- | --- |
| `id` | session uuid (from the **filename**) |
| `project_id` | |
| `parent_session_id` | set when this file continues an earlier session — see trap 4 in `TRANSCRIPT-FORMAT.md` |
| `file_path`, `file_size`, `file_mtime_ms` | the change-detection signature; unchanged means skip |
| `ai_title` | last `ai-title` record — Claude's own name for the session |
| `slug`, `git_branch` | |
| `started_at`, `ended_at`, `duration_ms` | |
| `msg_count`, `user_msg_count`, `tool_call_count`, `malformed_line_count` | |
| `models` | JSON array — sessions mix models |
| `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write`, `cost_est` | |

### `messages`

| Column | Notes |
| --- | --- |
| `uuid` | PK |
| `session_id`, `parent_uuid` | `parent_uuid` may dangle — not a foreign key |
| `seq` | monotonic on read; **the** ordering key, since timestamps tie and sometimes vanish |
| `role`, `type`, `ts` | |
| `text` | flattened text blocks, for FTS |
| `has_thinking` | signatures are never stored — pure token waste |
| `is_sidechain`, `agent_id` | subagent lines live here too, flagged |

### `tool_calls`

`id`, `session_id`, `message_uuid`, `name`, `input_json`, `result_ref`, `is_error`, `ts`.

`result_ref` points at `<session>/tool-results/<ref>.txt` when output was spilled to disk.

### `file_touches`

`session_id`, `project_id`, `path`, `op` (`read` | `edit` | `write`), `count`, `last_ts`.

Derived from tool inputs. Powers "what did Claude actually change", the per-project file
heatmap, and "show me every session that touched `auth.ts`".

### `subagents`

`agent_id` (PK), `session_id`, `parent_tool_use_id`, `agent_type`, `description`,
`spawn_depth`, `msg_count`, `started_at`, `ended_at`.

`parent_tool_use_id` joins back to the `tool_use` block that spawned it, so a subagent
renders inline where it happened.

### `artifacts`

`session_id`, `kind` (`pr-link` | `commit` | `url`), `payload_json`, `ts`.

`pr-link` records give a free session ↔ pull-request join.

### 🔒 `summaries`

| Column | Notes |
| --- | --- |
| `scope` | `session` \| `project` \| `week` |
| `target_id` | |
| `model`, `prompt_version` | |
| `source_hash` | hash of the redacted input; cache key together with the two above |
| `structured_json` | the Zod-validated object — what MCP serves |
| `content_md` | rendered from `structured_json` for humans |
| `input_tokens`, `output_tokens`, `cost` | |
| `stale` | prompt changed cosmetically; regenerate lazily |
| `created_at` | |

### 🔒 `decisions`

`project_id`, `session_id`, `message_uuid` (the citation), `title`, `rationale`,
`alternatives_json`, `status` (`active` | `superseded` | `rejected`), `superseded_by`,
`user_edited`, `ts`.

Extracted by the AI pipeline, editable by the user. This is what answers *"why did we
choose X?"* three months later — the question that costs the most to re-derive.

### 🔒 `open_threads`

`project_id`, `first_seen_session`, `title`, `body`, `status` (`open` | `done` |
`dropped`), `user_edited`, `ts`.

### 🔒 `notes`

`target_kind` (`project` | `session` | `message`), `target_id`, `body_md`, `ts`.

### Search

FTS5 `external content` virtual tables with `porter unicode61` tokenisation:

- `messages_fts` over `messages.text`
- `summaries_fts` over `summaries.content_md`
- `decisions_fts` over `decisions.title || rationale`

Each has `AFTER INSERT` / `AFTER UPDATE` / `AFTER DELETE` sync triggers. All three must be
updated together when a searchable column changes — see `.claude/skills/add-migration/`.

### `meta`

`key`/`value`. Holds `schema_version`, comparison against
`SIGHTLINE_SCHEMA_VERSION` forcing a rebuild of derived tables on mismatch.

---

## Indexes

```sql
CREATE INDEX idx_sessions_project_started ON sessions(project_id, started_at DESC);
CREATE INDEX idx_messages_session_seq     ON messages(session_id, seq);
CREATE INDEX idx_tool_calls_session_name  ON tool_calls(session_id, name);
CREATE INDEX idx_file_touches_path        ON file_touches(project_id, path);
CREATE INDEX idx_summaries_lookup         ON summaries(scope, target_id, prompt_version);
```

`(project_id, started_at DESC)` is the dashboard and timeline query.
`(session_id, seq)` is the session page. Everything else is secondary.

## Ingest state machine

```
discover file ─▶ size/mtime match stored? ─yes─▶ skip
       │no (or --force, or a subagent file changed)
       ▼
parse whole transcript + sidechains ─▶ delete session rows ─▶ reinsert ─▶ store new signature
```

**Implemented, superseding an earlier byte-offset design.** Reading only the appended tail
looks free — the files are append-only — but every session aggregate (token totals, file
touches, counts, title) is a function of the *whole* transcript, so a tail read would have
to merge partial aggregates and stay correct across compaction and rewrites. Reparsing the
entire 127 MB corpus takes under four seconds, so the complexity bought nothing. Revisit
if a corpus shows up where it matters.

The whole per-session write is one transaction, and it deletes before it reinserts — a
crash mid-write leaves the previous signature in place, so the next run simply redoes it.

Two known consequences, stated rather than hidden:

- A rewrite that preserves both size and mtime is invisible. `--force` is the escape hatch.
- A **subagent** write changes what a session contains without touching the parent file, so
  the watcher force-indexes on sidechain events instead of trusting the signature.
