---
name: write-prompt
description: Use when editing anything under packages/ai/src/prompts, changing a summary output schema, or changing which model a pipeline stage uses. Covers prompt versioning and cache invalidation — an unversioned prompt edit silently leaves stale summaries in place forever.
---

# Changing a prompt

Summaries are cached on `(source_hash, prompt_version, model)`. `source_hash` covers the
transcript; it does **not** cover the prompt. So an edited prompt with an unchanged
version means every already-summarised session keeps its old summary — forever, silently.
The bug looks like "my prompt improvement did nothing".

## Procedure

1. Edit the prompt in `packages/ai/src/prompts/<stage>/`.
2. Bump `version` in that stage's `meta.ts`.
3. Decide the invalidation scope and record it in the same commit:
   - **Cosmetic** (wording, formatting, examples) → bump, mark existing summaries
     `stale = true`. They keep rendering; they regenerate lazily on next request.
   - **Semantic** (new field, changed meaning of an existing field, different extraction
     criteria) → bump *and* delete the affected cached rows. Rendering a mix of two
     incompatible schemas is worse than regenerating.
4. If the output schema changed, update the Zod schema in `packages/ai/src/schemas/` and
   the migration for `summaries.structured_json` consumers.
5. Add or update a golden test in `packages/ai/src/prompts/<stage>/__tests__/`. Golden
   tests run against recorded provider responses — they assert the *parsing and
   assembly*, not the model's wording, which is not deterministic and must not be
   asserted on.

## Rules for the prompts themselves

- **Structured output, always.** Every stage declares a Zod schema and the provider is
  forced to conform. Free-text summaries are unqueryable, and the MCP server needs
  fields, not prose.
- **Redaction happens before the prompt is assembled**, in the pipeline — never rely on
  instructing the model to ignore secrets. There is a test asserting no call site
  bypasses the redactor.
- **The `risks` field is the product.** It is where "what did the agent do that I should
  go check myself" lives, and it is the reason Sightline exists rather than being another
  transcript renderer. Prompt it for specifics — file paths, commands, assumptions the
  agent made without confirming — not for reassurance. An empty `risks` array is a valid
  and useful answer; a vague one is not.
- **Never invent.** Instruct the model to cite the turn index or file path backing each
  claim, and to omit anything it cannot ground in the transcript. A confidently wrong
  project brief poisons every future agent that reads it through MCP.
- **Map stages get the cheap model, reduce stages get the strong one.** Per-chunk
  extraction is Haiku work. Cross-session synthesis, where the reasoning is actually
  hard, is Sonnet work. Changing this changes cost per project by an order of magnitude —
  say so in the PR body.

## Verifying

```bash
pnpm --filter @sightline/ai test
pnpm sightline summarize --session <id> --dry-run   # prints the assembled prompt
```

`--dry-run` prints exactly what would be sent, post-redaction. Read it before shipping —
especially the token count, and especially that no secret survived.
