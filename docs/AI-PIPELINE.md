# AI pipeline

The part that makes Sightline more than a transcript renderer: turning a 3,000-line
session into something you'd actually read, and something an agent can query.

## Principles

- **Structured output, always.** Every stage declares a Zod schema. Markdown is *rendered
  from* the structure, never parsed back out of it.
- **Grounded or omitted.** Every claim cites the turn or file path backing it. A model
  that can't ground a claim must drop it. A confidently wrong project brief poisons every
  agent that later reads it through MCP — this is the highest-stakes correctness
  requirement in the codebase.
- **Cheap by default.** Tier 0 needs no LLM at all. Map stages use the small model.
  Nothing runs automatically unless the user opts in.
- **Redaction is a chokepoint.** One function, called once per provider, with its own
  tests. Not a convention.

---

## Tiers

### Tier 0 — no LLM

Session title (`ai-title`), files touched, tools used, git branch, duration, token counts
and cost, linked PRs and commits, subagent tree. Free, exact, always available. A large
fraction of "what happened here?" is answered before any model runs.

### Tier 1 — Session Digest

Map over turn-groups → reduce into one object per session.

```ts
{
  headline: string                    // one line, no hedging
  objective: string                   // what the user actually asked for
  what_changed: { summary, files[], turn_ref }[]
  decisions: { title, rationale, alternatives_rejected[], turn_ref }[]
  problems_hit: { symptom, root_cause, fix, turn_ref }[]
  risks: { claim, why_uncertain, how_to_verify, turn_ref }[]
  unfinished: { title, detail, turn_ref }[]
  next_steps: string[]
  glossary: { term, meaning }[]       // project-specific entities introduced
}
```

**`risks` is the product.** It answers *"what did the agent do that I should go check
myself?"* — an untested edge case, a config value it guessed, a migration it wrote but
never ran, an assumption it made without asking. Prompt it for specifics with a
verification step attached. An empty array is a valid answer; a vague one is not.

Chunking: turn-groups (a user prompt plus everything until the next one), packed to fit
the map model's context with overlap of one group. Thinking-block signatures, tool result
blobs over a threshold, and base64 attachments are stripped before packing.

### Tier 2 — Project Brief

Reduces session digests plus git metadata into the living document you read first:
current architecture understanding, active workstreams, chronological timeline, decision
log, open threads, glossary.

Regenerated incrementally: new digests are folded into the existing brief rather than
re-reducing from scratch, with a full re-reduce every N folds to prevent drift.

### Tier 3 — Weekly digest *(optional)*

Cross-project: "here's where each of your four projects got to this week." Cheap, since
it reduces over Tier 1 output rather than transcripts.

---

## Caching

Cache key: `(source_hash, prompt_version, model)`.

`source_hash` covers the **redacted** input, so redaction changes correctly invalidate.
It does *not* cover the prompt — which is why editing a prompt without bumping its
version leaves stale summaries in place forever. See `.claude/skills/write-prompt/`.

`stale = true` marks "regenerate when convenient" (cosmetic prompt change); deletion
marks "the old shape is incompatible" (semantic change).

## Redaction

Runs before prompt assembly, over every string that will be sent:

- Provider API key shapes (`sk-…`, `gh[pousr]_…`, `AKIA…`, JWTs, PEM blocks)
- `KEY=value` lines where the key name matches secret-ish patterns
- `Authorization:` headers, `.env` file contents read via tools
- Connection strings with embedded credentials

Replaced with `«redacted:<kind>»` — a stable token, so the model can still reason about
*"a secret was present here"* without seeing it, and so digests don't change when a
secret rotates.

Redaction is lossy and deliberately over-eager. Sending a secret to a provider is
unrecoverable; over-redacting a summary is a cosmetic bug.

`sightline summarize --dry-run` prints the exact post-redaction payload and its token
count. Read it before shipping any prompt change.

## Providers

```ts
interface SummaryProvider {
  name: string
  summarize<T>(input: { prompt: string; schema: ZodType<T>; model: ModelTier }): Promise<{
    value: T
    usage: { inputTokens: number; outputTokens: number }
  }>
}
```

| Provider | How | Trade-off |
| --- | --- | --- |
| `claude-cli` *(default)* | spawns `claude -p --output-format json` | Uses the existing subscription — no API key, no per-token bill. Serial, and depends on the CLI being installed. |
| `anthropic-api` | Anthropic SDK | Parallel, predictable, scriptable. Costs money, needs a key. |

`ModelTier` is `cheap` | `strong`, resolved per provider — map stages ask for `cheap`
(Haiku 4.5), reduce stages for `strong` (Sonnet 5). Changing that mapping changes cost per
project by roughly an order of magnitude; say so in any PR that touches it.

## Cost control

- Nothing summarises during `scan` unless `--summarize` is passed.
- The UI shows an estimated cost before running a batch.
- `sightline summarize --since 7d` / `--project X` / `--session <id>` for scoping.
- Digests for sessions under a configurable message threshold are skipped — a four-message
  session is already legible.
- Target: **< $0.02 per typical session**.

## Testing

Golden tests run against **recorded** provider responses and assert parsing, schema
conformance and assembly — never the model's wording, which is not deterministic. Prompt
quality is evaluated manually against a held-out set of real sessions; record the
comparison in the PR body when changing a prompt.
