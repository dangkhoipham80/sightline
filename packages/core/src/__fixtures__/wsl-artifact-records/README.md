# Fixture: wsl-artifact-records

Derived from a real Claude Code transcript via `scripts/anonymise-fixture.ts`.
Structure is byte-for-byte faithful; identities, credentials and prose are not.

- Claude Code version: `2.1.238`
- Lines: 23 (0 deliberately malformed)
- Source lines selected: `--lines 746-768` of 971
- Prose: replaced with deterministic filler
- Subagent transcripts: 0

| Record type | Count |
| --- | ---: |
| `assistant` | 4 |
| `user` | 3 |
| `attachment` | 3 |
| `frame-link` | 2 |
| `artifact-comment-monitor` | 1 |
| `system` | 1 |
| `artifact-autoreact-ledger` | 1 |
| `file-history-snapshot` | 1 |
| `last-prompt` | 1 |
| `ai-title` | 1 |
| `mode` | 1 |
| `permission-mode` | 1 |
| `atis-latch` | 1 |
| `pr-link` | 1 |
| `bridge-session` | 1 |

## What this fixture is here to prove

Claude Code `2.1.238` writes five record types that `2.1.198` did not. All five appear
here, and this is the first capture in the repo from the **WSL** store rather than the
Windows one.

| Type | What it is |
| --- | --- |
| `atis-latch` | Emitted once per turn while the session is bridged to claude.ai. `atis` was `""` in all 141 records across the store — meaning genuinely unknown |
| `bridge-session` | Ties the local session to its claude.ai counterpart. Arrives carrying `ownerAccountUuid` and `ownerOrganizationUuid`, which the parser deliberately does not read |
| `frame-link` | A claude.ai artifact the session produced. Two shapes, both present here: one naming the artifact, one a bare `artifactCount` + `timestamp` |
| `artifact-comment-monitor` | Per-artifact comment state, keyed by artifact id |
| `artifact-autoreact-ledger` | Per-artifact reaction bookkeeping, keyed by artifact id |

The point that needed checking rather than assuming: **none of the five carries a `uuid`.**
That is what makes them a display problem and not a repeat of trap 1, where `attachment`
records *do* carry one and excluding them severed 1,345 records. `fixtures.test.ts` asserts
it against this capture instead of taking it on trust.

### Two things about this capture that are artefacts, not evidence

- **`parentUuid` values dangle here.** Lines 746–768 are a window cut out of a 970-line
  session, so the parents of the first few messages are simply outside the window. This is
  *not* an observation of trap 4 in the wild — that still has zero real occurrences. It does
  incidentally exercise the orphan-to-root path.
- **The window spans a session boundary** (`last-prompt` → `ai-title` → `mode` →
  `permission-mode` → `atis-latch` → `bridge-session`), which is why the bookkeeping records
  cluster in the middle rather than at the top.

### Reproducing it

```bash
pnpm --filter @sightline/core exec tsx scripts/anonymise-fixture.ts \
  '\\wsl.localhost\Ubuntu-24.04\home\<user>\.claude\projects\<folder-key>\<session>.jsonl' \
  src/__fixtures__/wsl-artifact-records \
  --lines 746-768 \
  --replace App_BlueOne_v2=Sample_App_v2 --replace App-BlueOne-v2=Sample-App-v2 \
  --replace blueone-v1=sample-v1 --replace demo-phieu-giao=demo-artifact
```

The two `--replace` spellings of the project name are both needed: it appears as the real
directory name *and* in the lossy folder-key encoding, where `_` has already become `-`.
