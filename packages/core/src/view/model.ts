/**
 * The shape a transcript renderer consumes.
 *
 * Everything here is plain, serialisable data: no records, no class instances, no
 * functions. That is the whole point — the server can build a view in one pass and hand
 * it to a client component across the RSC boundary without either side re-deriving it.
 *
 * The other reason to build this in `core` rather than in the app is that the awkward
 * parts are all format problems, not UI problems: pairing a `tool_use` with the
 * `tool_result` that arrives three records later, attaching a subagent transcript to the
 * `Task` call that spawned it, deciding what a "turn" is. Those deserve fixture-backed
 * tests, and fixtures live here.
 */

import { flattenText } from '../parse/content.js'
import type { ParsedSubagent } from '../parse/subagents.js'
import type { ParsedSession } from '../parse/transcript.js'
import type { JsonValue, TranscriptRecord, UserRecord } from '../types.js'
import type { FileDiff } from './diff.js'
import { diffLines } from './diff.js'
import type { ToolSummary } from './tools.js'
import { editPreviews, summariseTool } from './tools.js'
import type { Turn } from './turns.js'
import { groupTurns, indexToolResults, toolResultText } from './turns.js'

/**
 * A single `Read` result can be longer than the rest of the conversation put together,
 * and the whole view crosses a serialisation boundary. Text is clipped here rather than
 * in CSS so the payload is bounded too — a clipped body that still ships 400 KB of it
 * has solved the wrong half of the problem.
 */
export const TEXT_LIMIT = 20_000
export const RESULT_LIMIT = 8_000

/** Beyond this a diff is noise; the stat line still tells the truth about its size. */
export const DIFF_LINE_LIMIT = 600

export interface ClippedText {
  text: string
  /** Characters dropped from the end. Zero when the text is whole. */
  clipped: number
}

export interface DiffView {
  filePath: string
  /** Set when one call carried several edits. */
  label?: string
  diff: FileDiff
  /** Hunks past `DIFF_LINE_LIMIT` were dropped; `diff.stat` still counts the whole change. */
  clipped: boolean
}

export interface ToolResultView {
  body: ClippedText
  isError: boolean
}

export type StepView =
  | { id: string; type: 'prose'; role: 'assistant' | 'user'; body: ClippedText }
  | { id: string; type: 'thinking'; body: ClippedText }
  | { id: string; type: 'system'; subtype?: string; body: ClippedText }
  | {
      id: string
      type: 'tool'
      summary: ToolSummary
      /** The call's raw arguments, for the "show input" escape hatch. */
      input: ClippedText
      result?: ToolResultView
      diffs?: DiffView[]
      subagents?: SubagentView[]
    }

export interface SubagentView {
  agentId: string
  agentType?: string
  description?: string
  messageCount: number
  startedAt?: string
  endedAt?: string
  steps: StepView[]
}

export interface TurnView {
  index: number
  /** What the human typed. Absent for a turn the session opened with rather than a prompt. */
  prompt?: ClippedText
  startedAt?: string
  endedAt?: string
  durationMs?: number
  steps: StepView[]
  toolCallCount: number
  /** Files this turn wrote to, deduplicated, for the collapsed header. */
  filesTouched: string[]
  subagentCount: number
}

/**
 * Why a subagent renders on its own instead of beside the call that started it.
 *
 * The two causes look identical in the data and mean opposite things, so they are kept
 * apart rather than explained with one sentence that is right about half of them.
 */
export type UnattachedReason =
  /**
   * There was never a spawning `tool_use` — the agent's `meta.json` carries no
   * `toolUseId`. Workflow-spawned agents are all of this kind and are the only kind
   * observed: 177 of 177 workflow agents lack the field, against 205 of 205 `Task`-spawned
   * agents that carry it.
   */
  | 'no-spawning-call'
  /**
   * There was one, and it is not in this file. The usual cause is a session resumed after
   * its agents finished, leaving the spawning turn in an earlier transcript.
   */
  | 'spawning-call-elsewhere'

export interface UnattachedSubagentView extends SubagentView {
  reason: UnattachedReason
}

export interface TranscriptView {
  sessionId: string
  turns: TurnView[]
  /**
   * Subagents with no spawning call to sit beside. Shown at the end rather than dropped:
   * the work happened, and the alternative is a viewer that silently loses it.
   */
  unattachedSubagents: UnattachedSubagentView[]
  toolCallCount: number
  malformedCount: number
}

export function buildTranscriptView(parsed: ParsedSession): TranscriptView {
  const results = indexToolResults(parsed.records)

  // Subagents attach to the `tool_use` id of the `Task` call that spawned them, and one
  // call can spawn several.
  const byParentToolUse = new Map<string, ParsedSubagent[]>()
  for (const subagent of parsed.subagents) {
    const parent = subagent.parentToolUseId
    if (parent === undefined) continue
    const existing = byParentToolUse.get(parent)
    if (existing === undefined) byParentToolUse.set(parent, [subagent])
    else existing.push(subagent)
  }

  const unattached = new Set(parsed.unattachedSubagentIds)
  const turns = groupTurns(parsed.records).map((turn) =>
    buildTurn(turn, results, byParentToolUse, unattached),
  )

  return {
    sessionId: parsed.summary.sessionId,
    turns,
    unattachedSubagents: parsed.subagents
      .filter((a) => unattached.has(a.agentId))
      .map((a) => ({
        ...buildSubagent(a),
        reason:
          a.parentToolUseId === undefined
            ? ('no-spawning-call' as const)
            : ('spawning-call-elsewhere' as const),
      })),
    toolCallCount: turns.reduce((sum, turn) => sum + turn.toolCallCount, 0),
    malformedCount: parsed.summary.malformed.length,
  }
}

type ResultIndex = ReturnType<typeof indexToolResults>

function buildTurn(
  turn: Turn,
  results: ResultIndex,
  byParentToolUse: Map<string, ParsedSubagent[]>,
  unattached: ReadonlySet<string>,
): TurnView {
  const steps = buildSteps(turn.records, results, byParentToolUse, unattached)

  const filesTouched: string[] = []
  let subagentCount = 0
  for (const step of steps) {
    if (step.type !== 'tool') continue
    subagentCount += step.subagents?.length ?? 0
    for (const diff of step.diffs ?? []) {
      if (!filesTouched.includes(diff.filePath)) filesTouched.push(diff.filePath)
    }
  }

  const durationMs = span(turn.startedAt, turn.endedAt)

  return {
    index: turn.index,
    ...(turn.prompt !== undefined && { prompt: clip(promptText(turn.prompt), TEXT_LIMIT) }),
    ...(turn.startedAt !== undefined && { startedAt: turn.startedAt }),
    ...(turn.endedAt !== undefined && { endedAt: turn.endedAt }),
    ...(durationMs !== undefined && { durationMs }),
    steps,
    toolCallCount: turn.toolCallCount,
    filesTouched,
    subagentCount,
  }
}

function buildSubagent(subagent: ParsedSubagent): SubagentView {
  // A subagent's own transcript has no user prompts to group on — everything after the
  // opening instruction is one continuous stretch of work — so it renders as a flat run
  // of steps rather than as turns.
  const results = indexToolResults(subagent.records)

  return {
    agentId: subagent.agentId,
    ...(subagent.agentType !== undefined && { agentType: subagent.agentType }),
    ...(subagent.description !== undefined && { description: subagent.description }),
    messageCount: subagent.messageCount,
    ...(subagent.startedAt !== undefined && { startedAt: subagent.startedAt }),
    ...(subagent.endedAt !== undefined && { endedAt: subagent.endedAt }),
    steps: buildSteps(subagent.records, results, new Map(), new Set()),
  }
}

function buildSteps(
  records: readonly TranscriptRecord[],
  results: ResultIndex,
  byParentToolUse: Map<string, ParsedSubagent[]>,
  unattached: ReadonlySet<string>,
): StepView[] {
  const steps: StepView[] = []

  for (const record of records) {
    if (record.kind === 'system') {
      const body = record.text.trim()
      if (body.length === 0) continue
      steps.push({
        id: stepId(record, steps.length),
        type: 'system',
        ...(record.subtype !== undefined && { subtype: record.subtype }),
        body: clip(body, TEXT_LIMIT),
      })
      continue
    }

    if (record.kind !== 'user' && record.kind !== 'assistant') continue

    for (const [position, block] of record.content.entries()) {
      switch (block.type) {
        case 'text': {
          const body = block.text.trim()
          // A user record's text is the prompt that opened the turn; it is rendered as
          // the turn header, and repeating it as a step would show it twice.
          if (body.length === 0 || record.kind === 'user') break
          steps.push({
            id: stepId(record, position),
            type: 'prose',
            role: 'assistant',
            body: clip(body, TEXT_LIMIT),
          })
          break
        }

        case 'thinking': {
          const body = block.thinking.trim()
          if (body.length === 0) break
          steps.push({
            id: stepId(record, position),
            type: 'thinking',
            body: clip(body, TEXT_LIMIT),
          })
          break
        }

        case 'tool_use': {
          const result = results.get(block.id)
          const spawned = (byParentToolUse.get(block.id) ?? []).filter(
            (a) => !unattached.has(a.agentId),
          )
          const diffs = buildDiffs(block.name, block.input)

          steps.push({
            id: block.id.length > 0 ? block.id : stepId(record, position),
            type: 'tool',
            summary: summariseTool(block.name, block.input),
            input: clip(stringifyInput(block.input), RESULT_LIMIT),
            ...(result !== undefined && {
              result: {
                body: clip(toolResultText(result.content).trim(), RESULT_LIMIT),
                isError: result.isError,
              },
            }),
            ...(diffs !== undefined && { diffs }),
            ...(spawned.length > 0 && { subagents: spawned.map(buildSubagent) }),
          })
          break
        }

        default:
          // `tool_result` blocks are consumed by the index and rendered under their call;
          // `unknown` blocks are a type we haven't met yet and have nothing to show.
          break
      }
    }
  }

  return steps
}

function buildDiffs(name: string, input: JsonValue): DiffView[] | undefined {
  const previews = editPreviews(name, input)
  if (previews === undefined) return undefined

  return previews.map((preview) => {
    const full = diffLines(preview.before, preview.after)

    let kept = 0
    const hunks: typeof full.hunks = []
    for (const hunk of full.hunks) {
      if (kept + hunk.lines.length > DIFF_LINE_LIMIT) break
      hunks.push(hunk)
      kept += hunk.lines.length
    }

    return {
      filePath: preview.filePath,
      ...(preview.label !== undefined && { label: preview.label }),
      diff: { hunks, stat: full.stat },
      clipped: hunks.length < full.hunks.length,
    }
  })
}

/**
 * A prompt's displayable text.
 *
 * Slash commands arrive wrapped in `<command-name>`/`<command-args>` tags with the
 * expansion inline, which is machinery the reader did not type. Showing the tags verbatim
 * buries the one line that matters.
 */
function promptText(record: UserRecord): string {
  const text = flattenText(record.content)
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command === null) return text

  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)
  const name = (command[1] ?? '').trim()
  const argText = (args?.[1] ?? '').trim()
  return argText.length > 0 ? `${name} ${argText}` : name
}

function stringifyInput(input: JsonValue): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input, null, 2) ?? ''
}

function clip(text: string, limit: number): ClippedText {
  if (text.length <= limit) return { text, clipped: 0 }
  return { text: text.slice(0, limit), clipped: text.length - limit }
}

/** Stable within a render, and stable across renders because `seq` is assignment order. */
function stepId(record: TranscriptRecord, position: number): string {
  return `${record.envelope.uuid ?? `seq-${record.seq}`}:${position}`
}

function span(from: string | undefined, to: string | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
  return end - start
}
