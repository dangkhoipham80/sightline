# ADR 0002 — Hand-written SQL instead of Drizzle

- **Status:** accepted
- **Date:** 2026-08-02
- **Supersedes:** the "Drizzle + drizzle-kit" choice recorded in `docs/ARCHITECTURE.md` and
  `docs/DATA-MODEL.md` before any database code existed

## Context

The original plan specified Drizzle ORM with `drizzle-kit generate` for migrations. That
was decided on paper. Writing the schema changed the calculus in three ways:

1. **Drizzle does not manage FTS5.** Virtual tables, their `external content` linkage, and
   the three sync triggers per table are hand-written SQL either way. Search is not a
   corner of this schema — it is a headline feature — so the part that most needs
   management is the part the tool cannot manage.
2. **The database is a derived index.** Every table can be rebuilt from
   `~/.claude/projects` in seconds (measured: 7.3 s for 52 sessions). The migration story
   Drizzle is strongest at — safely evolving irreplaceable production data — is the story
   we have the least of. When a migration would be awkward we bump
   `SIGHTLINE_SCHEMA_VERSION` and re-ingest.
3. **A codegen step is a standing cost.** `drizzle-kit generate` adds a tool whose output
   must be reviewed anyway (it rewrites tables for many SQLite `ALTER`s, sometimes
   dropping indexes and always dropping triggers), plus version drift between
   `drizzle-orm` and `drizzle-kit`.

## Decision

`better-sqlite3` with hand-written migration SQL in `packages/db/src/schema.ts`, applied
in order and recorded in a `migrations` table. Queries are prepared statements behind
typed functions in `queries.ts`; writes go through `writer.ts`.

## Consequences

**Gained**

- The schema is one readable file. The FTS5 declaration sits next to its triggers, which
  is exactly where a reader needs it.
- No codegen, no generated-file review, no tool-version drift.
- Bulk inserts use prepared statements inside a single transaction — the fastest thing
  `better-sqlite3` offers, with nothing between us and it.

**Lost**

- **Compile-time query checking.** A typo in a column name inside a SQL string is a
  runtime error, not a type error. Mitigated by tests that exercise every statement — the
  migration, writer and query tests in `packages/db` execute all of them — but the
  mitigation is discipline, not the compiler. This is the real cost of the decision and
  it should be weighed again if the schema grows past roughly fifteen tables.
- Row types are hand-written and must be kept in step with the schema by hand. The
  `toProjectRow` / `toSessionRow` mappers concentrate that risk in one place on purpose.

**Neutral**

- Native module. `better-sqlite3` needs a build step; pnpm 10 requires it to be listed in
  `pnpm.onlyBuiltDependencies`, and an existing install needs
  `pnpm rebuild better-sqlite3` after that list changes. Documented in
  `docs/CONTRIBUTING.md` because it is a genuinely confusing first-run failure.

## Revisit when

The schema stops being purely derived — the moment `summaries`, `notes` and user-edited
`decisions` land, some rows become irreplaceable and migrations stop being disposable.
That is the point to re-ask whether a query builder's type safety is worth its ceremony.
It is a contained change: the SQL strings are already isolated in two files.
