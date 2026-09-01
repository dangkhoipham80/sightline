import { describe, expect, it } from 'vitest'
import {
  buildSpawnPlan,
  type LaunchStore,
  parseLaunchStore,
  resumeCommand,
  type SpawnPlanOptions,
} from './launch.js'
import { parseHostPath } from './paths.js'

const LAUNCH_DIR = 'C:\\Users\\khoi'
const WINDOWS: LaunchStore = { host: 'windows' }
const WSL: LaunchStore = { host: 'wsl', distro: 'Ubuntu-24.04' }
const UNIX: LaunchStore = { host: 'unix' }

/** The four real shapes on the reference machine. See ADR 0005. */
const WINDOWS_CWD = 'D:\\Management_Vibe_Coding'
const UNC_CWD = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dangkhoi04\\code\\DailyTaskGame'
const WSL_CWD = '/home/dangkhoi04/code/App_BlueOne_v2'

/**
 * Spelled out once, so the `-ErrorAction Stop` cannot be quietly dropped from four
 * assertions at a time. Without it a failed move still runs `claude`, in the wrong
 * directory — observed against a live shell, not theorised.
 */
const cd = (path: string) => `Set-Location -LiteralPath '${path}' -ErrorAction Stop`

function plan(overrides: Partial<SpawnPlanOptions> & Pick<SpawnPlanOptions, 'hostPath' | 'store'>) {
  const result = buildSpawnPlan({
    mode: { kind: 'claude' },
    platform: 'win32',
    launchDir: LAUNCH_DIR,
    ...overrides,
  })
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}`)
  return result.plan
}

describe('buildSpawnPlan — windows store', () => {
  it('spawns in place and goes through a shell, because claude is a .cmd shim', () => {
    const result = plan({ hostPath: parseHostPath(WINDOWS_CWD), store: WINDOWS })
    expect(result.file).toBe('powershell.exe')
    expect(result.cwd).toBe(WINDOWS_CWD)
    expect(result.args).toEqual(['-NoLogo', '-Command', "& 'claude'"])
    // A bare `claude` would be handed to CreateProcessW, which cannot execute a .cmd.
    expect(result.args.join(' ')).not.toContain('.cmd')
  })

  it('passes --resume through the call operator, fully quoted', () => {
    const result = plan({
      hostPath: parseHostPath(WINDOWS_CWD),
      store: WINDOWS,
      mode: { kind: 'claude', resumeSessionId: '074b1e09-0000-4000-8000-000000000000' },
    })
    expect(result.args[2]).toBe("& 'claude' '--resume' '074b1e09-0000-4000-8000-000000000000'")
  })

  it('carries extra flags such as a model override', () => {
    const result = plan({
      hostPath: parseHostPath(WINDOWS_CWD),
      store: WINDOWS,
      mode: { kind: 'claude', extraArgs: ['--model', 'opus'] },
    })
    expect(result.args[2]).toBe("& 'claude' '--model' 'opus'")
  })

  /**
   * The bug this whole PR exists for. A `\\wsl.localhost\…` cwd recorded by the *Windows*
   * binary must stay on Windows — its transcript lives in the Windows store, and the WSL
   * binary has never heard of the session.
   */
  it('keeps a UNC working directory on Windows and moves with Set-Location', () => {
    const result = plan({ hostPath: parseHostPath(UNC_CWD), store: WINDOWS })
    expect(result.file).toBe('powershell.exe')
    expect(result.args[2]).toBe(`${cd(UNC_CWD)}; & 'claude'`)
    // cmd.exe refuses a UNC cwd and silently lands in C:\Windows, so it never gets one.
    expect(result.cwd).toBe(LAUNCH_DIR)
  })

  it('keeps a plain shell open after moving, but not after claude exits', () => {
    const moved = plan({
      hostPath: parseHostPath(UNC_CWD),
      store: WINDOWS,
      mode: { kind: 'shell' },
    })
    expect(moved.args).toEqual(['-NoLogo', '-NoExit', '-Command', cd(UNC_CWD)])

    const inPlace = plan({
      hostPath: parseHostPath(WINDOWS_CWD),
      store: WINDOWS,
      mode: { kind: 'shell' },
    })
    expect(inPlace.args).toEqual(['-NoLogo'])
    expect(inPlace.cwd).toBe(WINDOWS_CWD)
  })

  it('survives apostrophes and spaces in a path by doubling the quote', () => {
    const result = plan({
      hostPath: parseHostPath("D:\\My Projects\\it's here"),
      store: WINDOWS,
    })
    expect(result.cwd).toBe("D:\\My Projects\\it's here")
    expect(result.args).toEqual(['-NoLogo', '-Command', "& 'claude'"])
  })
})

describe('buildSpawnPlan — wsl store', () => {
  it('re-enters the distro, leaving --cd unquoted because it is an argv element', () => {
    const result = plan({ hostPath: parseHostPath(WSL_CWD), store: WSL })
    expect(result.file).toBe('wsl.exe')
    expect(result.args).toEqual([
      '-d',
      'Ubuntu-24.04',
      '--cd',
      WSL_CWD,
      '--',
      'bash',
      '-lic',
      'claude',
    ])
    expect(result.cwd).toBe(LAUNCH_DIR)
  })

  it('quotes the shell payload but still not --cd, when the path has a space', () => {
    const result = plan({ hostPath: parseHostPath('/home/dev/my code'), store: WSL })
    expect(result.args[3]).toBe('/home/dev/my code')
    expect(result.args.at(-1)).toBe('claude')
  })

  it('accepts a UNC cwd, using the POSIX path the distro actually sees', () => {
    const result = plan({ hostPath: parseHostPath(UNC_CWD), store: WSL })
    expect(result.args[3]).toBe('/home/dangkhoi04/code/DailyTaskGame')
  })

  it('opens a login shell rather than an empty -lic payload', () => {
    const result = plan({ hostPath: parseHostPath(WSL_CWD), store: WSL, mode: { kind: 'shell' } })
    expect(result.args.slice(-2)).toEqual(['bash', '-li'])
  })
})

describe('buildSpawnPlan — unix store', () => {
  it('runs an interactive login shell in place', () => {
    const result = plan({
      hostPath: parseHostPath('/srv/app'),
      store: UNIX,
      platform: 'linux',
    })
    expect(result.file).toBe('bash')
    // -lic, not -lc: nvm is sourced from interactive rc files on most setups.
    expect(result.args).toEqual(['-lic', 'claude'])
    expect(result.cwd).toBe('/srv/app')
  })

  it('honours a custom binary and shell', () => {
    const result = plan({
      hostPath: parseHostPath('/srv/app'),
      store: UNIX,
      platform: 'darwin',
      posixShell: 'zsh',
      binary: 'claude-beta',
    })
    expect(result.file).toBe('zsh')
    expect(result.args).toEqual(['-lic', 'claude-beta'])
  })
})

describe('buildSpawnPlan — impossible combinations', () => {
  it.each([
    ['windows', WINDOWS, 'linux', 'windows-store-requires-windows-host'],
    ['wsl', WSL, 'linux', 'wsl-store-requires-windows-host'],
    ['unix', UNIX, 'win32', 'unix-store-requires-posix-host'],
  ] as const)('refuses a %s store on %s', (_label, store, platform, reason) => {
    const result = buildSpawnPlan({
      hostPath: parseHostPath('/srv/app'),
      store,
      mode: { kind: 'claude' },
      platform,
      launchDir: LAUNCH_DIR,
    })
    expect(result).toEqual({ ok: false, reason })
  })

  it('reports an empty path rather than spawning somewhere arbitrary', () => {
    const result = buildSpawnPlan({
      hostPath: parseHostPath(''),
      store: UNIX,
      mode: { kind: 'claude' },
      platform: 'linux',
      launchDir: LAUNCH_DIR,
    })
    expect(result).toEqual({ ok: false, reason: 'empty-path' })
  })
})

describe('buildSpawnPlan — invariants that hold for every plan', () => {
  const every: SpawnPlanOptions[] = [
    {
      hostPath: parseHostPath(WINDOWS_CWD),
      store: WINDOWS,
      mode: { kind: 'claude' },
      platform: 'win32',
      launchDir: LAUNCH_DIR,
    },
    {
      hostPath: parseHostPath(UNC_CWD),
      store: WINDOWS,
      mode: { kind: 'shell' },
      platform: 'win32',
      launchDir: LAUNCH_DIR,
    },
    {
      hostPath: parseHostPath(UNC_CWD),
      store: WINDOWS,
      mode: { kind: 'claude', resumeSessionId: 'x' },
      platform: 'win32',
      launchDir: LAUNCH_DIR,
    },
    {
      hostPath: parseHostPath(WSL_CWD),
      store: WSL,
      mode: { kind: 'claude' },
      platform: 'win32',
      launchDir: LAUNCH_DIR,
    },
    {
      hostPath: parseHostPath(WSL_CWD),
      store: WSL,
      mode: { kind: 'shell' },
      platform: 'win32',
      launchDir: LAUNCH_DIR,
    },
    {
      hostPath: parseHostPath('/srv/app'),
      store: UNIX,
      mode: { kind: 'claude' },
      platform: 'linux',
      launchDir: '/home/dev',
    },
    {
      hostPath: parseHostPath('/srv/app'),
      store: UNIX,
      mode: { kind: 'shell' },
      platform: 'linux',
      launchDir: '/home/dev',
    },
  ]

  it('never hands node-pty a UNC working directory', () => {
    for (const options of every) {
      expect(plan(options).cwd.startsWith('\\\\')).toBe(false)
    }
  })

  it('never emits an empty argv element', () => {
    for (const options of every) {
      expect(plan(options).args).not.toContain('')
    }
  })

  it('never lets a failed move fall through into running claude', () => {
    // `;` is a statement separator in PowerShell, not `&&`, and a failed Set-Location is
    // non-terminating by default. Observed against a live shell: a broken path printed a
    // red error and then ran `claude` anyway, from the directory the shell started in.
    for (const options of every) {
      const command = plan(options).args.at(-1) ?? ''
      if (!command.includes('Set-Location')) continue
      expect(command).toContain('-ErrorAction Stop')
    }
  })

  it('always sets a terminal-shaped TERM', () => {
    for (const options of every) {
      expect(plan(options).env['TERM']).toBe('xterm-256color')
    }
  })
})

describe('buildSpawnPlan — a session id is data, not syntax', () => {
  // Session ids come from our own index and are uuids, so this is defence in depth
  // rather than a live threat. It is cheap, and the day someone passes a branch name
  // through here it stops being theoretical.
  const hostile = "x'; whoami; '"

  it('contains a PowerShell injection inside a doubled-quote literal', () => {
    const result = plan({
      hostPath: parseHostPath(WINDOWS_CWD),
      store: WINDOWS,
      mode: { kind: 'claude', resumeSessionId: hostile },
    })
    expect(result.args[2]).toBe("& 'claude' '--resume' 'x''; whoami; '''")
  })

  it('contains a POSIX injection inside a single-quoted literal', () => {
    const result = plan({
      hostPath: parseHostPath(WSL_CWD),
      store: WSL,
      mode: { kind: 'claude', resumeSessionId: hostile },
    })
    expect(result.args.at(-1)).toBe(`claude --resume 'x'\\''; whoami; '\\'''`)
  })
})

describe('resumeCommand', () => {
  it('re-enters the distro for a session from the WSL store', () => {
    expect(
      resumeCommand({ hostPath: parseHostPath(WSL_CWD), store: WSL, sessionId: 'abc-123' }),
    ).toBe(`wsl -d Ubuntu-24.04 --cd ${WSL_CWD} -- claude --resume abc-123`)
  })

  /**
   * Previously this emitted `wsl -d … --resume` for any UNC path, which starts the WSL
   * binary against a store containing no such session: it runs, finds nothing, and
   * reports nothing. The store, not the path, decides.
   */
  it('stays on Windows for a UNC path recorded by the Windows binary', () => {
    expect(
      resumeCommand({ hostPath: parseHostPath(UNC_CWD), store: WINDOWS, sessionId: 'abc-123' }),
    ).toBe(`${cd(UNC_CWD)}; & 'claude' '--resume' 'abc-123'`)
  })

  /** `cd /d` is cmd-only syntax and fails in PowerShell, which is what Windows opens. */
  it('uses PowerShell syntax on Windows', () => {
    expect(
      resumeCommand({ hostPath: parseHostPath(WINDOWS_CWD), store: WINDOWS, sessionId: 'abc' }),
    ).toBe(`${cd(WINDOWS_CWD)}; & 'claude' '--resume' 'abc'`)
  })

  it('quotes POSIX paths containing spaces', () => {
    expect(
      resumeCommand({ hostPath: parseHostPath('/home/dev/my code'), store: UNIX, sessionId: 'x' }),
    ).toBe("cd '/home/dev/my code' && claude --resume x")
  })

  it('honours a custom binary name', () => {
    expect(
      resumeCommand({
        hostPath: parseHostPath('/srv/app'),
        store: UNIX,
        sessionId: 'x',
        binary: 'claude-beta',
      }),
    ).toBe('cd /srv/app && claude-beta --resume x')
  })

  it('agrees with buildSpawnPlan about where the session lives', () => {
    // The two answer different questions — a string to paste, and argv to spawn — but
    // they must never disagree about the destination.
    for (const [hostPath, store, needle] of [
      [parseHostPath(WINDOWS_CWD), WINDOWS, WINDOWS_CWD],
      [parseHostPath(UNC_CWD), WINDOWS, UNC_CWD],
      [parseHostPath(WSL_CWD), WSL, WSL_CWD],
    ] as const) {
      const command = resumeCommand({ hostPath, store, sessionId: 'x' })
      const spawned = plan({ hostPath, store, mode: { kind: 'claude', resumeSessionId: 'x' } })
      expect(command).toContain(needle)
      expect(spawned.display).toContain(needle)
    }
  })
})

/**
 * The index stores a `LaunchStore` as two loose columns, so this is the seam where a bad
 * or absent value gets a chance to become a plausible one. It must not take it: a store we
 * cannot name is a store we cannot launch against, and the caller withholds the command
 * rather than aiming it somewhere.
 */
describe('parseLaunchStore', () => {
  it('reads the three store shapes back', () => {
    expect(parseLaunchStore('windows', null)).toEqual(WINDOWS)
    expect(parseLaunchStore('unix', null)).toEqual(UNIX)
    expect(parseLaunchStore('wsl', 'Ubuntu-24.04')).toEqual(WSL)
  })

  it('ignores a distro on a store that has none', () => {
    expect(parseLaunchStore('windows', 'Ubuntu-24.04')).toEqual(WINDOWS)
  })

  /** `wsl -d '' -- claude --resume <id>` is not a command that fails usefully. */
  it.each([null, undefined, ''])('refuses a distro store with distro %p', (distro) => {
    expect(parseLaunchStore('wsl', distro)).toBeUndefined()
  })

  it.each([null, undefined, '', 'linux', 'WINDOWS'])('refuses the kind %p', (kind) => {
    expect(parseLaunchStore(kind, null)).toBeUndefined()
  })
})
