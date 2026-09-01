# ADR 0005 — A machine has more than one `~/.claude`

- **Status:** accepted
- **Date:** 2026-09-01

## Context

Sightline reads `~/.claude/projects` — singular, resolved from `os.homedir()`. On a
Windows machine that also runs WSL, that assumption is wrong, and it is wrong in a way
that produces plausible output rather than an error.

Verified on the reference machine:

| Store | Path | Project folder keys | `claude` binary |
| --- | --- | ---: | --- |
| Windows | `C:\Users\khoi\.claude` | 17, **four of them `--wsl-localhost-Ubuntu-24-04-…`** | `claude.cmd` |
| WSL | `/home/dangkhoi04/.claude` | 3 | `/home/dangkhoi04/.local/bin/claude` |

Two consequences follow, and both were live bugs.

**1. `App_BlueOne_v2` exists in both stores.** The owner has been reviewing half of that
project's history without any indication that the other half exists.

**2. The four `--wsl-localhost-…` keys in the Windows store are not WSL sessions.** They
are the *Windows* `claude` invoked with a UNC working directory. Their transcripts live in
the Windows store; the WSL store has never heard of them — it contains no `DailyTaskGame`
at all.

`packages/core` conflated these. `parseHostPath()` returns `kind: 'wsl'` for a UNC path,
and `resumeCommand()` branched on that `kind` to emit:

```
wsl -d Ubuntu-24.04 --cd /home/dangkhoi04/code/DailyTaskGame -- claude --resume <id>
```

which starts the **WSL** binary against a store that does not contain `<id>`. The command
runs. It finds nothing. Nothing errors.

## Decision

**The store is a first-class property, separate from the path.**

- `HostPath.kind` continues to describe *the shape of a path*. It is not, and never was, a
  statement about which binary can resume a session.
- A new `LaunchStore` discriminator (`{host: 'windows'} | {host: 'wsl', distro} |
  {host: 'unix'}`) describes *which `~/.claude` a transcript came from*, and therefore
  which `claude` can resume it and where a terminal for it must be spawned.
- Ingest discovers and indexes every store it can find, recording `projects.store_kind` and
  `sessions.store_root`.
- Anything that builds a command or spawns a process branches on `LaunchStore`, never on
  `HostPath.kind`.

## Rationale

The two fields answer different questions and happen to agree in the common case, which is
precisely what made the bug survive. Three of the four combinations occur on one ordinary
machine:

| Store | `cwd` kind | Correct launch |
| --- | --- | --- |
| windows | windows | Windows `claude`, cwd `D:\…` |
| windows | wsl (UNC) | **Windows** `claude`, cwd = the UNC path |
| wsl | unix | `wsl.exe -d <distro> --cd <posix> -- …` |

Deriving the launch host from the path gets the middle row wrong — 4 of 17 folder keys
here — and gets it wrong silently, because a working directory that looks like WSL is
overwhelming evidence for the wrong conclusion.

Grouping the sidebar by store rather than by path kind also makes the UI honest: the
"Linux" group should list the projects where a terminal will open a Linux shell, which is
not the same set as the projects whose paths start with `\\wsl.localhost`.

## Consequences

- `resumeCommand()` needs a `store` argument. Both of its existing branches were wrong in
  at least one case: the WSL branch for the UNC-cwd rows above, and the Windows branch for
  emitting `cd /d`, which is cmd.exe syntax that fails in PowerShell.
- Ingest gains a discovery step. Enumerating WSL distros and their home directories is an
  I/O concern and belongs in `ingest`, not `core`.
- Reading a WSL store from Windows goes over the 9P share, where chokidar's native events
  do not fire. Watchers on those roots need `usePolling`; the Windows root must not pay
  that cost.
- The two stores are genuinely separate installations with separate `settings.json`,
  separate `cleanupPeriodDays`, and separate live-session registries. Nothing may be
  assumed to be shared between them.
- One project can now be assembled from sessions in two stores. Grouping still happens on
  the resolved git root, which is what reunites them — but the git root is resolved on
  different filesystems, so path comparison must stay store-aware.

## Revisit when

A third store shape appears — a dev container, a remote SSH host, or Claude Code's own
`kind: 'cloud'` sessions. `LaunchStore` is a discriminated union specifically so adding a
variant is a compile error at every site that must handle it, rather than a silent default.
