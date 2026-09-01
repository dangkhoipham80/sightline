# Sightline — Product Requirements

## The problem

Claude Code keeps a complete record of its own work and then makes it unusable.

- `claude --resume` scopes to the directory you're standing in. Across five repos you get
  five disconnected lists of opaque session IDs and slugs.
- A single session is 400–3,000 JSONL lines. Nobody reads that, so nobody does.
- Transcripts older than 30 days are deleted by default.
- Subagent work — often the majority of what happened — lives in sibling files most
  tooling never opens.
- Running several projects at once means one OS terminal tab each, and a session blocked
  on a permission prompt looks exactly like one that is busy thinking. You find out you
  were the bottleneck twenty minutes later.

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

The category consolidated in April 2026 — Anthropic shipped a first-party multi-session UI
in Claude Desktop, Cursor 3 shipped its Agents Window, and Vibe Kanban shut down with 28k
stars. Sidebar plus git worktrees plus an embedded terminal is now table stakes given away
by the model vendors, so it is not a position. What none of them do is stated in
Anthropic's own documentation: **Claude Desktop cannot see CLI, VS Code, or cloud
sessions.** Every one of these tools shows you the sessions it started. Sightline reads the
record on disk, so it shows you all of them — and that is the thing worth defending.

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

### v0.4 — run everything

One window: a project sidebar grouped by host, a real terminal per project running the
`claude` binary, live status for every running session — including ones Sightline did not
start — and a usage meter for the 5-hour and weekly windows.

**Success:** the user stops keeping one OS terminal tab per project, and a session that has
been blocked on a permission prompt for twenty minutes is noticed in seconds rather than
whenever they next go looking.

### Why the client boundary moved

Earlier revisions of this document listed *"Being a Claude Code client"* as out of scope,
on the grounds that `claudecodeui` does it well and duplicating it would double the surface
area. That reasoning was about **chat** — reimplementing the conversation, sending prompts,
rendering a model's replies. It still holds, and that is still out of scope below.

Hosting a PTY is a different thing, and the difference is not a technicality:

- We never speak to the Anthropic API and never handle a key, so we can never be *wrong
  about what Claude said*. The real binary runs; we own the window it runs in.
- The rule that made the original boundary worth having — read-only toward `~/.claude` —
  is untouched. `claude` writes its own transcripts exactly as before, and Sightline reads
  them exactly as before.
- The record and the running process are the same subject seen at two moments.
  A tool that shows you what happened but cannot show you what is happening *right now*
  keeps sending you back to the terminal it was supposed to replace.

The cost is real and is accepted deliberately: a socket that spawns shells is the highest
risk surface in the product, and it gets its own ADR
([0004](adr/0004-terminal-authentication.md)) rather than a paragraph.

### Explicitly out of scope

- **Talking to the Anthropic API on the user's behalf.** No chat UI, no prompt sending, no
  API key handling. Sightline hosts a terminal; it does not become a party to the
  conversation.
- **Any write to `~/.claude` — including config.** The statusline hook that supplies
  official quota data is *printed* for the user to install. We never install it.
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
| Keystroke to terminal echo, local | < 30 ms |
| Switching projects in the sidebar | instant — the PTY is already running and its scrollback is replayed from the server |
| A running `claude` surviving a UI reload, tab close, or web-server restart | always |
| Terminals reachable from a page the user did not open | zero — loopback bind, exact-match `Origin`, scoped HMAC ticket |

## Risks

| Risk | Mitigation |
| --- | --- |
| Claude Code changes its JSONL format | Tolerant Zod parsing, `raw` bucket, version-tagged fixtures, `version` field gating |
| A summary is confidently wrong | Every claim cites its turn; digests are drill-downable; prompts forbid ungrounded claims |
| Secrets leak to a provider | Mandatory redaction chokepoint with its own test suite; `--dry-run` prints exactly what would be sent |
| Token cost surprises the user | Cheap model for map stages, hash-keyed cache, summarisation opt-in, cost shown before running |
| Scope creep into "another Claude client" | The out-of-scope list above is binding: no API calls, no chat, no writes to `~/.claude` |
| The terminal socket is used to run arbitrary code | Three independent controls, not one — see [ADR 0004](adr/0004-terminal-authentication.md). Tickets are only issued for projects already in the index |
| A leaked or orphaned `claude` process outlives the UI | PTYs are owned by one sidecar with a `pty-pids/` registry reaped at boot; `taskkill /T /F` fallback on Windows, where `IPty.kill(signal)` throws |
| The quota meter shows a confidently wrong number | Official percentages come from Claude Code's own statusline payload and are labelled with their capture age; locally-derived figures are labelled as estimates; a window we cannot see reads "—", never 0 |
