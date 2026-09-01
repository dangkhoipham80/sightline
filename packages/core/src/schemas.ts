/**
 * Zod schemas for Claude Code's transcript records.
 *
 * Every schema is `looseObject` — unknown keys pass through untouched. That is
 * deliberate: Claude Code adds fields between releases, and a schema that rejects
 * them would break users on the next CLI update. The parser's contract is "never
 * throw on real input", and these schemas exist to *describe* what we can use,
 * not to *police* what is allowed.
 */

import { z } from 'zod'

export const envelopeSchema = z.looseObject({
  uuid: z.string().optional(),
  parentUuid: z.string().nullish(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  isSidechain: z.boolean().optional(),
  agentId: z.string().optional(),
  slug: z.string().optional(),
  userType: z.string().optional(),
  entrypoint: z.string().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
})

const textBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
})

const thinkingBlockSchema = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string().catch(''),
  // `signature` is intentionally not surfaced — see ContentBlock in types.ts.
})

const toolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
})

/** Union order matters: the catch-all must come last. */
export const contentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  z.looseObject({ type: z.string() }),
])

/** Content is a bare string on typed prompts and an array of blocks otherwise. */
export const messageContentSchema = z.union([z.string(), z.array(contentBlockSchema)])

export const usageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
})

export const userMessageSchema = z.looseObject({
  role: z.string().optional(),
  content: messageContentSchema,
})

export const assistantMessageSchema = z.looseObject({
  role: z.string().optional(),
  id: z.string().optional(),
  model: z.string().optional(),
  content: messageContentSchema,
  stop_reason: z.string().nullish(),
  usage: usageSchema.optional(),
})

export const userRecordSchema = z.looseObject({
  type: z.literal('user'),
  message: userMessageSchema,
  promptId: z.string().optional(),
  promptSource: z.string().optional(),
  origin: z.looseObject({ kind: z.string().optional() }).optional(),
})

export const assistantRecordSchema = z.looseObject({
  type: z.literal('assistant'),
  message: assistantMessageSchema,
  requestId: z.string().optional(),
})

export const systemRecordSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.string().optional(),
  durationMs: z.number().optional(),
  messageCount: z.number().optional(),
  content: z.string().optional(),
})

export const aiTitleRecordSchema = z.looseObject({
  type: z.literal('ai-title'),
  aiTitle: z.string(),
})

export const agentNameRecordSchema = z.looseObject({
  type: z.literal('agent-name'),
  agentName: z.string(),
})

export const lastPromptRecordSchema = z.looseObject({
  type: z.literal('last-prompt'),
  lastPrompt: z.string(),
  leafUuid: z.string().optional(),
})

export const modeRecordSchema = z.looseObject({
  type: z.literal('mode'),
  mode: z.string(),
})

export const permissionModeRecordSchema = z.looseObject({
  type: z.literal('permission-mode'),
  permissionMode: z.string(),
})

export const summaryRecordSchema = z.looseObject({
  type: z.literal('summary'),
  summary: z.string(),
  leafUuid: z.string().optional(),
})

export const attachmentRecordSchema = z.looseObject({
  type: z.literal('attachment'),
  attachment: z.looseObject({ type: z.string().optional() }).optional(),
})

export const fileHistorySnapshotRecordSchema = z.looseObject({
  type: z.literal('file-history-snapshot'),
  messageId: z.string().optional(),
  isSnapshotUpdate: z.boolean().optional(),
})

export const queueOperationRecordSchema = z.looseObject({
  type: z.literal('queue-operation'),
  operation: z.string(),
  content: z.string().catch(''),
})

export const prLinkRecordSchema = z.looseObject({
  type: z.literal('pr-link'),
  prNumber: z.number().optional(),
  prUrl: z.string().optional(),
  prRepository: z.string().optional(),
})

/*
 * The five record types below all appeared together in the WSL store, first written by
 * `2.1.238`. None of them carries a `uuid`, so none of them was ever at risk of severing
 * the conversation graph the way `attachment` was (trap 1) — but all 306 of them landed in
 * `raw`, which is a slow leak of the thing we exist to prevent: work we can see but cannot
 * describe.
 */

/**
 * Emitted once per turn while a session is bridged to claude.ai. `atis` was the empty
 * string in all 141 records observed, so its meaning is genuinely unknown — the schema
 * says "a string is here", not "this is what it means".
 */
export const atisLatchRecordSchema = z.looseObject({
  type: z.literal('atis-latch'),
  atis: z.string(),
})

/**
 * Ties a local session to its claude.ai counterpart.
 *
 * `ownerAccountUuid` and `ownerOrganizationUuid` are deliberately *not* surfaced. They are
 * stable account identifiers rather than session data, they are of no use to a transcript
 * viewer, and the moment they enter the domain model they enter the database and the
 * export path too. Reading a field is a decision to be responsible for it.
 */
export const bridgeSessionRecordSchema = z.looseObject({
  type: z.literal('bridge-session'),
  bridgeSessionId: z.string().optional(),
  lastSequenceNum: z.number().optional(),
})

/**
 * A claude.ai artifact produced by the session. Only 1 of the 9 observed records carried
 * `path` / `frameUrl` / `title`; the other 8 were the bare `artifactCount` + `timestamp`
 * form, which is why all three are optional.
 */
export const frameLinkRecordSchema = z.looseObject({
  type: z.literal('frame-link'),
  path: z.string().optional(),
  frameUrl: z.string().optional(),
  title: z.string().optional(),
  artifactCount: z.number().optional(),
})

/** Both artifact ledgers key their state by artifact id, and both carry a schema `v`. */
const artifactLedgerShape = {
  v: z.number().optional(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
}

export const artifactCommentMonitorRecordSchema = z.looseObject({
  type: z.literal('artifact-comment-monitor'),
  ...artifactLedgerShape,
})

export const artifactAutoreactLedgerRecordSchema = z.looseObject({
  type: z.literal('artifact-autoreact-ledger'),
  ...artifactLedgerShape,
})

/** Metadata written alongside each subagent transcript. */
export const subagentMetaSchema = z.looseObject({
  agentType: z.string().optional(),
  description: z.string().optional(),
  /** Joins back to the `tool_use` block in the parent transcript that spawned this agent. */
  toolUseId: z.string().optional(),
  spawnDepth: z.number().optional(),
})

export type SubagentMeta = z.infer<typeof subagentMetaSchema>
