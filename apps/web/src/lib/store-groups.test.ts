import type { LaunchStore } from '@sightline/core'
import type { ProjectRow } from '@sightline/db'
import { describe, expect, it } from 'vitest'
import { groupByStore, storeKey } from './store-groups'

/** Only the fields the grouping reads are meaningful; the rest keep the type honest. */
function project(displayName: string, store: LaunchStore | null, hostKind = 'windows'): ProjectRow {
  return {
    id: displayName,
    gitRoot: null,
    realCwd: `/${displayName}`,
    folderKeys: [],
    displayName,
    repoUrl: null,
    hostKind,
    distro: null,
    store,
    firstSeen: null,
    lastActive: null,
    orphaned: false,
    archived: false,
    sessionCount: 1,
    messageCount: 1,
  }
}

const WINDOWS: LaunchStore = { host: 'windows' }
const UBUNTU: LaunchStore = { host: 'wsl', distro: 'Ubuntu-24.04' }
const DEBIAN: LaunchStore = { host: 'wsl', distro: 'Legacy-Debian' }
const UNIX: LaunchStore = { host: 'unix' }

describe('groupByStore', () => {
  /**
   * The whole reason this function exists rather than a one-line `groupBy`. `DailyTaskGame`
   * is the Windows binary run with a UNC working directory: `hostKind` says `wsl`, the store
   * says `windows`, and only the store is right about which shell a terminal opens. Four of
   * seventeen projects on the reference machine are this shape.
   */
  it('groups a UNC-path project under its store, not under the shape of its path', () => {
    const groups = groupByStore([project('DailyTaskGame', WINDOWS, 'wsl')])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('windows')
    expect(groups[0]?.label).toBe('Windows')
  })

  it('keeps two distros apart rather than merging them into one Linux group', () => {
    const groups = groupByStore([project('a', UBUNTU), project('b', DEBIAN)])

    expect(groups.map((g) => g.label)).toEqual(['Legacy-Debian', 'Ubuntu-24.04'])
    expect(groups.map((g) => g.projects.length)).toEqual([1, 1])
  })

  /**
   * A row with no store cannot be assigned to one, and assigning it anyway would be a
   * guess dressed as data. It gets a heading that says what it is.
   */
  it('gives store-less projects their own group instead of folding them into one', () => {
    const groups = groupByStore([project('old', null), project('new', WINDOWS)])

    expect(groups.map((g) => g.key)).toEqual(['windows', 'unknown'])
    expect(groups[1]?.projects.map((p) => p.displayName)).toEqual(['old'])
    expect(groups[1]?.label).toBe('Store unknown')
  })

  it('puts the local store first and the unknowns last', () => {
    const groups = groupByStore([project('u', null), project('w', UBUNTU), project('l', WINDOWS)])

    expect(groups.map((g) => g.key)).toEqual(['windows', 'wsl:Ubuntu-24.04', 'unknown'])
  })

  it('ranks a unix local store the same as a windows one', () => {
    const groups = groupByStore([project('w', UBUNTU), project('l', UNIX)])

    expect(groups.map((g) => g.key)).toEqual(['unix', 'wsl:Ubuntu-24.04'])
    expect(groups[0]?.label).toBe('Linux')
  })

  /** The caller sorts by `last_active DESC`; grouping must not quietly reorder within a group. */
  it('preserves input order inside a group', () => {
    const groups = groupByStore([
      project('first', WINDOWS),
      project('second', WINDOWS),
      project('third', WINDOWS),
    ])

    expect(groups[0]?.projects.map((p) => p.displayName)).toEqual(['first', 'second', 'third'])
  })

  it('names the command that opens a terminal for each group', () => {
    const groups = groupByStore([project('w', UBUNTU), project('l', WINDOWS)])

    expect(groups.map((g) => g.detail)).toEqual(['powershell', 'wsl -d Ubuntu-24.04'])
  })

  it('produces no groups for no projects', () => {
    expect(groupByStore([])).toEqual([])
  })
})

describe('storeKey', () => {
  it('separates distros and collapses everything else by host', () => {
    expect(storeKey(WINDOWS)).toBe('windows')
    expect(storeKey(UNIX)).toBe('unix')
    expect(storeKey(UBUNTU)).toBe('wsl:Ubuntu-24.04')
    expect(storeKey(DEBIAN)).toBe('wsl:Legacy-Debian')
    expect(storeKey(null)).toBe('unknown')
  })
})
