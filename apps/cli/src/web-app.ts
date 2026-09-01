/**
 * Finding the Next app that `sightline serve` starts.
 *
 * `apps/web` is not bundled into this binary and deliberately is not. better-sqlite3 is a
 * native addon that the web app goes to some trouble to keep *out* of webpack's bundle
 * (see the comment in `apps/web/next.config.ts`); adding a second bundler on top of that
 * arrangement is a way to rediscover the same failure from further away. So `serve` runs
 * the real `next start` against the real build, and this module's whole job is locating
 * them and saying something useful when they are not there.
 *
 * The consequence is stated rather than hidden: **`serve` needs a repository checkout with
 * `apps/web` built.** That is why `npx sightline` is not claimed by this PR — see the
 * `serve` entry in `docs/CLI.md`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type WebAppLookup =
  | { ok: true; dir: string; nextBin: string }
  | { ok: false; reason: 'no-app'; searchedFrom: string }
  | { ok: false; reason: 'not-built'; dir: string }
  | { ok: false; reason: 'no-next'; dir: string; detail: string }

/** Where the search starts. Overridable so tests never depend on this file's own location. */
export interface FindWebAppOptions {
  from?: string
  /** `SIGHTLINE_WEB_DIR`, for a checkout laid out in a way this cannot guess. */
  override?: string | undefined
}

export function findWebApp(options: FindWebAppOptions = {}): WebAppLookup {
  const from = options.from ?? dirname(fileURLToPath(import.meta.url))

  const dir = options.override ?? locate(from)
  if (dir === undefined) return { ok: false, reason: 'no-app', searchedFrom: from }

  // `BUILD_ID` rather than `.next/`: `next dev` leaves a `.next` behind that `next start`
  // refuses to serve, and "the directory exists" would call that a working install.
  if (!existsSync(join(dir, '.next', 'BUILD_ID'))) return { ok: false, reason: 'not-built', dir }

  try {
    // Resolved from the app's own package.json so pnpm's store layout is followed rather
    // than guessed. The binary is *not* at the repository root — `node_modules/.bin/next`
    // there is a shim that does not exist for a nested workspace install.
    const nextBin = createRequire(join(dir, 'package.json')).resolve('next/dist/bin/next')
    return { ok: true, dir, nextBin }
  } catch (error) {
    return {
      ok: false,
      reason: 'no-next',
      dir,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Walk up looking for `apps/web`, confirming by package name rather than by path shape. */
function locate(from: string): string | undefined {
  let current = from

  for (;;) {
    const candidate = join(current, 'apps', 'web')
    if (isWebApp(candidate)) return candidate

    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isWebApp(dir: string): boolean {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return false

  try {
    return (
      (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === '@sightline/web'
    )
  } catch {
    return false
  }
}

/** What to print when the app cannot be started, phrased as the next thing to do. */
export function explainLookupFailure(lookup: Extract<WebAppLookup, { ok: false }>): string {
  switch (lookup.reason) {
    case 'no-app':
      return [
        `sightline serve: could not find the web app (searched upwards from ${lookup.searchedFrom}).`,
        '',
        'serve runs the Next build in apps/web, so it needs a Sightline checkout. Run it from',
        'inside one, or set SIGHTLINE_WEB_DIR to the apps/web directory.',
      ].join('\n')

    case 'not-built':
      return [
        `sightline serve: ${lookup.dir} has no production build.`,
        '',
        'Build it first:',
        '',
        '  pnpm build',
        '',
        'A `.next` left behind by `pnpm dev` is not one — `next start` will not serve it.',
      ].join('\n')

    case 'no-next':
      return [
        `sightline serve: could not resolve the next binary from ${lookup.dir}.`,
        `  ${lookup.detail}`,
        '',
        'Run `pnpm install` in the repository root.',
      ].join('\n')
  }
}
