import { subagentMetaSchema } from '../schemas.js'
import type { MalformedLine, TranscriptRecord } from '../types.js'
import { parseRecords } from './records.js'
import type { MessageTree } from './tree.js'
import { buildMessageTree } from './tree.js'

export interface SubagentInput {
  /** From the filename: `agent-<agentId>.jsonl`. */
  agentId: string
  /** Contents of the sibling `agent-<agentId>.meta.json`, already JSON-parsed. */
  meta?: unknown
  lines: Iterable<string>
}

export interface ParsedSubagent {
  agentId: string
  agentType?: string
  description?: string
  /** Joins back to the `tool_use` block in the parent transcript that spawned this agent. */
  parentToolUseId?: string
  /** 1 for a directly spawned agent; agents spawn agents. */
  spawnDepth: number
  records: TranscriptRecord[]
  tree: MessageTree
  messageCount: number
  startedAt?: string
  endedAt?: string
  malformed: MalformedLine[]
}

/**
 * Parse one subagent transcript.
 *
 * Subagent work is **not** inline in the main transcript — it lives in
 * `<session>/subagents/agent-*.jsonl`, with every line marked `isSidechain: true`.
 * A parser that only reads the top-level file misses most of what was actually done,
 * which is the single most consequential omission a viewer can make.
 *
 * I/O is the caller's job: this takes lines and already-parsed metadata so that
 * `@sightline/core` stays free of filesystem dependencies and can be tested against
 * fixtures without setup.
 */
export function parseSubagent(input: SubagentInput): ParsedSubagent {
  const { records, malformed } = parseRecords(input.lines)
  const tree = buildMessageTree(records)

  const metaParsed = subagentMetaSchema.safeParse(input.meta ?? {})
  const meta = metaParsed.success ? metaParsed.data : {}

  let startedAt: string | undefined
  let endedAt: string | undefined
  let messageCount = 0

  for (const record of records) {
    if (record.kind === 'user' || record.kind === 'assistant' || record.kind === 'system') {
      messageCount += 1
    }
    const ts = record.envelope.timestamp
    if (ts === undefined) continue
    if (startedAt === undefined || ts < startedAt) startedAt = ts
    if (endedAt === undefined || ts > endedAt) endedAt = ts
  }

  return {
    agentId: input.agentId,
    spawnDepth: meta.spawnDepth ?? 1,
    ...(meta.agentType !== undefined && { agentType: meta.agentType }),
    ...(meta.description !== undefined && { description: meta.description }),
    ...(meta.toolUseId !== undefined && { parentToolUseId: meta.toolUseId }),
    ...(startedAt !== undefined && { startedAt }),
    ...(endedAt !== undefined && { endedAt }),
    records,
    tree,
    messageCount,
    malformed,
  }
}

/** Extract the agent id from a subagent filename, or null if it isn't one. */
export function agentIdFromFilename(filename: string): string | null {
  const match = /^agent-([^.]+)\.jsonl$/.exec(filename)
  return match?.[1] ?? null
}
