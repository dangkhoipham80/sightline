import { describe, expect, it } from 'vitest'
import { parseRecords } from './records.js'
import { buildMessageTree, flattenTree } from './tree.js'

const line = (value: unknown): string => JSON.stringify(value)

const msg = (uuid: string, parentUuid: string | null): string =>
  line({
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: `message ${uuid}` },
  })

const treeOf = (lines: string[]) => buildMessageTree(parseRecords(lines).records)

describe('buildMessageTree', () => {
  it('links a simple chain', () => {
    const tree = treeOf([msg('a', null), msg('b', 'a'), msg('c', 'b')])
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0]?.children[0]?.record.envelope.uuid).toBe('b')
    expect(tree.byUuid.get('c')?.depth).toBe(2)
  })

  it('keeps branches separate when the user rewinds and re-asks', () => {
    const tree = treeOf([msg('a', null), msg('b', 'a'), msg('c', 'a')])
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0]?.children).toHaveLength(2)
  })

  /**
   * Trap 3 — anthropics/claude-code#36583. A `file-history-snapshot` carries a
   * `messageId` equal to the uuid of the message it snapshots. Indexing records by
   * "their id" without filtering first silently replaces real messages with snapshots.
   */
  it('excludes file-history-snapshot records whose messageId collides with a real uuid', () => {
    const tree = treeOf([
      msg('real-uuid', null),
      line({
        type: 'file-history-snapshot',
        messageId: 'real-uuid',
        snapshot: { messageId: 'real-uuid', trackedFileBackups: {} },
        isSnapshotUpdate: false,
      }),
      msg('child', 'real-uuid'),
    ])

    expect(tree.byUuid.size).toBe(2)
    expect(tree.byUuid.get('real-uuid')?.record.kind).toBe('user')
    expect(tree.byUuid.get('real-uuid')?.children).toHaveLength(1)
    expect(tree.duplicateUuidCount).toBe(0)
  })

  /**
   * Trap 2 — anthropics/claude-code#22526. Dropping records with an unresolvable parent
   * would discard entire branches of real conversation.
   */
  it('roots records whose parentUuid references a uuid absent from the file', () => {
    const tree = treeOf([msg('a', null), msg('orphan', 'never-written'), msg('b', 'a')])
    expect(tree.orphanCount).toBe(1)
    expect(tree.roots.map((r) => r.record.envelope.uuid)).toContain('orphan')
    expect(flattenTree(tree)).toHaveLength(3)
  })

  it('keeps the first record when a uuid is duplicated', () => {
    const tree = treeOf([
      msg('dup', null),
      line({ type: 'user', uuid: 'dup', parentUuid: null, message: { content: 'second' } }),
    ])
    expect(tree.duplicateUuidCount).toBe(1)
    expect(tree.byUuid.size).toBe(1)
    expect(tree.byUuid.get('dup')?.record).toMatchObject({ text: 'message dup' })
  })

  /**
   * The bug this test exists to prevent, found by running the parser over a real corpus:
   * `attachment` records carry a `uuid` and a `parentUuid`, so they are links in the
   * chain. Indexing only user/assistant/system records severed every branch that passed
   * through one — 1,345 falsely orphaned records across 52 sessions, each of which looked
   * like a plausible root rather than like an error.
   */
  it('threads the chain through attachment records instead of severing it', () => {
    const tree = treeOf([
      msg('prompt', null),
      line({
        type: 'attachment',
        uuid: 'att',
        parentUuid: 'prompt',
        attachment: { type: 'deferred_tools_delta' },
      }),
      msg('reply', 'att'),
    ])

    expect(tree.orphanCount).toBe(0)
    expect(tree.roots).toHaveLength(1)
    expect(tree.byUuid.get('reply')?.depth).toBe(2)
  })

  it('breaks cycles instead of hanging, so rendering always terminates', () => {
    const tree = treeOf([msg('a', 'b'), msg('b', 'a')])
    expect(tree.cycleCount).toBeGreaterThan(0)
    expect(flattenTree(tree)).toHaveLength(2)
  })

  it('ignores self-parenting records', () => {
    const tree = treeOf([msg('a', 'a')])
    expect(tree.orphanCount).toBe(1)
    expect(flattenTree(tree)).toHaveLength(1)
  })

  it('loses nothing: every conversation record appears exactly once when flattened', () => {
    const tree = treeOf([
      msg('a', null),
      msg('b', 'a'),
      msg('c', 'missing'),
      msg('d', 'b'),
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'file-history-snapshot', messageId: 'a' }),
    ])
    const flattened = flattenTree(tree)
    const uuids = flattened.map((r) => r.envelope.uuid)
    expect(new Set(uuids).size).toBe(uuids.length)
    expect(uuids.sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})
