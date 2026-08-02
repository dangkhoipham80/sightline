# Claude Code transcript format

> Reverse-engineered from live data (Claude Code `2.1.198`, August 2026), cross-checked
> against public write-ups and the upstream issue tracker. This is not an official spec
> and Anthropic changes it without notice — treat every statement here as "true of the
> versions we have observed", and see [Version history](#version-history).

This document exists because getting these details wrong is the single largest source of
bugs in every transcript viewer in this space. If you're about to write a parser, read
[Traps](#traps) first.

---

## On-disk layout

```
~/.claude/
├── projects/
│   └── <project-folder-key>/
│       ├── <session-uuid>.jsonl              ← the main transcript, append-only
│       └── <session-uuid>/
│           ├── subagents/
│           │   ├── agent-<agentId>.jsonl     ← one file per subagent
│           │   └── agent-<agentId>.meta.json
│           └── tool-results/
│               └── <ref>.txt                 ← spilled large tool output
├── file-history/
│   └── <uuid>/<fileHash>@v<N>                ← pre-edit backups of touched files
├── history.jsonl                             ← flat log of every prompt the user typed
└── settings.json                             ← incl. cleanupPeriodDays
```

### `<project-folder-key>`

The working directory with every non-alphanumeric character replaced by `-`.

```
\\wsl.localhost\Ubuntu-24.04\home\dangkhoi04\code\App_BlueOne_v2
→  --wsl-localhost-Ubuntu-24-04-home-dangkhoi04-code-App-BlueOne-v2
```

**This encoding is lossy and not invertible.** `_`, `.`, `\`, `/` and `-` all map to `-`,
so `App_BlueOne_v2`, `App.BlueOne.v2` and `App-BlueOne-v2` are indistinguishable
afterwards. Any tool that displays a path derived from the folder key is showing you a
guess. Read `cwd` off the first record instead — it is present, absolute, and exact.

### `history.jsonl`

A flat, global list of every prompt submitted, with `display`, `timestamp` (epoch ms),
`project` (the **real** path, not the folder key) and `sessionId`. Useful as a
cross-check when a transcript is missing or truncated, and as a cheap global "what was I
working on" index.

---

## Record types

Every line is one self-contained JSON object with a `type` field. Observed distribution
over a representative 412-line session:

| `type` | Count | Carries conversation | Notes |
| --- | ---: | :---: | --- |
| `assistant` | 167 | ✅ | `message.content[]` of `text` / `thinking` / `tool_use` blocks |
| `user` | 86 | ✅ | prompt text, or `tool_result` blocks |
| `system` | 16 | — | `subtype` = `turn_duration`, etc. |
| `mode` | 22 | — | `normal` / `plan` |
| `permission-mode` | 22 | — | `default` / `acceptEdits` / `bypassPermissions` / `plan` |
| `ai-title` | 22 | — | **Claude's own name for the session** — rewritten as it evolves |
| `last-prompt` | 21 | — | latest prompt + `leafUuid`, used by `--resume` |
| `attachment` | 19 | — | deferred-tool deltas, pasted content, IDE selections |
| `file-history-snapshot` | 15 | — | see [trap 3](#3-file-history-snapshot-messageid-collides-with-message-uuid) |
| `queue-operation` | 10 | — | prompts typed while Claude was still working |

Other types observed in the wild: `summary`, `custom-title`, `agent-name`,
`pr-link`, `compact-boundary`. Assume the list is open-ended.

### Common envelope

Present on `user`, `assistant`, `system` and most others:

```jsonc
{
  "uuid":        "9ee04d5b-…",   // this line's id
  "parentUuid":  "63120809-…",   // the line this responded to; null at a root
  "sessionId":   "992575db-…",
  "timestamp":   "2026-08-01T04:20:08.619Z",
  "cwd":         "\\\\wsl.localhost\\Ubuntu-24.04\\home\\…\\App_BlueOne_v2",
  "gitBranch":   "HEAD",         // literally "HEAD" when detached
  "version":     "2.1.198",      // Claude Code version — use this to gate parsing
  "isSidechain": false,
  "userType":    "external",
  "entrypoint":  "cli",
  "slug":        "dynamic-popping-crab"
}
```

`cwd` is **per record**, not per session — it changes when the user or the agent moves
between directories mid-session. A session can legitimately span several directories of
the same repo; group on the git root, not on `cwd` equality.

### Fields worth mining (no LLM required)

| Field | Where | Use |
| --- | --- | --- |
| `aiTitle` | `ai-title` records | Session title. Free, already good, updated as the session evolves — take the **last** one. |
| `lastPrompt` + `leafUuid` | `last-prompt` | The resume point. |
| `message.usage` | `assistant` | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` → real cost. |
| `message.model` | `assistant` | e.g. `claude-opus-5`. Sessions can mix models. |
| `durationMs`, `messageCount` | `system` / `turn_duration` | Per-turn wall-clock. |
| `content` | `queue-operation` | What the user typed while waiting — often the *real* intent. |
| `prNumber`, `prUrl`, `prRepository` | `pr-link` | Links a session directly to the PR it produced. |
| `promptSource`, `origin.kind` | `user` | Distinguishes typed / pasted / hook-injected / agent-generated input. |

---

## Subagents

Subagent work is **not** inline. Each `Task`/agent invocation writes a sibling file:

```
<session-uuid>/subagents/agent-<agentId>.jsonl
<session-uuid>/subagents/agent-<agentId>.meta.json
```

`meta.json`:

```json
{
  "agentType": "general-purpose",
  "description": "Find live API + recent build context",
  "toolUseId": "toolu_01VRTWwThnGfeXT7c5xNWrDi",
  "spawnDepth": 1
}
```

Every line inside carries `isSidechain: true` and an `agentId`. `toolUseId` is the join
key back to the `tool_use` block in the parent transcript, so a subagent renders as an
expandable sub-thread exactly where it was spawned. `spawnDepth` can exceed 1 — agents
spawn agents.

> Older descriptions of this format claim sidechain lines are interleaved into the main
> file. That has not been true for a long time. Every line in the top-level `.jsonl` has
> `isSidechain: false`. **A parser that only reads the top-level file misses most of the
> work that was actually done.**

## Spilled tool results

Large tool output is written to `<session-uuid>/tool-results/<ref>.txt` rather than
inlined. These files are *not* JSONL — observed content includes line-numbered excerpts of
the transcript itself. Treat them as opaque blobs referenced by the tool result.

## `file-history/`

Pre-edit backups, keyed `<contentHash>@v<N>`, grouped by a directory uuid. Combined with
the `Edit`/`Write` tool inputs from the transcript this is enough to reconstruct a real
diff of what a session changed on disk — including changes that were never committed.

---

## Traps

### 1. The folder key is lossy

Covered above. Never derive a display path or a filesystem path from it. Use it only as
an opaque grouping key, and resolve the real path from `cwd`.

### 2. `parentUuid` can dangle

`parentUuid` may reference a uuid that does not exist anywhere in the file
([anthropics/claude-code#22526](https://github.com/anthropics/claude-code/issues/22526)).
Build a `Map<uuid, record>`, then attach unresolvable children to the root rather than
throwing or dropping them. The transcript is a DAG, not a list — branches happen when the
user rewinds and re-asks.

### 3. `file-history-snapshot` `messageId` collides with message `uuid`

Snapshot records carry a `messageId` equal to the uuid of the message they snapshot
([anthropics/claude-code#36583](https://github.com/anthropics/claude-code/issues/36583)).
Naively indexing every record by "its id" overwrites real messages with snapshots.
**Filter `file-history-snapshot` out before building the uuid index.**

### 4. Session continuation is invisible unless you look for it

On `--resume` (and after compaction) Claude Code opens a **new** file. The new file's
first record carries the *previous* session's id, while the filename carries the new one.

```
filename uuid  ≠  first record's sessionId   ⟹  this file continues that session
```

Follow the chain to reconstruct a lineage. Without this, one continuous week of work
shows up as six unrelated sessions and the whole UI is a lie. Also skip records marked
`isCompactSummary` — they are synthetic, not something the user said.

### 5. Records are not uniformly shaped

Bookkeeping records (`mode`, `permission-mode`, `ai-title`, `last-prompt`) have almost
none of the common envelope — no `uuid`, no `timestamp`, sometimes only `type` and
`sessionId`. Schemas must be per-type unions, not one optional-everything blob.

### 6. Timestamps tie, and sometimes vanish

Several records can share a millisecond, and bookkeeping records have none. File order is
the authoritative sequence. Assign a monotonic `seq` on read and sort by it.

### 7. Transcripts are deleted after 30 days

`cleanupPeriodDays` in `~/.claude/settings.json` defaults to 30. Anything older is gone.
This is why Sightline's index is a permanent archive rather than a cache, and why first
ingest should be run sooner rather than later on a machine with history worth keeping.

### 8. `thinking` blocks are signed and mostly empty

`content[]` entries of type `thinking` carry a long `signature` and frequently an empty
`thinking` string. Don't render the signature, don't count it toward length, and don't
send it to a summariser — it is pure token waste.

---

## Parsing strategy

1. Stream line by line; never `JSON.parse` the whole file.
2. Per line: `JSON.parse` in a `try`; on failure increment a `malformed` counter and move
   on. Report the count — never fail the file.
3. Discriminate on `type` against a Zod union of tolerant (`passthrough`) schemas.
   Unknown `type` → `{ kind: 'raw', raw }`, retained so the UI can show *something* and
   so we can discover new record types by querying for them.
4. Filter `file-history-snapshot` out of the message index (keep them aside — they drive
   the diff view).
5. Build `Map<uuid, node>`, link children, attach orphans to root.
6. Glob `<session>/subagents/agent-*.jsonl`, parse each the same way, join on `toolUseId`.
7. Derive session metadata: last `aiTitle`, first/last timestamp, model set, token totals,
   `file_touches` from `Edit`/`Write`/`Read` tool inputs, artifacts from `pr-link`.
8. Resolve continuation lineage across files within the project folder.

Incremental re-reads exploit append-only-ness: store the byte offset consumed so far and
read only the tail. If the file shrank or the prefix hash changed, reparse from zero.

---

## Version history

| Claude Code version | Observed | Notes |
| --- | --- | --- |
| `2.1.198` | Aug 2026 | Baseline for this document. Subagents in sibling files; `ai-title`, `queue-operation`, `pr-link` present. |

Add a row whenever a fixture for a new version is introduced, and describe the delta.
