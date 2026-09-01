# Roadmap

Shipped as a sequence of small, independently reviewable pull requests. Each one must run
on its own — no PR depends on a later one to be useful.

**PRs 1–6 contain no LLM code at all.** Sightline has to be worth opening before it is
allowed to cost a cent.

| # | Branch | Contents | Status |
| --- | --- | --- | --- |
| 1 | `chore/scaffold` | Monorepo, tooling, CI, `CLAUDE.md`, `SKILLS.md`, `docs/` | ✅ |
| 2 | `feat/transcript-parser` | `packages/core`: tolerant Zod schemas, streaming parser, subagent loading, lineage linking, WSL/Windows path normalisation, anonymised fixtures, golden tests | ✅ |
| 3 | `feat/ingest-db` | `packages/db` + `packages/ingest`: schema, migrations, FTS5, scanner, signature-based incremental ingest, chokidar watcher, project grouping by git root | ✅ |
| 4 | `feat/web-shell` | `apps/web`: dashboard, project page, session list — deterministic data only | ✅ |
| 5 | `feat/session-viewer` | Transcript renderer: progressive disclosure, diff rendering for `Edit`/`Write`, subagent sub-threads, minimap, virtualisation | ✅ |
| 6 | `feat/search` | FTS5 queries + ⌘K palette, scoped and global | ✅ |
| 7 | `feat/ai-summaries` | `packages/ai`: provider abstraction, redaction, Tier 1 digests, Tier 2 project briefs, caching | |
| 8 | `feat/mcp-server` | `packages/mcp` + `sightline export` | |
| 9 | `feat/cli` | `sightline serve \| scan \| summarize \| mcp \| export`, npx packaging — `apps/cli` and `sightline statusline` already exist, landed with 16 | |
| 10 | `docs/polish` | README, screenshots, ADRs, install guide | |

### v0.4 — the cockpit

Sequenced as its own run of PRs. It shares no files with 7–10, so the two tracks are
independent and either can go first.

| # | Branch | Contents | Status |
| --- | --- | --- | --- |
| 11 | `docs/cockpit-direction` | This document, the PRD scope change, `docs/LIVE-SESSIONS.md`, ADRs 0003–0005 | ✅ |
| 12 | `fix/host-aware-commands` | `LaunchStore` in `core`; fix `resumeCommand` for the Windows-store/UNC-cwd case and its cmd-only `cd /d`; add `buildSpawnPlan` + `matchHostPath`; wire the two web components to `core` | ✅ |
| 13 | `chore/ci` | Activate `.github/workflows-pending/ci.yml`, add a `windows-latest` leg | ✅ |
| 14a | `feat/store-aware-ingest` | Ingest carries a `LaunchStore` through to `sessions.store_kind` / `store_distro` / `store_root`; two spellings of one WSL directory resolve to one project; schema bump + re-ingest | ✅ |
| 14b | `feat/wsl-store-discovery` | Enumerate distros with `wsl.exe -l -q`, find each one's `$HOME`, index its store over `\\wsl.localhost\…`; polling watcher for the 9P share | ✅ |
| 14c | `feat/scan-every-store` | `scanAll` — the Rescan button reads every discovered store, not just the local one; skipped distros surfaced instead of silently shortening the index | ✅ |
| 15 | `feat/project-sidebar` | Persistent sidebar grouped by store, `InstrumentBar` hoisted into the layout, CONSOLE/REVIEW tabs per project | ✅ |
| 16 | `feat/usage-meter` | `token_events` migration, 5-hour blocks, `sightline statusline` capture, pricing loader, sidebar footer | |
| 17 | `feat/terminal-sidecar` | `packages/terminal`: `ws` server, rendezvous, origin allowlist, ticket HMAC, protocol codec. No PTY yet | |
| 18 | `feat/session-registry` | Watch every store's `~/.claude/sessions`, live status dots | |
| 19 | `feat/pty-supervisor` | `@lydell/node-pty` + `@xterm/headless` mirror, backpressure, orphan reaping | |
| 20 | `feat/terminal-ui` | xterm v6 client, LRU pool, reconnect, launcher | |

The ordering is deliberate in four places. **12 before anything that spawns** — the argv
logic is pure string work and gets reviewed and tested as such, before a process can run
it. **14 before 15**, because the sidebar's Windows/Linux split is wrong until stores are
separated. **14a before 14b**, because everything except the discovery step is pure enough
to test exhaustively, while enumerating distros is I/O that can be slow (9P) or absent (a
stopped distro) — worth reviewing on its own rather than alongside a schema change.
**17 and 19 are split** rather than one `feat/terminal` PR, so the socket that spawns
shells gets reviewed on its own instead of alongside PTY lifecycle code.

A throwaway `spike/pty` branch runs before 17 and is never merged. Its first question is
whether `@xterm/addon-serialize` round-trips a full-screen `claude` TUI out of
`@xterm/headless` — if it does not, the reattach design changes and 19–20 change with it.

## Milestones

**v0.1 — see everything** *(PRs 1–6, 9)*
Every project in one dashboard, every session readable, everything searchable, no LLM.
*Done when:* finding a thing you remember doing "sometime last month" takes under 30 s.

**v0.2 — understand everything** *(PR 7)*
Session digests and project briefs.
*Done when:* you read the digest instead of the transcript and it's enough — and one
`risks` item turns out to be something you actually needed to fix.

**v0.3 — the agent reads it too** *(PR 8)*
MCP server and Markdown export.
*Done when:* in a fresh session in project A, Claude correctly answers "why did we choose
X?" without you re-explaining.

**v0.4 — run everything** *(PRs 11–20)*
One window, one sidebar, a live terminal per project, and a usage meter.
*Done when:* the last per-project OS terminal tab is closed, and a session that has been
sitting on a permission prompt is noticed because the sidebar said so.

## Later, maybe

Ordered by how often the need is likely to bite, not by how interesting they are:

- **Diff reconstruction from `~/.claude/file-history/`** — show what a session actually
  changed on disk, including uncommitted work. High value, moderate effort; a strong
  candidate for v0.4.
- **Timeline across projects** — one chronological feed of everything, all repos.
- **Embeddings** as an additive column, *if* FTS over AI summaries proves insufficient.
  It probably won't; summaries are already dense and semantic.
- **Hook integration** — auto-summarise on `SessionEnd` rather than on demand.
- **Team mode** — shared index, attribution, review workflow.
- **Other agents** (Codex, Cursor, Copilot) — only once the Claude Code experience is
  genuinely good. Breadth before depth would be a mistake.

## Explicitly not planned

Talking to the Anthropic API on the user's behalf (no chat, no prompt sending, no API
keys), cloud sync, and any write path into `~/.claude` — including config.

v0.4 hosts a terminal for the real `claude` binary, which is a change from an earlier
version of this list. See [Why the client boundary moved](PRD.md#why-the-client-boundary-moved)
for what did and did not change, and why the read-only rule is untouched.
