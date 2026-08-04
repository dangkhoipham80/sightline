/**
 * Grouping a transcript into the units a human actually reads.
 *
 * A session is not a flat list of messages, and rendering it as one is why every existing
 * viewer still requires you to read thousands of lines. It is a sequence of **turns**: you
 * asked for something, and everything until you asked for the next thing is the work.
 *
 * The load-bearing detail is that Claude Code sends tool *results* back as `user` records.
 * Splitting on every user record would cut a single turn into one fragment per tool call —
 * on a real session that turns 12 turns into 300. A turn opens only on a record that
 * carries something the human typed.
 */

import type { ConversationRecord, TranscriptRecord, UserRecord } from '../types.js'
import { isConversationRecord } from '../types.js'

export interface Turn {
  /** 0-based position in the session. Stable, and what the minimap and anchors key on. */
  index: number
  /**
   * The prompt that opened the turn. Absent for the leading turn of a session that starts
   * with system bookkeeping, and for a resumed file whose first records continue earlier work.
   */
  prompt?: UserRecord
  records: ConversationRecord[]
  startedAt?: string
  endedAt?: string
  toolCallCount: number
  /** Ids of the `tool_use` blocks issued in this turn, in order. */
  toolUseIds: string[]
}

/**
 * True when a `user` record carries something a person typed.
 *
 * Tool results and meta records are also `user` records. The distinction is not cosmetic:
 * it decides where turns begin, and getting it wrong shreds the structure of the session.
 */
export function isUserPrompt(record: TranscriptRecord): record is UserRecord {
  if (record.kind !== 'user') return false
  if (record.envelope.isMeta === true) return false
  if (record.content.length === 0) return false
  // A record that is nothing but tool results is the transport for a tool's output, not a
  // prompt — whatever `type` it wears.
  return record.content.some((block) => block.type === 'text' && block.text.trim().length > 0)
}

export function groupTurns(records: readonly TranscriptRecord[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined

  for (const record of records) {
    if (!isConversationRecord(record)) continue

    if (isUserPrompt(record) || current === undefined) {
      current = {
        index: turns.length,
        ...(isUserPrompt(record) && { prompt: record }),
        records: [],
        toolCallCount: 0,
        toolUseIds: [],
      }
      turns.push(current)
    }

    current.records.push(record)

    const at = record.envelope.timestamp
    if (at !== undefined) {
      if (current.startedAt === undefined) current.startedAt = at
      current.endedAt = at
    }

    if (record.kind === 'assistant') {
      for (const block of record.content) {
        if (block.type !== 'tool_use') continue
        current.toolCallCount += 1
        current.toolUseIds.push(block.id)
      }
    }
  }

  return turns
}

/**
 * Index tool results by the `tool_use` id they answer.
 *
 * Results arrive in a *later* record than the call they belong to, so a renderer that walks
 * forward has no way to show a call and its outcome together without this.
 */
export function indexToolResults(
  records: readonly TranscriptRecord[],
): Map<string, { content: unknown; isError: boolean }> {
  const results = new Map<string, { content: unknown; isError: boolean }>()

  for (const record of records) {
    if (record.kind !== 'user') continue
    for (const block of record.content) {
      if (block.type !== 'tool_result') continue
      results.set(block.toolUseId, { content: block.content, isError: block.isError })
    }
  }

  return results
}

/**
 * Flatten a tool result's content into text.
 *
 * The field is a string on some records and an array of blocks on others, and it is the
 * single most variable shape in the format. Anything unrecognised is stringified rather
 * than dropped: an unreadable result still tells you the tool ran.
 */
export function toolResultText(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') parts.push(item)
      else if (typeof item === 'object' && item !== null && 'text' in item) {
        parts.push(String((item as { text: unknown }).text))
      } else parts.push(JSON.stringify(item))
    }
    return parts.join('\n')
  }

  return JSON.stringify(content, null, 2)
}
