<div align="center">

# Sightline

**A clear line of sight into every Claude Code session, across every project.**

*Stop vibing blind.*

</div>

---

Claude Code writes a complete, honest record of everything it does — every prompt, every
tool call, every file it edited — into `~/.claude/projects/**/*.jsonl`. Then it makes that
record almost impossible to use:

- `claude --resume` only ever shows you the sessions for **the directory you're standing in**.
- Across five repos you get five disconnected lists of opaque session IDs.
- Transcripts older than 30 days are **deleted by default** (`cleanupPeriodDays`).
- Even when you find the right session, it's 2,000+ JSON lines. Nobody reads that.

So you end up trusting an agent whose work you never actually reviewed. That's vibe coding
blind, and it doesn't scale past one small project.

**Sightline turns that record into something you — and your agents — can actually use.**

## What it does

- **One dashboard for every project.** Every repo Claude has ever touched, WSL and Windows
  alike, grouped by real git root rather than by Claude's lossy folder names.
- **AI session digests.** Each session gets a durable, reviewable summary: what you asked,
  what actually changed (with file paths), what was decided and why, what broke, **what you
  should go verify yourself**, and what's still unfinished.
- **A living project brief.** Digests reduce upward into a per-project brief: current
  architecture, active workstreams, decision log, open threads.
- **Full-text search across everything.** Messages, summaries and decisions, scoped to one
  project or across all of them.
- **A permanent archive.** Sightline's index outlives Claude Code's 30-day cleanup.
- **An MCP server, so your agents can read it too.** Claude working in *any* project can ask
  `sightline_project_brief`, `sightline_decisions`, `sightline_open_threads` — turning months
  of past sessions into queryable institutional memory instead of deleted JSONL.

Read-only on `~/.claude`. Your transcripts are never modified.

## Status

🚧 **Pre-alpha — under active construction.** Nothing is installable yet.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what's landing in what order, and
[`docs/PRD.md`](docs/PRD.md) for the full product rationale.

## Documentation

| Doc | What's in it |
| --- | --- |
| [`docs/PRD.md`](docs/PRD.md) | Problem, users, market gap, scope |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Packages, data flow, key decisions |
| [`docs/TRANSCRIPT-FORMAT.md`](docs/TRANSCRIPT-FORMAT.md) | Reverse-engineered spec of Claude Code's JSONL |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | SQLite schema and indexing strategy |
| [`docs/AI-PIPELINE.md`](docs/AI-PIPELINE.md) | Summarization pipeline, prompts, redaction, cost |
| [`docs/MCP.md`](docs/MCP.md) | MCP tool surface and setup |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Branch/PR workflow and local dev |
| [`CLAUDE.md`](CLAUDE.md) | How Claude Code should work inside this repo |

## License

MIT — see [LICENSE](LICENSE).
