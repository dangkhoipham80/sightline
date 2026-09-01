/**
 * How to start `claude` for a session — as a command a human can paste, and as the argv a
 * PTY can spawn.
 *
 * The load-bearing idea in this module is that **the store is not the path**. `HostPath`
 * describes the shape of a working directory; `LaunchStore` describes which `~/.claude`
 * the transcript was written to, and therefore which binary can resume it. They agree in
 * the common case, which is exactly why conflating them survived review once already:
 * a `\\wsl.localhost\…` working directory is *usually the Windows binary*, and resuming
 * it inside WSL runs successfully against a data directory that has never heard of the
 * session. See `docs/adr/0005-two-claude-code-data-stores.md` and trap 10 in
 * `docs/TRANSCRIPT-FORMAT.md`.
 *
 * Everything here is pure string work — no filesystem, no process. `launchDir` is passed
 * in rather than read, because `core` does not get to know what exists on disk.
 */

import type { HostPath } from './paths.js'
import { quotePosix, quotePowerShell } from './shell.js'

/**
 * Which `~/.claude` a session was written to, and so which `claude` can resume it.
 *
 * A discriminated union on purpose: adding a variant (a dev container, an SSH host,
 * Claude Code's own cloud sessions) should be a compile error at every site that has to
 * handle it, not a silent fall-through.
 */
export type LaunchStore = { host: 'windows' } | { host: 'wsl'; distro: string } | { host: 'unix' }

/**
 * Rebuild a `LaunchStore` from the two columns the index stores it in.
 *
 * Returns `undefined` rather than falling back to a plausible default. A store we cannot
 * name is a store we cannot launch against, and inventing one is exactly the class of
 * silent wrong-place launch this module exists to prevent — a `wsl` row with no distro
 * would produce `wsl -d '' -- claude --resume <id>`, which does not fail usefully.
 */
export function parseLaunchStore(
  kind: string | null | undefined,
  distro: string | null | undefined,
): LaunchStore | undefined {
  switch (kind) {
    case 'windows':
      return { host: 'windows' }
    case 'unix':
      return { host: 'unix' }
    case 'wsl':
      return distro === null || distro === undefined || distro === ''
        ? undefined
        : { host: 'wsl', distro }
    default:
      return undefined
  }
}

/** What to run once we are in the right place. */
export type LaunchMode =
  | { kind: 'claude'; resumeSessionId?: string; extraArgs?: readonly string[] }
  | { kind: 'shell' }

/** The platforms node-pty can be running on. Narrower than `NodeJS.Platform` by design. */
export type LaunchPlatform = 'win32' | 'darwin' | 'linux'

export interface SpawnPlan {
  file: string
  args: string[]
  /**
   * The child's working directory, as handed to node-pty.
   *
   * **Never a UNC path.** `cmd.exe` refuses a UNC current directory and silently falls
   * back to `C:\Windows` — the command then runs, in the wrong place, with no error. When
   * the real directory cannot safely be the spawn cwd we spawn in `launchDir` and move
   * inside the shell instead, where a bad path fails loudly.
   */
  cwd: string
  /** Terminal-shaped environment. Merging with `process.env` is the caller's job. */
  env: Record<string, string>
  /** Human-readable, for a console header or a log line. Never executed. */
  display: string
}

export type SpawnPlanFailure =
  | 'empty-path'
  | 'windows-store-requires-windows-host'
  | 'wsl-store-requires-windows-host'
  | 'unix-store-requires-posix-host'

export type SpawnPlanResult =
  | { ok: true; plan: SpawnPlan }
  | { ok: false; reason: SpawnPlanFailure }

export interface SpawnPlanOptions {
  hostPath: HostPath
  store: LaunchStore
  mode: LaunchMode
  /** The platform the spawning process is running on. */
  platform: LaunchPlatform
  /**
   * A directory on the spawning host that is guaranteed to exist and is not a UNC path,
   * used whenever the real working directory cannot be the spawn cwd. Callers pass
   * `os.homedir()`.
   */
  launchDir: string
  /** Windows shell able to resolve the `claude.cmd` shim. Default `powershell.exe`. */
  windowsShell?: string
  /** POSIX shell. Default `bash`. */
  posixShell?: string
  /** Default `claude`. Override when the binary is installed under another name. */
  binary?: string
}

/**
 * A terminal-shaped environment.
 *
 * `TERM` is what makes `claude`'s TUI render at all; the colour hints stop it degrading to
 * monochrome because it cannot see a terminal it recognises.
 */
const TERMINAL_ENV: Record<string, string> = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '1',
}

/**
 * Build the argv for a terminal in a project.
 *
 * Returns a result rather than throwing, matching the rest of the package: bad input is
 * data, and an exception during a spawn is a dead terminal with no explanation.
 */
export function buildSpawnPlan(options: SpawnPlanOptions): SpawnPlanResult {
  const { hostPath, store, mode, platform, launchDir } = options
  const binary = options.binary ?? 'claude'
  const windowsShell = options.windowsShell ?? 'powershell.exe'
  const posixShell = options.posixShell ?? 'bash'

  switch (store.host) {
    case 'windows': {
      if (platform !== 'win32') return { ok: false, reason: 'windows-store-requires-windows-host' }

      // A Windows-shaped path can be the spawn cwd directly. Anything else — a UNC path,
      // in practice — cannot, so we land in `launchDir` and move inside the shell.
      const spawnInPlace = hostPath.kind === 'windows'
      const target = spawnInPlace ? hostPath.nativePath : hostPath.raw
      if (target === '') return { ok: false, reason: 'empty-path' }

      // `claude` on Windows is a `.cmd` shim, and ConPTY ultimately calls CreateProcessW,
      // which cannot execute one. Every Windows launch goes through a shell.
      //
      // No `-NoProfile`: nvm / fnm / volta put their shims on PATH from the profile, and a
      // deterministic shell that cannot find `claude` is worse than a slow one that can.
      const steps: string[] = []
      if (!spawnInPlace) steps.push(setLocation(target))
      if (mode.kind === 'claude') steps.push(powerShellInvocation(binary, mode))

      const args = ['-NoLogo']
      if (steps.length > 0) {
        // A bare shell that ran a Set-Location must stay open afterwards; one that ran
        // `claude` must not, or closing the agent leaves an idle prompt behind.
        if (mode.kind === 'shell') args.push('-NoExit')
        args.push('-Command', steps.join('; '))
      }

      return {
        ok: true,
        plan: {
          file: windowsShell,
          args,
          cwd: spawnInPlace ? target : launchDir,
          env: { ...TERMINAL_ENV },
          display: `cd ${target} && ${displayCommand(binary, mode)}`,
        },
      }
    }

    case 'wsl': {
      // wsl.exe is a Windows binary. A sidecar running *inside* the distro is not this
      // case at all — from in there the store is plainly `unix`.
      if (platform !== 'win32') return { ok: false, reason: 'wsl-store-requires-windows-host' }
      if (hostPath.nativePath === '') return { ok: false, reason: 'empty-path' }

      // `--cd` is an argv element, so it is passed raw — quoting it would make the quotes
      // part of the path. Only the shell payload gets quoted. Two quoting domains in one
      // argv, which is the easiest thing in this file to get wrong.
      return {
        ok: true,
        plan: {
          file: 'wsl.exe',
          args: [
            '-d',
            store.distro,
            '--cd',
            hostPath.nativePath,
            '--',
            posixShell,
            ...posixShellArgs(binary, mode),
          ],
          cwd: launchDir,
          env: { ...TERMINAL_ENV },
          display: `wsl -d ${store.distro} --cd ${hostPath.nativePath} -- ${displayCommand(binary, mode)}`,
        },
      }
    }

    case 'unix': {
      if (platform === 'win32') return { ok: false, reason: 'unix-store-requires-posix-host' }
      if (hostPath.nativePath === '') return { ok: false, reason: 'empty-path' }

      return {
        ok: true,
        plan: {
          file: posixShell,
          args: posixShellArgs(binary, mode),
          cwd: hostPath.nativePath,
          env: { ...TERMINAL_ENV },
          display: `cd ${hostPath.nativePath} && ${displayCommand(binary, mode)}`,
        },
      }
    }
  }
}

export interface ResumeCommandOptions {
  hostPath: HostPath
  /** Which `~/.claude` holds this session. Not derivable from `hostPath` — see ADR 0005. */
  store: LaunchStore
  sessionId: string
  /** Defaults to `claude`. */
  binary?: string
}

/**
 * The command that reopens a session where it ran, for a human to paste.
 *
 * `claude --resume` scopes to the directory you are standing in, so getting back into a
 * session found here means getting to the right place first — and *which* place differs
 * per store, not per path. The Windows form is PowerShell, because that is what a Windows
 * Terminal tab opens with and because the previous `cd /d` form was cmd-only syntax that
 * fails there.
 */
export function resumeCommand(options: ResumeCommandOptions): string {
  const binary = options.binary ?? 'claude'
  const mode: LaunchMode = { kind: 'claude', resumeSessionId: options.sessionId }
  const { hostPath, store } = options

  switch (store.host) {
    case 'windows': {
      const target = hostPath.kind === 'windows' ? hostPath.nativePath : hostPath.raw
      return `${setLocation(target)}; ${powerShellInvocation(binary, mode)}`
    }
    case 'wsl':
      return `wsl -d ${store.distro} --cd ${quotePosix(hostPath.nativePath)} -- ${posixInvocation(binary, mode)}`
    case 'unix':
      return `cd ${quotePosix(hostPath.nativePath)} && ${posixInvocation(binary, mode)}`
  }
}

/**
 * Move to a directory, and **stop the whole command if that fails**.
 *
 * `-ErrorAction Stop` is the entire point of this helper. `;` in PowerShell is a statement
 * separator, not `&&`: a failed `Set-Location` is a non-terminating error by default, so
 * `Set-Location <bad>; claude --resume <id>` prints a loud red error and then cheerfully
 * runs `claude` in whatever directory the shell happened to start in. That is the same
 * failure this module exists to prevent — a command that runs in the wrong place — merely
 * noisier than the `cmd.exe` version of it.
 *
 * Observed, not reasoned about: a `--version` probe with a deliberately broken path
 * printed the error *and* the version, from `D:\Management_Vibe_Coding`.
 */
function setLocation(target: string): string {
  return `Set-Location -LiteralPath ${quotePowerShell(target)} -ErrorAction Stop`
}

/**
 * PowerShell's argument parsing has enough special cases that the only form worth relying
 * on is the call operator with fully-quoted literals.
 */
function powerShellInvocation(binary: string, mode: LaunchMode): string {
  if (mode.kind === 'shell') return ''
  const parts = [`& ${quotePowerShell(binary)}`]
  if (mode.resumeSessionId !== undefined) {
    parts.push(quotePowerShell('--resume'), quotePowerShell(mode.resumeSessionId))
  }
  for (const arg of mode.extraArgs ?? []) parts.push(quotePowerShell(arg))
  return parts.join(' ')
}

function posixInvocation(binary: string, mode: LaunchMode): string {
  if (mode.kind === 'shell') return ''
  const parts = [quotePosix(binary)]
  if (mode.resumeSessionId !== undefined) parts.push('--resume', quotePosix(mode.resumeSessionId))
  for (const arg of mode.extraArgs ?? []) parts.push(quotePosix(arg))
  return parts.join(' ')
}

/**
 * `-lic`, not `-lc`: nvm is sourced from interactive rc files on most setups, so a
 * non-interactive login shell frequently cannot find `claude`.
 */
function posixShellArgs(binary: string, mode: LaunchMode): string[] {
  if (mode.kind === 'shell') return ['-li']
  return ['-lic', posixInvocation(binary, mode)]
}

function displayCommand(binary: string, mode: LaunchMode): string {
  if (mode.kind === 'shell') return 'shell'
  const parts = [binary]
  if (mode.resumeSessionId !== undefined) parts.push('--resume', mode.resumeSessionId)
  for (const arg of mode.extraArgs ?? []) parts.push(arg)
  return parts.join(' ')
}
