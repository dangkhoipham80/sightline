# Architecture

## Shape

```
              every ~/.claude on the machine — Windows and each WSL distro
                    projects/**/*.jsonl · sessions/<pid>.json
                              (read-only, source of truth)
                              │
                    ┌─────────▼─────────┐
                    │  packages/core    │  parse · normalise paths · link lineage
                    │  pure, no I/O deps│  ← exhaustively fixture-tested
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐        ┌──────────────────┐
                    │ packages/ingest   │───────▶│  packages/db     │
                    │ scan · watch      │        │  SQLite + FTS5   │
                    │ incremental index │        │  ~/.sightline/   │
                    └───────────────────┘        └────┬────────┬────┘
                                                      │        │
                              ┌───────────────────────┘        │
                              │                                │
                    ┌─────────▼─────────┐            ┌─────────▼─────────┐
                    │  packages/ai      │───────────▶│  summaries table  │
                    │  redact · map     │            └─────────┬─────────┘
                    │  reduce · cache   │                      │
                    └───────────────────┘             ┌────────┴────────┐
                                                      │                 │
                                            ┌─────────▼──────┐ ┌────────▼────────┐
                                            │   apps/web     │ │  packages/mcp   │
                                            │   (humans)     │ │   (agents)      │
                                            └───────┬────────┘ └─────────────────┘
                                                    │ ws://127.0.0.1
                                            ┌───────▼──────────────┐
                                            │ packages/terminal    │  separate process
                                            │ PTY per project      │  spawns `claude`
                                            │ headless mirror      │  watches sessions/
                                            └──────────────────────┘
```

Two readers, one index. That symmetry is the whole design: anything the UI can render,
the MCP server can answer, because both read the same tables.

`packages/terminal` is the one arrow that points *out* — it starts processes rather than
reading files. It is a separate OS process for a reason given in
[ADR 0003](adr/0003-a-pty-sidecar-over-a-next-custom-server.md), and it still writes
nothing to `~/.claude`: the `claude` it spawns writes its own transcripts, which ingest
then picks up like any other.

## Packages

| Package | Responsibility | May depend on |
| --- | --- | --- |
| `@sightline/core` | Domain types, JSONL parsing, path normalisation, lineage linking | *nothing internal* |
| `@sightline/db` | Drizzle schema, migrations, FTS5, query helpers | `core` |
| `@sightline/ingest` | Directory scanning, chokidar watching, incremental indexing | `core`, `db` |
| `@sightline/ai` | Provider abstraction, redaction, prompt pipeline, caching | `core`, `db` |
| `@sightline/mcp` | MCP server over the index | `core`, `db` |
| `@sightline/terminal` | PTY supervisor, WebSocket server, live-session watcher | `core`, `db` |
| `apps/web` | Next.js UI | all packages |
| `apps/cli` | `sightline` binary | all packages |

**`core` stays pure.** No database, no network, no filesystem beyond a passed-in stream.
That purity is what lets it be tested against hundreds of real transcript fixtures
without setup, and it is the single most important constraint in the repo.

## Key decisions

### SQLite, not Postgres or a vector store

Local-first, zero-setup, single file the user can delete. FTS5 gives excellent full-text
search with no separate service. Embeddings would add an index to maintain, a model to
download, and latency — for a corpus where keyword search over *AI-written summaries*
already answers the question, because the summaries are dense and already semantic. If
recall proves insufficient, embeddings go in as an additive column, not a rewrite.

### The database is a derived index, never a source of truth

Everything except `summaries`, `notes`, and user-edited `decisions` / `open_threads` can
be rebuilt from disk. Migrations get to be pragmatic: when one would be gnarly, bump
`SIGHTLINE_SCHEMA_VERSION` and re-ingest. See `.claude/skills/add-migration/`.

### The store is not the path

`HostPath.kind` describes the shape of a working directory. **Which `~/.claude` a session
was written to** is a separate fact, and it is the one that decides which `claude` binary
can resume it and where a terminal must be spawned. They agree in the common case, which is
exactly why conflating them survived review once already. See
[ADR 0005](adr/0005-two-claude-code-data-stores.md) and trap 10 in
`docs/TRANSCRIPT-FORMAT.md`.

### Group projects by real git root, not folder key

Claude Code's folder key is a lossy encoding of `cwd`, and one repository routinely
produces several of them (root, subpackage, mobile app). Grouping on the resolved git
root reunites them. `cwd` is read from the records; git root is resolved by walking up
from it. When the directory no longer exists — a deleted or renamed repo — the last known
`cwd` is retained and the project is marked orphaned rather than dropped, because its
history is often exactly what you want to look up.

### Incremental ingest by file signature

The indexer stores each transcript's size and mtime and skips anything unchanged. What
changed is reparsed **in full**, not from a byte offset: every session aggregate is a
function of the whole transcript, and the entire corpus reparses in seconds, so tail-only
reads would buy complexity rather than speed. See `docs/DATA-MODEL.md` for the state
machine and its two known blind spots.

### Claude CLI headless as the default AI provider

`claude -p --output-format json` uses the subscription the user already pays for — no API
key, no per-token billing, no new credential to leak. The provider interface is small
(`summarize(prompt, schema) → object`), so an Anthropic SDK provider is a drop-in for
anyone who prefers it or needs parallelism the CLI can't give.

### Structured output everywhere

Every summarisation stage declares a Zod schema. Prose summaries are unqueryable, and the
MCP server needs fields — `decisions`, `open_threads`, `risks` — not paragraphs. The
Markdown a human reads is *rendered from* the structure, not the other way round.

### Redaction as a chokepoint, not a habit

One function, one call site per provider, its own test suite. Real transcripts contain
real credentials; "remember to redact" is not a design.

## Data flow: a session ends

1. `chokidar` sees `<session>.jsonl` grow — or one of its `subagents/agent-*.jsonl`
   sidechains, which changes the session without touching the parent file at all.
2. The write is debounced (quiet period, with a ceiling so a long agent run still updates),
   then ingest reparses the transcript and replaces `messages`, `tool_calls`,
   `file_touches`, `artifacts` and the session aggregates in one transaction.
3. FTS5 triggers keep the search index in sync.
4. SSE pushes the delta; the open UI updates without a refresh.
5. *If* summarisation is enabled (or the user clicks Summarize), `ai` computes a
   `source_hash`, misses the cache, redacts, maps over turn-groups on the cheap model,
   reduces on the strong one, and writes a `summaries` row plus extracted `decisions` and
   `open_threads`.
6. The project brief is marked stale and regenerated lazily on next view.

## What is deliberately absent

- **No server process required to read.** `sightline serve` is a local Next.js server; the
  CLI and MCP server talk to the same SQLite file directly. The terminal sidecar is
  required only to *run* a terminal — without it the console tab says so and everything
  else works.
- **No background daemon by default.** Watching is opt-in per invocation, and the sidecar
  starts with `pnpm dev` / `sightline serve` rather than at login.
- **No network calls** except to the configured AI provider — and none at all in v0.1.
  The terminal is a local socket; it never leaves the loopback interface.
- **No writes to `~/.claude`, still.** Spawning `claude` in a PTY is not a write path: the
  child writes its own data directory, exactly as it does from any other terminal.
