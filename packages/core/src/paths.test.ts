import { describe, expect, it } from 'vitest'
import {
  encodeProjectFolderKey,
  isSameOrDescendant,
  parseHostPath,
  resumeCommand,
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

describe('resumeCommand', () => {
  it('re-enters the distro for WSL sessions rather than cd-ing to the UNC path', () => {
    const hostPath = parseHostPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\code\\app')
    expect(resumeCommand({ hostPath, sessionId: 'abc-123' })).toBe(
      'wsl -d Ubuntu-24.04 --cd /home/dev/code/app -- claude --resume abc-123',
    )
  })

  it('uses cd /d on Windows so a drive change actually happens', () => {
    const hostPath = parseHostPath('D:\\Management_Vibe_Coding')
    expect(resumeCommand({ hostPath, sessionId: 'abc-123' })).toBe(
      'cd /d "D:\\Management_Vibe_Coding" && claude --resume abc-123',
    )
  })

  it('quotes POSIX paths containing spaces', () => {
    const hostPath = parseHostPath('/home/dev/my code')
    expect(resumeCommand({ hostPath, sessionId: 'x' })).toBe(
      "cd '/home/dev/my code' && claude --resume x",
    )
  })

  it('honours a custom binary name', () => {
    const hostPath = parseHostPath('/srv/app')
    expect(resumeCommand({ hostPath, sessionId: 'x', binary: 'claude-beta' })).toContain(
      'claude-beta --resume x',
    )
  })
})
