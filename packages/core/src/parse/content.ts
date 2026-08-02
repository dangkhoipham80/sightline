import { contentBlockSchema, messageContentSchema } from '../schemas.js'
import type { ContentBlock, JsonObject, JsonValue } from '../types.js'

/**
 * Normalise a message's `content` — which is a bare string for typed prompts and an
 * array of blocks otherwise — into a uniform block list.
 *
 * Blocks whose `type` we don't recognise become `unknown` blocks rather than being
 * dropped. The UI can still show something, and querying for them is how we discover
 * that Claude Code has started emitting a new block type.
 */
export function normaliseContent(rawContent: unknown): ContentBlock[] {
  const parsed = messageContentSchema.safeParse(rawContent)
  if (!parsed.success) return []

  if (typeof parsed.data === 'string') {
    return parsed.data.length > 0 ? [{ type: 'text', text: parsed.data }] : []
  }

  const blocks: ContentBlock[] = []
  for (const block of parsed.data) {
    const normalised = normaliseBlock(block)
    if (normalised) blocks.push(normalised)
  }
  return blocks
}

function normaliseBlock(block: unknown): ContentBlock | null {
  const parsed = contentBlockSchema.safeParse(block)
  if (!parsed.success) return null
  const data = parsed.data as Record<string, unknown>

  switch (data.type) {
    case 'text':
      return { type: 'text', text: String(data.text ?? '') }

    case 'thinking':
      // The `signature` field is discarded here — it is a long opaque blob that would
      // otherwise dominate stored text and get shipped to summarisers as pure waste.
      return { type: 'thinking', thinking: String(data.thinking ?? '') }

    case 'tool_use':
      return {
        type: 'tool_use',
        id: String(data.id ?? ''),
        name: String(data.name ?? ''),
        input: (data.input ?? null) as JsonValue,
      }

    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: String(data.tool_use_id ?? ''),
        content: (data.content ?? null) as JsonValue,
        isError: data.is_error === true,
      }

    default:
      return {
        type: 'unknown',
        blockType: String(data.type ?? ''),
        raw: data as JsonObject,
      }
  }
}

/**
 * Flatten blocks into the plain text used for full-text search and previews.
 *
 * Thinking blocks are excluded: they are the model's scratchpad, and indexing them
 * makes searches match reasoning the user never saw. Tool results are excluded for the
 * same reason plus volume — a single `Read` result can dwarf an entire conversation.
 */
export function flattenText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool_use') parts.push(`[${block.name}]`)
  }
  return parts.join('\n').trim()
}

export function hasThinking(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'thinking')
}

export function toolUseBlocks(
  blocks: readonly ContentBlock[],
): Extract<ContentBlock, { type: 'tool_use' }>[] {
  return blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  )
}
