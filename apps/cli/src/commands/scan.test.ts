import type { ScanAllResult } from '@sightline/ingest'
import { describe, expect, it } from 'vitest'
import { formatScanResult } from './scan.js'

function result(overrides: Partial<ScanAllResult> = {}): ScanAllResult {
  return {
    discovered: 0,
    ingested: 0,
    skipped: 0,
    failed: [],
    projects: 0,
    malformedLines: 0,
    durationMs: 0,
    stores: [],
    skippedDistros: [],
    ...overrides,
  }
}

describe('formatScanResult', () => {
  it('reports each store on its own, so a short index is visible as a short index', () => {
    const text = formatScanResult(
      result({
        ingested: 137,
        skipped: 4,
        projects: 17,
        durationMs: 17_400,
        stores: [
          {
            store: { host: 'windows' },
            root: 'C:\\Users\\me\\.claude',
            result: {
              discovered: 137,
              ingested: 137,
              skipped: 0,
              failed: [],
              projects: 17,
              malformedLines: 0,
              durationMs: 17_000,
            },
          },
          {
            store: { host: 'wsl', distro: 'Ubuntu-24.04' },
            root: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\.claude',
            error: 'ENOENT',
          },
        ],
      }),
    )

    expect(text).toContain('windows  C:\\Users\\me\\.claude')
    expect(text).toContain('137 sessions — 137 indexed, 0 unchanged')
    expect(text).toContain('wsl:Ubuntu-24.04')
    expect(text).toContain('could not be read: ENOENT')
    expect(text).toContain('137 indexed, 4 unchanged, 17 projects touched, 17.4s')
  })

  it('names a skipped distro instead of dropping it', () => {
    // A stopped distro silently shortens the index by everything that happened inside it.
    const text = formatScanResult(
      result({ skippedDistros: [{ distro: 'docker-desktop', reason: 'not-running' }] }),
    )

    expect(text).toContain('docker-desktop  skipped: not-running')
  })

  it('separates malformed lines from failed sessions', () => {
    const text = formatScanResult(result({ malformedLines: 12 }))

    // Trap: one bad line must not read as a lost file.
    expect(text).toContain('12 malformed lines skipped (the files they are in are fine)')
  })

  it('caps the failure list but says how many it capped', () => {
    const failed = Array.from({ length: 14 }, (_, i) => ({ sessionId: `s${i}`, error: 'boom' }))

    const text = formatScanResult(result({ failed }))

    expect(text.match(/^failed: /gm)).toHaveLength(10)
    expect(text).toContain('… and 4 more failures')
  })
})
