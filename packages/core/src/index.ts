/**
 * `@sightline/core` — the domain layer.
 *
 * Everything that understands Claude Code's on-disk format lives here, and nothing here
 * touches a database, a network, or a filesystem. Callers hand in lines; this package
 * hands back structure. That purity is what lets the parser be tested exhaustively
 * against real transcript fixtures, and it is a constraint worth defending.
 *
 * See `docs/TRANSCRIPT-FORMAT.md` for the reverse-engineered spec this implements.
 */

export { PRODUCT_NAME, SIGHTLINE_SCHEMA_VERSION } from './constants.js'
export type {
  LaunchMode,
  LaunchPlatform,
  LaunchStore,
  ResumeCommandOptions,
  SpawnPlan,
  SpawnPlanFailure,
  SpawnPlanOptions,
  SpawnPlanResult,
} from './launch.js'
export { buildSpawnPlan, parseLaunchStore, resumeCommand } from './launch.js'
export { flattenText, hasThinking, normaliseContent, toolUseBlocks } from './parse/content.js'
export type { Lineage, LineageMember } from './parse/lineage.js'
export { linkLineages } from './parse/lineage.js'
export type { ParseRecordsResult } from './parse/records.js'
export { parseRecords } from './parse/records.js'
export type { DeriveSessionOptions, SessionSummary } from './parse/session.js'
export { deriveSessionSummary } from './parse/session.js'
export type { ParsedSubagent, SubagentInput } from './parse/subagents.js'
export { agentIdFromFilename, parseSubagent } from './parse/subagents.js'
export type { CollectTokenEventsOptions, TokenEvent } from './parse/tokens.js'
export { collectTokenEvents, totalUsage } from './parse/tokens.js'
export type { ParsedSession, ParseSessionInput } from './parse/transcript.js'
export { parseSession } from './parse/transcript.js'
export type { MessageNode, MessageTree } from './parse/tree.js'
export { buildMessageTree, flattenTree } from './parse/tree.js'
export type { HostKind, HostPath } from './paths.js'
export {
  encodeProjectFolderKey,
  isSameOrDescendant,
  matchHostPath,
  normalisePathForComparison,
  parseHostPath,
  toWslUnc,
} from './paths.js'
export { quotePosix, quotePowerShell } from './shell.js'
export type {
  AgentNameRecord,
  Artifact,
  ArtifactLedgerRecord,
  AssistantRecord,
  AtisLatchRecord,
  AttachmentRecord,
  BridgeSessionRecord,
  ContentBlock,
  ConversationRecord,
  Envelope,
  FileOperation,
  FileTouch,
  FrameLinkRecord,
  JsonObject,
  JsonValue,
  MalformedLine,
  RecordKind,
  SystemRecord,
  TokenUsage,
  TranscriptRecord,
  UserRecord,
} from './types.js'
export { hasGraphIdentity, isConversationRecord } from './types.js'
export type { GroupIntoBlocksOptions, UsageBlock } from './usage/blocks.js'
export { activeBlock, BLOCK_HOURS, groupIntoBlocks } from './usage/blocks.js'
export type {
  Confidence,
  EstimatedWindow,
  MeterWindow,
  OfficialWindow,
  RateLimitReading,
  RateLimitWindow,
  UnknownWindow,
} from './usage/meter.js'
export { isPlausiblePercentage } from './usage/meter.js'
export type { CostBreakdown, ModelPricing, PricingTable } from './usage/pricing.js'
export { costByModel, costUsage } from './usage/pricing.js'
export type { DiffHunk, DiffLine, DiffLineKind, DiffStat, FileDiff } from './view/diff.js'
export { diffLines } from './view/diff.js'
export type { MessageLocation } from './view/locate.js'
export { locateMessage } from './view/locate.js'
export type {
  ClippedText,
  DiffView,
  StepView,
  SubagentView,
  ToolResultView,
  TranscriptView,
  TurnView,
  UnattachedReason,
  UnattachedSubagentView,
} from './view/model.js'
export { buildTranscriptView, DIFF_LINE_LIMIT, RESULT_LIMIT, TEXT_LIMIT } from './view/model.js'
export type { EditPreview, ToolKind, ToolSummary } from './view/tools.js'
export { editPreviews, summariseTool, truncateMiddle } from './view/tools.js'
export type { Turn } from './view/turns.js'
export { groupTurns, indexToolResults, isUserPrompt, toolResultText } from './view/turns.js'
