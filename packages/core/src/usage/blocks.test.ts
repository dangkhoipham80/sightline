import { describe, expect, it } from 'vitest'
import type { TokenEvent } from '../parse/tokens.js'
import { activeBlock, groupIntoBlocks } from './blocks.js'

function event(timestamp: string | undefined, output = 1): TokenEvent {
  return {
    dedupeKey: `${timestamp}-${output}`,
    ...(timestamp !== undefined && { timestamp }),
    usage: {
      inputTokens: 1,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    },
  }
}

const NOW = new Date('2026-09-01T12:00:00.000Z')

describe('groupIntoBlocks', () => {
  it('puts everything inside five hours of the first event in one block', () => {
    const blocks = groupIntoBlocks(
      [
        event('2026-09-01T08:10:00.000Z'),
        event('2026-09-01T10:00:00.000Z'),
        event('2026-09-01T12:50:00.000Z'),
      ],
      { now: NOW },
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.events).toHaveLength(3)
  })

  it('floors the block start to the hour, so it matches how a reset time reads', () => {
    const blocks = groupIntoBlocks([event('2026-09-01T08:47:12.000Z')], { now: NOW })
    expect(blocks[0]?.startedAt).toBe('2026-09-01T08:00:00.000Z')
    expect(blocks[0]?.endsAt).toBe('2026-09-01T13:00:00.000Z')
    // The window's start, not the event's — both are kept because they answer different
    // questions.
    expect(blocks[0]?.firstEventAt).toBe('2026-09-01T08:47:12.000Z')
  })

  it('opens a new block once five hours have passed since it started', () => {
    const blocks = groupIntoBlocks(
      [event('2026-09-01T04:00:00.000Z'), event('2026-09-01T09:30:00.000Z')],
      { now: NOW },
    )
    expect(blocks).toHaveLength(2)
  })

  /**
   * The condition that is easy to omit. An idle gap longer than the window means the old
   * window expired unused, so the next message opens a fresh one — it does not land inside
   * a window that has already reset.
   */
  it('opens a new block after an idle gap longer than the window', () => {
    const blocks = groupIntoBlocks(
      [
        event('2026-09-01T00:10:00.000Z'),
        // 6 hours later: within nothing, because the first block ended at 05:00.
        event('2026-09-01T06:20:00.000Z'),
      ],
      { now: NOW },
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[1]?.startedAt).toBe('2026-09-01T06:00:00.000Z')
  })

  it('sorts out-of-order events before grouping', () => {
    const blocks = groupIntoBlocks(
      [event('2026-09-01T10:00:00.000Z'), event('2026-09-01T08:00:00.000Z')],
      { now: NOW },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.firstEventAt).toBe('2026-09-01T08:00:00.000Z')
  })

  /**
   * An event with no timestamp cannot be placed in a window. Putting it in the nearest one
   * would be inventing the boundary this whole module refuses to invent.
   */
  it('drops events that carry no timestamp rather than guessing a window', () => {
    const blocks = groupIntoBlocks([event(undefined), event('2026-09-01T10:00:00.000Z')], {
      now: NOW,
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.events).toHaveLength(1)
  })

  it('has no blocks at all when there is nothing to group', () => {
    expect(groupIntoBlocks([], { now: NOW })).toEqual([])
  })

  it('sums usage over the block', () => {
    const blocks = groupIntoBlocks(
      [event('2026-09-01T10:00:00.000Z', 5), event('2026-09-01T11:00:00.000Z', 7)],
      { now: NOW },
    )
    expect(blocks[0]?.usage.outputTokens).toBe(12)
    expect(blocks[0]?.usage.inputTokens).toBe(2)
  })
})

describe('activeBlock', () => {
  it('finds the block `now` falls inside', () => {
    const blocks = groupIntoBlocks([event('2026-09-01T10:30:00.000Z')], { now: NOW })
    expect(activeBlock(blocks)?.isActive).toBe(true)
  })

  /**
   * No active block is a real answer — the last window expired and nothing has opened a new
   * one. The caller turns this into "—", never into 0%.
   */
  it('returns nothing when the last window has already expired', () => {
    const blocks = groupIntoBlocks([event('2026-09-01T02:00:00.000Z')], { now: NOW })
    expect(blocks).toHaveLength(1)
    expect(activeBlock(blocks)).toBeUndefined()
  })
})
