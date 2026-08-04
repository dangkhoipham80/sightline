'use server'

import { scan } from '@sightline/ingest'
import { revalidatePath } from 'next/cache'
import { getDatabase } from '@/lib/db'

export interface ScanReport {
  ingested: number
  skipped: number
  failed: number
  projects: number
  durationMs: number
}

/**
 * Read `~/.claude/projects` and bring the index up to date.
 *
 * Synchronous and blocking, which for a single-user local server is the honest trade: the
 * whole corpus reparses in a few seconds and a progress protocol would cost more than it
 * saves. `sightline serve` will run the watcher alongside this; until then, this button is
 * how the index gets built.
 */
export async function scanTranscripts(): Promise<ScanReport> {
  const result = scan(getDatabase())
  revalidatePath('/', 'layout')

  return {
    ingested: result.ingested,
    skipped: result.skipped,
    failed: result.failed.length,
    projects: result.projects,
    durationMs: result.durationMs,
  }
}
