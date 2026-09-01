/**
 * `sightline serve` — start the web UI.
 *
 * A thin supervisor over `next start`, not a server of its own. See `web-app.ts` for why
 * the Next app is spawned rather than imported or bundled.
 */

import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { defaultIndexPath } from '@sightline/db'
import type { ParsedArgs } from '../args.js'
import { boolFlag, parsePort, stringFlag, unknownFlags } from '../args.js'
import { explainLookupFailure, findWebApp } from '../web-app.js'

/** The port `apps/web`'s own `start` script has always used. */
export const DEFAULT_PORT = 4317

const KNOWN = ['port', 'host', 'index', 'open', 'help', 'h']

export async function serve(parsed: ParsedArgs): Promise<number> {
  const unknown = unknownFlags(parsed, KNOWN)
  if (unknown.length > 0) {
    process.stderr.write(`sightline serve: unknown option --${unknown[0]}\n${SERVE_USAGE}`)
    return 1
  }
  if (boolFlag(parsed, 'help') || boolFlag(parsed, 'h')) {
    process.stdout.write(SERVE_USAGE)
    return 0
  }

  const rawPort = stringFlag(parsed, 'port')
  if (rawPort === 'missing-value') {
    process.stderr.write('sightline serve: --port needs a number\n')
    return 1
  }
  const port = rawPort === undefined ? DEFAULT_PORT : parsePort(rawPort)
  if (typeof port === 'string') {
    process.stderr.write(`sightline serve: --port ${port}\n`)
    return 1
  }

  const host = stringFlag(parsed, 'host')
  if (host === 'missing-value') {
    process.stderr.write('sightline serve: --host needs a value\n')
    return 1
  }
  const hostname = host ?? '127.0.0.1'

  const index = stringFlag(parsed, 'index')
  if (index === 'missing-value') {
    process.stderr.write('sightline serve: --index needs a path\n')
    return 1
  }

  const lookup = findWebApp({ override: process.env['SIGHTLINE_WEB_DIR'] })
  if (!lookup.ok) {
    process.stderr.write(`${explainLookupFailure(lookup)}\n`)
    return 1
  }

  // Checked before spawning rather than after. `next start` on a taken port fails with a
  // message about EADDRINUSE that reads like a Next problem, and the far more common cause
  // is a server this command started earlier — which then goes on serving an *older build*
  // while you read the new one's output. That has cost real debugging time here before.
  if (await portInUse(hostname, port)) {
    process.stderr.write(
      [
        `sightline serve: something is already listening on ${hostname}:${port}.`,
        '',
        'It may be an older sightline still serving a previous build. Either stop it or',
        `pick another port with --port. To find it:  netstat -ano | grep :${port}`,
        '',
      ].join('\n'),
    )
    return 1
  }

  const indexPath = index ?? process.env['SIGHTLINE_INDEX'] ?? defaultIndexPath()
  process.stdout.write(`sightline: serving ${lookup.dir}\nsightline: index ${indexPath}\n`)

  const child = spawn(
    process.execPath,
    [lookup.nextBin, 'start', '--port', String(port), '--hostname', hostname],
    {
      cwd: lookup.dir,
      stdio: 'inherit',
      env: { ...process.env, SIGHTLINE_INDEX: indexPath },
    },
  )

  // The child is a direct child sharing this console, so Ctrl-C reaches it on its own. What
  // does not happen on its own is the reverse: if this process is killed some other way,
  // `next start` keeps the port — and a held port is the stale-build trap above.
  const stop = (): void => {
    if (!child.killed) child.kill()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('exit', stop)

  const url = `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${port}`
  if (boolFlag(parsed, 'open')) {
    // Polled rather than parsed out of Next's stdout: the ready line has changed wording
    // between minor versions, and an accepted connection is the thing actually being
    // waited for. `stdio: 'inherit'` means there is no stream to read anyway.
    void waitForPort(hostname, port, child).then((ready) => {
      if (ready) openBrowser(url)
    })
  }

  return await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      process.stderr.write(`sightline serve: could not start next: ${error.message}\n`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      // Ctrl-C is how this command is meant to end. Reporting it as a failure would make
      // every normal use look like a broken one.
      resolve(signal !== null ? 0 : (code ?? 0))
    })
  })
}

/** One connection attempt. Refused means free; anything else means treat it as taken. */
function portInUse(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname === '0.0.0.0' ? '127.0.0.1' : hostname, port })
    socket.setTimeout(500)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(false))
  })
}

async function waitForPort(
  hostname: string,
  port: number,
  child: { exitCode: number | null },
): Promise<boolean> {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false
    if (await portInUse(hostname, port)) return true
    await new Promise((r) => setTimeout(r, 200))
  }

  return false
}

/**
 * Hand the URL to the OS and forget about it.
 *
 * Detached and unwatched on purpose: the browser is not this process's problem, and on
 * Windows `start` returns immediately while the actual browser outlives everything here.
 */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? // The empty string is the window title `start` would otherwise take the URL to be.
        ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]

  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // No browser opener is not a reason to fail; the URL was already printed by Next.
  }
}

export const SERVE_USAGE = `sightline serve — run the web UI

  --port <n>       port to listen on (default ${DEFAULT_PORT})
  --host <name>    interface to bind (default 127.0.0.1)
  --index <path>   index to read (default $SIGHTLINE_INDEX, then ~/.sightline/index.db)
  --open           open a browser once the server answers

Needs a Sightline checkout with apps/web built (\`pnpm build\`).
`
