# MCP server

Sightline's index has two readers: the web UI, for you, and an MCP server, for your
agents. Same tables, same summaries — so an agent starting fresh in project A can ask what
happened in project A three weeks ago instead of making you re-explain it.

## Setup

```bash
claude mcp add --scope user sightline -- npx -y sightline mcp
```

User scope on purpose: registered once, available from **every** project. The point is
cross-project recall — an agent in project A asking about project B is the interesting
case, not the exception.

The server talks to `~/.sightline/index.db` directly over stdio. No network, no daemon,
no port.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `sightline_list_projects` | `include_archived?` | Projects with last activity, session counts, open-thread counts |
| `sightline_project_brief` | `project` | The Tier 2 brief: architecture, workstreams, decisions, open threads |
| `sightline_search` | `query`, `project?`, `since?`, `limit?` | FTS hits across messages, summaries and decisions, with session/turn refs |
| `sightline_session_digest` | `session_id` | The Tier 1 digest: what changed, decisions, problems, risks, unfinished |
| `sightline_decisions` | `project`, `query?`, `status?` | Decision log — *"why did we choose X?"* |
| `sightline_open_threads` | `project`, `status?` | What was left unfinished, and where |
| `sightline_recent_activity` | `project`, `days?` | Sessions in a window with headlines and files touched |

`project` accepts a display name, a path, or a project id — resolved fuzzily, because an
agent knows "the BlueOne app", not a hash.

Every response carries provenance: session id, turn reference, and timestamp. An agent
that repeats a claim from Sightline can say where it came from, and you can click through
to the transcript that backs it.

## Design constraints

**Seven tools, and it stays that way.** Every MCP tool's description is injected into the
agent's context and competes for its attention; a sprawling surface makes the agent slower
to choose and likelier to choose wrong. If an eighth tool is proposed, something else
should probably merge into it.

**Responses are bounded.** Summaries, not transcripts. `sightline_search` returns snippets
with refs; fetching a full session is a deliberate second call. Retrieval that dumps 40k
tokens of history into an agent's context is worse than no retrieval — it displaces the
task.

**Read-only.** The MCP server never writes. Notes and decision edits happen in the UI,
where a human is making the judgement.

## Markdown export — the no-MCP path

```bash
sightline export --project my-app --out .sightline/
```

Writes `PROJECT_BRIEF.md`, `DECISIONS.md`, `OPEN_THREADS.md` into the repo itself. Commit
them and every agent reads them as ordinary files — no MCP registration, no server, and
teammates get the same context. Add `sightline export` to a hook or CI step to keep them
fresh.

The two paths are complementary: export is durable, versioned and shareable; MCP is
live, cross-project and queryable.
