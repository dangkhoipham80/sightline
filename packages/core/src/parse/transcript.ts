import type { TranscriptRecord } from '../types.js'
import { parseRecords } from './records.js'
import type { SessionSummary } from './session.js'
import { deriveSessionSummary } from './session.js'
import type { ParsedSubagent, SubagentInput } from './subagents.js'
import { parseSubagent } from './subagents.js'
import { collectTokenEvents, totalUsage } from './tokens.js'
import type { MessageTree } from './tree.js'
import { buildMessageTree } from './tree.js'

export interface ParseSessionInput {
  /** The uuid from the transcript's filename — authoritative for session identity. */
  sessionId: string
  lines: Iterable<string>
  /** Sibling `subagents/agent-*.jsonl` files. The caller does the globbing. */
  subagents?: readonly SubagentInput[]
}

export interface ParsedSession {
  summary: SessionSummary
  records: TranscriptRecord[]
  tree: MessageTree
  subagents: ParsedSubagent[]
  /**
   * Subagents whose `parentToolUseId` matches no `tool_use` block in the main
   * transcript. Not an error — a session can be resumed after its subagents ran, leaving
   * the spawning turn in an earlier file — but worth surfacing so the UI can still show
   * the work instead of hiding it.
   */
  unattachedSubagentIds: string[]
}

/**
 * Parse one complete session: the main transcript plus its subagent sidechains.
 *
 * This is the entry point ingest uses. It never throws — malformed lines are counted and
 * reported on the summary, because transcripts of live sessions routinely end mid-line.
 */
export function parseSession(input: ParseSessionInput): ParsedSession {
  const { records, malformed } = parseRecords(input.lines)
  const tree = buildMessageTree(records)
  const summary = deriveSessionSummary(records, {
    fileSessionId: input.sessionId,
    malformed,
  })

  const subagents = (input.subagents ?? []).map(parseSubagent)

  const toolUseIds = new Set<string>()
  for (const record of records) {
    if (record.kind !== 'assistant') continue
    for (const block of record.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
    }
  }

  const unattachedSubagentIds = subagents
    .filter((a) => a.parentToolUseId === undefined || !toolUseIds.has(a.parentToolUseId))
    .map((a) => a.agentId)

  // Subagent tokens are session tokens. `deriveSessionSummary` only sees the main
  // transcript, so on its own it reports a session that delegated as having spent almost
  // nothing — and delegating is exactly when a session spends most. The events are keyed by
  // `message.id`, so merging and re-deduplicating is safe even if a response somehow
  // appeared in both files.
  const events = [...summary.tokenEvents]
  const seen = new Set(events.map((e) => e.dedupeKey))
  for (const agent of subagents) {
    for (const event of collectTokenEvents(agent.records, { agentId: agent.agentId })) {
      if (seen.has(event.dedupeKey)) continue
      seen.add(event.dedupeKey)
      events.push(event)
    }
  }
  summary.tokenEvents = events
  summary.usage = totalUsage(events)

  return { summary, records, tree, subagents, unattachedSubagentIds }
}
