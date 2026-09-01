import { describe, expect, it } from 'vitest'
import { readRateLimits, renderStatusLine, settingsSnippet } from './statusline.js'

const AT = '2026-09-01T12:00:00.000Z'
const NOW = new Date(AT)

describe('readRateLimits', () => {
  it('reads both windows out of a statusLine payload', () => {
    const readings = readRateLimits(
      {
        rate_limits: {
          five_hour: { used_percentage: 42.5, resets_at: '2026-09-01T15:00:00.000Z' },
          seven_day: { used_percentage: 8, resets_at: '2026-09-05T00:00:00.000Z' },
        },
      },
      AT,
    )

    expect(readings).toEqual([
      {
        window: 'five_hour',
        usedPercentage: 42.5,
        resetsAt: '2026-09-01T15:00:00.000Z',
        capturedAt: AT,
      },
      {
        window: 'seven_day',
        usedPercentage: 8,
        resetsAt: '2026-09-05T00:00:00.000Z',
        capturedAt: AT,
      },
    ])
  })

  /**
   * anthropics/claude-code#52326: an epoch has been observed in `used_percentage`. Rendering
   * it would read as 1.7-billion-percent usage.
   *
   * Dropped rather than clamped. Clamping to 100 would display "you are at your limit",
   * which is a more alarming lie than showing nothing at all.
   */
  it('drops an epoch leaked into used_percentage rather than clamping it', () => {
    const readings = readRateLimits(
      { rate_limits: { five_hour: { used_percentage: 1_787_421_279_361 } } },
      AT,
    )
    expect(readings).toEqual([])
  })

  it('keeps a reading that rounds just past 100', () => {
    const readings = readRateLimits({ rate_limits: { five_hour: { used_percentage: 100.4 } } }, AT)
    expect(readings).toHaveLength(1)
  })

  it('rejects anything past the 101 bound', () => {
    const readings = readRateLimits({ rate_limits: { five_hour: { used_percentage: 101.1 } } }, AT)
    expect(readings).toEqual([])
  })

  it('survives a payload with no rate limits at all', () => {
    expect(readRateLimits({}, AT)).toEqual([])
    expect(readRateLimits(undefined, AT)).toEqual([])
    expect(readRateLimits('not an object', AT)).toEqual([])
    expect(readRateLimits({ rate_limits: null }, AT)).toEqual([])
  })

  it('keeps a window that has a percentage but no reset time', () => {
    const readings = readRateLimits({ rate_limits: { five_hour: { used_percentage: 10 } } }, AT)
    expect(readings[0]).toEqual({ window: 'five_hour', usedPercentage: 10, capturedAt: AT })
  })
})

describe('renderStatusLine', () => {
  it('shows percentages and a countdown', () => {
    const line = renderStatusLine(
      [
        {
          window: 'five_hour',
          usedPercentage: 42.5,
          resetsAt: '2026-09-01T14:30:00.000Z',
          capturedAt: AT,
        },
      ],
      NOW,
    )
    expect(line).toBe('sightline 5h 43% (2h30m)')
  })

  /**
   * The denominator is per-account and unpublished, so a remaining-token figure would be
   * invented. This asserts the absence, because "helpfully" adding one later is exactly the
   * change that would pass review.
   */
  it('never claims a number of tokens remaining', () => {
    const line = renderStatusLine(
      [{ window: 'five_hour', usedPercentage: 42.5, capturedAt: AT }],
      NOW,
    )
    expect(line).not.toMatch(/token/i)
    expect(line).not.toMatch(/remaining|left/i)
    expect(line).toBe('sightline 5h 43%')
  })

  it('says so when there is nothing, rather than showing a zero', () => {
    expect(renderStatusLine([], NOW)).toBe('sightline: no rate limit data')
  })

  it('reports a window that is already past its reset', () => {
    const line = renderStatusLine(
      [
        {
          window: 'seven_day',
          usedPercentage: 3,
          resetsAt: '2026-08-30T00:00:00.000Z',
          capturedAt: AT,
        },
      ],
      NOW,
    )
    expect(line).toBe('sightline 7d 3% (resetting)')
  })
})

describe('settingsSnippet', () => {
  /**
   * Rule 2. The snippet is printed for the user to paste; nothing in this package opens a
   * write handle under `~/.claude`. `packages/ingest/src/read-only.test.ts` enforces the
   * general case, but the temptation is concentrated here, so it is also stated here.
   */
  it('tells the user to install it themselves', () => {
    const snippet = settingsSnippet('sightline statusline')
    expect(snippet).toContain('never writes to ~/.claude')
    expect(snippet).toContain('"statusLine"')
    expect(snippet).toContain('sightline statusline')
  })

  it('is valid JSON that Claude Code would accept', () => {
    const snippet = settingsSnippet('sightline statusline')
    const json = snippet.slice(snippet.indexOf('{'), snippet.lastIndexOf('}') + 1)
    expect(JSON.parse(json)).toEqual({
      statusLine: { type: 'command', command: 'sightline statusline' },
    })
  })
})
