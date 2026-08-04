/**
 * A line diff, so an `Edit` reads as a change rather than as two walls of text.
 *
 * Claude Code records an edit as `old_string` and `new_string` — the before and after, with
 * no indication of what actually moved. Showing both verbatim is what every transcript
 * viewer does, and it makes a one-character fix look identical to a rewrite.
 *
 * Plain Myers-style LCS over lines. No dependency: the inputs are the fragments a model
 * chose to replace, which are small, and the guard below covers the case where they aren't.
 */

export type DiffLineKind = 'context' | 'add' | 'remove'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line number in the before text; absent on added lines. */
  oldLine?: number
  /** 1-based line number in the after text; absent on removed lines. */
  newLine?: number
}

export interface DiffHunk {
  lines: DiffLine[]
  /** Lines skipped between the previous hunk and this one, for a `⋯ 12 unchanged` marker. */
  skippedBefore: number
}

export interface DiffStat {
  added: number
  removed: number
  /** The diff was too large to compute exactly and is shown as a wholesale replacement. */
  truncated: boolean
}

export interface FileDiff {
  hunks: DiffHunk[]
  stat: DiffStat
}

/**
 * Above this, the quadratic LCS table costs more than the result is worth and we fall back
 * to "everything removed, everything added" — which is honest, just less useful.
 */
const MAX_LCS_LINES = 3000

export function diffLines(before: string, after: string, context = 3): FileDiff {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)

  if (oldLines.length * newLines.length > MAX_LCS_LINES * MAX_LCS_LINES) {
    return wholesale(oldLines, newLines)
  }

  const lines = align(oldLines, newLines)
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'remove').length

  return { hunks: toHunks(lines, context), stat: { added, removed, truncated: false } }
}

function splitLines(text: string): string[] {
  if (text === '') return []
  // A trailing newline denotes termination, not an extra empty line.
  const normalised = text.replace(/\r\n/g, '\n')
  const lines = normalised.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function wholesale(oldLines: string[], newLines: string[]): FileDiff {
  const lines: DiffLine[] = [
    ...oldLines.map((text, i) => ({ kind: 'remove' as const, text, oldLine: i + 1 })),
    ...newLines.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
  ]
  return {
    hunks: lines.length > 0 ? [{ lines, skippedBefore: 0 }] : [],
    stat: { added: newLines.length, removed: oldLines.length, truncated: true },
  }
}

/** Longest common subsequence table, walked back into an aligned line list. */
function align(oldLines: readonly string[], newLines: readonly string[]): DiffLine[] {
  const rows = oldLines.length
  const cols = newLines.length

  // table[i][j] = LCS length of oldLines[i..] and newLines[j..]
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  )
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      const row = table[i]
      const next = table[i + 1]
      if (row === undefined || next === undefined) continue
      row[j] =
        oldLines[i] === newLines[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0

  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: 'context', text: oldLines[i] ?? '', oldLine: i + 1, newLine: j + 1 })
      i += 1
      j += 1
      continue
    }

    const down = table[i + 1]?.[j] ?? 0
    const right = table[i]?.[j + 1] ?? 0
    if (down >= right) {
      lines.push({ kind: 'remove', text: oldLines[i] ?? '', oldLine: i + 1 })
      i += 1
    } else {
      lines.push({ kind: 'add', text: newLines[j] ?? '', newLine: j + 1 })
      j += 1
    }
  }

  while (i < rows) {
    lines.push({ kind: 'remove', text: oldLines[i] ?? '', oldLine: i + 1 })
    i += 1
  }
  while (j < cols) {
    lines.push({ kind: 'add', text: newLines[j] ?? '', newLine: j + 1 })
    j += 1
  }

  return lines
}

/**
 * Keep `context` unchanged lines either side of each change and drop the rest.
 *
 * A `Write` of a 600-line file is 600 additions with no context to trim; an `Edit` inside
 * one is three lines of change that nobody can locate without the lines around it.
 */
function toHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false)

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === 'context') continue
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) {
      keep[j] = true
    }
  }

  const hunks: DiffHunk[] = []
  let current: DiffLine[] = []
  let skipped = 0
  let pendingSkip = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) continue

    if (keep[i] === true) {
      if (current.length === 0) {
        skipped = pendingSkip
        pendingSkip = 0
      }
      current.push(line)
      continue
    }

    if (current.length > 0) {
      hunks.push({ lines: current, skippedBefore: skipped })
      current = []
    }
    pendingSkip += 1
  }

  if (current.length > 0) hunks.push({ lines: current, skippedBefore: skipped })
  return hunks
}
