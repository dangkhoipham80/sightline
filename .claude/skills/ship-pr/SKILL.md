---
name: ship-pr
description: Use when a unit of work in the Sightline repo is finished and ready to go out. Covers branching from a fresh main, the verify gate, Conventional Commits, and opening the PR. Enforces the repo's absolute rules — never push to main, never merge.
---

# Shipping a change

The repository owner reviews and merges every PR themselves. Your job ends when the PR
is open and green.

## 1. Start from a fresh base

```bash
git checkout main
git pull
git checkout -b <type>/<short-kebab-description>
```

`<type>` is one of `feat`, `fix`, `refactor`, `docs`, `chore`, `test`.

If you're already partway through work on a stale branch, rebase onto the updated `main`
rather than merging `main` into your branch — the history stays readable.

## 2. Pass the gate before committing

```bash
pnpm verify   # lint + typecheck + test
```

CI runs exactly this. Do not open a PR you haven't run it on. If a test fails, fix the
code — never the fixture (see the `parse-transcript` skill for why).

## 3. Commit

Conventional Commits, imperative mood, scoped to the package when it helps:

```
feat(core): link resume-continuation sessions into one lineage

Claude Code starts a new session file on resume, and the first record carries the
*previous* session's id. Without linking, one continuous piece of work shows up in
the UI as five unrelated sessions.
```

Body explains *why*. The diff already shows *what*. End with:

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

Several small commits are better than one large one, but never split a commit such that
an intermediate state fails `pnpm verify`.

## 4. Open the PR

```bash
git push -u origin <branch>
gh pr create --base main --title "<type>: <summary>" --body "<body>"
```

The body follows `.github/pull_request_template.md`: what changed, why, how it was
verified, and anything the reviewer should look at hardest. Say plainly what you did
*not* test.

End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 5. Stop

Do **not**:

- push to `main` — directly or via any flag
- merge the PR, or enable auto-merge
- force-push a branch the owner is already reviewing
- open the next PR on top of an unmerged branch unless the dependency is genuine, and
  if it is, say so explicitly in the PR body

Report the PR URL and wait.

## After the owner merges

```bash
git checkout main
git pull
git branch -d <branch>
```

Then branch again for the next unit of work.
