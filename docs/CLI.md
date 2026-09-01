# The `sightline` binary

```
sightline serve                 run the web UI (default http://127.0.0.1:4317)
sightline scan                  index every ~/.claude this machine can reach
sightline export <session>      one session as Markdown
sightline statusline            read a statusLine payload on stdin, capture rate limits
```

Roadmap PR 9's row also names `summarize` and `mcp`. They are **not** implemented, and they
are not silently absent either: both exit 1 naming the roadmap PR that has to ship first
(`packages/ai` for `summarize`, `packages/mcp` for `mcp`). A command that exits 0 having
done nothing is worse than one that says why it cannot.

Every command reads `$SIGHTLINE_INDEX`, then falls back to `~/.sightline/index.db`.
`--index` overrides both — which is how you point a scan at a scratch database instead of
your real one, and worth doing before any run that could re-ingest.

---

## `serve`

```
sightline serve [--port 4317] [--host 127.0.0.1] [--index <path>] [--open]
```

**Needs a repository checkout with `apps/web` built.** `serve` is a supervisor over
`next start`, not a server of its own.

### Why it spawns Next rather than bundling or importing it

Three options were on the table:

| | Verdict |
| --- | --- |
| **Spawn `next start`** | Chosen. Zero new build machinery, and the thing that runs in production is the thing that runs under `pnpm dev`. |
| `output: 'standalone'` | Rejected for now. It changes the build for every consumer, and `.next/static` and `public/` are *not* copied into the standalone output — so it adds a copy step whose omission produces a site that loads with no CSS. It buys nothing until there is something to publish. |
| `import next` as a library | Rejected. It means owning a custom HTTP server and, more to the point, adding a second module resolution path around `better-sqlite3` — a native addon `apps/web/next.config.ts` already goes to deliberate trouble to keep out of webpack's bundle. That failure surfaces as `Cannot read properties of undefined`, a long way from its cause. |

Two guards exist because both failures have cost real time here:

- **The port is probed before spawning.** `next start` on a taken port reports EADDRINUSE
  in a way that reads like a Next problem; the usual cause is an earlier `sightline serve`
  still running — which then goes on serving an *older build* while you read the new one's
  output and conclude the change did not work.
- **`.next/BUILD_ID` is checked, not `.next/`.** A `.next` left by `pnpm dev` exists and is
  not something `next start` will serve.

`--open` polls the port rather than parsing Next's "Ready" line, whose wording has moved
between minor versions.

### npx

Not claimed, and deliberately not. `apps/cli` depends on `workspace:*` packages, which do
not publish, and `serve` needs a built `apps/web` besides. Publishing is its own piece of
work — bundle or real publish, plus the standalone build above — and it belongs after
`packages/ai` and `packages/mcp` exist, so that what ships is the whole CLI rather than
three fifths of it.

## `scan`

```
sightline scan [--force] [--index <path>] [--quiet]
```

Calls `scanAll`, never the single-store `scan`. The single-store version succeeds on a
machine with two `~/.claude` directories and returns a smaller, entirely plausible index —
the failure mode [ADR 0005](adr/0005-two-claude-code-data-stores.md) exists to describe.

Reference run, Windows store, 138 sessions: 21 s cold, 0.3 s warm.

Reading the output:

- Distros that were skipped are **named**, with the reason. A stopped distro shortens the
  index by everything that happened inside it.
- **Exit code 1 if any store could not be read.** Rows already written are kept; a scan
  that indexed one store and lost another is not a clean run and should not report as one.
- `N projects touched` counts what this run resolved, not what the index holds. An
  incremental scan legitimately reports 2 on a 14-project index.
- Malformed lines are reported separately from failed sessions. One bad line never costs a
  file — that is the parser's contract, and conflating the two counts would hide it.

## `export`

```
sightline export <session-id-or-title> [--out <path>] [--thinking] [--no-tool-results]
```

Markdown on stdout, or to `--out`. The argument is an exact session id, or a substring of a
title; an ambiguous title is listed rather than resolved to the newest, because exporting
the wrong session succeeds silently and a Markdown file is not read closely enough to catch
it.

The rendering is `renderMarkdown` in `@sightline/core` — pure, fixture-tested, and shared
with the MCP server when PR 8 lands. An agent reading a second, subtly different rendering
of the same session is a bug that would take a long time to notice.

Every truncation is annotated: clipped text says how many characters were dropped, a
clipped diff says so while still reporting the whole change's `+n −m`, and unparseable
lines are counted at the end. An export that silently looked complete is the failure worth
designing against.

Subagents are included — **including the workflow-spawned ones that have no `tool_use` call
to sit beside.** There were 177 of those unindexed on the reference machine until PR #20;
dropping them yields an export that looks whole and is missing most of the session.

Fences widen to survive their contents. Transcripts are full of Markdown, and a tool result
containing ` ``` ` closes a three-backtick fence early. On one real 140-subagent session
this fired 118 times.

## `statusline`

See [USAGE-ACCOUNTING.md](USAGE-ACCOUNTING.md). `sightline statusline --install` **prints**
the settings snippet; it never writes `~/.claude/settings.json`. That is rule 2, and the
usage meter is the one feature with a real reason to want an exception.
