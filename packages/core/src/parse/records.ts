import {
  agentNameRecordSchema,
  aiTitleRecordSchema,
  assistantRecordSchema,
  attachmentRecordSchema,
  envelopeSchema,
  fileHistorySnapshotRecordSchema,
  lastPromptRecordSchema,
  modeRecordSchema,
  permissionModeRecordSchema,
  prLinkRecordSchema,
  queueOperationRecordSchema,
  summaryRecordSchema,
  systemRecordSchema,
  userRecordSchema,
} from '../schemas.js'
import type { Envelope, JsonObject, MalformedLine, TokenUsage, TranscriptRecord } from '../types.js'
import { flattenText, normaliseContent } from './content.js'

export interface ParseRecordsResult {
  records: TranscriptRecord[]
  malformed: MalformedLine[]
}

/** How much of a malformed line to keep for diagnostics. Bounded because a partially
 * written line can contain a partially written secret. */
const MALFORMED_EXCERPT_LENGTH = 200

/**
 * Parse JSONL lines into typed records.
 *
 * Contract: **this never throws on real input.** A line that isn't valid JSON, or that
 * doesn't match the schema for its own declared `type`, is recorded in `malformed` (or
 * degraded to a `raw` record) and parsing continues. Claude Code writes transcripts
 * while the process is live; truncated final lines are normal, not exceptional.
 */
export function parseRecords(lines: Iterable<string>): ParseRecordsResult {
  const records: TranscriptRecord[] = []
  const malformed: MalformedLine[] = []

  let lineNumber = 0
  let seq = 0

  for (const line of lines) {
    lineNumber += 1
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch (error) {
      malformed.push({
        lineNumber,
        error: error instanceof Error ? error.message : String(error),
        excerpt: trimmed.slice(0, MALFORMED_EXCERPT_LENGTH),
      })
      continue
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      malformed.push({
        lineNumber,
        error: 'line is not a JSON object',
        excerpt: trimmed.slice(0, MALFORMED_EXCERPT_LENGTH),
      })
      continue
    }

    records.push(toRecord(value as JsonObject, seq))
    seq += 1
  }

  return { records, malformed }
}

function toRecord(raw: JsonObject, seq: number): TranscriptRecord {
  const envelope = readEnvelope(raw)
  const base = { seq, envelope, raw } as const
  const recordType = typeof raw.type === 'string' ? raw.type : ''

  switch (recordType) {
    case 'user': {
      const parsed = userRecordSchema.safeParse(raw)
      if (!parsed.success) break
      const content = normaliseContent(parsed.data.message.content)
      return {
        ...base,
        kind: 'user',
        content,
        text: flattenText(content),
        ...(parsed.data.promptId !== undefined && { promptId: parsed.data.promptId }),
        ...(parsed.data.promptSource !== undefined && { promptSource: parsed.data.promptSource }),
        ...(parsed.data.origin?.kind !== undefined && { originKind: parsed.data.origin.kind }),
      }
    }

    case 'assistant': {
      const parsed = assistantRecordSchema.safeParse(raw)
      if (!parsed.success) break
      const message = parsed.data.message
      const content = normaliseContent(message.content)
      return {
        ...base,
        kind: 'assistant',
        content,
        text: flattenText(content),
        ...(message.model !== undefined && { model: message.model }),
        ...(message.id !== undefined && { messageId: message.id }),
        ...(typeof message.stop_reason === 'string' && { stopReason: message.stop_reason }),
        ...(message.usage !== undefined && { usage: readUsage(message.usage) }),
        ...(parsed.data.requestId !== undefined && { requestId: parsed.data.requestId }),
      }
    }

    case 'system': {
      const parsed = systemRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return {
        ...base,
        kind: 'system',
        text: parsed.data.content ?? '',
        ...(parsed.data.subtype !== undefined && { subtype: parsed.data.subtype }),
        ...(parsed.data.durationMs !== undefined && { durationMs: parsed.data.durationMs }),
        ...(parsed.data.messageCount !== undefined && { messageCount: parsed.data.messageCount }),
      }
    }

    case 'summary': {
      const parsed = summaryRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return {
        ...base,
        kind: 'summary',
        summary: parsed.data.summary,
        ...(parsed.data.leafUuid !== undefined && { leafUuid: parsed.data.leafUuid }),
      }
    }

    case 'ai-title': {
      const parsed = aiTitleRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return { ...base, kind: 'ai-title', aiTitle: parsed.data.aiTitle }
    }

    case 'agent-name': {
      const parsed = agentNameRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return { ...base, kind: 'agent-name', agentName: parsed.data.agentName }
    }

    case 'last-prompt': {
      const parsed = lastPromptRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return {
        ...base,
        kind: 'last-prompt',
        lastPrompt: parsed.data.lastPrompt,
        ...(parsed.data.leafUuid !== undefined && { leafUuid: parsed.data.leafUuid }),
      }
    }

    case 'mode': {
      const parsed = modeRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return { ...base, kind: 'mode', mode: parsed.data.mode }
    }

    case 'permission-mode': {
      const parsed = permissionModeRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return { ...base, kind: 'permission-mode', permissionMode: parsed.data.permissionMode }
    }

    case 'attachment': {
      const parsed = attachmentRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return {
        ...base,
        kind: 'attachment',
        ...(parsed.data.attachment?.type !== undefined && {
          attachmentType: parsed.data.attachment.type,
        }),
      }
    }

    case 'file-history-snapshot': {
      const parsed = fileHistorySnapshotRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return {
        ...base,
        kind: 'file-history-snapshot',
        isSnapshotUpdate: parsed.data.isSnapshotUpdate === true,
        ...(parsed.data.messageId !== undefined && { messageId: parsed.data.messageId }),
      }
    }

    case 'queue-operation': {
      const parsed = queueOperationRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return {
        ...base,
        kind: 'queue-operation',
        operation: parsed.data.operation,
        content: parsed.data.content,
      }
    }

    case 'pr-link': {
      const parsed = prLinkRecordSchema.safeParse(raw)
      if (!parsed.success) break
      return {
        ...base,
        kind: 'pr-link',
        ...(parsed.data.prNumber !== undefined && { prNumber: parsed.data.prNumber }),
        ...(parsed.data.prUrl !== undefined && { prUrl: parsed.data.prUrl }),
        ...(parsed.data.prRepository !== undefined && { prRepository: parsed.data.prRepository }),
      }
    }

    default:
      break
  }

  // Either an unknown `type`, or a known one whose shape has drifted. Both keep their
  // raw payload so the UI can render something and so a query can find them later.
  return { ...base, kind: 'raw', recordType }
}

function readEnvelope(raw: JsonObject): Envelope {
  const parsed = envelopeSchema.safeParse(raw)
  if (!parsed.success) return {}
  const d = parsed.data
  return {
    ...(d.uuid !== undefined && { uuid: d.uuid }),
    ...(d.parentUuid !== undefined && { parentUuid: d.parentUuid }),
    ...(d.sessionId !== undefined && { sessionId: d.sessionId }),
    ...(d.timestamp !== undefined && { timestamp: d.timestamp }),
    ...(d.cwd !== undefined && { cwd: d.cwd }),
    ...(d.gitBranch !== undefined && { gitBranch: d.gitBranch }),
    ...(d.version !== undefined && { version: d.version }),
    ...(d.isSidechain !== undefined && { isSidechain: d.isSidechain }),
    ...(d.agentId !== undefined && { agentId: d.agentId }),
    ...(d.slug !== undefined && { slug: d.slug }),
    ...(d.userType !== undefined && { userType: d.userType }),
    ...(d.entrypoint !== undefined && { entrypoint: d.entrypoint }),
    ...(d.isMeta !== undefined && { isMeta: d.isMeta }),
    ...(d.isCompactSummary !== undefined && { isCompactSummary: d.isCompactSummary }),
  }
}

function readUsage(usage: {
  input_tokens?: number | undefined
  output_tokens?: number | undefined
  cache_read_input_tokens?: number | undefined
  cache_creation_input_tokens?: number | undefined
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  }
}
