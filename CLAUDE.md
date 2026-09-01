# CLAUDE.md

Guidance for Claude Code working inside the **Sightline** repository.

Sightline reads Claude Code's own transcripts and turns them into a reviewable,
searchable, agent-queryable record. That makes this repo unusual in one way worth
holding onto: **we are the tool that catches sloppy agent work, so sloppy agent work
here is especially expensive.** Verify before claiming.

---

## Non-negotiable rules

### 1. Never push to `main`. Never merge.

- Every change goes through a branch and a pull request.
- Start every unit of work from a fresh base: `git checkout main && git pull`.
- Branch names: `feat/…`, `fix/…`, `refactor/…`, `docs/…`, `chore/…`, `test/…`.
- Open the PR with `gh pr create --base main`. **Then stop.** The repository owner
  reviews and merges. Do not merge, do not enable auto-merge, do not force-push `main`.
- After the owner merges, return to `main`, pull, and branch again for the next unit.

The `/ship-pr` skill (`.claude/skills/ship-pr/`) encodes this flow — use it.

### 2. Never modify `~/.claude`

Sightline is **read-only** with respect to Claude Code's own data directory. It reads
`~/.claude/projects/**`, `~/.claude/file-history/**` and `~/.claude/settings.json`. It
writes only to its own data directory (`~/.sightline/` by default) and to files the user
explicitly asks it to export. Any code path that opens a file under `~/.claude` for
writing is a bug.

`packages/ingest/src/read-only.test.ts` enforces it the only way that actually settles the
question: it builds a directory shaped like a real `~/.claude` — transcripts, subagents,
`settings.json`, `history.jsonl`, `file-history/`, the live session registry —
fingerprints every byte, runs a full ingest over it, and fingerprints again. Extend that
fixture when you add a code path that reads something new.

### 3. Never fix a failing test by editing the fixture

Fixtures under `**/fixtures/` are byte-exact captures of real Claude Code transcripts.
They are the specification. If a fixture makes a test fail, the parser is wrong — or
Claude Code changed its format, in which case you **add** a new fixture for the new
version rather than mutating the old one. See `.claude/skills/parse-transcript/`.

### 4. Redaction is not optional

Real transcripts contain API keys, tokens and `.env` values. Nothing reaches an LLM
provider without passing through the redactor in `packages/ai`. If you add a new call
site, it goes through the same chokepoint.

---

## Commands

```bash
pnpm install          # bootstrap
pnpm verify           # lint + typecheck + test  ← run before every PR
pnpm lint:fix         # Biome autofix
pnpm test:watch       # vitest watch across the workspace
pnpm build            # turbo build, topologically ordered
pnpm dev              # run the web app + watchers
```

`pnpm verify` is the gate. A PR that hasn't passed it locally is not ready.

CI runs `verify` plus `build`, on **Ubuntu and Windows**, and asserts that no source file
opens a write path under `~/.claude`. The Windows leg is not decoration: from
`packages/terminal` onward this repo carries platform-specific code — ConPTY, PowerShell
quoting, `taskkill /T /F` — that a Linux-only run cannot see break.

---

## Layout

```
apps/web        Next.js 15 App Router — the UI
apps/cli        the `sightline` binary: serve | scan | summarize | mcp | export
packages/core   domain types, transcript parser, path normalisation   ← pure, no I/O deps
packages/db     Drizzle + better-sqlite3 schema, migrations, FTS5
packages/ingest scanner, watcher, incremental indexer
packages/ai     provider abstraction, prompts, redaction, summarisation pipeline
packages/mcp    MCP server exposing the knowledge base to any Claude Code session
packages/terminal PTY supervisor + WebSocket sidecar: spawns `claude`, watches live sessions
docs/           architecture, data model, transcript spec, ADRs
```

**Dependency direction is one-way**: `core` depends on nothing internal; `db`, `ingest`
and `terminal` depend on `core`; `ai` depends on `core` and `db`; `mcp` and the apps sit
on top. Never introduce a cycle, and never let `core` import a database or network module —
its purity is what makes exhaustive fixture testing possible.

---

## Working with Claude Code's transcript format

Read `docs/TRANSCRIPT-FORMAT.md` before touching anything that parses JSONL. It is a
reverse-engineered spec, and the traps in it are real, load-bearing, and were verified
against live data:

- **`attachment` records are part of the conversation graph.** They carry a `uuid` *and* a
  `parentUuid`. Index every record that has a `uuid`, not just user/assistant/system —
  indexing the narrower set severed 1,345 records on our own corpus and the resulting tree
  looked perfectly plausible. Filter for display, never for structure.
- The project folder name is a **lossy** encoding of the working directory
  (`_` and `.` both become `-`). Never reconstruct a path from it — read `cwd` from the
  first record instead.
- **There is more than one `~/.claude`.** A Windows machine running WSL has two, with
  separate settings and separate histories, and one project can appear in both. Worse, a
  `\\wsl.localhost\…` `cwd` does **not** mean the session belongs to WSL — it is usually
  the Windows binary with a UNC working directory, and resuming it inside WSL silently
  finds nothing. `cwd` says where the work happened; only the store says which `claude`
  can resume it. Never derive one from the other.
- Subagent work lives in sibling files (`<session>/subagents/agent-*.jsonl`), not inline.
  Skipping them loses most of what actually happened.
- `file-history-snapshot` records carry a `messageId` that can collide with a real
  message `uuid`. Filter them **before** building the uuid index.
- `parentUuid` may reference a uuid that does not exist. Traverse defensively; never throw.
- A session file whose first record carries a different `sessionId` than its filename is a
  **continuation** of an earlier session. Link them, don't display them as unrelated.

The last two are documented upstream but did **not** reproduce on our corpus at `2.1.198`.
`docs/TRANSCRIPT-FORMAT.md` tags every claim as verified or unverified — respect that
distinction when you add to it. Writing down a trap you inferred rather than observed is
how the 1,345-record bug nearly got shipped as a feature.

Parsing is tolerant by design: one malformed line must never take down a file, and an
unrecognised record type is data we don't understand yet — not an error.

`~/.claude/sessions/<pid>.json` is *live* state, not transcript, and has its own spec in
`docs/LIVE-SESSIONS.md`. Two things there bite immediately: the file is keyed by pid but
identified by `sessionId` (a resume changes the pid), and a `JSON.parse` failure means a
read raced a write — "try again", never "session gone".

---

## Style

- TypeScript strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  Both are on for a reason; don't disable them locally to make an error go away.
- No `any`. Parse untrusted input with Zod and let the schema express the uncertainty.
- Biome for lint and format — don't hand-format, run `pnpm lint:fix`.
- Comments explain *why*, not *what*. The transcript-format traps above are exactly the
  kind of thing that deserves a comment; a `for` loop is not.
- Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.

## Testing

- Vitest everywhere. Parser changes need a fixture-backed test; a parser PR without one
  will be sent back.
- Prefer real anonymised transcript fixtures over hand-written JSON — hand-written JSON
  tests the parser against your assumptions, and your assumptions are what's wrong.
- Playwright covers the web app's critical path: dashboard → project → session → search.

## When you're unsure

Ask before inventing. Specifically: don't guess at Claude Code's transcript semantics —
inspect real files under `~/.claude/projects/` and confirm, then write the finding into
`docs/TRANSCRIPT-FORMAT.md` so the next person doesn't have to rediscover it.
