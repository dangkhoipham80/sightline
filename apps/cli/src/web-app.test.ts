import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { explainLookupFailure, findWebApp } from './web-app.js'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sightline-webapp-'))
  roots.push(dir)
  return dir
}

/** A checkout-shaped tree. `built` decides whether `next start` would have anything to serve. */
function checkout(options: { name?: string; built?: boolean } = {}): {
  root: string
  webDir: string
} {
  const root = scratch()
  const webDir = join(root, 'apps', 'web')
  mkdirSync(webDir, { recursive: true })
  writeFileSync(
    join(webDir, 'package.json'),
    JSON.stringify({ name: options.name ?? '@sightline/web' }),
  )

  if (options.built === true) {
    mkdirSync(join(webDir, '.next'), { recursive: true })
    writeFileSync(join(webDir, '.next', 'BUILD_ID'), 'abc123')
  }

  return { root, webDir }
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('findWebApp', () => {
  it('walks up from a nested directory to find apps/web', () => {
    const { root, webDir } = checkout({ built: true })
    const deep = join(root, 'apps', 'cli', 'dist')
    mkdirSync(deep, { recursive: true })

    const lookup = findWebApp({ from: deep })

    // `next` resolves from the real workspace, not this tree, so a successful lookup here
    // would need a node_modules. What matters is that the directory was found and judged
    // built — the failure is about `next`, not about the app.
    expect(lookup.ok === true ? lookup.dir : (lookup as { dir?: string }).dir).toBe(webDir)
    if (!lookup.ok) expect(lookup.reason).toBe('no-next')
  })

  it('reports a directory that exists but was never built', () => {
    const { root, webDir } = checkout()

    const lookup = findWebApp({ from: root })

    expect(lookup).toEqual({ ok: false, reason: 'not-built', dir: webDir })
    expect(explainLookupFailure(lookup as Extract<typeof lookup, { ok: false }>)).toContain(
      'pnpm build',
    )
  })

  it('ignores an apps/web belonging to some other project', () => {
    // Confirmed by package name rather than by path shape: `apps/web` is a common layout,
    // and starting a stranger's Next app would be a confusing way to fail.
    const { root } = checkout({ name: '@someone-else/web', built: true })

    const lookup = findWebApp({ from: root })

    expect(lookup.ok).toBe(false)
    if (!lookup.ok) expect(lookup.reason).toBe('no-app')
  })

  it('gives up at the filesystem root rather than looping', () => {
    const lookup = findWebApp({ from: scratch() })

    expect(lookup).toMatchObject({ ok: false, reason: 'no-app' })
    if (!lookup.ok) expect(explainLookupFailure(lookup)).toContain('SIGHTLINE_WEB_DIR')
  })

  it('honours an explicit override without searching', () => {
    const { webDir } = checkout()

    const lookup = findWebApp({ from: scratch(), override: webDir })

    expect(lookup).toEqual({ ok: false, reason: 'not-built', dir: webDir })
  })

  it('does not treat a package.json it cannot parse as the web app', () => {
    const root = scratch()
    const webDir = join(root, 'apps', 'web')
    mkdirSync(webDir, { recursive: true })
    writeFileSync(join(webDir, 'package.json'), '{ not json')

    expect(findWebApp({ from: root })).toMatchObject({ ok: false, reason: 'no-app' })
  })
})
