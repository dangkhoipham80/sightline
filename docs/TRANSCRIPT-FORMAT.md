# Claude Code transcript format

> Reverse-engineered from live data (Claude Code `2.1.198`, August 2026), cross-checked
> against public write-ups and the upstream issue tracker. This is not an official spec
> and Anthropic changes it without notice — treat every statement here as "true of the
> versions we have observed", and see [Version history](#version-history).

This document exists because getting these details wrong is the single largest source of
bugs in every transcript viewer in this space. If you're about to write a parser, read
[Traps](#traps) first.

**Every claim below is tagged with its evidence**, because several traps widely repeated
in public write-ups did not reproduce on our corpus, and the trap that actually cost us
1,345 lost records is not documented anywhere else:

| Tag | Meaning |
| --- | --- |
| ✅ **verified** | Observed directly in our corpus and covered by a test |
| ⚠️ **unverified** | Reported publicly or upstream, but *not* observed at `2.1.198`. We defend against it anyway; it is cheap to handle and expensive to get wrong |

Corpus used throughout: **52 sessions · 59 subagent transcripts · 36,815 records ·
127.5 MB**, from 12 projects spanning WSL and Windows working directories, all written by
Claude Code `2.1.198`. Reproduce with
`pnpm --filter @sightline/core exec tsx scripts/check-corpus.ts`.

Counts in [trap 11](#11-the-type-list-grows-between-releases) come from a second, wider
sweep of **both** stores — 485 transcript files, 144,442 records — because the record types
it describes do not exist in the `2.1.198` corpus above.

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
├── sessions/
│   └── <pid>.json                            ← processes running *right now*
├── daemon/                                   ← background-dispatch supervisor
├── history.jsonl                             ← flat log of every prompt the user typed
└── settings.json                             ← incl. cleanupPeriodDays
```

`sessions/` and `daemon/` are live state rather than transcript, and have their own
document: **`docs/LIVE-SESSIONS.md`**. They are listed here only so the layout is complete.

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

Also observed in our corpus: `agent-name` (146 occurrences — a user-facing name for an
agent session, distinct from `ai-title`) and `pr-link`. Reported elsewhere but not seen
here: `summary`, `custom-title`, `compact-boundary`. Assume the list is open-ended — see
[trap 11](#11-the-type-list-grows-between-releases) for what happened when it did.

### Which records carry a `uuid`

This distinction turns out to matter more than any other, so it is worth stating flatly.
Measured over a 20-file sample:

| Carries `uuid` | Does not |
| --- | --- |
| `user`, `assistant`, `system`, **`attachment`** | `mode`, `permission-mode`, `file-history-snapshot`, `ai-title`, `last-prompt`, `queue-operation`, `pr-link`, `agent-name`, `atis-latch`, `bridge-session`, `frame-link`, `artifact-comment-monitor`, `artifact-autoreact-ledger` |

`attachment` being in the left column is [trap 1](#1-the-conversation-graph-is-wider-than-the-conversation).
`file-history-snapshot` being in the right column is what makes
[trap 3](#3-file-history-snapshot-messageid-collides-with-message-uuid) narrower than it
is usually described.

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
| `message.usage` | `assistant` | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` → real cost. **Usage belongs to the API response, not the record**: one response is written as several `assistant` records that each repeat it, so summing per record over-counts by 2.4×. Group by `message.id` and keep the last. See [USAGE-ACCOUNTING.md](USAGE-ACCOUNTING.md). |
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

### 1. The conversation graph is wider than the conversation

✅ **verified — 1,345 records, 3.7% of the corpus**

`attachment` records carry a `uuid` **and** a `parentUuid`. They are links in the chain,
not annotations beside it. A parser that indexes only `user` / `assistant` / `system`
records severs every branch that passes through an attachment, and each severed message
then looks like a legitimate root rather than like an error.

This is the trap that actually bit us, it is documented nowhere else, and it is invisible
without a corpus check: the resulting tree renders fine. Our first implementation reported
1,345 "dangling parentUuid" records and we nearly wrote them up as evidence for trap 3
below. Every single one had an `attachment` as its parent.

**Index every record that carries a `uuid`.** Filter for display, not for structure.

### 2. The folder key is lossy

✅ **verified**

Covered above. Never derive a display path or a filesystem path from it. Use it only as
an opaque grouping key, and resolve the real path from `cwd`.

### 3. `file-history-snapshot` `messageId` collides with message `uuid`

✅ **collision verified** · ⚠️ **impact narrower than usually described**

Snapshot records carry a `messageId` equal to the uuid of the message they snapshot
([anthropics/claude-code#36583](https://github.com/anthropics/claude-code/issues/36583)),
and our smallest five-line fixture contains an instance of exactly that.

But snapshots carry **no `uuid` field of their own**, so a parser indexing on `uuid`
alone is already immune. The collision only bites code that reaches for
`messageId ?? uuid` — which is a very natural thing to write, and is presumably how the
upstream report was found. Excluding snapshots explicitly costs one line and removes the
hazard permanently.

### 4. `parentUuid` can dangle

⚠️ **unverified at 2.1.198 — 0 occurrences once trap 1 was fixed**

`parentUuid` is reported to sometimes reference a uuid absent from the file
([anthropics/claude-code#22526](https://github.com/anthropics/claude-code/issues/22526)).
We have not seen it. Handle it anyway: attach unresolvable children to the root rather
than throwing or dropping them, because the cost is a branch and the benefit is nothing.

The transcript is a DAG, not a list — genuine branches happen when the user rewinds and
re-asks.

### 5. Session continuation

⚠️ **unverified at 2.1.198 — 0 occurrences across 52 sessions**

The widely documented heuristic is:

```
filename uuid  ≠  first record's sessionId   ⟹  this file continues that session
```

**Not a single record in our entire corpus carries a `sessionId` differing from its
filename**, including in projects where `--resume` was used heavily. Either the behaviour
changed, or it only appears after compaction, or the reports describe a different version.

We implement the check because it is nearly free and the failure mode it prevents is
severe — one continuous week of work rendering as six unrelated sessions. But it is
currently untested against reality, and the UI must not *depend* on it. Also skip records
marked `isCompactSummary`: they are synthetic, not something the user said.

### 6. Duplicate uuids happen

✅ **verified — 11 occurrences, all `user` records, all in one file**

The same `uuid` can appear twice, most plausibly from a tail being replayed after an
interrupted write. First occurrence wins; count the rest and move on.

### 7. Records are not uniformly shaped

Bookkeeping records (`mode`, `permission-mode`, `ai-title`, `last-prompt`) have almost
none of the common envelope — no `uuid`, no `timestamp`, sometimes only `type` and
`sessionId`. Schemas must be per-type unions, not one optional-everything blob.

### 8. Timestamps tie, and sometimes vanish

Several records can share a millisecond, and bookkeeping records have none. File order is
the authoritative sequence. Assign a monotonic `seq` on read and sort by it.

### 9. Transcripts are deleted after 30 days

`cleanupPeriodDays` in `~/.claude/settings.json` defaults to 30. Anything older is gone.
This is why Sightline's index is a permanent archive rather than a cache, and why first
ingest should be run sooner rather than later on a machine with history worth keeping.

### 10. There is more than one `~/.claude`

✅ **verified — 4 of 17 folder keys misattributed on the reference machine**

`os.homedir()` finds one store. A Windows machine that also runs WSL has two, and they are
separate installations with separate settings, separate cleanup schedules, and separate
histories:

| Store | Folder keys | Binary |
| --- | ---: | --- |
| `C:\Users\khoi\.claude` | 17, four of them `--wsl-localhost-Ubuntu-24-04-…` | `claude.cmd` |
| `/home/dangkhoi04/.claude` | 3 | `/home/dangkhoi04/.local/bin/claude` |

The trap is not that a store is missing — that is merely incomplete. The trap is that
**a UNC `cwd` does not mean the session belongs to WSL.** Those four
`--wsl-localhost-…` keys are the *Windows* `claude` invoked with a UNC working directory.
Their transcripts live in the Windows store, and the WSL store has never heard of them.

So `cwd` tells you where the work happened; only the store tells you which binary can
resume it. Deriving one from the other produces a `wsl -d … -- claude --resume <id>` that
runs successfully against a store containing no such session, and reports nothing.

One project can legitimately appear in both stores — `App_BlueOne_v2` does here — so
indexing one of them shows half a history with no indication the other half exists.
Indexing both reunites it: 13 projects rather than 15, with `blueone-v1` holding 22
sessions drawn from both stores.

Finding the second store is its own small minefield — `wsl.exe` speaks UTF-16LE, its error
messages arrive on *stdout* in a different encoding than the command output, and reading a
distro at all wakes it up. See [ADR 0005](adr/0005-two-claude-code-data-stores.md).

### 11. The `type` list grows between releases

✅ **verified — 306 records, 5 new types, first written by `2.1.238`**

Our `2.1.198` corpus knows thirteen record types. The WSL store on the same machine runs
`2.1.246` and its transcripts contain five more, all of them added around `2.1.238` and all
of them connected to sessions bridged to claude.ai:

| `type` | Count | Carries `uuid` | What it is |
| --- | ---: | :---: | --- |
| `atis-latch` | 141 | — | One per turn while the session is bridged. `atis` was `""` in **all 141** — meaning unknown |
| `bridge-session` | 140 | — | Ties the local session to its claude.ai counterpart. Carries `bridgeSessionId`, `lastSequenceNum`, and the account's `ownerAccountUuid` / `ownerOrganizationUuid` |
| `artifact-autoreact-ledger` | 14 | — | Per-artifact reaction bookkeeping, keyed by artifact id. Has its own schema `v` |
| `frame-link` | 9 | — | A claude.ai artifact the session produced. **Two shapes**: 1 record named the artifact (`path`, `frameUrl`, `title`), the other 8 were a bare `artifactCount` + `timestamp` |
| `artifact-comment-monitor` | 2 | — | Per-artifact comment state, keyed by artifact id |

**None of the five carries a `uuid`**, and that is the fact worth checking rather than
assuming. `attachment` does, which is why excluding it severed 1,345 records (trap 1). These
five never touched the graph — they were a *display* failure, 306 records rendering as
"unrecognised" while sitting in the index intact. Different severity, and the only way to
know which you have is to look.

The `ownerAccountUuid` / `ownerOrganizationUuid` pair on `bridge-session` are stable account
identifiers rather than session data. The parser reads neither: a field that enters the
domain model enters the database and `sightline export` with it.

Two related things live nearby and are **not** transcript:

- `<session>/subagents/workflows/wf_<id>/journal.jsonl` — the Workflow tool's own journal,
  with `started` / `result` records (202 in our Windows store) and no transcript envelope at
  all. The `agent-*.jsonl` glob already excludes it. Don't widen that glob.
- The `signature` on a `thinking` block is base64 protobuf, and the organization uuid is
  *inside* it. Any redaction that only inspects the encoded string will miss it.

### 12. `last-prompt` sometimes has no prompt

✅ **verified — 17 of 6,199 records, both stores, `2.1.198` and `2.1.238`+**

`last-prompt` is the resume pointer. `leafUuid` is the half `--resume` needs and was present
on **all 6,199** records observed. `lastPrompt` — the text displayed beside it — is absent
from 17 of them, at most one per session file:

| Position of the bare record | Count | Context |
| --- | ---: | --- |
| First record in the file, no `user` record before it | 13 | Session boot |
| Last record of a 6- or 7-line file | 2 | The file is a `/clear` and nothing else |
| Last record of a long file | 2 | Session ended on something other than a prompt |

So the field is optional, and a schema that requires it turns a readable resume pointer into
a `raw` record. The **inference** — that Claude Code writes the record whenever it has a leaf
but no prompt text to show — is consistent with all 17 but is not itself measured. The
tidier hypothesis, *"absent exactly when `leafUuid` points outside this file"*, is **false**:
all 17 leaf uuids resolve within their own file.

There is a second-order trap here worth stating, because it is the kind that arrives disguised
as a fix. Making the field optional *creates* a way to lose data: while `lastPrompt` was
required, a bare record degraded to `raw` and never reached session derivation at all. Once it
parses, a bare record arriving **last** will assign `undefined` over a prompt already read.
Four of the 17 are the last `last-prompt` in their file. Only overwrite when the text is there.

### 13. `thinking` blocks are signed and mostly empty

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
4. Filter `file-history-snapshot` out of the index (keep them aside — they drive the diff
   view).
5. Build `Map<uuid, node>` over **every remaining record that has a `uuid`** — attachments
   included, per trap 1 — link children, attach orphans to root.
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
| `2.1.198` | Aug 2026 | Baseline for this document. Subagents in sibling files; `ai-title`, `agent-name`, `queue-operation`, `pr-link` present. Attachments participate in the uuid graph. No session-continuation mismatches and no genuinely dangling `parentUuid` observed. |
| `2.1.198` | Sep 2026 | Second store found on the same machine (trap 10). Live session registry documented separately in `docs/LIVE-SESSIONS.md`. No transcript-format delta. |
| `2.1.238`–`2.1.241` | Sep 2026 | Read from the WSL store (binary now at `2.1.246`; no session has run under it yet, so the newest records we can attest to are `2.1.241`). **Five new record types** — `atis-latch`, `bridge-session`, `frame-link`, `artifact-comment-monitor`, `artifact-autoreact-ledger` — all tied to claude.ai bridging, none carrying a `uuid`. See [trap 11](#11-the-type-list-grows-between-releases). Fixture: `wsl-artifact-records`. `last-prompt` also appears without its `lastPrompt` field, but that is not new — it happens at `2.1.198` too. |

Add a row whenever a fixture for a new version is introduced, and describe the delta.
