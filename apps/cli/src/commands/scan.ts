/**
 * `sightline scan` — index every `~/.claude` this machine can reach.
 *
 * `scanAll`, never `scan`: the single-store primitive succeeds on a machine with two
 * stores and returns a smaller, entirely plausible index. That failure mode is what
 * ADR 0005 exists to describe, and a CLI is the worst place to reintroduce it — nothing
 * about the output would say a store was missed.
 */

import type { LaunchStore } from '@sightline/core'
import { defaultIndexPath, openDatabase } from '@sightline/db'
import type { ScanAllResult } from '@sightline/ingest'
import { scanAll } from '@sightline/ingest'
import type { ParsedArgs } from '../args.js'
import { boolFlag, stringFlag, unknownFlags } from '../args.js'

const KNOWN = ['force', 'index', 'quiet', 'help', 'h']

export function scanCommand(parsed: ParsedArgs): number {
  const unknown = unknownFlags(parsed, KNOWN)
  if (unknown.length > 0) {
    process.stderr.write(`sightline scan: unknown option --${unknown[0]}\n${SCAN_USAGE}`)
    return 1
  }
  if (boolFlag(parsed, 'help') || boolFlag(parsed, 'h')) {
    process.stdout.write(SCAN_USAGE)
    return 0
  }

  const index = stringFlag(parsed, 'index')
  if (index === 'missing-value') {
    process.stderr.write('sightline scan: --index needs a path\n')
    return 1
  }

  const path = index ?? process.env['SIGHTLINE_INDEX'] ?? defaultIndexPath()
  // Progress is drawn with `\r`, which only redraws on a terminal. Piped, it produces one
  // long line of every intermediate count — so a non-TTY gets the summary and nothing else.
  const quiet = boolFlag(parsed, 'quiet') || process.stderr.isTTY !== true

  // Printed before the work, not after. Opening the index can migrate it — and when the
  // derived schema version has moved, migrating means dropping and rebuilding every
  // derived table. Being told which file that is about to happen to *afterwards* is being
  // told too late.
  process.stdout.write(`sightline: index ${path}\n`)

  const db = openDatabase({ path })

  try {
    const result = scanAll(db, {
      force: boolFlag(parsed, 'force'),
      ...(quiet
        ? {}
        : {
            onProgress: (progress, store) => {
              if (progress.processed % 25 !== 0 && progress.processed !== progress.total) return
              process.stderr.write(
                `\r  ${storeLabel(store.launch)}: ${progress.processed}/${progress.total}    `,
              )
            },
          }),
    })

    if (!quiet) process.stderr.write('\r'.padEnd(60, ' ') + '\r')
    process.stdout.write(formatScanResult(result))

    // A store that could not be read is a shorter index, and the exit code should say so.
    // The rows already written are kept either way — see the comment on `scanAll`.
    return result.stores.some((s) => s.error !== undefined) ? 1 : 0
  } finally {
    db.close()
  }
}

/** Matches `storeKey` in the web app: two spellings of one store must read as one store. */
function storeLabel(store: LaunchStore): string {
  return store.host === 'wsl' ? `wsl:${store.distro}` : store.host
}

/** Pure, so the reporting can be tested without a filesystem or a database. */
export function formatScanResult(result: ScanAllResult): string {
  const lines: string[] = []

  for (const store of result.stores) {
    const label = storeLabel(store.store)
    if (store.error !== undefined) {
      lines.push(`  ${label}  ${store.root}`, `    could not be read: ${store.error}`)
      continue
    }
    const r = store.result
    if (r === undefined) continue
    lines.push(
      `  ${label}  ${store.root}`,
      `    ${r.discovered} sessions — ${r.ingested} indexed, ${r.skipped} unchanged${
        r.failed.length === 0 ? '' : `, ${r.failed.length} failed`
      }`,
    )
  }

  for (const skipped of result.skippedDistros) {
    // Named, never dropped. A distro that is merely stopped silently shortens the index by
    // however much work happened inside it.
    lines.push(`  ${skipped.distro}  skipped: ${skipped.reason}`)
  }

  lines.push(
    '',
    // "projects touched", not "projects": the count comes from the indexer and covers the
    // projects this run resolved, so an incremental scan reports 2 on a 14-project index.
    // Printing it as a total would be a number that quietly shrinks every time you re-scan.
    `${result.ingested} indexed, ${result.skipped} unchanged, ${result.projects} projects touched, ${(result.durationMs / 1000).toFixed(1)}s`,
  )

  if (result.malformedLines > 0) {
    lines.push(`${result.malformedLines} malformed lines skipped (the files they are in are fine)`)
  }

  for (const failure of result.failed.slice(0, 10)) {
    lines.push(`failed: ${failure.sessionId} — ${failure.error}`)
  }
  if (result.failed.length > 10) {
    lines.push(`… and ${result.failed.length - 10} more failures`)
  }

  return `${lines.join('\n')}\n`
}

export const SCAN_USAGE = `sightline scan — index every ~/.claude this machine can reach

  --force          re-read every transcript, ignoring size and mtime
  --index <path>   index to write (default $SIGHTLINE_INDEX, then ~/.sightline/index.db)
  --quiet          no progress output

Exits 1 if a store could not be read, so a shortened index is never reported as a clean run.
`
