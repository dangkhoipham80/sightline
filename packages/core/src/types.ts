/**
 * Domain types for Claude Code transcripts.
 *
 * These describe what we have *observed*, not what Anthropic guarantees. Every
 * optional field here is optional because a real record was found without it —
 * see `docs/TRANSCRIPT-FORMAT.md`.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }
export type JsonObject = { [k: string]: JsonValue }

/**
 * Record types we understand. Anything else parses into a `raw` record rather
 * than failing — Claude Code adds types without notice, and losing a line is
 * worse than not understanding it.
 */
export type RecordKind =
  | 'user'
  | 'assistant'
  | 'system'
  | 'summary'
  | 'ai-title'
  | 'agent-name'
  | 'last-prompt'
  | 'mode'
  | 'permission-mode'
  | 'attachment'
  | 'file-history-snapshot'
  | 'queue-operation'
  | 'pr-link'
  | 'raw'

/** Fields shared by conversation records. Bookkeeping records carry almost none of them. */
export interface Envelope {
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  /** Per-record, not per-session — it changes when the agent moves between directories. */
  cwd?: string
  gitBranch?: string
  /** Claude Code version that wrote this line. Use it to gate version-specific parsing. */
  version?: string
  isSidechain?: boolean
  agentId?: string
  slug?: string
  userType?: string
  entrypoint?: string
  isMeta?: boolean
  isCompactSummary?: boolean
}

export type ContentBlock =
  | { type: 'text'; text: string }
  /** `signature` is deliberately dropped on parse — it is long, opaque and pure token waste. */
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue }
  | { type: 'tool_result'; toolUseId: string; content: JsonValue; isError: boolean }
  | { type: 'unknown'; blockType: string; raw: JsonObject }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Total cache writes. Equals the two TTL buckets below added together. */
  cacheCreationTokens: number
  /**
   * Cache writes split by time-to-live. Kept separate because they are priced
   * differently — a 1-hour write costs roughly twice what a 5-minute one does — so a
   * meter that only has the total cannot cost it without guessing.
   */
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
}

interface RecordBase {
  /** Assignment order on read. The authoritative sequence — timestamps tie and sometimes vanish. */
  seq: number
  envelope: Envelope
  raw: JsonObject
}

export interface UserRecord extends RecordBase {
  kind: 'user'
  content: ContentBlock[]
  text: string
  promptId?: string
  promptSource?: string
  originKind?: string
}

export interface AssistantRecord extends RecordBase {
  kind: 'assistant'
  content: ContentBlock[]
  text: string
  model?: string
  messageId?: string
  stopReason?: string
  usage?: TokenUsage
  requestId?: string
}

export interface SystemRecord extends RecordBase {
  kind: 'system'
  subtype?: string
  durationMs?: number
  messageCount?: number
  text: string
}

export interface AiTitleRecord extends RecordBase {
  kind: 'ai-title'
  aiTitle: string
}

export interface LastPromptRecord extends RecordBase {
  kind: 'last-prompt'
  lastPrompt: string
  leafUuid?: string
}

export interface ModeRecord extends RecordBase {
  kind: 'mode'
  mode: string
}

export interface PermissionModeRecord extends RecordBase {
  kind: 'permission-mode'
  permissionMode: string
}

export interface SummaryRecord extends RecordBase {
  kind: 'summary'
  summary: string
  leafUuid?: string
}

/**
 * Attachments carry a `uuid` **and** a `parentUuid`, which makes them full participants
 * in the conversation graph rather than the inert metadata their name suggests. Excluding
 * them from the uuid index turns every message that follows one into a false orphan —
 * 1,345 of them across a 52-session corpus.
 */
export interface AttachmentRecord extends RecordBase {
  kind: 'attachment'
  attachmentType?: string
}

/** A user-facing name for an agent session, distinct from `ai-title`. */
export interface AgentNameRecord extends RecordBase {
  kind: 'agent-name'
  agentName: string
}

export interface FileHistorySnapshotRecord extends RecordBase {
  kind: 'file-history-snapshot'
  /**
   * Equal to the `uuid` of the message it snapshots — which is exactly why these
   * records must be excluded before building the uuid index.
   * See anthropics/claude-code#36583.
   */
  messageId?: string
  isSnapshotUpdate: boolean
}

export interface QueueOperationRecord extends RecordBase {
  kind: 'queue-operation'
  operation: string
  content: string
}

export interface PrLinkRecord extends RecordBase {
  kind: 'pr-link'
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/** A record whose `type` we don't recognise. Retained so nothing is ever silently lost. */
export interface RawRecord extends RecordBase {
  kind: 'raw'
  recordType: string
}

export type TranscriptRecord =
  | UserRecord
  | AssistantRecord
  | SystemRecord
  | SummaryRecord
  | AiTitleRecord
  | AgentNameRecord
  | LastPromptRecord
  | ModeRecord
  | PermissionModeRecord
  | AttachmentRecord
  | FileHistorySnapshotRecord
  | QueueOperationRecord
  | PrLinkRecord
  | RawRecord

/** Records a reader would think of as part of the conversation. */
export type ConversationRecord = UserRecord | AssistantRecord | SystemRecord

export function isConversationRecord(r: TranscriptRecord): r is ConversationRecord {
  return r.kind === 'user' || r.kind === 'assistant' || r.kind === 'system'
}

/**
 * Records that participate in the `parentUuid` graph.
 *
 * This is a **wider** set than `ConversationRecord`: attachments are linked into the
 * chain too. Building the graph over the narrower set is a subtle and expensive mistake —
 * it silently severs every branch that passes through an attachment.
 */
export function hasGraphIdentity(r: TranscriptRecord): boolean {
  return r.envelope.uuid !== undefined && r.kind !== 'file-history-snapshot'
}

export interface MalformedLine {
  /** 1-based line number within the source file. */
  lineNumber: number
  error: string
  /** Truncated for safety — a malformed line may be a partially written secret. */
  excerpt: string
}

export type FileOperation = 'read' | 'edit' | 'write'

export interface FileTouch {
  path: string
  op: FileOperation
  count: number
  lastSeq: number
}

export interface Artifact {
  kind: 'pr-link'
  prNumber?: number
  prUrl?: string
  prRepository?: string
  seq: number
}
