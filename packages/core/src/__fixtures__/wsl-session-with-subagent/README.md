# Fixture: wsl-session-with-subagent

Derived from a real Claude Code transcript via `scripts/anonymise-fixture.ts`.
Structure is byte-for-byte faithful; identities, credentials and prose are not.

- Claude Code version: `2.1.198`
- Lines: 12 (0 deliberately malformed)
- Prose: replaced with deterministic filler
- Subagent transcripts: 1

| Record type | Count |
| --- | ---: |
| `attachment` | 3 |
| `assistant` | 3 |
| `mode` | 1 |
| `permission-mode` | 1 |
| `file-history-snapshot` | 1 |
| `user` | 1 |
| `ai-title` | 1 |
| `last-prompt` | 1 |

## What this fixture is here to prove

Subagent work is not inline. This capture keeps the sibling
`subagents/agent-<agentId>.jsonl` and its `.meta.json`, so it asserts the join that a
parser reading only the top-level file gets wrong: `meta.toolUseId` → the `tool_use` block
in the parent transcript that spawned the agent, rendering the sidechain as a sub-thread
exactly where it happened.

It also holds the line on three smaller things — every main-transcript line is
`isSidechain: false` while the agent's are `true`; the session title comes from Claude's own
`ai-title` record rather than being invented; and the three `attachment` records carry a
`uuid` *and* a `parentUuid`, which is trap 1 sitting in plain sight.

> The `signature` values in this fixture were replaced after the fact — the base64 blob on
> a `thinking` block decodes to plain text containing the account's organization uuid, and
> the original anonymiser only ever looked at the encoded form. Nothing else in the file
> changed; both files are the same length they were. See `scrubSignature` in
> `scripts/anonymise-fixture.ts`.
