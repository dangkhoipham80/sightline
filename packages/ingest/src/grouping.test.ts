import type { LaunchStore } from '@sightline/core'
import { parseHostPath } from '@sightline/core'
import { describe, expect, it } from 'vitest'
import { hostAccessPath, hostPathForStore, resolveProject } from './grouping.js'

/**
 * WSL paths are the awkward case: Claude records them one way, this process has to open
 * them another way, and conflating the two put mixed separators into the index —
 * `\\wsl.localhost\Ubuntu-24.04\home/me/code/app`. These pin the two forms apart.
 */
describe('hostAccessPath', () => {
  it('reaches a POSIX WSL path through its UNC form', () => {
    const hostPath = parseHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\code\\app')

    expect(hostPath.kind).toBe('wsl')
    expect(hostPath.nativePath).toBe('/home/me/code/app')
    expect(hostAccessPath(hostPath, '/home/me/code/app')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\code\\app',
    )
  })

  it('round-trips a WSL path recorded from inside the distro', () => {
    // How the cwd looks when `claude` runs *in* WSL rather than from Windows: a bare
    // POSIX path, classified `unix`, with no distro to reach it through.
    const fromInside = parseHostPath('/home/me/code/app')
    expect(fromInside.kind).toBe('unix')
    expect(hostAccessPath(fromInside, '/home/me/code/app')).toBe('/home/me/code/app')
  })

  it('leaves Windows and Unix paths untouched', () => {
    const windows = parseHostPath('D:\\code\\app')
    const unix = parseHostPath('/srv/app')

    expect(hostAccessPath(windows, 'D:\\code\\app')).toBe('D:\\code\\app')
    expect(hostAccessPath(unix, '/srv/app')).toBe('/srv/app')
  })
})

const WINDOWS: LaunchStore = { host: 'windows' }
const UNIX: LaunchStore = { host: 'unix' }
const UBUNTU: LaunchStore = { host: 'wsl', distro: 'Ubuntu-24.04' }

/**
 * The same directory has two spellings depending on which `claude` was standing in it, and
 * which one a transcript records is a property of the *store*, not of the text. Getting
 * this wrong shows the owner half a project's history twice with nothing saying so — the
 * `App_BlueOne_v2` case in ADR 0005.
 *
 * These paths do not exist, so every project here resolves orphaned with no git root. That
 * is deliberate: it isolates the identity rule from filesystem behaviour, and it is also
 * the harder case, since a shared git root would paper over a bad `cwd` reading.
 */
describe('hostPathForStore', () => {
  it('reads a bare POSIX cwd from a WSL store as the distro path it is', () => {
    const promoted = hostPathForStore('/home/me/code/app', UBUNTU)

    expect(promoted.kind).toBe('wsl')
    expect(promoted.distro).toBe('Ubuntu-24.04')
    expect(promoted.nativePath).toBe('/home/me/code/app')
    // The raw form becomes the spelling this process can actually open — a Sightline
    // reading a distro's store is on Windows, where `/home/me/…` opens nothing.
    expect(promoted.raw).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\code\\app')
  })

  it('leaves a UNC cwd alone whatever store it came from', () => {
    const unc = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\code\\app'
    expect(hostPathForStore(unc, WINDOWS).raw).toBe(unc)
    expect(hostPathForStore(unc, UBUNTU).raw).toBe(unc)
  })

  it('leaves a POSIX cwd alone when the store is not a distro', () => {
    expect(hostPathForStore('/home/me/code/app', UNIX).kind).toBe('unix')
    expect(hostPathForStore('/home/me/code/app', WINDOWS).kind).toBe('unix')
  })
})

describe('resolveProject', () => {
  it('gives one project id to both spellings of one WSL directory', () => {
    const inside = resolveProject('/home/me/code/app', UBUNTU)
    const outside = resolveProject('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\code\\app', WINDOWS)

    expect(inside.id).toBe(outside.id)
    expect(inside.displayName).toBe('app')
    expect(outside.displayName).toBe('app')
  })

  /**
   * The negative half, and the one that keeps the test honest: unify on the *store*, not
   * on the path text. `/home/me/code/app` on a Linux box is a different machine's
   * directory from `/home/me/code/app` inside a distro, and merging them would fabricate a
   * project neither store has.
   */
  it('keeps the same POSIX path apart when the stores are different', () => {
    expect(resolveProject('/home/me/code/app', UNIX).id).not.toBe(
      resolveProject('/home/me/code/app', UBUNTU).id,
    )
  })

  it('keeps two distros apart', () => {
    expect(resolveProject('/home/me/code/app', UBUNTU).id).not.toBe(
      resolveProject('/home/me/code/app', { host: 'wsl', distro: 'Debian' }).id,
    )
  })
})
