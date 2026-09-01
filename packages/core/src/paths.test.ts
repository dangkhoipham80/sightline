import { describe, expect, it } from 'vitest'
import {
  encodeProjectFolderKey,
  isSameOrDescendant,
  matchHostPath,
  parseHostPath,
} from './paths.js'

describe('parseHostPath', () => {
  it('decodes a WSL UNC path into distro plus POSIX path', () => {
    const result = parseHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\code\\App_v2')
    expect(result.kind).toBe('wsl')
    expect(result.distro).toBe('Ubuntu-24.04')
    expect(result.nativePath).toBe('/home/dev/code/App_v2')
    expect(result.basename).toBe('App_v2')
  })

  it('accepts the legacy \\\\wsl$ prefix', () => {
    const result = parseHostPath('\\\\wsl$\\Debian\\srv\\app')
    expect(result.kind).toBe('wsl')
    expect(result.distro).toBe('Debian')
    expect(result.nativePath).toBe('/srv/app')
  })

  it('recognises Windows drive paths', () => {
    const result = parseHostPath('D:\\Management_Vibe_Coding')
    expect(result.kind).toBe('windows')
    expect(result.nativePath).toBe('D:\\Management_Vibe_Coding')
    expect(result.basename).toBe('Management_Vibe_Coding')
  })

  it('recognises plain POSIX paths', () => {
    const result = parseHostPath('/home/dev/code/app')
    expect(result.kind).toBe('unix')
    expect(result.basename).toBe('app')
  })

  it('never throws on nonsense, degrading to unix', () => {
    expect(() => parseHostPath('')).not.toThrow()
    expect(() => parseHostPath('???')).not.toThrow()
    expect(parseHostPath('').kind).toBe('unix')
  })
})

describe('encodeProjectFolderKey', () => {
  // Expectations taken from real folder names observed under ~/.claude/projects.
  // If Claude Code ever changes this encoding, these are the tests that catch it.
  it.each([
    [
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dangkhoi04\\code\\App_BlueOne_v2',
      '--wsl-localhost-Ubuntu-24-04-home-dangkhoi04-code-App-BlueOne-v2',
    ],
    ['D:\\Management_Vibe_Coding', 'D--Management-Vibe-Coding'],
    ['C:\\Users\\khoi', 'C--Users-khoi'],
    ['C:\\Windows\\System32', 'C--Windows-System32'],
  ])('encodes %s', (cwd, expected) => {
    expect(encodeProjectFolderKey(cwd)).toBe(expected)
  })

  it('is lossy — distinct paths collide, which is why it must never be inverted', () => {
    const underscored = encodeProjectFolderKey('D:\\code\\App_Blue_v2')
    const dotted = encodeProjectFolderKey('D:\\code\\App.Blue.v2')
    const dashed = encodeProjectFolderKey('D:\\code\\App-Blue-v2')
    expect(underscored).toBe(dotted)
    expect(dotted).toBe(dashed)
  })
})

describe('isSameOrDescendant', () => {
  const repoRoot = parseHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\code\\App')
  const subdir = parseHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\code\\App\\mobile')

  it('folds a subdirectory into its repository', () => {
    expect(isSameOrDescendant(repoRoot, subdir)).toBe(true)
    expect(isSameOrDescendant(repoRoot, repoRoot)).toBe(true)
  })

  it('does not match a sibling whose name merely shares a prefix', () => {
    const sibling = parseHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\code\\App2')
    expect(isSameOrDescendant(repoRoot, sibling)).toBe(false)
  })

  it('never matches across distros or host kinds', () => {
    const otherDistro = parseHostPath('\\\\wsl.localhost\\Debian\\home\\dev\\code\\App\\mobile')
    expect(isSameOrDescendant(repoRoot, otherDistro)).toBe(false)
    expect(isSameOrDescendant(repoRoot, parseHostPath('D:\\home\\dev\\code\\App'))).toBe(false)
  })

  it('treats Windows paths case-insensitively and POSIX paths case-sensitively', () => {
    const win = parseHostPath('D:\\Code\\App')
    const winLower = parseHostPath('d:\\code\\app\\src')
    expect(isSameOrDescendant(win, winLower)).toBe(true)

    const nix = parseHostPath('/home/dev/App')
    const nixLower = parseHostPath('/home/dev/app/src')
    expect(isSameOrDescendant(nix, nixLower)).toBe(false)
  })
})

describe('matchHostPath', () => {
  // Shaped after the real corpus: App_BlueOne_v2 is indexed as a project and so is
  // blueone-v1 beneath it.
  const projects = [
    { id: 'outer', path: '/home/dev/code/App_BlueOne_v2' },
    { id: 'inner', path: '/home/dev/code/App_BlueOne_v2/blueone-v1' },
    { id: 'windows', path: 'D:\\Management_Vibe_Coding' },
  ]

  it('prefers the nearest ancestor when projects nest', () => {
    expect(matchHostPath(projects, '/home/dev/code/App_BlueOne_v2/blueone-v1/src')).toBe('inner')
    expect(matchHostPath(projects, '/home/dev/code/App_BlueOne_v2/docs')).toBe('outer')
  })

  it('matches a project by its own path', () => {
    expect(matchHostPath(projects, 'D:\\Management_Vibe_Coding')).toBe('windows')
  })

  it('matches Windows paths case-insensitively', () => {
    expect(matchHostPath(projects, 'd:\\management_vibe_coding\\packages\\core')).toBe('windows')
  })

  it('returns undefined rather than guessing when nothing contains the cwd', () => {
    expect(matchHostPath(projects, 'C:\\Users\\dev')).toBeUndefined()
    expect(matchHostPath([], '/home/dev')).toBeUndefined()
  })

  it('never matches a POSIX cwd against a UNC project, or the reverse', () => {
    const unc = [{ id: 'unc', path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\app' }]
    // Same distro, same directory, different *shape* — these are the same place, but
    // `isSameOrDescendant` compares within a host kind, and the caller that has a bare
    // POSIX cwd is reading a WSL store where the UNC form never appears.
    expect(matchHostPath(unc, '/home/dev/app')).toBeUndefined()
  })

  it('does not match a sibling sharing a name prefix', () => {
    expect(matchHostPath(projects, '/home/dev/code/App_BlueOne_v2_old/src')).toBeUndefined()
  })
})

describe('segments', () => {
  /**
   * The drive letter is a root marker, not a component. Including it meant
   * `findGitRoot` rebuilt paths as `C:\C:\Users\…` and silently found no repository —
   * which in turn scattered one project across a row per subdirectory.
   */
  it('excludes the Windows drive letter', () => {
    expect(parseHostPath('D:\\code\\app').segments).toEqual(['code', 'app'])
  })

  it('excludes the WSL UNC prefix and distro', () => {
    expect(parseHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\app').segments).toEqual([
      'home',
      'dev',
      'app',
    ])
  })

  it('has no leading empty segment on POSIX paths', () => {
    expect(parseHostPath('/home/dev/app').segments).toEqual(['home', 'dev', 'app'])
  })
})
