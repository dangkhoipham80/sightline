# Pending workflows

`ci.yml` lives here rather than in `.github/workflows/` for one boring reason: GitHub
refuses pushes that create or modify workflow files when the OAuth token lacks the
`workflow` scope, and the token that opened this PR doesn't have it.

The workflow itself is finished and reviewable as-is. Activating it is a one-line move:

```bash
gh auth refresh -h github.com -s workflow    # once, interactively
git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml
```

Delete this directory in the same PR that does the move.
