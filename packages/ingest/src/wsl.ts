import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { toWslUnc } from '@sightline/core'

/** One completed `wsl.exe` invocation. Buffers, never strings — see `decodeWslText`. */
export interface WslResult {
  /** `-1` when `wsl.exe` could not be spawned at all. */
  code: number
  stdout: Buffer
  stderr: Buffer
}

/** Runs `wsl.exe` with the given argv. Injected so the parsing above it is testable. */
export type WslRunner = (args: string[]) => WslResult

/**
 * Why a distro contributed no store. Always reported, never swallowed: "we found nothing"
 * and "we declined to look" are different answers, and only one of them means the owner's
 * history is actually absent.
 */
export type SkipReason = 'not-running' | 'no-home' | 'no-store'

export interface SkippedDistro {
  distro: string
  reason: SkipReason
}

/** A distro whose `~/.claude` was found, and where to read it from. */
export interface WslStoreLocation {
  distro: string
  /** The store directory, reachable from Windows: `\\wsl.localhost\<distro>\…\.claude`. */
  root: string
}

export interface WslDiscovery {
  found: WslStoreLocation[]
  skipped: SkippedDistro[]
}

/**
 * Decode text that `wsl.exe` produced *itself* — distro lists, error messages.
 *
 * **`wsl.exe` speaks UTF-16LE.** Read as UTF-8 the list comes back with a NUL between
 * every letter, which matches no distro name and throws nothing: discovery silently finds
 * zero stores on a machine that has them. This is the single highest-value line in the file.
 *
 * Output written by a *command running inside a distro* is a different stream with a
 * different encoding — see `distroHome`.
 */
export function decodeWslText(buffer: Buffer): string[] {
  return (
    buffer
      .toString('utf16le')
      // Some builds prefix a BOM, and `trim()` does not remove U+FEFF. Written as an escape
      // because the literal character is invisible in an editor.
      .replace(/^\u{FEFF}/u, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  )
}

function realRunner(args: string[]): WslResult {
  try {
    const stdout = execFileSync('wsl.exe', args, { encoding: 'buffer', windowsHide: true })
    return { code: 0, stdout, stderr: Buffer.alloc(0) }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: Buffer; stderr?: Buffer }
    return {
      code: failure.status ?? -1,
      stdout: failure.stdout ?? Buffer.alloc(0),
      stderr: failure.stderr ?? Buffer.alloc(0),
    }
  }
}

/**
 * The distros installed on this machine, and which of them are already running.
 *
 * Deliberately `-l -q` twice rather than parsing `wsl -l -v`. The verbose table is a
 * human-facing, **localised** layout — its `NAME  STATE  VERSION` header and its
 * `Running` / `Stopped` values are translated on a non-English Windows, so matching on
 * either would report every distro as stopped in half the world. `--running` asks WSL to
 * do the filtering and returns bare names in any locale.
 *
 * Neither call starts a distro.
 */
export function listDistros(run: WslRunner = realRunner): {
  installed: string[]
  running: string[]
} {
  const all = run(['--list', '--quiet'])
  if (all.code !== 0) return { installed: [], running: [] }

  const active = run(['--list', '--quiet', '--running'])
  return {
    installed: decodeWslText(all.stdout),
    // A non-zero exit here means "none are running", not a failure worth propagating.
    running: active.code === 0 ? decodeWslText(active.stdout) : [],
  }
}

/**
 * `$HOME` inside a distro, which is where its `~/.claude` lives.
 *
 * Two encodings meet in this one call. The distro's own stdout is **UTF-8**; but if
 * `wsl.exe` fails before the distro ever runs, the message it substitutes on that same
 * stream is **UTF-16LE**. Read as UTF-8, that error is a long NUL-interleaved string —
 * non-empty, and perfectly capable of sailing on as a home directory. Hence two guards:
 * the exit code first, then a shape check on the result.
 *
 * `printf` rather than `echo`, whose trailing newline varies by shell.
 */
export function distroHome(distro: string, run: WslRunner = realRunner): string | undefined {
  const result = run(['-d', distro, '--', 'sh', '-c', 'printf %s "$HOME"'])
  if (result.code !== 0) return undefined

  const home = result.stdout.toString('utf8').trim()
  // Absolute POSIX path, and free of the interleaved NULs that betray UTF-16 text read as
  // UTF-8. Note what is deliberately *not* rejected: a space. A home directory containing
  // one is unusual on Linux but legal, and excluding it would drop a real store.
  return home.startsWith('/') && !hasControlChars(home) ? home : undefined
}

/**
 * True if a string carries any C0 control character.
 *
 * Spelled as a code-point comparison rather than a regex with escapes: the byte this is
 * really looking for is NUL, and a literal NUL in a source file makes git treat the whole
 * file as binary — no diff, no review.
 */
function hasControlChars(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32)
}

/** Where a distro's `~/.claude` is reachable from Windows. */
export function wslStoreRoot(distro: string, home: string): string {
  return toWslUnc(distro, `${home}/.claude`)
}

export interface WslDiscoveryOptions {
  run?: WslRunner
  /** Defaults to `process.platform`; a parameter so the win32 gate itself is testable. */
  platform?: NodeJS.Platform
  /** Probe for a store on disk. Injected so tests need no `\\wsl.localhost` share. */
  exists?: (path: string) => boolean
}

/**
 * Find a `~/.claude` inside every running WSL distro.
 *
 * **Stopped distros are skipped, and that is a behavioural choice, not an optimisation.**
 * Both `wsl -d <distro> -- …` and merely opening `\\wsl.localhost\<distro>\…` *boot* the
 * distro — seconds of latency and a `vmmem` process holding RAM for as long as it stays up.
 * A background scan is not allowed to start virtual machines. The cost is real: a stopped
 * distro's history stays invisible until it is running. So every skip is reported rather
 * than silently producing a shorter list, and the caller surfaces it.
 *
 * Absence is decided by data, never by a name denylist. `docker-desktop` on the reference
 * machine has `$HOME=/root` and no `~/.claude`; it is skipped for that reason alone, which
 * is the same reason that would apply to any distro that has never run Claude Code.
 *
 * Returns bare locations rather than `ClaudeStore`s so that this module stays a leaf:
 * everything here is about talking to `wsl.exe`, and assembling a store is `discover.ts`'s
 * job. Importing `storeAt` to do it here made the two files mutually dependent, which is
 * not merely untidy — see the note on the cycle in `discover.ts`.
 */
export function discoverWslStores(options: WslDiscoveryOptions = {}): WslDiscovery {
  const platform = options.platform ?? process.platform
  // A Sightline running *inside* a distro reaches its own store as a plain `unix` one, and
  // has no `wsl.exe` to enumerate siblings with.
  if (platform !== 'win32') return { found: [], skipped: [] }

  const run = options.run ?? realRunner
  const exists = options.exists ?? existsSync
  const { installed, running } = listDistros(run)
  const isRunning = new Set(running)

  const found: WslStoreLocation[] = []
  const skipped: SkippedDistro[] = []

  for (const distro of installed) {
    if (!isRunning.has(distro)) {
      skipped.push({ distro, reason: 'not-running' })
      continue
    }

    const home = distroHome(distro, run)
    if (home === undefined) {
      skipped.push({ distro, reason: 'no-home' })
      continue
    }

    const root = wslStoreRoot(distro, home)
    if (!exists(root)) {
      skipped.push({ distro, reason: 'no-store' })
      continue
    }

    found.push({ distro, root })
  }

  return { found, skipped }
}
