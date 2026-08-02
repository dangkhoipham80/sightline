import type { TranscriptRecord } from '../types.js'
import { hasGraphIdentity } from '../types.js'

export interface MessageNode {
  record: TranscriptRecord
  children: MessageNode[]
  /** Depth from the root of its branch. */
  depth: number
}

export interface MessageTree {
  roots: MessageNode[]
  byUuid: Map<string, MessageNode>
  /** Records whose `parentUuid` referenced a uuid absent from the file. */
  orphanCount: number
  /** Records sharing a uuid with an earlier record. The first occurrence wins. */
  duplicateUuidCount: number
  /** Records whose parent chain formed a cycle and were promoted to roots. */
  cycleCount: number
}

/**
 * Build the conversation graph.
 *
 * A transcript is a DAG, not a list — the user rewinding and re-asking creates branches,
 * each with its own `parentUuid` chain. Four hazards are handled here:
 *
 * 1. **The graph is wider than the conversation.** `attachment` records carry a `uuid`
 *    *and* a `parentUuid`, so they are links in the chain, not annotations beside it.
 *    Indexing only user/assistant/system records severs every branch that passes through
 *    one — measured at 1,345 falsely orphaned records across a 52-session corpus. This is
 *    the mistake that is easiest to make and hardest to notice, because the result looks
 *    like a plausible tree.
 * 2. `file-history-snapshot` records are excluded before indexing. Their `messageId` can
 *    equal a real message's `uuid` (anthropics/claude-code#36583). They carry no `uuid`
 *    of their own, so indexing on `uuid` alone is already safe — the explicit exclusion
 *    is there so that a future refactor reaching for `messageId ?? uuid`, which is the
 *    natural thing to write, doesn't silently overwrite real messages.
 * 3. `parentUuid` may reference a uuid absent from the file
 *    (anthropics/claude-code#22526). Those records become roots rather than being
 *    dropped — losing a subtree loses real conversation. Not observed in our corpus at
 *    2.1.198, but cheap to defend against and catastrophic to get wrong.
 * 4. A malformed chain can form a cycle. Nodes unreachable from any root after linking
 *    are promoted to roots, guaranteeing every record is reachable exactly once and that
 *    rendering terminates.
 */
export function buildMessageTree(records: readonly TranscriptRecord[]): MessageTree {
  const byUuid = new Map<string, MessageNode>()
  const ordered: MessageNode[] = []
  let duplicateUuidCount = 0

  for (const record of records) {
    if (!hasGraphIdentity(record)) continue
    const uuid = record.envelope.uuid
    if (uuid === undefined) continue

    if (byUuid.has(uuid)) {
      duplicateUuidCount += 1
      continue
    }

    const node: MessageNode = { record, children: [], depth: 0 }
    byUuid.set(uuid, node)
    ordered.push(node)
  }

  const roots: MessageNode[] = []
  let orphanCount = 0

  for (const node of ordered) {
    const parentUuid = node.record.envelope.parentUuid
    if (parentUuid === undefined || parentUuid === null) {
      roots.push(node)
      continue
    }

    const parent = byUuid.get(parentUuid)
    if (parent === undefined) {
      orphanCount += 1
      roots.push(node)
      continue
    }
    if (parent === node) {
      // Self-parenting: pathological, but cheaper to handle than to debug later.
      orphanCount += 1
      roots.push(node)
      continue
    }

    parent.children.push(node)
  }

  const cycleCount = promoteUnreachable(roots, ordered)
  assignDepths(roots)

  return { roots, byUuid, orphanCount, duplicateUuidCount, cycleCount }
}

/** Promote any node not reachable from a root — i.e. trapped in a cycle — to a root. */
function promoteUnreachable(roots: MessageNode[], ordered: readonly MessageNode[]): number {
  const reachable = new Set<MessageNode>()
  const stack = [...roots]

  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || reachable.has(node)) continue
    reachable.add(node)
    stack.push(...node.children)
  }

  let promoted = 0
  for (const node of ordered) {
    if (reachable.has(node)) continue
    // Detach from whichever parent trapped it, then root it.
    for (const candidate of ordered) {
      const index = candidate.children.indexOf(node)
      if (index !== -1) candidate.children.splice(index, 1)
    }
    roots.push(node)
    promoted += 1
    // Everything below it is now reachable.
    const stack2 = [node]
    while (stack2.length > 0) {
      const current = stack2.pop()
      if (current === undefined || reachable.has(current)) continue
      reachable.add(current)
      stack2.push(...current.children)
    }
  }

  return promoted
}

function assignDepths(roots: readonly MessageNode[]): void {
  const stack: Array<{ node: MessageNode; depth: number }> = roots.map((node) => ({
    node,
    depth: 0,
  }))
  const seen = new Set<MessageNode>()

  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined || seen.has(entry.node)) continue
    seen.add(entry.node)
    entry.node.depth = entry.depth
    for (const child of entry.node.children) {
      stack.push({ node: child, depth: entry.depth + 1 })
    }
  }
}

/** Flatten the tree back to file order — the order a reader expects to see. */
export function flattenTree(tree: MessageTree): TranscriptRecord[] {
  const out: TranscriptRecord[] = []
  const seen = new Set<MessageNode>()

  const visit = (node: MessageNode): void => {
    if (seen.has(node)) return
    seen.add(node)
    out.push(node.record)
    for (const child of [...node.children].sort((a, b) => a.record.seq - b.record.seq)) {
      visit(child)
    }
  }

  for (const root of [...tree.roots].sort((a, b) => a.record.seq - b.record.seq)) visit(root)
  return out
}
