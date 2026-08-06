/**
 * Finding where a message lives, so a search result can be clicked.
 *
 * A search hit is a message uuid. The viewer's anchors are turns. Bridging the two is not
 * quite a lookup, because a hit can land in a **subagent** transcript — a different file,
 * with its own records, whose only tie to the main thread is the `tool_use` id of the call
 * that spawned it. A viewer that only searched the main thread would silently fail to
 * find most of what happened in any session that delegated.
 */

import type { ParsedSession } from '../parse/transcript.js'
import { groupTurns } from './turns.js'

export interface MessageLocation {
  /** Index into `TranscriptView.turns` — the anchor the page scrolls to. */
  turnIndex: number
  /** Set when the message is inside a subagent's transcript rather than the main thread. */
  agentId?: string
}

/**
 * Locate a message uuid within a session, or undefined when it is not in this file.
 *
 * Undefined is a normal answer: the index outlives the transcript, and a link can be
 * older than the file it points into.
 */
export function locateMessage(parsed: ParsedSession, uuid: string): MessageLocation | undefined {
  const turns = groupTurns(parsed.records)

  for (const turn of turns) {
    for (const record of turn.records) {
      if (record.envelope.uuid === uuid) return { turnIndex: turn.index }
    }
  }

  // Not in the main thread. It may be in a sidechain, in which case the reader wants the
  // turn that *spawned* that agent — the subagent's own records have no anchor of their own.
  for (const subagent of parsed.subagents) {
    const hit = subagent.records.some((record) => record.envelope.uuid === uuid)
    if (!hit) continue

    const parent = subagent.parentToolUseId
    if (parent === undefined) return { turnIndex: 0, agentId: subagent.agentId }

    const turn = turns.find((t) => t.toolUseIds.includes(parent))
    // A subagent whose spawning call is in an earlier file has no turn to point at. The
    // viewer renders those in a trailing section, so turn 0 is wrong but harmless — the
    // agentId is what the caller needs to find it.
    return turn === undefined
      ? { turnIndex: turns.length, agentId: subagent.agentId }
      : { turnIndex: turn.index, agentId: subagent.agentId }
  }

  return undefined
}
