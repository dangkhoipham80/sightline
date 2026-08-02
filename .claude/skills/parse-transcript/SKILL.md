---
name: parse-transcript
description: Use when changing anything in packages/core that reads Claude Code's JSONL transcripts, when a parser test fails, or when Claude Code has shipped a new transcript format. Covers the parser's invariants and the correct way to add a fixture instead of editing one.
---

# Changing the transcript parser

`docs/TRANSCRIPT-FORMAT.md` is the spec. Read it first — it records traps that were
verified against live data and that every other viewer in this space gets wrong.

## Invariants that must survive your change

1. **Never throw on real input.** A malformed line is skipped and counted, not fatal.
   An unrecognised `type` goes into the `raw` bucket. Claude Code changes its format
   without notice; a parser that crashes on an unknown record is a parser that breaks
   for users on the next CLI release.
2. **Never reconstruct a path from the project folder name.** The encoding is lossy
   (`_` and `.` both collapse to `-`). Read `cwd` from the first record.
3. **Filter `file-history-snapshot` before building the uuid index.** Its `messageId`
   can collide with a real message `uuid` (upstream bug anthropics/claude-code#36583).
4. **Traverse `parentUuid` defensively.** It can reference a uuid that isn't in the file
   (upstream bug anthropics/claude-code#22526). Dangling parents attach to the root.
5. **Load the sibling subagent files.** `<session>/subagents/agent-*.jsonl` plus the
   matching `.meta.json`. Dropping them loses most of the actual work.
6. **Preserve ordering.** Records are append-only; file order is the ground truth when
   timestamps tie or are missing.

## Adding a fixture

Fixtures live in `packages/core/src/__fixtures__/<case-name>/`, are byte-exact, and are
marked `-text` in `.gitattributes` so git never rewrites them.

```bash
# 1. Find a real session that exhibits the case
ls ~/.claude/projects/

# 2. Copy it, then anonymise
pnpm --filter @sightline/core exec tsx scripts/anonymise-fixture.ts \
  ~/.claude/projects/<folder>/<session>.jsonl \
  src/__fixtures__/<case-name>/
```

Anonymisation replaces usernames, absolute paths outside the project, hostnames, emails,
tokens and repo URLs — and **must not** alter structure: same line count, same record
types, same uuid graph shape. A fixture that has been structurally "tidied" no longer
tests anything real.

Name the directory after the *behaviour* it pins, not the session:
`resume-continuation/`, `dangling-parent-uuid/`, `subagent-depth-2/`,
`snapshot-uuid-collision/`.

Every fixture directory gets a `README.md` — one paragraph: where it came from, which
Claude Code `version` produced it, and what it is here to prove.

## When Claude Code changes its format

Do **not** edit the existing fixture to match the new shape. That silently drops coverage
for every user still on the old version.

1. Add a *new* fixture directory suffixed with the version: `attachment-v2.1.198/`.
2. Extend the Zod schema with the new shape as a union member; keep the old one.
3. Add a test asserting **both** parse correctly.
4. Record the delta in `docs/TRANSCRIPT-FORMAT.md` under "Version history".

## Before opening the PR

Run the corpus check — it parses every transcript on the machine and asserts no throws
and no dropped messages:

```bash
pnpm --filter @sightline/core test
pnpm --filter @sightline/core exec tsx scripts/check-corpus.ts ~/.claude/projects
```

The corpus check is not part of CI (it needs local data), so it is on you to run it.
Report its output in the PR body — including the count of skipped malformed lines, which
should be zero or explained.
