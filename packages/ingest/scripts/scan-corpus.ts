#!/usr/bin/env tsx
/**
 * Index the real transcripts on this machine and report what landed.
 *
 *   pnpm --filter @sightline/ingest exec tsx scripts/scan-corpus.ts [--db <path>] [--force]
 *
 * Like `check-corpus.ts` in core, this is deliberately not in CI — it needs local data.
 * Run it before any ingest PR and paste the output into the PR body. Fixtures prove the
 * indexer handles the shapes we already know about; this proves it survives yours.
 *
 * Defaults to a scratch database under the system temp directory so it never touches a
 * real index by accident.
 */

import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFileTouches, listProjects, listSessions, openDatabase, search } from '@sightline/db'
import { scan } from '../src/scan.js'

function main(): void {
  const args = process.argv.slice(2)
  const dbFlag = args.indexOf('--db')
  const dbPath =
    dbFlag === -1 ? join(tmpdir(), 'sightline-scan-corpus.db') : (args[dbFlag + 1] ?? '')
  const force = args.includes('--force')
  const fresh = dbFlag === -1

  if (fresh) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  }

  const db = openDatabase({ path: dbPath })
  const result = scan(db, { force })

  console.log(`index: ${dbPath}`)
  console.log('')
  console.log(`  discovered            ${result.discovered}`)
  console.log(`  ingested              ${result.ingested}`)
  console.log(`  skipped (unchanged)   ${result.skipped}`)
  console.log(`  failed                ${result.failed.length}`)
  console.log(`  malformed lines       ${result.malformedLines}`)
  console.log(`  elapsed               ${result.durationMs} ms`)
  console.log('')

  for (const failure of result.failed) {
    console.log(`  FAILED ${failure.sessionId}: ${failure.error}`)
  }

  const projects = listProjects(db)
  console.log(`  projects              ${projects.length}`)
  console.log('')
  console.log('  name                          sessions  msgs   folder keys  last active')
  for (const project of projects) {
    console.log(
      `  ${project.displayName.slice(0, 28).padEnd(28)}  ${String(project.sessionCount).padStart(8)}  ${String(
        project.messageCount,
      ).padStart(5)}  ${String(project.folderKeys.length).padStart(11)}  ${
        project.lastActive?.slice(0, 10) ?? '—'
      }${project.orphaned ? '  (orphaned)' : ''}`,
    )
  }
  console.log('')

  // A project whose sessions came from several folder keys is one that folder-key
  // grouping would have shown as several unrelated projects.
  const merged = projects.filter((p) => p.folderKeys.length > 1)
  console.log(`  projects reunited from multiple folder keys: ${merged.length}`)
  for (const project of merged) {
    console.log(`    ${project.displayName}: ${project.folderKeys.join(', ')}`)
  }
  console.log('')

  const sessions = listSessions(db, { limit: 5 })
  console.log('  five most recent sessions:')
  for (const session of sessions) {
    console.log(`    ${session.startedAt?.slice(0, 16) ?? '—'}  ${session.title ?? session.id}`)
  }
  console.log('')

  const busiest = projects[0]
  if (busiest !== undefined) {
    console.log(`  most-touched files in "${busiest.displayName}":`)
    for (const touch of listFileTouches(db, busiest.id, 5)) {
      console.log(`    ${String(touch.count).padStart(4)}×  ${touch.op.padEnd(5)}  ${touch.path}`)
    }
    console.log('')
  }

  const started = process.hrtime.bigint()
  const hits = search(db, 'transcript')
  const searchMs = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`  search("transcript"): ${hits.length} hits in ${searchMs.toFixed(1)} ms`)

  const incrementalStart = Date.now()
  const second = scan(db)
  console.log(
    `  second scan: ${second.skipped} skipped, ${second.ingested} re-ingested, ${Date.now() - incrementalStart} ms`,
  )

  process.exit(result.failed.length > 0 ? 1 : 0)
}

main()
