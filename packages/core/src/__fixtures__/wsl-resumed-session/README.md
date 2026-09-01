# Fixture: wsl-resumed-session

Derived from a real Claude Code transcript via `scripts/anonymise-fixture.ts`.
Structure is byte-for-byte faithful; identities, credentials and prose are not.

- Claude Code version: `2.1.241`
- Lines: 8 (0 deliberately malformed)
- Source lines selected: `--lines 1-8` of 463
- Prose: replaced with deterministic filler
- Subagent transcripts: 0

| Record type | Count |
| --- | ---: |
| `last-prompt` | 1 |
| `mode` | 1 |
| `permission-mode` | 1 |
| `atis-latch` | 1 |
| `bridge-session` | 1 |
| `attachment` | 1 |
| `file-history-snapshot` | 1 |
| `user` | 1 |

## What this fixture is here to prove

Line 1 is a `last-prompt` record with **no `lastPrompt` field** — just `leafUuid`,
`sessionId` and `type`. A schema that requires the text drops the whole record into `raw`,
which is how a resume pointer we could have read gets reported as a record we do not
understand.

The eight lines are the boot sequence of a resumed session, which is what makes the shape
legible: the resume pointer is written *before* there is a prompt to point at.

### What we actually measured, and what we did not

Across both stores — 6,199 `last-prompt` records — **17 carry no `lastPrompt`**, at most one
per session file, and every one of the 17 still carries `leafUuid`. That much is counted.

Where they sit is also counted:

| Position | Count | Context |
| --- | ---: | --- |
| First record in the file, no `user` record before it | 13 | Session boot, like this fixture |
| Last record of a 6- or 7-line file | 2 | The file is a `/clear` and nothing else |
| Last record of a long file (1965/1969, 293/294) | 2 | Session ended on something other than a prompt |

The **inference** — not measured — is that Claude Code writes the record whenever it has a
leaf to point at but no prompt text to show. The obvious tidier hypothesis, *"`lastPrompt`
is absent exactly when `leafUuid` points outside this file"*, was checked and is **false**:
all 17 leaf uuids resolve to a record in the same file.

### Why the two-line unit test next to it matters more than it looks

The last two rows of that table are a live regression risk that only appeared *because* of
this fix. While `lastPrompt` was required, a bare record degraded to `raw` and never reached
`deriveSessionSummary`. Now that it parses, a bare record arriving last would assign
`undefined` over a prompt already read — so those two sessions would lose a `last_prompt`
they currently have. `deriveSessionSummary` only overwrites when the text is present.

### Reproducing it

```bash
pnpm --filter @sightline/core exec tsx scripts/anonymise-fixture.ts \
  '\\wsl.localhost\Ubuntu-24.04\home\<user>\.claude\projects\<folder-key>\<session>.jsonl' \
  src/__fixtures__/wsl-resumed-session \
  --lines 1-8 \
  --replace App_BlueOne_v2=Sample_App_v2 --replace App-BlueOne-v2=Sample-App-v2 \
  --replace blueone-v1=sample-v1
```
