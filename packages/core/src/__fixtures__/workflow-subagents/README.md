# Fixture: workflow-subagents

Derived from a real Claude Code transcript via `scripts/anonymise-fixture.ts`.
Structure is byte-for-byte faithful; identities, credentials and prose are not.

- Claude Code version: `2.1.198`
- Lines: 13 (0 deliberately malformed)
- Source lines selected: `--lines 1-6,12-18` of 267
- Prose: replaced with deterministic filler
- Subagent transcripts: 3
- Agents selected: `--agents a28c2f8eb69294d78,a76ef90fbbf1b7354,a2b84adb895396028`
- Sidechain lines selected: `--subagent-lines 1,4-11`

| Record type | Count |
| --- | ---: |
| `user` | 3 |
| `assistant` | 3 |
| `mode` | 2 |
| `file-history-snapshot` | 2 |
| `system` | 1 |
| `last-prompt` | 1 |
| `ai-title` | 1 |

## What this fixture is here to prove

That sidechains are **not all in one directory**, and that a loader which reads only the
top level of `subagents/` silently under-reports the sessions that did the most work.

Agents spawned by the Workflow tool nest a level deeper. On the machine this was captured
from there were 177 such transcripts, none of them ever indexed; the session that leaned on
workflows hardest reported 221,781 output tokens against a real 2,810,387 — **92% of its
spend missing**, with nothing anywhere to indicate a number was wrong.

The directory layout is the fixture. Three workflow directories, chosen for what each one
breaks:

| Directory | Contents | Catches |
| --- | --- | --- |
| `wf_6c8105ba-380` | 2 agents + `journal.jsonl` | descent; several agents in one directory; the journal sitting right beside them |
| `wf_3a420fad-abe` | 1 agent + `journal.jsonl` | a second workflow directory in the same session |
| `wf_edd090dc-ab7` | `journal.jsonl` only | a workflow directory with no agents at all |

`journal.jsonl` is the Workflow tool's own log — `started`/`result` records, no transcript
envelope. It is here because widening the glob to `*.jsonl` is the obvious way to reach the
nested files, and its records carry an `agentId`, so doing that yields a plausible phantom
agent rather than an error. Flattening this tree when copying it would defeat the whole
capture.

Every `meta.json` here is `{agentType: "workflow-subagent", spawnDepth: 1}` with **no
`toolUseId`** — verified as 177 of 177 workflow agents against 205 of 205 `Task`-spawned
agents that do carry one. These agents are therefore unattached by construction, which is a
different thing from an agent whose spawning call is merely in another file.

The sidechain line ranges keep one response written as several `assistant` records sharing
a `message.id`, so the fixture also holds the per-response billing case rather than only
the discovery case.
