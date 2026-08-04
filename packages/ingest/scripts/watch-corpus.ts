#!/usr/bin/env tsx
/**
 * Watch the real transcripts on this machine and report what the watcher picks up.
 *
 *   pnpm --filter @sightline/ingest exec tsx scripts/watch-corpus.ts [--seconds 30] [--db <path>]
 *
 * The companion to `scan-corpus.ts`, and deliberately not in CI for the same reason: it
 * needs local data and a clock. Run it before any ingest PR and paste the output into the
 * PR body.
 *
 * The honest way to run it is to keep a Claude Code session going in another window while
 * it watches — the session writing the transcript is the load. If nothing is running, it
 * will correctly report zero events, which proves nothing.
 */

import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions, openDatabase } from '@sightline/db'
import { scan } from '../src/scan.js'
import { watch } from '../src/watch.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const secondsFlag = args.indexOf('--seconds')
  const seconds = secondsFlag === -1 ? 30 : Number(args[secondsFlag + 1] ?? 30)
  const dbFlag = args.indexOf('--db')
  const dbPath =
    dbFlag === -1 ? join(tmpdir(), 'sightline-watch-corpus.db') : (args[dbFlag + 1] ?? '')

  if (dbFlag === -1) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  }

  const db = openDatabase({ path: dbPath })

  const baseline = scan(db)
  console.log(`index: ${dbPath}`)
  console.log(
    `  baseline scan: ${baseline.ingested} ingested, ${baseline.skipped} skipped, ` +
      `${baseline.projects} projects, ${baseline.durationMs} ms`,
  )
  console.log('')
  console.log(`  watching for ${seconds}s — keep a Claude Code session running elsewhere`)
  console.log('')

  let events = 0
  const perSession = new Map<string, number>()
  const started = Date.now()

  const watcher = watch(db, {
    onIndexed: (event) => {
      events += 1
      perSession.set(event.sessionId, (perSession.get(event.sessionId) ?? 0) + 1)
      const elapsed = ((Date.now() - started) / 1000).toFixed(1).padStart(6)
      const messages = listSessions(db, { limit: 1000 }).find((s) => s.id === event.sessionId)
      console.log(
        `  ${elapsed}s  ${event.sessionId.slice(0, 8)}  ` +
          `${String(messages?.messageCount ?? 0).padStart(5)} msgs  ` +
          `${String(messages?.toolCallCount ?? 0).padStart(4)} tools` +
          (event.malformedLines > 0 ? `  (${event.malformedLines} malformed)` : ''),
      )
    },
    onError: (error) => {
      console.log(`  ERROR ${error.sessionId ?? '—'}: ${error.error.message}`)
    },
  })

  await watcher.ready
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  await watcher.close()

  console.log('')
  console.log(`  re-index events: ${events} across ${perSession.size} sessions`)
  for (const [sessionId, count] of [...perSession].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${sessionId.slice(0, 8)}  ${count}×`)
  }

  const after = scan(db)
  console.log('')
  console.log(
    `  scan after watching: ${after.ingested} re-ingested, ${after.skipped} skipped — ` +
      'a low re-ingest count means the watcher kept up',
  )
}

void main()
