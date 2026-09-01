import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendRateLimits, latestRateLimits, loadPricing } from './sightline-home.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sightline-home-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fingerprint(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else
        out.set(relative(root, full), createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(root)
  return out
}

describe('rate limit capture', () => {
  /**
   * Rule 2, at the one place in the codebase with a real motive to break it. The official
   * quota numbers only exist inside a statusLine hook payload, and installing that hook
   * means editing `~/.claude/settings.json` — so the temptation is to write it. We do not.
   * `sightline statusline --install` prints the snippet and the user pastes it.
   */
  it('writes nothing under a ~/.claude sitting right next to it', () => {
    const claude = join(dir, '.claude')
    mkdirSync(claude, { recursive: true })
    writeFileSync(join(claude, 'settings.json'), '{"cleanupPeriodDays":30}\n', 'utf8')
    const before = fingerprint(claude)

    appendRateLimits(
      [{ window: 'five_hour', usedPercentage: 12, capturedAt: '2026-09-01T12:00:00.000Z' }],
      join(dir, '.sightline', 'rate-limits.jsonl'),
    )

    expect(fingerprint(claude)).toEqual(before)
  })

  it('round-trips a capture', () => {
    const path = join(dir, 'rate-limits.jsonl')
    appendRateLimits(
      [
        {
          window: 'five_hour',
          usedPercentage: 12,
          resetsAt: '2026-09-01T15:00:00.000Z',
          capturedAt: '2026-09-01T12:00:00.000Z',
        },
      ],
      path,
    )

    expect(latestRateLimits(path).get('five_hour')?.usedPercentage).toBe(12)
  })

  it('keeps the newest reading per window', () => {
    const path = join(dir, 'rate-limits.jsonl')
    appendRateLimits(
      [{ window: 'five_hour', usedPercentage: 10, capturedAt: '2026-09-01T10:00:00.000Z' }],
      path,
    )
    appendRateLimits(
      [{ window: 'five_hour', usedPercentage: 40, capturedAt: '2026-09-01T12:00:00.000Z' }],
      path,
    )

    expect(latestRateLimits(path).get('five_hour')?.usedPercentage).toBe(40)
  })

  /**
   * The hook appends while the reader reads, so a torn final line is normal rather than
   * exceptional — the same lesson as `docs/LIVE-SESSIONS.md`: a parse failure means "try
   * again", not "data gone".
   */
  it('ignores a torn final line instead of losing the whole file', () => {
    const path = join(dir, 'rate-limits.jsonl')
    appendRateLimits(
      [{ window: 'five_hour', usedPercentage: 10, capturedAt: '2026-09-01T10:00:00.000Z' }],
      path,
    )
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"window":"five_hour","used`, 'utf8')

    expect(latestRateLimits(path).get('five_hour')?.usedPercentage).toBe(10)
  })

  it('drops an epoch that leaked into used_percentage, even from an old file', () => {
    const path = join(dir, 'rate-limits.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({ window: 'five_hour', usedPercentage: 1_787_421_279_361, capturedAt: '2026-09-01T10:00:00.000Z' })}\n`,
      'utf8',
    )
    expect(latestRateLimits(path).size).toBe(0)
  })

  it('reads nothing, and throws nothing, when the file does not exist', () => {
    expect(latestRateLimits(join(dir, 'absent.jsonl')).size).toBe(0)
  })
})

describe('loadPricing', () => {
  /**
   * `undefined`, not `{}`. No price file means the meter shows tokens and omits the cost
   * line entirely — Sightline ships no prices, so this is the default state.
   */
  it('is undefined when the user has supplied no price file', () => {
    expect(loadPricing(join(dir, 'absent.json'))).toBeUndefined()
  })

  it('is undefined rather than an exception when the file is malformed', () => {
    const path = join(dir, 'pricing.json')
    writeFileSync(path, '{ this is not json', 'utf8')
    expect(loadPricing(path)).toBeUndefined()
  })

  it('reads a model’s rates', () => {
    const path = join(dir, 'pricing.json')
    writeFileSync(
      path,
      JSON.stringify({
        'claude-opus-5': {
          input: 5,
          output: 25,
          cacheRead: 0.5,
          cacheWrite5m: 6.25,
          cacheWrite1h: 10,
        },
      }),
      'utf8',
    )
    expect(loadPricing(path)?.['claude-opus-5']).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    })
  })

  /**
   * A missing cache-write rate falls back to the input price, not to zero. A cache write
   * that costs nothing is a claim, and the wrong one.
   */
  it('falls back to the input price for absent cache-write rates', () => {
    const path = join(dir, 'pricing.json')
    writeFileSync(path, JSON.stringify({ m: { input: 3, output: 15 } }), 'utf8')
    expect(loadPricing(path)?.['m']).toMatchObject({
      cacheWrite5m: 3,
      cacheWrite1h: 3,
      cacheRead: 0,
    })
  })

  it('skips an entry with no input or output price rather than inventing one', () => {
    const path = join(dir, 'pricing.json')
    writeFileSync(
      path,
      JSON.stringify({ good: { input: 1, output: 2 }, bad: { input: 1 } }),
      'utf8',
    )
    const table = loadPricing(path)
    expect(Object.keys(table ?? {})).toEqual(['good'])
  })
})
