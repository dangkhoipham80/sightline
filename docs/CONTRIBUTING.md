# Contributing

## Requirements

Node ≥ 22.14, pnpm 10.5+, git. A local Claude Code install is needed for the corpus check
and for the default AI provider — but not for `pnpm verify`, which runs entirely offline.

```bash
pnpm install
pnpm verify      # lint + typecheck + test — the gate CI enforces
```

## Workflow

`main` is protected. Nobody pushes to it, including the repository owner's agents.

```bash
git checkout main && git pull
git checkout -b feat/short-description
# … work …
pnpm verify
git commit                       # Conventional Commits
git push -u origin feat/short-description
gh pr create --base main
```

Then **stop**. The repository owner reviews and merges. Do not merge your own PR and do
not enable auto-merge.

Branch prefixes: `feat/` `fix/` `refactor/` `docs/` `chore/` `test/`.

## Commit messages

Conventional Commits, imperative mood, optional package scope. The body explains *why* —
the diff already covers *what*.

```
fix(core): attach orphaned messages to root instead of dropping them

Claude Code writes parentUuid values referencing uuids absent from the file
(anthropics/claude-code#22526). Dropping those subtrees silently lost whole
branches of long sessions.
```

## Pull requests

Follow `.github/pull_request_template.md`. Say plainly what you verified and what you
did **not** — an honest gap is useful; a confident claim that turns out to be untested is
expensive.

Keep PRs small enough to review in one sitting. If a change wants to be large, look for
the seam that splits it into "mechanical" and "interesting".

## Testing

- Parser changes require a fixture-backed test. See `.claude/skills/parse-transcript/`.
- **Never edit a fixture to make a test pass.** Fixtures are byte-exact captures of real
  transcripts; they are the specification. If Claude Code changed its format, add a new
  version-tagged fixture alongside the old one.
- The corpus check (`scripts/check-corpus.ts`) parses every transcript on your machine and
  asserts no throws and no dropped messages. It is not in CI — it needs local data — so
  run it before any parser PR and report the output.
- Schema changes require a migration test that seeds a row at the previous migration and
  asserts it survives. See `.claude/skills/add-migration/`.

## Things that will get a PR sent back

- Writing anywhere under `~/.claude`
- A prompt change without a `prompt_version` bump
- An LLM call that bypasses the redactor
- `any`, or disabling a strict-mode flag locally to silence an error
- A new import that makes `packages/core` depend on I/O
- An eighth MCP tool without something merging away

## Working with Claude Code in this repo

`CLAUDE.md` is loaded automatically and encodes the rules above. The skills in
`.claude/skills/` cover the procedures that are easy to get subtly wrong — use
`/ship-pr` rather than improvising the branch-and-PR flow.
