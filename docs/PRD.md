# Sightline — Product Requirements

## The problem

Claude Code keeps a complete record of its own work and then makes it unusable.

- `claude --resume` scopes to the directory you're standing in. Across five repos you get
  five disconnected lists of opaque session IDs and slugs.
- A single session is 400–3,000 JSONL lines. Nobody reads that, so nobody does.
- Transcripts older than 30 days are deleted by default.
- Subagent work — often the majority of what happened — lives in sibling files most
  tooling never opens.

The result is a specific and worsening failure mode: **you accumulate weeks of agent work
you have never reviewed and can no longer reconstruct.** You don't know what was changed,
why an approach was chosen, what was left half-finished, or which of the agent's
assumptions were never checked. Every new session starts by re-explaining context the
agent already had last week.

The reference corpus for this project — one developer's machine, August 2026 — is
**174 MB across 12 projects**, spanning WSL and Windows working directories. None of it is
searchable, summarised, or reachable by the agent that produced it.

## Who it's for

1. **Solo developers running Claude Code across several repos.** Primary. Needs: one
   place to see everything, a summary that means they don't have to read transcripts, and
   confidence that they know what the agent actually did.
2. **The agents themselves.** Equally important. An agent starting work in project A
   should be able to ask what happened in project A three weeks ago, and why.
3. *(Later)* Small teams wanting a shared, reviewable record of agent-authored work.

## Market gap

| Category | Examples | Faithful record | Semantic synthesis |
| --- | --- | :---: | :---: |
| Viewers | `d-kimuson/claude-code-viewer`, `jhlee0409/claude-code-history-viewer`, `siteboon/claudecodeui` | ✅ | ❌ |
| Boards / orchestrators | Vibe Kanban (sunset Jul 2026), Crystal (deprecated Feb 2026) | ✅ diffs/cards | ❌ |
| Memory MCP servers | mem0, memory-keeper, knowledge-graph | ❌ never reads transcripts | ⚠️ fragmentary |

Every existing viewer is a **rendering layer**. Search, filter, collapse, minimap — all of
them are manual-attention tools that still require a human to read thousands of messages.
None runs an LLM over a completed transcript to produce a durable, reviewable summary.
Memory MCP servers do synthesis but start from nothing: they never touch the transcript
that already contains the answer.

**Sightline's position: the synthesis layer over the record that already exists, exposed
to both the human and the agent.**

## Principles

1. **Read-only on `~/.claude`.** We never risk a user's transcripts. Our index is
   disposable; their data is not.
2. **Fidelity underneath synthesis.** Every AI claim links back to the turn that backs it.
   A summary you can't drill into is a summary you can't trust.
3. **Surface uncertainty, don't smooth it.** The `risks` section — "here's what the agent
   did that you should verify" — is the product, not a footnote.
4. **Cheap by default.** Deterministic facts need no LLM. Summarisation is cached,
   incremental, opt-in, and runs on the smallest model that does the job.
5. **The agent is a first-class reader.** Anything the UI can show, MCP can answer.

## Scope

### v0.1 — see everything

Ingest all projects · dashboard · session viewer with tool/diff/subagent rendering ·
full-text search · resume-command generation. No LLM anywhere.

**Success:** the user finds a specific thing they remember doing "sometime last month" in
under 30 seconds.

### v0.2 — understand everything

Session digests · project briefs · decisions and open-thread extraction · redaction.

**Success:** the user reads a digest instead of the transcript, and it's enough. At least
one `risks` item turns out to be a real thing they needed to fix.

### v0.3 — the agent reads it too

MCP server · Markdown export into repos.

**Success:** in a fresh session in project A, Claude answers "why did we choose X?"
correctly from Sightline without the user re-explaining.

### Explicitly out of scope

- **Being a Claude Code client.** No chat, no sending prompts. `claudecodeui` does that
  well; duplicating it would double the surface area and halve the focus.
- **Cloud sync / hosted service.** Local-first. Transcripts contain credentials, customer
  data, and unreleased work.
- **Multi-vendor support** (Codex, Cursor, Copilot) before the Claude Code experience is
  genuinely good. Breadth is a distraction until depth exists.
- **Editing transcripts.** Ever.

## Non-functional requirements

| | Target |
| --- | --- |
| First ingest, 174 MB / 12 projects | < 60 s |
| Incremental ingest after a session ends | < 1 s |
| Search latency, full corpus | < 100 ms |
| Session page render, 3,000-message session | < 500 ms (virtualised) |
| Secrets reaching an LLM provider | zero — enforced by test |
| Writes to `~/.claude` | zero — enforced by test |
| Cost to summarise one typical session | < $0.02 |

## Risks

| Risk | Mitigation |
| --- | --- |
| Claude Code changes its JSONL format | Tolerant Zod parsing, `raw` bucket, version-tagged fixtures, `version` field gating |
| A summary is confidently wrong | Every claim cites its turn; digests are drill-downable; prompts forbid ungrounded claims |
| Secrets leak to a provider | Mandatory redaction chokepoint with its own test suite; `--dry-run` prints exactly what would be sent |
| Token cost surprises the user | Cheap model for map stages, hash-keyed cache, summarisation opt-in, cost shown before running |
| Scope creep into "another Claude client" | The out-of-scope list above is binding |
