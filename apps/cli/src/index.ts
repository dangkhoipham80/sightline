#!/usr/bin/env node
/**
 * The `sightline` binary.
 *
 * Currently one command. `serve | scan | summarize | mcp | export` are roadmap PR 9 and
 * land here alongside it; this file exists now because the usage meter needs a place for
 * `sightline statusline` and inventing a second entry point for it would be worse.
 */

import { appendRateLimits, rateLimitsPath } from '@sightline/db'
import { readRateLimits, renderStatusLine, settingsSnippet } from './statusline.js'

const USAGE = `sightline — the memory & review layer for Claude Code

  sightline statusline            read a statusLine payload on stdin, capture rate limits
  sightline statusline --install  print the settings snippet to paste yourself
`

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case 'statusline':
      return statusline(rest)
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`sightline: unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
      return 1
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
// and the testable logic lives in `statusline.ts` where no process state is involved.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`sightline: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
