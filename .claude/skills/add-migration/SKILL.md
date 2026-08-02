---
name: add-migration
description: Use when changing the SQLite schema in packages/db — adding a table or column, changing an index, or touching the FTS5 virtual tables and their sync triggers. Covers migration generation, FTS5 ordering constraints, and when a re-index is required instead.
---

# Changing the database schema

Sightline's database is a **derived index**, not a source of truth. Every row can be
rebuilt from the JSONL on disk. That is a superpower: when a migration would be gnarly,
bumping `SIGHTLINE_SCHEMA_VERSION` and re-ingesting is a legitimate, often better choice.

The exceptions — the only data that cannot be rebuilt — are:

- `summaries` (cost real tokens to generate)
- `notes` (the user typed them)
- `decisions` / `open_threads` where the user has edited or resolved them

**Any migration must preserve those three.** Everything else is disposable.

## Procedure

1. Edit the Drizzle schema in `packages/db/src/schema/`.
2. Generate the migration:
   ```bash
   pnpm --filter @sightline/db exec drizzle-kit generate
   ```
3. **Read the generated SQL.** Drizzle emits a table rebuild for many SQLite ALTERs;
   confirm it isn't silently dropping an index or a trigger you care about.
4. If the change affects a column that feeds an FTS5 table, update the triggers by hand
   in the same migration file — Drizzle does not manage FTS5.
5. Add a migration test in `packages/db/src/migrations.test.ts`: open a database at the
   previous migration, seed a row, migrate, assert the row survived intact.
6. `pnpm --filter @sightline/db test`

## FTS5 rules

- Virtual tables are declared as `external content` over their base table, so the base
  table's `rowid` is load-bearing. Never rebuild a base table in a way that renumbers it
  without also running `INSERT INTO <fts>(<fts>) VALUES('rebuild')`.
- Sync triggers come in threes — `AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE`. Adding
  a searchable column means editing all three plus the table declaration. Missing one
  produces a search index that is subtly, silently stale.
- Order within a migration matters: drop triggers → alter base table → recreate FTS
  table → recreate triggers → `rebuild`.

## When to re-index instead of migrating

If the change alters what a column *means* rather than merely adding one — a different
normalisation for project grouping, a corrected token accounting, a new derivation for
`file_touches` — a migration that leaves old rows computed the old way is worse than no
migration, because the data is now inconsistent and nothing says so.

In that case:

1. Bump `SIGHTLINE_SCHEMA_VERSION` in `packages/core/src/constants.ts`.
2. Ship the migration as: preserve `summaries`, `notes`, edited `decisions` /
   `open_threads`; truncate the derived tables; mark all sessions un-ingested.
3. The next `sightline scan` rebuilds everything. On a 174 MB corpus that is seconds,
   not minutes.

Say in the PR body that the change triggers a re-index, so the owner isn't surprised by a
one-off slow scan after merging.
