import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '../types.js'
import { costByModel, costUsage } from './pricing.js'

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  ...over,
})

const OPUS = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
}

describe('costUsage', () => {
  it('prices each bucket at its own rate', () => {
    const cost = costUsage(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreation5mTokens: 1_000_000,
        cacheCreation1hTokens: 1_000_000,
      }),
      OPUS,
    )
    expect(cost).toBe(5 + 25 + 0.5 + 6.25 + 10)
  })

  /**
   * The two cache TTLs bill differently, so a meter holding only the flat total cannot cost
   * a session. If this collapses to one rate, an hour-cached session is under-billed.
   */
  it('charges a 1h cache write more than a 5m one', () => {
    const fiveMinute = costUsage(usage({ cacheCreation5mTokens: 1_000_000 }), OPUS)
    const oneHour = costUsage(usage({ cacheCreation1hTokens: 1_000_000 }), OPUS)
    expect(oneHour).toBeGreaterThan(fiveMinute as number)
  })

  /**
   * `undefined`, not 0. A zero renders as "$0.00", which reads as "this was free" rather
   * than "we do not know what this cost" — and Sightline ships no prices, so unpriced is
   * the default state, not an edge case.
   */
  it('returns undefined for an unpriced model rather than zero', () => {
    expect(costUsage(usage({ inputTokens: 1_000_000 }), undefined)).toBeUndefined()
  })
})

describe('costByModel', () => {
  it('adds up the models it has prices for', () => {
    const cost = costByModel(
      new Map([
        ['claude-opus-5', usage({ inputTokens: 1_000_000 })],
        ['claude-sonnet-5', usage({ inputTokens: 1_000_000 })],
      ]),
      { 'claude-opus-5': OPUS, 'claude-sonnet-5': { ...OPUS, input: 3 } },
    )
    expect(cost.usd).toBe(8)
    expect(cost.unpricedModels).toEqual([])
  })

  /**
   * A partial answer reported as partial. Presenting the priced half as if it were the whole
   * total is how a usage meter quietly under-reports — the number looks complete and there
   * is nothing on screen to say it is not.
   */
  it('names the models it could not price instead of silently skipping them', () => {
    const cost = costByModel(
      new Map([
        ['claude-opus-5', usage({ inputTokens: 1_000_000 })],
        ['claude-fable-5', usage({ inputTokens: 1_000_000 })],
      ]),
      { 'claude-opus-5': OPUS },
    )
    expect(cost.usd).toBe(5)
    expect(cost.unpricedModels).toEqual(['claude-fable-5'])
  })

  it('has no total at all when nothing is priced', () => {
    const cost = costByModel(new Map([['claude-opus-5', usage({ inputTokens: 1 })]]), {})
    expect(cost.usd).toBeUndefined()
    expect(cost.unpricedModels).toEqual(['claude-opus-5'])
  })
})
