import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HostPath, LaunchStore } from '@sightline/core'
import { parseHostPath, toWslUnc } from '@sightline/core'

export interface ProjectIdentity {
  id: string
  gitRoot?: string
  realCwd: string
  displayName: string
  repoUrl?: string
  hostPath: HostPath
  orphaned: boolean
}

/**
 * Resolve the project a working directory belongs to.
 *
 * Grouping on Claude Code's folder key would be wrong twice over: the encoding is lossy,
 * and one repository routinely produces several keys because sessions are started from
 * the repo root, a subpackage, and a mobile app directory. Walking up to the git root
 * reunites them into the single project a human would name.
 *
 * When the directory is gone — a deleted or renamed repo — we keep the last known path
 * and mark the project orphaned rather than dropping it. Its history is frequently the
 * exact thing someone wants to look up.
 *
 * `store` is which `~/.claude` the session came from. It is needed here, and not only at
 * launch time, because it is what tells two spellings of one directory apart from two
 * directories — see `hostPathForStore`.
 */
export function resolveProject(cwd: string, store: LaunchStore): ProjectIdentity {
  const hostPath = hostPathForStore(cwd, store)
  const accessible = isAccessible(hostPath)
  const gitRoot = accessible ? findGitRoot(hostPath) : undefined

  const identityPath = gitRoot ?? hostPath.nativePath
  const displayName = lastSegment(identityPath) ?? hostPath.basename
  // `gitRoot` is stored in the host's own form, so reading from it has to go back through
  // `hostAccessPath` — on Windows, `/home/me/app` is not openable as written.
  const repoUrl = gitRoot === undefined ? undefined : readRepoUrl(hostAccessPath(hostPath, gitRoot))

  return {
    // Hashing rather than using the path keeps ids stable-length and free of characters
    // that would need escaping in URLs. The path is still stored verbatim alongside.
    id: hashIdentity(hostPath, identityPath),
    ...(gitRoot !== undefined && { gitRoot }),
    realCwd: hostPath.raw,
    displayName,
    ...(repoUrl !== undefined && { repoUrl }),
    hostPath,
    orphaned: !accessible,
  }
}

/**
 * Read a recorded `cwd` in the light of the store that recorded it.
 *
 * **This is where one project's two halves are reunited.** The same directory is spelled
 * two ways depending on which `claude` was standing in it: the binary inside a distro
 * records `/home/me/code/app`, the Windows binary entering over the share records
 * `\\wsl.localhost\Ubuntu-24.04\home\me\code\app`. Grouped on the raw string those are two
 * projects, and the owner sees half a history twice with nothing saying so — the
 * `App_BlueOne_v2` case in ADR 0005.
 *
 * A bare POSIX `cwd` from a `wsl` store is therefore promoted to its UNC form: same
 * identity as the Windows-recorded half, and — since a `wsl` store is only ever *read*
 * from Windows — the spelling this process can actually open to find `.git`.
 *
 * The promotion is deliberately one-directional. A UNC `cwd` is left exactly as it is,
 * whatever store it came from: it is already unambiguous, and rewriting it towards a
 * distro would re-create the conflation this whole design exists to remove.
 */
export function hostPathForStore(cwd: string, store: LaunchStore): HostPath {
  const parsed = parseHostPath(cwd)
  if (store.host !== 'wsl' || store.distro === '' || parsed.kind !== 'unix') return parsed
  return parseHostPath(toWslUnc(store.distro, parsed.nativePath))
}

function hashIdentity(hostPath: HostPath, identityPath: string): string {
  const scope = hostPath.kind === 'wsl' ? `wsl:${hostPath.distro ?? ''}` : hostPath.kind
  const normalised = hostPath.kind === 'unix' ? identityPath : identityPath.toLowerCase()
  return createHash('sha256').update(`${scope}\u0000${normalised}`).digest('hex').slice(0, 16)
}

/**
 * Walk up from `cwd` looking for `.git`.
 *
 * `.git` is a *file* rather than a directory inside a worktree or submodule, so both are
 * accepted — worktrees are common in agent workflows and treating them as "not a repo"
 * would scatter one project across several rows.
 */
export function findGitRoot(hostPath: HostPath): string | undefined {
  const segments = [...hostPath.segments]

  while (segments.length > 0) {
    const nativeRoot = nativePath(hostPath, segments)
    try {
      if (existsSync(join(hostAccessPath(hostPath, nativeRoot), '.git'))) return nativeRoot
    } catch {
      // An inaccessible directory mid-walk (permissions, a stopped WSL distro) is not
      // an error worth propagating — it just means we can't prove a repo is there.
      return undefined
    }
    segments.pop()
  }
  return undefined
}

/**
 * Rebuild a path in the form the host that *ran* Claude would write it.
 *
 * This is the value that gets stored and displayed, so it has to be internally
 * consistent: a WSL root is POSIX all the way through, a Windows root is backslashed all
 * the way through. Mixing the two — which is what building on the UNC search prefix did —
 * produced `\\wsl.localhost\Ubuntu-24.04\home/me/code/app` in the index.
 */
function nativePath(hostPath: HostPath, segments: string[]): string {
  if (hostPath.kind === 'windows') {
    // The drive letter is a root marker that `segments` deliberately excludes.
    return `${hostPath.nativePath.slice(0, 2)}\\${segments.join('\\')}`
  }
  return `/${segments.join('/')}`
}

/**
 * Turn a stored path into one reachable *from the machine running Sightline*.
 *
 * A WSL path is recorded and stored as `/home/dev/app`, but this process is on Windows
 * and can only open it through its UNC form. Every filesystem call against a stored path
 * goes through here; nothing else is allowed to hand a POSIX WSL path to `fs`.
 */
export function hostAccessPath(hostPath: HostPath, path: string): string {
  if (hostPath.kind !== 'wsl') return path
  return toWslUnc(hostPath.distro ?? '', path)
}

function isAccessible(hostPath: HostPath): boolean {
  try {
    return statSync(hostPath.raw).isDirectory()
  } catch {
    return false
  }
}

/**
 * Best-effort remote URL, read straight from `.git/config` to avoid shelling out.
 *
 * The value stops at the end of its line. An earlier `.` with the `s` flag ran past the
 * newline and swallowed every following section of the file, so the stored "URL" was the
 * whole config tail — branch stanzas and all — and the UI rendered it verbatim.
 *
 * `url` is anchored to the start of its line so that `pushurl = …` cannot satisfy it.
 */
function readRepoUrl(gitConfigDir: string): string | undefined {
  try {
    const config = readFileSync(join(gitConfigDir, '.git', 'config'), 'utf8')
    const match = /\[remote "origin"\][^[]*?^\s*url\s*=\s*([^\r\n]+)/m.exec(config)
    return match?.[1]?.trim()
  } catch {
    return undefined
  }
}

function lastSegment(path: string): string | undefined {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0)
  return parts.at(-1)
}
