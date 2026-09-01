#!/usr/bin/env node

/**
 * The `sightline` binary.
 *
 * `serve`, `scan` and `export` are roadmap PR 9. `summarize` and `mcp` are named in that
 * roadmap row too, and they are *not* here — they call packages that do not exist yet.
 * See `commands/not-yet.ts` for why they still appear in this dispatch rather than being
 * left out entirely.
 */

import { appendRateLimits, rateLimitsPath } from '@sightline/db'
import { parseArgs } from './args.js'
import { EXPORT_USAGE, exportCommand } from './commands/export.js'
import { NOT_YET, notYet } from './commands/not-yet.js'
import { SCAN_USAGE, scanCommand } from './commands/scan.js'
import { SERVE_USAGE, serve } from './commands/serve.js'
import { readRateLimits, renderStatusLine, settingsSnippet } from './statusline.js'

const USAGE = `sightline — the memory & review layer for Claude Code

  sightline serve                 run the web UI (default http://127.0.0.1:4317)
  sightline scan                  index every ~/.claude this machine can reach
  sightline export <session>      one session as Markdown
  sightline statusline            read a statusLine payload on stdin, capture rate limits
  sightline statusline --install  print the settings snippet to paste yourself

Add --help to any command for its options.

Sightline only ever reads ~/.claude. Everything it writes goes to ~/.sightline.
`

/** Options that take a value, across every command. Shared so `--index x` parses the same way. */
const VALUED = ['port', 'host', 'index', 'out']

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const args = parseArgs(rest, VALUED)

  switch (command) {
    case 'serve':
      return await serve(args)
    case 'scan':
      return scanCommand(args)
    case 'export':
      return exportCommand(args)
    case 'statusline':
      return await statusline(rest)

    case 'summarize':
    case 'mcp': {
      const entry = NOT_YET.find((e) => e.command === command)
      return entry === undefined ? 1 : notYet(entry)
    }

    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(usageFor(rest[0]))
      return 0

    default:
      process.stderr.write(`sightline: unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
      return 1
  }
}

function usageFor(topic: string | undefined): string {
  switch (topic) {
    case 'serve':
      return SERVE_USAGE
    case 'scan':
      return SCAN_USAGE
    case 'export':
      return EXPORT_USAGE
    default:
      return USAGE
  }
}

async function statusline(args: readonly string[]): Promise<number> {
  if (args.includes('--install')) {
    process.stdout.write(`${settingsSnippet('sightline statusline')}\n`)
    return 0
  }

  const payload = parseJson(await readStdin())
  const now = new Date()
  const readings = readRateLimits(payload, now.toISOString())

  // Capture first, render second. If writing fails — read-only home, full disk — the status
  // line still renders. A hook that breaks the user's prompt to report its own failure is a
  // worse outcome than a hook that quietly captures nothing.
  try {
    appendRateLimits(readings)
  } catch (error) {
    process.stderr.write(
      `sightline: could not write ${rateLimitsPath()}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }

  process.stdout.write(`${renderStatusLine(readings, now)}\n`)
  return 0
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // A statusLine hook always pipes stdin. Run by hand in a terminal it would hang
    // forever, so an empty payload after a beat is treated as "nothing to capture".
    if (process.stdin.isTTY === true) {
      resolve('')
      return
    }

    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

// `import.meta.url` check omitted deliberately: this file is only ever the bin entry point,
// and the testable logic lives beside it in modules where no process state is involved.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`sightline: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
