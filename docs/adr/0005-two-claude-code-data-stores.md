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
- Ingest discovers and indexes every store it can find, recording the store on each
  **session**: `sessions.store_kind`, `store_distro`, `store_root`.
- A project's store is **derived** from its most recent session, not stored. An earlier
  draft of this ADR put `store_kind` on `projects`; implementing it showed why that is
  wrong. One project is routinely worked on from both stores — that is the
  `App_BlueOne_v2` case above — so a column on `projects` would hold whichever session was
  ingested last, which is not the same as the most recent one, and it would go stale
  silently every time a session was re-ingested.
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
- Reading a WSL store from Windows goes over the 9P share, where native watching is not
  merely unreliable — **it refuses to start.** Measured on the reference machine (chokidar
  5, Node 22, Windows 11): `fs.watch` on a `\\wsl.localhost\…` directory throws `EISDIR`
  immediately. The production watcher over the real WSL store emits 12 `EISDIR` errors,
  reports `ready`, and then observes nothing; with `usePolling` it emits none. A separate
  trial appending to a file from *inside* the distro caught 0 of 2 writes natively and 2 of
  2 while polling. Since `watch()` routes errors to `onError` and never throws, getting
  this wrong looks exactly like a project nobody is working in. Watchers on those roots
  need `usePolling`; the Windows root must not pay that cost. *(This bullet was recorded as
  an unverified expectation in the original ADR; PR 14b measured it and it was understated.)*
- The two stores are genuinely separate installations with separate `settings.json`,
  separate `cleanupPeriodDays`, and separate live-session registries. Nothing may be
  assumed to be shared between them.
- One project can now be assembled from sessions in two stores. Grouping still happens on
  the resolved git root, which is what reunites them — but the git root is resolved on
  different filesystems, so path comparison must stay store-aware.

## Enumerating the stores (added by PR 14b)

Discovery is `wsl.exe --list --quiet` for what exists, `--list --quiet --running` for what
is awake, then `$HOME` per running distro. Four things about that were measured, not
assumed, and all four are the kind that fail quietly.

**`wsl.exe` writes UTF-16LE with CRLF.** Read as UTF-8 the distro list comes back with a
NUL between every letter. It matches no distro name, and it throws nothing — the machine
simply appears to have no WSL at all. This one line is the difference between finding a
store and silently reporting none.

**One command, two encodings.** `wsl -d X -- sh -c 'printf %s "$HOME"'` returns the
*distro's* stdout as UTF-8. But when `wsl.exe` fails before the distro runs, it writes its
own error to that same stdout in UTF-16 — `There is no distribution with the supplied
name.` — with exit code `-1`. Decoded as UTF-8 that is a long, non-empty, NUL-interleaved
string, perfectly capable of being accepted as a home directory. Hence two independent
guards: the exit code, and a shape check on the result.

**`wsl -l -v` is not parseable across locales.** Its `NAME / STATE / VERSION` header *and*
its `Running` / `Stopped` values are translated on a non-English Windows, so matching
`'Running'` would report every distro as stopped in much of the world. `--running` makes
WSL do the filtering and returns bare names in any locale.

**Stopped distros are skipped.** This is a behavioural decision, not an optimisation:
`wsl -d X -- …` *boots* a stopped distro, and so does merely opening
`\\wsl.localhost\X\…`. A background scan is not allowed to start virtual machines and hold
RAM in `vmmem`. The cost is that a stopped distro's history stays invisible until it is
running, so discovery returns every skip with a reason (`not-running`, `no-home`,
`no-store`) instead of just a shorter list. Reversing this decision is a one-line change in
`discoverWslStores`, and it is the bullet to revisit first if the invisible-history cost
turns out to bite more than the boot does.

Absence is decided by evidence, never a name denylist: `docker-desktop` on the reference
machine has `$HOME=/root` and no `~/.claude`, and is skipped as `no-store` — the same
reason that would apply to any distro that has never run Claude Code.

Reading a store over 9P is cheaper than feared: `existsSync` on the UNC root is 5 ms,
`readdir` of the projects root 2 ms, and a full ingest of the WSL store's 5 sessions 603 ms.
Enumeration end to end is ~330 ms.

**Not verified:** no distro on the reference machine was stopped at the time of writing, so
the `not-running` branch is covered by injected fakes only — including an assertion that
nothing is ever executed or `stat`ed against a stopped distro, which is the property that
actually matters.

## Revisit when

A third store shape appears — a dev container, a remote SSH host, or Claude Code's own
`kind: 'cloud'` sessions. `LaunchStore` is a discriminated union specifically so adding a
variant is a compile error at every site that must handle it, rather than a silent default.
