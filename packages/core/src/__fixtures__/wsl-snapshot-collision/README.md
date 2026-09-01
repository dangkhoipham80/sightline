# Fixture: wsl-snapshot-collision

Derived from a real Claude Code transcript via `scripts/anonymise-fixture.ts`.
Structure is byte-for-byte faithful; identities, credentials and prose are not.

- Claude Code version: `2.1.198`
- Lines: 5 (0 deliberately malformed)
- Prose: replaced with deterministic filler

| Record type | Count |
| --- | ---: |
| `user` | 2 |
| `mode` | 1 |
| `file-history-snapshot` | 1 |
| `system` | 1 |

## What this fixture is here to prove

Trap 3, in five lines of real transcript: the `file-history-snapshot` record's `messageId`
is *also* the `uuid` of a `user` record two lines below it. Not a constructed edge case —
this is simply what a short session looks like.

It also pins down how narrow the trap is. Snapshots carry no `uuid` of their own, so a
parser indexing on `uuid` is already immune; the collision only bites code that reaches for
`messageId ?? uuid`. `fixtures.test.ts` asserts both halves — that the collision is present,
and that the tree indexes the message rather than the snapshot.

The UNC `cwd` carries a third assertion: that the working directory is read off the record
rather than reconstructed from the lossy folder key (trap 2).
