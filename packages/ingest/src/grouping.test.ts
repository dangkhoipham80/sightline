import { parseHostPath } from '@sightline/core'
import { describe, expect, it } from 'vitest'
import { hostAccessPath } from './grouping.js'

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
