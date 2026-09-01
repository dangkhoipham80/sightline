# Live session registry

> Reverse-engineered from live data (Claude Code `2.1.198`, September 2026). Undocumented
> upstream. Same evidence tags as `docs/TRANSCRIPT-FORMAT.md`: ✅ **verified** means
> observed directly on our corpus, ⚠️ **unverified** means inferred or reported but not
> observed.

`~/.claude/projects/**` tells you what Claude Code *did*. `~/.claude/sessions/` tells you
what it is *doing right now* — including whether it is sitting on a permission prompt
waiting for a human who has no idea.

That distinction is the whole reason Sightline's sidebar can show a status dot for a
`claude` process it did not start.

---

## Layout

```
~/.claude/
├── sessions/
│   └── <pid>.json          ← one file per running Claude Code process
├── session-env/
│   └── <session-uuid>/     ← per-session scratch, 202 entries on our machine
├── daemon/
│   ├── roster.json         ← background-dispatch supervisor state
│   ├── pty-pids/<id>.pid
│   ├── dispatch/
│   ├── control.key
│   └── pipe.key
├── daemon.status.json
└── daemon.lock
```

## `sessions/<pid>.json`

✅ **verified** — observed across four concurrent processes, then watched three of them
exit.

```json
{
  "pid": 8144,
  "sessionId": "a269b916-24a6-4ec9-8c0b-0d2d36351d9c",
  "cwd": "D:\\Management_Vibe_Coding",
  "startedAt": 1788222870519,
  "procStart": "639238448690651960",
  "version": "2.1.198",
  "peerProtocol": 1,
  "kind": "interactive",
  "entrypoint": "cli",
  "name": "management-vibe-coding-09",
  "nameSource": "derived",
  "status": "busy",
  "updatedAt": 1788222878274,
  "statusUpdatedAt": 1788222878274
}
```

| Field | Notes |
| --- | --- |
| `pid` | The filename, and the OS process id. **Not stable across a resume** — see trap 1. |
| `sessionId` | Joins straight to `sessions.id` in our index, and to `<session-uuid>.jsonl` on disk. |
| `cwd` | Absolute, exact, in the host's own form — including `\\wsl.localhost\…` UNC paths. Resolve to a project with `matchHostPath`, never by string equality. |
| `startedAt`, `updatedAt`, `statusUpdatedAt` | Epoch ms. |
| `procStart` | A Windows FILETIME-shaped string. Useful only to notice the file was rewritten by a *different* process; there is no cheap way to compare it against a live process from Node. |
| `status` | `busy` · `waiting` · `idle` — all three ✅ verified. |
| `waitingFor` | Present only when `status` is `waiting`. Observed value: `"permission prompt"`. |
| `name`, `nameSource` | A human-readable label (`jobpilot-ec`), `nameSource: "derived"` when Claude Code generated it. |
| `kind`, `entrypoint` | `interactive` / `cli` observed. Assume both are open-ended. |
| `peerProtocol`, `version` | Gate parsing on these the way we gate on `version` elsewhere. |

### Status values

✅ **verified**, all three:

- **`busy`** — working. Nothing needed from you.
- **`waiting`** — blocked on the human, with `waitingFor` saying why. This is the state
  the whole feature exists to surface: on a four-project machine it is invisible until you
  go looking.
- **`idle`** — alive at a prompt.

---

## Traps

### 1. `pid` is the filename but `sessionId` is the identity

✅ **verified**

We watched `sessionId: ab67d700-…` (`D:\JobPilot`) appear first as `15792.json` and later
as `32680.json`, same session, new process. A registry keyed on `pid` will show one
session as two, or resurrect a dead one when the OS reuses a pid.

**Key on `sessionId`.** Treat `pid` as a liveness handle, nothing more.

### 2. Files vanish on exit, so absence is not "idle"

✅ **verified** — four files became one as three processes were closed.

Claude Code removes `<pid>.json` on a clean exit. So the registry is a set of *live*
sessions, and a missing file means "not running", never "running quietly". A crash
presumably leaves the file behind (⚠️ **unverified** — we did not crash one deliberately),
which is why liveness must be checked rather than assumed:

```ts
try { process.kill(pid, 0) } catch (error) {
  // ESRCH → the process is gone. EPERM → alive, but not ours.
}
```

### 3. The file is rewritten in place, so reads race with writes

⚠️ **unverified, defended anyway**

`updatedAt` moves every few seconds, and chokidar will happily hand you a `change` event
mid-write. A `JSON.parse` failure here must mean **"no change, try again"** — never
"session gone". Getting this backwards makes dots flicker on every status transition,
which is worse than useless because it trains you to ignore them.

### 4. There is a second registry you cannot see from Windows

✅ **verified** — see [ADR 0005](adr/0005-two-claude-code-data-stores.md).

A `claude` running *inside* WSL writes to `/home/<user>/.claude/sessions/`, not to the
Windows one. Both must be watched. chokidar's native events do not work over the 9P share,
so the WSL root needs `usePolling`; the Windows root should not pay that cost.

---

## `daemon/` — related, and deliberately untouched

`~/.claude/daemon/` holds a background-dispatch supervisor: `roster.json` maps worker ids
to `{pid, procStart, sessionId, rendezvousSock, ptySock, cliVersion}`, with named-pipe
endpoints like `\\.\pipe\cc-daemon-<hash>-pty-<short>` and a `dispatch/` record per worker
carrying `launch.mode`, `flagArgs`, `env` and `respawnFlags`. It was idle
(`daemon.status.json → workers: {}`) throughout our observation.

**Sightline does not attach to it.** It is undocumented, its control channel is keyed
(`control.key`, `pipe.key`), and driving it would mean writing into `~/.claude` — rule 2.
It is recorded here so the next person who finds it does not have to wonder, and because
one idea in it is worth copying: `daemon/pty-pids/<id>.pid` is exactly the orphan-reaping
mechanism `packages/terminal` needs for its own PTYs across restarts.

---

## Version history

| Claude Code version | Observed | Notes |
| --- | --- | --- |
| `2.1.198` | Sep 2026 | Baseline. `sessions/<pid>.json` with `status` ∈ {`busy`, `waiting`, `idle`}, `waitingFor: "permission prompt"`, deleted on clean exit, `sessionId` stable across a resume. |
