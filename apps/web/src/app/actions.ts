'use server'

import type { LaunchStore } from '@sightline/core'
import type { SkipReason } from '@sightline/ingest'
import { scanAll } from '@sightline/ingest'
import { revalidatePath } from 'next/cache'
import { getDatabase } from '@/lib/db'

/** A store that exists but contributed nothing, phrased for a human. */
export interface ScanGap {
  label: string
  detail: string
}

export interface ScanReport {
  ingested: number
  skipped: number
  failed: number
  projects: number
  durationMs: number
  /** How many `~/.claude` stores were actually read. */
  stores: number
  /** Stores that exist but were not indexed. Surfaced, never left as a silent shortfall. */
  gaps: ScanGap[]
}

/**
 * How to phrase a skip — and which skips are worth phrasing at all.
 *
 * `no-store` is deliberately absent. The other two reasons mean *we do not know what is
 * there*: a stopped distro was never opened, and a distro whose `$HOME` we could not read
 * was never looked in. `no-store` means we did look and there is nothing — a settled
 * answer, not a gap. `docker-desktop` on the reference machine is permanently in that
 * state, so reporting it would put a warning on every scan that never stops being true.
 */
const SKIP_DETAIL: Partial<Record<SkipReason, string>> = {
  'not-running': 'not running — start it to index its history',
  'no-home': 'home directory unreadable',
}

function storeLabel(store: LaunchStore): string {
  return store.host === 'wsl' ? store.distro : store.host === 'windows' ? 'Windows' : 'Linux'
}

/**
 * Read every `~/.claude` on this machine and bring the index up to date.
 *
 * **Every store, not just the local one.** This used to call `scan` with no store, which
 * reads the machine's own `~/.claude` and stops — so on a Windows box running WSL the
 * entire distro-side history was missing from the index while this button reported a
 * clean scan. See `docs/adr/0005-two-claude-code-data-stores.md`.
 *
 * Still synchronous and blocking, which for a single-user local server remains the honest
 * trade: a progress protocol would cost more than it saves. Multi-store makes the wait
 * longer but not differently shaped — measured on the reference machine, the local store
 * is 24.6 s of the 27.2 s total and the WSL store over the 9P share is the remaining 2.5 s.
 * A tenth on top of a wait that was already long is not what should motivate going async.
 *
 * `gaps` is the reason `discoverStores` reports skips rather than just returning a shorter
 * list: a stopped distro's history is genuinely absent, and the UI has to say so rather
 * than quietly show less.
 */
export async function scanTranscripts(): Promise<ScanReport> {
  const result = scanAll(getDatabase())
  revalidatePath('/', 'layout')

  const gaps: ScanGap[] = [
    ...result.skippedDistros.flatMap((skipped) => {
      const detail = SKIP_DETAIL[skipped.reason]
      return detail === undefined ? [] : [{ label: skipped.distro, detail }]
    }),
    ...result.stores.flatMap((store) =>
      store.error === undefined
        ? []
        : [{ label: storeLabel(store.store), detail: `unreadable — ${store.error}` }],
    ),
  ]

  return {
    ingested: result.ingested,
    skipped: result.skipped,
    failed: result.failed.length,
    projects: result.projects,
    durationMs: result.durationMs,
    stores: result.stores.filter((store) => store.result !== undefined).length,
    gaps,
  }
}
