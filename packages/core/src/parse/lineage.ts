export interface LineageMember {
  sessionId: string
  continuesSessionId?: string
  startedAt?: string
}

export interface Lineage {
  /** The earliest session in the chain — the one the user originally started. */
  rootSessionId: string
  /** All members, oldest first. */
  sessionIds: string[]
  /**
   * True when the chain's root claims to continue a session we don't have, usually
   * because Claude Code deleted it under `cleanupPeriodDays`. Worth surfacing: it tells
   * the user their history was truncated rather than that it never existed.
   */
  truncated: boolean
}

/**
 * Group sessions into resume lineages.
 *
 * On `--resume` (and after compaction) Claude Code opens a **new** file whose first
 * record still carries the *previous* session's id. Without linking those, a single
 * continuous stretch of work shows up as several unrelated sessions and the whole
 * timeline misrepresents what happened.
 *
 * Chains are reconstructed defensively: a missing parent yields a truncated chain rather
 * than a dropped session, and a cycle is broken rather than hung on.
 */
export function linkLineages(members: readonly LineageMember[]): Lineage[] {
  const bySessionId = new Map<string, LineageMember>()
  for (const member of members) {
    if (!bySessionId.has(member.sessionId)) bySessionId.set(member.sessionId, member)
  }

  const rootOf = new Map<string, string>()
  const truncatedRoots = new Set<string>()

  for (const member of bySessionId.values()) {
    const seen = new Set<string>([member.sessionId])
    let current = member
    let truncated = false
    let cycled = false

    for (;;) {
      const parentId = current.continuesSessionId
      if (parentId === undefined) break

      const parent = bySessionId.get(parentId)
      if (parent === undefined) {
        // The parent transcript is gone — most likely aged out of Claude Code's
        // 30-day cleanup. Stop here and mark the chain as truncated.
        truncated = true
        break
      }
      if (seen.has(parentId)) {
        cycled = true
        break
      }
      seen.add(parentId)
      current = parent
    }

    // A cycle has no genuine root, and picking "wherever the walk stopped" would give a
    // different answer depending on which member we started from — splitting one cycle
    // into several lineages. Choosing the lowest id in the cycle is arbitrary but
    // identical from every entry point, which is the property that actually matters.
    const rootId = cycled ? ([...seen].sort()[0] ?? current.sessionId) : current.sessionId

    rootOf.set(member.sessionId, rootId)
    if (truncated) truncatedRoots.add(rootId)
  }

  const grouped = new Map<string, LineageMember[]>()
  for (const member of bySessionId.values()) {
    const root = rootOf.get(member.sessionId) ?? member.sessionId
    const bucket = grouped.get(root)
    if (bucket === undefined) grouped.set(root, [member])
    else bucket.push(member)
  }

  const lineages: Lineage[] = []
  for (const [rootSessionId, bucket] of grouped) {
    bucket.sort(compareByStart)
    lineages.push({
      rootSessionId,
      sessionIds: bucket.map((m) => m.sessionId),
      truncated: truncatedRoots.has(rootSessionId),
    })
  }

  lineages.sort((a, b) => {
    const aStart = bySessionId.get(a.rootSessionId)?.startedAt ?? ''
    const bStart = bySessionId.get(b.rootSessionId)?.startedAt ?? ''
    return aStart.localeCompare(bStart)
  })

  return lineages
}

function compareByStart(a: LineageMember, b: LineageMember): number {
  const aStart = a.startedAt
  const bStart = b.startedAt
  if (aStart !== undefined && bStart !== undefined) return aStart.localeCompare(bStart)
  if (aStart !== undefined) return -1
  if (bStart !== undefined) return 1
  return a.sessionId.localeCompare(b.sessionId)
}
