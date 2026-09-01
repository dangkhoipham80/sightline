import type {
  Artifact,
  FileOperation,
  FileTouch,
  JsonValue,
  MalformedLine,
  TokenUsage,
  TranscriptRecord,
} from '../types.js'
import { toolUseBlocks } from './content.js'
import type { TokenEvent } from './tokens.js'
import { collectTokenEvents, totalUsage } from './tokens.js'

export interface SessionSummary {
  /**
   * The session's own id, taken from the **filename** — which is authoritative.
   * Records inside may carry a different `sessionId`; see `continuesSessionId`.
   */
  sessionId: string
  /** `sessionId` as written in the first record. */
  declaredSessionId?: string
  /**
   * Set when the first record's `sessionId` differs from the filename's, which means
   * this file continues an earlier session (a `--resume`, or a post-compaction restart).
   * Without following this, one continuous stretch of work renders as several
   * unrelated sessions.
   */
  continuesSessionId?: string

  /** Claude Code's own name for the session — the last `ai-title` wins, as it is rewritten. */
  aiTitle?: string
  lastPrompt?: string
  slug?: string
  gitBranch?: string
  /** Claude Code version, from the last record that declared one. */
  version?: string

  /** Every distinct working directory seen, in first-seen order. Sessions do move around. */
  cwds: string[]
  startedAt?: string
  endedAt?: string

  recordCount: number
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number

  models: string[]
  /**
   * Totals over `tokenEvents`, **not** over records.
   *
   * For a whole session this is the union of the main transcript and every subagent —
   * `parseSession` folds the sidechains in. Sidechain spend is real spend, and a workflow
   * run can put more of it in the subagent files than in the transcript that spawned them.
   */
  usage: TokenUsage
  /** One entry per API response, already deduplicated within this session. */
  tokenEvents: TokenEvent[]
  /** Wall-clock per turn, from `system`/`turn_duration` records. */
  turnDurationsMs: number[]

  fileTouches: FileTouch[]
  artifacts: Artifact[]
  /** Prompts typed while Claude was still working — often the user's real intent. */
  queuedPrompts: string[]

  malformed: MalformedLine[]
}

export interface DeriveSessionOptions {
  /** The uuid in the transcript's filename. Authoritative for session identity. */
  fileSessionId: string
  malformed?: readonly MalformedLine[]
}

/**
 * Derive everything that can be known about a session without an LLM.
 *
 * This is deliberately substantial: title, files touched, tools used, branch, duration,
 * token cost and linked PRs all come free from the transcript. A large share of
 * "what happened here?" is answerable before any model runs, and anything answerable
 * for free should never cost a token.
 */
export function deriveSessionSummary(
  records: readonly TranscriptRecord[],
  options: DeriveSessionOptions,
): SessionSummary {
  const cwds: string[] = []
  const models: string[] = []
  const turnDurationsMs: number[] = []
  const queuedPrompts: string[] = []
  const artifacts: Artifact[] = []
  const touchesByKey = new Map<string, FileTouch>()

  // Deliberately computed up front rather than accumulated in the loop below. Usage is a
  // property of an API *response*, and one response is written as several `assistant`
  // records that each repeat it — see `collectTokenEvents`. Adding it up per record
  // over-counts by 2.4×.
  const tokenEvents = collectTokenEvents(records)
  const usage: TokenUsage = totalUsage(tokenEvents)

  let declaredSessionId: string | undefined
  let aiTitle: string | undefined
  let lastPrompt: string | undefined
  let slug: string | undefined
  let gitBranch: string | undefined
  let version: string | undefined
  let startedAt: string | undefined
  let endedAt: string | undefined

  let messageCount = 0
  let userMessageCount = 0
  let assistantMessageCount = 0
  let toolCallCount = 0

  for (const record of records) {
    const env = record.envelope

    if (declaredSessionId === undefined && env.sessionId !== undefined) {
      declaredSessionId = env.sessionId
    }
    if (env.cwd !== undefined && !cwds.includes(env.cwd)) cwds.push(env.cwd)
    if (env.slug !== undefined) slug = env.slug
    if (env.gitBranch !== undefined) gitBranch = env.gitBranch
    if (env.version !== undefined) version = env.version

    if (env.timestamp !== undefined) {
      if (startedAt === undefined || env.timestamp < startedAt) startedAt = env.timestamp
      if (endedAt === undefined || env.timestamp > endedAt) endedAt = env.timestamp
    }

    switch (record.kind) {
      case 'user': {
        // Tool results arrive as `user` records; they aren't things the human said.
        const isToolResultOnly =
          record.content.length > 0 && record.content.every((b) => b.type === 'tool_result')
        messageCount += 1
        if (!isToolResultOnly && env.isMeta !== true) userMessageCount += 1
        break
      }

      case 'assistant': {
        messageCount += 1
        assistantMessageCount += 1
        if (record.model !== undefined && !models.includes(record.model)) models.push(record.model)
        for (const block of toolUseBlocks(record.content)) {
          toolCallCount += 1
          const touch = readFileTouch(block.name, block.input)
          if (touch !== null) accumulateTouch(touchesByKey, touch, record.seq)
        }
        break
      }

      case 'system': {
        messageCount += 1
        if (record.subtype === 'turn_duration' && record.durationMs !== undefined) {
          turnDurationsMs.push(record.durationMs)
        }
        break
      }

      case 'ai-title':
        aiTitle = record.aiTitle
        break

      // A `last-prompt` record without `lastPrompt` omits the text; it does not assert that
      // there was no prompt. Two sessions in our corpus end on one — a `/clear` writes the
      // bare form as the file's last record — so assigning it straight through would erase a
      // prompt we had already read. Note that this only became reachable when the field was
      // made optional: while it was required, the record fell into `raw` and never got here.
      case 'last-prompt':
        if (record.lastPrompt !== undefined) lastPrompt = record.lastPrompt
        break

      case 'queue-operation':
        if (record.operation === 'enqueue' && record.content.length > 0) {
          queuedPrompts.push(record.content)
        }
        break

      case 'pr-link':
        artifacts.push({
          kind: 'pr-link',
          seq: record.seq,
          ...(record.prNumber !== undefined && { prNumber: record.prNumber }),
          ...(record.prUrl !== undefined && { prUrl: record.prUrl }),
          ...(record.prRepository !== undefined && { prRepository: record.prRepository }),
        })
        break

      // Most `frame-link` records are a bare count with no url — an artifact was updated,
      // not published. Only the ones that name the artifact are worth listing.
      case 'frame-link':
        if (record.frameUrl === undefined) break
        artifacts.push({
          kind: 'frame-link',
          seq: record.seq,
          frameUrl: record.frameUrl,
          ...(record.title !== undefined && { title: record.title }),
        })
        break

      default:
        break
    }
  }

  const continuesSessionId =
    declaredSessionId !== undefined && declaredSessionId !== options.fileSessionId
      ? declaredSessionId
      : undefined

  return {
    sessionId: options.fileSessionId,
    ...(declaredSessionId !== undefined && { declaredSessionId }),
    ...(continuesSessionId !== undefined && { continuesSessionId }),
    ...(aiTitle !== undefined && { aiTitle }),
    ...(lastPrompt !== undefined && { lastPrompt }),
    ...(slug !== undefined && { slug }),
    ...(gitBranch !== undefined && { gitBranch }),
    ...(version !== undefined && { version }),
    ...(startedAt !== undefined && { startedAt }),
    ...(endedAt !== undefined && { endedAt }),
    cwds,
    recordCount: records.length,
    messageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    models,
    usage,
    tokenEvents,
    turnDurationsMs,
    // Sorted by path then operation so the order is stable across runs — the same file
    // is routinely read *and* edited in one session, and Map insertion order would make
    // the result depend on which happened first.
    fileTouches: [...touchesByKey.values()].sort(
      (a, b) => a.path.localeCompare(b.path) || a.op.localeCompare(b.op),
    ),
    artifacts,
    queuedPrompts,
    malformed: [...(options.malformed ?? [])],
  }
}

const TOOL_OPERATIONS: Record<string, FileOperation> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
}

/**
 * Map a tool call to the file it acted on. This is what powers "what did Claude actually
 * change" — the question users ask first and no transcript viewer answers directly.
 */
function readFileTouch(
  toolName: string,
  input: JsonValue,
): { path: string; op: FileOperation } | null {
  const op = TOOL_OPERATIONS[toolName]
  if (op === undefined) return null
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null

  const candidate = input.file_path ?? input.notebook_path ?? input.path
  if (typeof candidate !== 'string' || candidate.length === 0) return null

  return { path: candidate, op }
}

function accumulateTouch(
  map: Map<string, FileTouch>,
  touch: { path: string; op: FileOperation },
  seq: number,
): void {
  const key = `${touch.op}\u0000${touch.path}`
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, { path: touch.path, op: touch.op, count: 1, lastSeq: seq })
    return
  }
  existing.count += 1
  existing.lastSeq = seq
}
