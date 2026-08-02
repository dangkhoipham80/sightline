# ADR 0001 — SQLite + FTS5 over a vector store

- **Status:** accepted
- **Date:** 2026-08-02

## Context

Sightline indexes a corpus in the order of hundreds of megabytes of transcripts (174 MB
across 12 projects on the reference machine) and must answer two kinds of question:

1. *"Where did I do that thing?"* — recall, from a half-remembered fragment.
2. *"What is the state of project X, and why?"* — synthesis, served to both a human and an
   agent over MCP.

The obvious modern answer is embeddings plus a vector index. The obvious boring answer is
SQLite's built-in FTS5.

## Decision

**SQLite with FTS5.** No embeddings in v0.1–v0.3.

## Rationale

The thing being searched is not raw transcript — it is the **AI-written summary layer**.
Digests and briefs are already dense, already semantic, and written in the vocabulary the
user would search with, because they were generated from the user's own conversation.
Keyword search over good summaries recovers most of what vector search over raw
transcripts would, at a fraction of the complexity.

Against that, embeddings would cost: a model to download or an API to call on every
ingest, an index to keep in sync with incremental updates, a rebuild path when the
embedding model changes, and meaningfully more first-ingest latency. All of it before we
have evidence that recall is actually the bottleneck.

FTS5 also comes free with `better-sqlite3` — no extra process, no extra dependency, no
extra failure mode — and the whole index remains a single file the user can delete.

## Consequences

- Search is exact-ish: `porter unicode61` stemming, prefix matching, `bm25()` ranking.
  Conceptual queries phrased in words absent from the text will miss.
- FTS5 sync triggers must be maintained by hand — Drizzle does not manage virtual tables.
  This is a real, recurring cost, documented in `.claude/skills/add-migration/`.
- The escape hatch is cheap: embeddings can be added as an additional column plus a
  `vec0` table, with FTS5 remaining the first-pass retriever in a hybrid ranking. Nothing
  in the schema forecloses it.

## Revisit when

Users report searches that *should* have matched and didn't, and inspection shows the
misses are conceptual rather than typos or missing summaries. Until there is a concrete
list of failed queries, adding embeddings is speculation.
