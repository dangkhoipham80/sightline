import { describe, expect, it } from 'vitest'
import { storeAt } from './discover.js'
import type { WslResult, WslRunner } from './wsl.js'
import { decodeWslText, discoverWslStores, distroHome, listDistros, wslStoreRoot } from './wsl.js'

/**
 * `wsl.exe` writes UTF-16LE with CRLF line endings. Every fixture here is built the same
 * way the real thing produces it — encoding the bytes, not the string — because a fixture
 * written as UTF-8 would let a decoder that never calls `toString('utf16le')` pass.
 */
function wslOut(text: string): Buffer {
  return Buffer.from(text, 'utf16le')
}

function ok(stdout: Buffer): WslResult {
  return { code: 0, stdout, stderr: Buffer.alloc(0) }
}

function fail(code: number, stdout: Buffer = Buffer.alloc(0)): WslResult {
  return { code, stdout, stderr: Buffer.alloc(0) }
}

/** A runner that records every argv it was handed, so we can assert what was *not* run. */
function recordingRunner(handler: (args: string[]) => WslResult): {
  run: WslRunner
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    run: (args) => {
      calls.push(args)
      return handler(args)
    },
  }
}

/**
 * The reference machine, as measured: two running distros, one of which has a store.
 * `wsl -l -q` output is verbatim, CRLF included.
 */
const REFERENCE = (args: string[]): WslResult => {
  if (args.includes('--running')) return ok(wslOut('Ubuntu-24.04\r\ndocker-desktop\r\n'))
  if (args[0] === '--list') return ok(wslOut('Ubuntu-24.04\r\ndocker-desktop\r\n'))
  if (args[1] === 'Ubuntu-24.04') return ok(Buffer.from('/home/dangkhoi04', 'utf8'))
  if (args[1] === 'docker-desktop') return ok(Buffer.from('/root', 'utf8'))
  return fail(-1)
}

const HAS_STORE = (path: string): boolean =>
  path === '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dangkhoi04\\.claude'

describe('decodeWslText', () => {
  it('decodes UTF-16LE and strips CR', () => {
    expect(decodeWslText(wslOut('Ubuntu-24.04\r\ndocker-desktop\r\n'))).toEqual([
      'Ubuntu-24.04',
      'docker-desktop',
    ])
  })

  it('is the whole point: the same bytes read as UTF-8 match nothing', () => {
    const buffer = wslOut('Ubuntu-24.04\r\n')
    // This is the silent failure the decoder exists to prevent — no throw, no match.
    expect(buffer.toString('utf8')).not.toContain('Ubuntu-24.04')
    expect(decodeWslText(buffer)).toEqual(['Ubuntu-24.04'])
  })

  it('strips a leading BOM, which trim() leaves behind', () => {
    expect(decodeWslText(wslOut('\u{FEFF}Ubuntu-24.04\r\n'))).toEqual(['Ubuntu-24.04'])
  })

  it('drops blank lines rather than yielding empty distro names', () => {
    expect(decodeWslText(wslOut('\r\nUbuntu-24.04\r\n\r\n'))).toEqual(['Ubuntu-24.04'])
  })
})

describe('listDistros', () => {
  it('reads installed and running as two name-only lists', () => {
    const { run } = recordingRunner(REFERENCE)
    expect(listDistros(run)).toEqual({
      installed: ['Ubuntu-24.04', 'docker-desktop'],
      running: ['Ubuntu-24.04', 'docker-desktop'],
    })
  })

  it('never parses the localised `-l -v` table', () => {
    const { run, calls } = recordingRunner(REFERENCE)
    listDistros(run)
    // `STATE` is translated on a non-English Windows; asking WSL to filter is locale-proof.
    expect(calls.every((args) => !args.includes('-v') && !args.includes('--verbose'))).toBe(true)
    expect(calls).toContainEqual(['--list', '--quiet', '--running'])
  })

  it('reports nothing when WSL is absent, rather than throwing', () => {
    expect(listDistros(() => fail(-1))).toEqual({ installed: [], running: [] })
  })

  it('treats a failing --running probe as "none running", keeping the installed list', () => {
    const run: WslRunner = (args) =>
      args.includes('--running') ? fail(1) : ok(wslOut('Ubuntu-24.04\r\n'))
    expect(listDistros(run)).toEqual({ installed: ['Ubuntu-24.04'], running: [] })
  })
})

describe('distroHome', () => {
  it('reads the distro’s own stdout as UTF-8', () => {
    expect(distroHome('Ubuntu-24.04', REFERENCE)).toBe('/home/dangkhoi04')
  })

  it('rejects wsl.exe’s UTF-16 error, which arrives on stdout and looks like text', () => {
    // Verbatim shape of a real failure: the message is on *stdout*, in UTF-16, exit -1.
    const error = wslOut('There is no distribution with the supplied name.\r\n')
    expect(distroHome('Nope', () => fail(-1, error))).toBeUndefined()
  })

  it('rejects UTF-16 text even if the exit code lies and says success', () => {
    // Belt and braces: the shape check alone must catch it. Read as UTF-8 this string is
    // non-empty and would otherwise be accepted as a home directory.
    const garbage = wslOut('/home/someone\r\n')
    expect(garbage.toString('utf8').length).toBeGreaterThan(0)
    expect(distroHome('X', () => ok(garbage))).toBeUndefined()
  })

  it('trusts the exit code over the output, however plausible the output looks', () => {
    // The two guards are not redundant. The control-char check happens to catch the
    // UTF-16 error above, but nothing makes a *failed* run print unreadable bytes: a
    // partially-executed command can leave clean UTF-8 on stdout. Non-zero means the
    // answer is unknown, and an unknown home silently becomes a store root that is wrong.
    const plausible = Buffer.from('/home/dangkhoi04', 'utf8')
    expect(distroHome('X', () => fail(1, plausible))).toBeUndefined()
  })

  it('rejects a relative path', () => {
    expect(distroHome('X', () => ok(Buffer.from('home/me', 'utf8')))).toBeUndefined()
  })

  it('accepts a home directory containing a space', () => {
    expect(distroHome('X', () => ok(Buffer.from('/home/my user', 'utf8')))).toBe('/home/my user')
  })
})

describe('wslStoreRoot', () => {
  it('builds a UNC path with no mixed separators', () => {
    const root = wslStoreRoot('Ubuntu-24.04', '/home/dangkhoi04')
    expect(root).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dangkhoi04\\.claude')
    expect(root.slice(2)).not.toContain('/')
  })

  /**
   * Composing below a UNC root must follow the *root's* separator, not the host's.
   * `path.join` follows the host, so on Linux this yielded `…\.claude/projects` — a string
   * that is still openable on Windows, so nothing errors; it only stops comparing equal to
   * the properly-spelled path, which is precisely what project grouping is built on.
   * Caught by the Ubuntu CI leg, invisible on Windows.
   */
  it('keeps a UNC store root backslashed all the way down, on any host', () => {
    const store = storeAt(wslStoreRoot('Ubuntu-24.04', '/home/dangkhoi04'), {
      host: 'wsl',
      distro: 'Ubuntu-24.04',
    })
    expect(store.projectsRoot).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dangkhoi04\\.claude\\projects',
    )
    expect(store.projectsRoot.slice(2)).not.toContain('/')
  })

  it('keeps a POSIX store root slashed, likewise', () => {
    expect(storeAt('/home/me/.claude', { host: 'unix' }).projectsRoot).toBe(
      '/home/me/.claude/projects',
    )
  })
})

describe('discoverWslStores', () => {
  it('finds the distro store and skips the one without a ~/.claude', () => {
    const result = discoverWslStores({
      platform: 'win32',
      run: REFERENCE,
      exists: HAS_STORE,
    })

    expect(result.found).toEqual([
      {
        distro: 'Ubuntu-24.04',
        root: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dangkhoi04\\.claude',
      },
    ])
    // Skipped on the evidence — no ~/.claude — and not because it is called docker-desktop.
    expect(result.skipped).toEqual([{ distro: 'docker-desktop', reason: 'no-store' }])
  })

  it('skips a stopped distro without ever executing anything against it', () => {
    const { run, calls } = recordingRunner((args) => {
      if (args.includes('--running')) return ok(wslOut('Ubuntu-24.04\r\n'))
      if (args[0] === '--list') return ok(wslOut('Ubuntu-24.04\r\nLegacy-Debian\r\n'))
      return ok(Buffer.from('/home/dangkhoi04', 'utf8'))
    })

    const result = discoverWslStores({ platform: 'win32', run, exists: () => true })

    expect(result.skipped).toEqual([{ distro: 'Legacy-Debian', reason: 'not-running' }])
    expect(result.found.map((location) => location.distro)).toEqual(['Ubuntu-24.04'])
    // The contract that matters: `wsl -d Legacy-Debian …` would BOOT it. Enumerating
    // stores must never start a virtual machine.
    expect(calls.some((args) => args.includes('Legacy-Debian'))).toBe(false)
  })

  it('does not probe the filesystem for a stopped distro either', () => {
    // Opening \\wsl.localhost\<distro>\… boots it just as surely as running a command.
    const probed: string[] = []
    discoverWslStores({
      platform: 'win32',
      run: (args) =>
        args.includes('--running')
          ? ok(wslOut(''))
          : args[0] === '--list'
            ? ok(wslOut('Legacy-Debian\r\n'))
            : ok(Buffer.from('/root', 'utf8')),
      exists: (path) => {
        probed.push(path)
        return true
      },
    })
    expect(probed).toEqual([])
  })

  it('skips a distro whose $HOME cannot be read', () => {
    const run: WslRunner = (args) => {
      if (args.includes('--running')) return ok(wslOut('Broken\r\n'))
      if (args[0] === '--list') return ok(wslOut('Broken\r\n'))
      return fail(-1, wslOut('Something went wrong.\r\n'))
    }
    expect(discoverWslStores({ platform: 'win32', run, exists: () => true })).toEqual({
      found: [],
      skipped: [{ distro: 'Broken', reason: 'no-home' }],
    })
  })

  it('does nothing at all off Windows, without spawning wsl.exe', () => {
    const { run, calls } = recordingRunner(REFERENCE)
    // Inside a distro Sightline reaches its own store as a plain `unix` one, and there is
    // no wsl.exe to enumerate siblings with.
    expect(discoverWslStores({ platform: 'linux', run })).toEqual({ found: [], skipped: [] })
    expect(calls).toEqual([])
  })
})
