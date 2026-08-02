## What

<!-- One paragraph. What does this change do? -->

## Why

<!-- The problem or need. Link the roadmap item or issue if there is one. -->

## How it was verified

<!--
Be specific and be honest. "pnpm verify passes" is the floor, not the answer.
What did you actually run or look at? What did you NOT test?
-->

- [ ] `pnpm verify` passes locally
- [ ] Parser change → fixture-backed test added, and `scripts/check-corpus.ts` run against
      local transcripts (paste the malformed-line count)
- [ ] Schema change → migration test added; says below whether a re-index is triggered
- [ ] Prompt change → `prompt_version` bumped; invalidation scope stated below
- [ ] UI change → exercised in the running app, not just typechecked

**Not tested:**

<!-- Say it plainly. An honest gap is useful; a confident untested claim is expensive. -->

## Reviewer, look hardest at

<!-- The bit you're least sure about. -->

---

- [ ] No writes anywhere under `~/.claude`
- [ ] No fixture was edited to make a test pass
- [ ] No LLM call bypasses the redactor
