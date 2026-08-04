/**
 * Working-directory handling.
 *
 * Claude Code records `cwd` in whatever form the host uses, and on a Windows machine
 * driving WSL that means UNC paths like `\\wsl.localhost\Ubuntu-24.04\home\me\code\app`
 * sitting alongside `D:\projects\app`. Sightline has to group, display and generate
 * resume commands for both, so path handling gets its own module with its own tests
 * rather than being sprinkled through the ingest layer.
 */

export type HostKind = 'wsl' | 'windows' | 'unix'

export interface HostPath {
  kind: HostKind
  /** Exactly as recorded in the transcript. */
  raw: string
  /** WSL distro name, e.g. `Ubuntu-24.04`. Only set for `wsl` paths. */
  distro?: string
  /**
   * The path as the *host that runs Claude* would use it: a POSIX path inside the
   * distro for WSL, the Windows path for Windows, the path itself for Unix.
   */
  nativePath: string
  /** Path segments, empty ones removed. */
  segments: string[]
  /** Last meaningful segment — the default project display name. */
  basename: string
}

const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

/**
 * Classify and normalise a recorded working directory.
 *
 * Never throws: an unrecognised shape is reported as `unix` with the raw string as its
 * native path, because a slightly wrong classification is recoverable and an exception
 * during ingest is not.
 */
export function parseHostPath(cwd: string): HostPath {
  const raw = cwd

  const wslMatch = WSL_UNC.exec(cwd)
  if (wslMatch !== null) {
    const distro = wslMatch[1] ?? ''
    const rest = (wslMatch[2] ?? '').replace(/\\/g, '/')
    const nativePath = `/${trimSlashes(rest)}`
    const segments = splitSegments(nativePath)
    return {
      kind: 'wsl',
      raw,
      distro,
      nativePath,
      segments,
      basename: segments.at(-1) ?? distro,
    }
  }

  if (WINDOWS_DRIVE.test(cwd)) {
    const nativePath = cwd.replace(/\//g, '\\').replace(/\\+$/, '')
    // The drive letter is a root marker, not a path component. Including it in
    // `segments` makes anything that rebuilds a path from them produce `C:\C:\Users\…`.
    const segments = splitSegments(nativePath.slice(2).replace(/\\/g, '/'))
    return {
      kind: 'windows',
      raw,
      nativePath,
      segments,
      basename: segments.at(-1) ?? nativePath,
    }
  }

  const nativePath = cwd.replace(/\\/g, '/')
  const segments = splitSegments(nativePath)
  return {
    kind: 'unix',
    raw,
    nativePath: nativePath === '' ? cwd : nativePath,
    segments,
    basename: segments.at(-1) ?? nativePath,
  }
}

/**
 * Reproduce Claude Code's project folder name for a working directory.
 *
 * **This encoding is lossy and must never be inverted.** Every non-alphanumeric character
 * collapses to `-`, so `App_BlueOne_v2`, `App.BlueOne.v2` and `App-BlueOne-v2` all
 * produce the same key. It exists here so that ingest can *locate* a project's directory
 * and so tests can pin the behaviour — not so that anything can recover a path from it.
 * Read `cwd` off the records for that.
 */
export function encodeProjectFolderKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Case-insensitive on Windows and WSL UNC paths, case-sensitive elsewhere. */
export function normalisePathForComparison(path: HostPath): string {
  const collapsed = path.nativePath.replace(/\\/g, '/').replace(/\/+$/, '')
  return path.kind === 'unix' ? collapsed : collapsed.toLowerCase()
}

/** True when `child` is `parent` or lives beneath it. Used to fold subdirectory sessions
 * of one repository into a single project. */
export function isSameOrDescendant(parent: HostPath, child: HostPath): boolean {
  if (parent.kind !== child.kind) return false
  if (parent.kind === 'wsl' && parent.distro !== child.distro) return false

  const a = normalisePathForComparison(parent)
  const b = normalisePathForComparison(child)
  return b === a || b.startsWith(`${a}/`)
}

export interface ResumeCommandOptions {
  hostPath: HostPath
  sessionId: string
  /** Defaults to `claude`. Override when the binary is installed under another name. */
  binary?: string
}

/**
 * Build the command that resumes a session in the right place.
 *
 * The whole point of the dashboard is being one keystroke from getting back to work, and
 * getting there differs per host: a WSL session can't be resumed by `cd`-ing to its UNC
 * path from Windows — it has to re-enter the distro.
 */
export function resumeCommand(options: ResumeCommandOptions): string {
  const binary = options.binary ?? 'claude'
  const resume = `${binary} --resume ${options.sessionId}`
  const { hostPath } = options

  switch (hostPath.kind) {
    case 'wsl':
      return `wsl -d ${hostPath.distro ?? ''} --cd ${quotePosix(hostPath.nativePath)} -- ${resume}`
    case 'windows':
      return `cd /d "${hostPath.nativePath}" && ${resume}`
    case 'unix':
      return `cd ${quotePosix(hostPath.nativePath)} && ${resume}`
  }
}

function quotePosix(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function splitSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '')
}
