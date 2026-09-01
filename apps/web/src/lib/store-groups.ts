import type { LaunchStore } from '@sightline/core'
import type { ProjectRow } from '@sightline/db'

/** A sidebar heading: one `~/.claude`, and the projects whose work lives in it. */
export interface StoreGroup {
  /** Stable identity for a React key and for tests. */
  key: string
  /** What the heading reads. */
  label: string
  /** The second line: which `claude` opens a terminal here. */
  detail: string
  projects: ProjectRow[]
}

/**
 * Which `~/.claude` a project belongs to, as a stable string.
 *
 * One group per distro rather than a single "Linux" bucket. Two distros are two separate
 * installations with separate histories and separate binaries — `wsl -d Ubuntu-24.04` and
 * `wsl -d Legacy-Debian` open different machines — so merging them would put projects
 * under a heading that cannot launch half of them.
 */
export function storeKey(store: LaunchStore | null): string {
  if (store === null) return 'unknown'
  return store.host === 'wsl' ? `wsl:${store.distro}` : store.host
}

/**
 * What to call a store on screen.
 *
 * One definition, because a project's own page and its sidebar heading disagreeing about
 * which store it belongs to would be worse than either name being wrong.
 */
export function storeLabel(store: LaunchStore | null): string {
  // A row with no store predates the store columns. Guessing which one it belongs to is
  // exactly the mistake ADR 0005 is about, so it is named as unknown rather than assigned.
  if (store === null) return 'Store unknown'
  if (store.host === 'wsl') return store.distro
  return store.host === 'windows' ? 'Windows' : 'Linux'
}

/** The shell a terminal for this store opens — the thing the label alone does not say. */
export function storeDetail(store: LaunchStore | null): string {
  if (store === null) return 'indexed before stores were recorded — rescan'
  if (store.host === 'wsl') return `wsl -d ${store.distro}`
  return store.host === 'windows' ? 'powershell' : 'bash'
}

/**
 * Rank a group for display. Local store first, then distros, then the unknowns.
 *
 * `windows` and `unix` never both appear — they are the same slot seen from two operating
 * systems — so giving them one rank each rather than sorting them against each other keeps
 * the local store at the top on either.
 */
function rank(key: string): number {
  if (key === 'windows' || key === 'unix') return 0
  if (key.startsWith('wsl:')) return 1
  return 2
}

/**
 * Group projects by the store they belong to.
 *
 * **Grouped on `store`, never on `hostKind`.** They answer different questions and agree
 * often enough to make the bug invisible: a Windows `claude` run with a `\\wsl.localhost\…`
 * working directory has `hostKind: 'wsl'` and lives in the *Windows* store — four of
 * seventeen projects on the reference machine. Grouping on the path would file those under
 * a Linux heading and open the wrong shell for every one of them. See ADR 0005.
 *
 * Input order is preserved inside each group, so the caller's `last_active DESC` survives.
 */
export function groupByStore(projects: readonly ProjectRow[]): StoreGroup[] {
  const groups = new Map<string, StoreGroup>()

  for (const project of projects) {
    const key = storeKey(project.store)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: storeLabel(project.store),
        detail: storeDetail(project.store),
        projects: [project],
      })
    } else existing.projects.push(project)
  }

  // Ties broken by label so two distros come out in a stable order rather than in whichever
  // order their most recent session happened to land.
  return [...groups.values()].sort(
    (a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label),
  )
}
