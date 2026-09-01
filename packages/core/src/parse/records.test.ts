import { describe, expect, it } from 'vitest'
import { parseRecords } from './records.js'

/**
 * Synthetic lines are used here deliberately: these tests pin *tolerance* behaviour,
 * and the whole point is inputs that a real transcript shouldn't contain but sometimes
 * does. Realism is covered by the fixture-backed tests in `fixtures.test.ts`.
 */
const line = (value: unknown): string => JSON.stringify(value)

describe('parseRecords tolerance', () => {
  it('never throws on invalid JSON and reports the line number', () => {
    const result = parseRecords(['{"type":"mode","mode":"normal"}', '{ not json', ''])
    expect(result.records).toHaveLength(1)
    expect(result.malformed).toHaveLength(1)
    expect(result.malformed[0]?.lineNumber).toBe(2)
  })

  it('rejects non-object lines rather than crashing on them', () => {
    const result = parseRecords(['[1,2,3]', '"a string"', '42'])
    expect(result.records).toHaveLength(0)
    expect(result.malformed).toHaveLength(3)
  })

  it('truncates malformed excerpts, since a partial line can hold a partial secret', () => {
    const result = parseRecords([`{"secret":"${'x'.repeat(5000)}`])
    expect(result.malformed[0]?.excerpt.length).toBeLessThanOrEqual(200)
  })

  it('keeps unknown record types as raw instead of dropping them', () => {
    const result = parseRecords([line({ type: 'some-future-thing', payload: { a: 1 } })])
    expect(result.records[0]?.kind).toBe('raw')
    expect(result.records[0]).toMatchObject({ recordType: 'some-future-thing' })
    expect(result.records[0]?.raw.payload).toEqual({ a: 1 })
  })

  it('degrades a known type with a drifted shape to raw rather than failing', () => {
    // `aiTitle` is required; a future version omitting it must not break the file.
    const result = parseRecords([line({ type: 'ai-title', title: 'moved field' })])
    expect(result.records[0]?.kind).toBe('raw')
    expect(result.records[0]?.raw.title).toBe('moved field')
  })

  it('assigns seq in file order, because timestamps tie and sometimes vanish', () => {
    const result = parseRecords([
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'permission-mode', permissionMode: 'default' }),
      line({ type: 'mode', mode: 'plan' }),
    ])
    expect(result.records.map((r) => r.seq)).toEqual([0, 1, 2])
  })
})

describe('parseRecords content handling', () => {
  it('normalises a bare string prompt into a text block', () => {
    const result = parseRecords([
      line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello there' } }),
    ])
    const record = result.records[0]
    expect(record?.kind).toBe('user')
    expect(record).toMatchObject({ text: 'hello there' })
  })

  it('drops thinking signatures — they are long, opaque and pure token waste', () => {
    const result = parseRecords([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'hmm', signature: 'x'.repeat(2000) }],
        },
      }),
    ])
    const record = result.records[0]
    expect(record?.kind).toBe('assistant')
    expect(JSON.stringify(record?.kind === 'assistant' ? record.content : [])).not.toContain('xxx')
  })

  it('excludes thinking from searchable text but keeps tool names', () => {
    const result = parseRecords([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning' },
            { type: 'text', text: 'visible answer' },
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } },
          ],
        },
      }),
    ])
    const record = result.records[0]
    expect(record).toMatchObject({ text: 'visible answer\n[Edit]' })
  })

  it('retains unrecognised content blocks so new block types are discoverable', () => {
    const result = parseRecords([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'video', url: 'x' }] },
      }),
    ])
    const record = result.records[0]
    expect(record?.kind === 'assistant' && record.content[0]).toMatchObject({
      type: 'unknown',
      blockType: 'video',
    })
  })

  it('sums token usage including cache fields', () => {
    const result = parseRecords([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 40,
          },
        },
      }),
    ])
    const record = result.records[0]
    expect(record?.kind === 'assistant' && record.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      // No `cache_creation` breakdown on this record, so the whole cache write lands in the
      // cheaper 5-minute bucket rather than being guessed upward.
      cacheCreation5mTokens: 40,
      cacheCreation1hTokens: 0,
    })
  })

  it('splits cache writes by ttl when the breakdown is present', () => {
    const result = parseRecords([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 100,
            cache_creation: {
              ephemeral_5m_input_tokens: 70,
              ephemeral_1h_input_tokens: 30,
            },
          },
        },
      }),
    ])
    const record = result.records[0]
    expect(record?.kind === 'assistant' && record.usage).toMatchObject({
      cacheCreationTokens: 100,
      cacheCreation5mTokens: 70,
      cacheCreation1hTokens: 30,
    })
  })
})
