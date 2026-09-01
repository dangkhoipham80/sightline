import type { TokenUsage } from '../types.js'

/**
 * Per-million-token prices for one model, in USD.
 *
 * **Sightline ships no prices.** Not one. Prices change without notice, a stale table is
 * indistinguishable from a current one once it is rendered as a dollar figure, and being
 * wrong about money is worse than saying nothing. The user supplies
 * `~/.sightline/pricing.json` if they want costs; without it the meter shows tokens and
 * omits the cost line entirely.
 */
export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  /** 5-minute cache writes. Typically ~1.25× input, but that is the user's number to set. */
  cacheWrite5m: number
  /** 1-hour cache writes. Typically ~2× input. */
  cacheWrite1h: number
}

/** `{ "claude-opus-5": { "input": 5, … } }`, keyed by `message.model`. */
export type PricingTable = Record<string, ModelPricing>

const PER_MILLION = 1_000_000

/**
 * Cost one model's usage, or `undefined` when that model has no price.
 *
 * `undefined` is load-bearing and must not be softened to `0`. A zero renders as "$0.00",
 * which reads as "this was free" rather than "we do not know what this cost".
 */
export function costUsage(
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (pricing === undefined) return undefined

  return (
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheCreation5mTokens * pricing.cacheWrite5m +
      usage.cacheCreation1hTokens * pricing.cacheWrite1h) /
    PER_MILLION
  )
}

export interface CostBreakdown {
  /** Summed over models that have a price. `undefined` when none of them did. */
  usd?: number
  /** Models present in the usage that carried no price — named, not silently skipped. */
  unpricedModels: string[]
}

/**
 * Cost a set of per-model usage totals.
 *
 * A partial answer is reported as partial: if two models ran and only one is priced, the
 * total is the one model's cost *and* `unpricedModels` names the other. Presenting a
 * partial sum as a whole is how a meter ends up quietly under-reporting.
 */
export function costByModel(
  usageByModel: ReadonlyMap<string, TokenUsage>,
  prices: PricingTable,
): CostBreakdown {
  const unpricedModels: string[] = []
  let usd: number | undefined

  for (const [model, usage] of usageByModel) {
    const cost = costUsage(usage, prices[model])
    if (cost === undefined) {
      unpricedModels.push(model)
      continue
    }
    usd = (usd ?? 0) + cost
  }

  unpricedModels.sort()
  return { ...(usd !== undefined && { usd }), unpricedModels }
}
