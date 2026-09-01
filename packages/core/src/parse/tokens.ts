import type { TokenUsage, TranscriptRecord } from '../types.js'

/**
 * One billable API response.
 *
 * The unit matters, and it is **not** the `assistant` record. Claude Code writes one
 * `assistant` record per content block — a `thinking` block and the `tool_use` block that
 * follows it are two records — and **every one of them repeats the same `message.usage`**.
 * Summing usage per record therefore counts the same call two, three or four times. On our
 * corpus that inflates the total by **2.408×**: 61,145,338 tokens where the truth is
 * 25,390,319.
 *
 * Grouping is by `message.id`, which is the id of the API response and is present on all
 * 57,073 assistant records observed. Within a group, `input`, `cache_read` and
 * `cache_creation` are identical while `output_tokens` grows as the response streams —
 * verified monotonic across 16,004 multi-record groups, zero decreases. So the last record
 * of a group carries the complete figure, and that is the one we keep.
 */
export interface TokenEvent {
  /**
   * Stable identity for this API response, used to deduplicate. `message.id` when present.
   *
   * Deduplication has to happen **globally**, not per session: 476 message ids in our corpus
   * appear in more than one transcript file, because resuming a session copies earlier turns
   * into the new file. Counting per file and adding the files up bills those turns twice.
   */
  dedupeKey: string
  timestamp?: string
  model?: string
  /** Set for a sidechain event; `undefined` for the main transcript. */
  agentId?: string
  usage: TokenUsage
}

export interface CollectTokenEventsOptions {
  /** Tags every event, so subagent spend stays attributable after the arrays are merged. */
  agentId?: string
}

/**
 * Reduce transcript records to one event per API response.
 *
 * Records with `model: "<synthetic>"` are excluded. Those are Claude Code's own error and
 * status messages — 68 in our corpus — and they were never billed by anyone.
 */
export function collectTokenEvents(
  records: readonly TranscriptRecord[],
  options: CollectTokenEventsOptions = {},
): TokenEvent[] {
  const byKey = new Map<string, TokenEvent>()

  for (const record of records) {
    if (record.kind !== 'assistant') continue
    if (record.usage === undefined) continue
    if (record.model === SYNTHETIC_MODEL) continue

    // `messageId` is the API response id. Falling back to the record uuid keeps an
    // unidentifiable response counted once rather than dropped — under-reporting spend is
    // the one failure mode a usage meter must not have.
    const key = record.messageId ?? record.envelope.uuid
    if (key === undefined) continue

    const existing = byKey.get(key)
    // Last writer wins on a tie: within a group the records are in file order, and file
    // order is the authoritative sequence.
    if (existing !== undefined && existing.usage.outputTokens > record.usage.outputTokens) {
      continue
    }

    byKey.set(key, {
      dedupeKey: key,
      usage: record.usage,
      ...(record.envelope.timestamp !== undefined && { timestamp: record.envelope.timestamp }),
      ...(record.model !== undefined && { model: record.model }),
      ...(options.agentId !== undefined && { agentId: options.agentId }),
    })
  }

  return [...byKey.values()]
}

/** Claude Code's own status and error messages, which cost nothing. */
const SYNTHETIC_MODEL = '<synthetic>'

/** Add up events that have already been deduplicated. */
export function totalUsage(events: readonly TokenEvent[]): TokenUsage {
  const total: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
  }

  for (const event of events) {
    total.inputTokens += event.usage.inputTokens
    total.outputTokens += event.usage.outputTokens
    total.cacheReadTokens += event.usage.cacheReadTokens
    total.cacheCreationTokens += event.usage.cacheCreationTokens
    total.cacheCreation5mTokens += event.usage.cacheCreation5mTokens
    total.cacheCreation1hTokens += event.usage.cacheCreation1hTokens
  }

  return total
}
