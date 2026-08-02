# Skills

Repository-local skills live in `.claude/skills/<name>/SKILL.md` and are picked up
automatically by Claude Code when working in this repo. They exist to freeze the
procedures that are easy to get subtly wrong — the ones where a plausible-looking
shortcut produces a mess that only shows up three PRs later.

| Skill | Invoke when | Why it exists |
| --- | --- | --- |
| [`ship-pr`](.claude/skills/ship-pr/SKILL.md) | Any change is ready to go out | Freezes the branch → commit → PR flow. Never push `main`, never merge. |
| [`parse-transcript`](.claude/skills/parse-transcript/SKILL.md) | Touching JSONL parsing, or Claude Code changed its format | The parser's invariants and the correct way to add a fixture instead of editing one. |
| [`add-migration`](.claude/skills/add-migration/SKILL.md) | Changing the SQLite schema | Migrations, FTS5 triggers and re-index semantics have an order that must be respected. |
| [`write-prompt`](.claude/skills/write-prompt/SKILL.md) | Changing anything under `packages/ai/prompts` | Prompt edits silently invalidate cached summaries unless the version is bumped. |

## Writing a new skill

Add `.claude/skills/<name>/SKILL.md` with YAML frontmatter:

```markdown
---
name: my-skill
description: One line describing exactly when to use this. Claude reads this to decide relevance, so lead with the trigger, not the mechanism.
---

Body: the procedure, in the order it must be performed.
```

Keep skills **procedural**. Facts about the codebase belong in `CLAUDE.md` or `docs/`;
a skill earns its place only when there's a sequence of steps whose order matters.

Then add a row to the table above — a skill nobody knows about is a skill nobody uses.
