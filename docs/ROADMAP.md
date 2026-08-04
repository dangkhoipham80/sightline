# Roadmap

Shipped as a sequence of small, independently reviewable pull requests. Each one must run
on its own — no PR depends on a later one to be useful.

**PRs 1–6 contain no LLM code at all.** Sightline has to be worth opening before it is
allowed to cost a cent.

| # | Branch | Contents | Status |
| --- | --- | --- | --- |
| 1 | `chore/scaffold` | Monorepo, tooling, CI, `CLAUDE.md`, `SKILLS.md`, `docs/` | ✅ |
| 2 | `feat/transcript-parser` | `packages/core`: tolerant Zod schemas, streaming parser, subagent loading, lineage linking, WSL/Windows path normalisation, anonymised fixtures, golden tests | ✅ |
| 3 | `feat/ingest-db` | `packages/db` + `packages/ingest`: schema, migrations, FTS5, scanner, signature-based incremental ingest, chokidar watcher, project grouping by git root | 🚧 |
| 4 | `feat/web-shell` | `apps/web`: dashboard, project page, session list — deterministic data only | |
| 5 | `feat/session-viewer` | Transcript renderer: progressive disclosure, diff rendering for `Edit`/`Write`, subagent sub-threads, minimap, virtualisation | |
| 6 | `feat/search` | FTS5 queries + ⌘K palette, scoped and global | |
| 7 | `feat/ai-summaries` | `packages/ai`: provider abstraction, redaction, Tier 1 digests, Tier 2 project briefs, caching | |
| 8 | `feat/mcp-server` | `packages/mcp` + `sightline export` | |
| 9 | `feat/cli` | `sightline serve \| scan \| summarize \| mcp \| export`, npx packaging | |
| 10 | `docs/polish` | README, screenshots, ADRs, install guide | |

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

Being a Claude Code client (no chat, no prompt sending), cloud sync, and any write path
into `~/.claude`. See `docs/PRD.md` for why.
