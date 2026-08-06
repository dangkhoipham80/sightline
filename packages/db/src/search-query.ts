/**
 * Turning what a person types into something FTS5 will accept.
 *
 * FTS5's `MATCH` argument is a query language, not a string, and it is unforgiving in a
 * way that matters here: a search box is exactly where a user types `c++`, a half-finished
 * `"quoted phrase`, or a trailing `OR`. Probed against the real engine, 12 of 24 plausible
 * inputs raise rather than return nothing:
 *
 *   c++          → fts5: syntax error near "+"
 *   a-b          → no such column: b        ← reads like a bug in Sightline
 *   fix"         → unterminated string
 *   auth OR      → fts5: syntax error near ""
 *   *            → unknown special query
 *
 * Every one of them is fixed by quoting the term, because a double-quoted FTS5 string is a
 * literal phrase: `"c++"` and `"--"` are both legal. So the strategy is to quote
 * everything, always, and re-introduce the two pieces of syntax people actually reach for —
 * phrases and boolean operators — deliberately rather than by accident.
 */

/** FTS5's own operators. Bare, uppercase, and only meaningful between two terms. */
const OPERATORS = new Set(['AND', 'OR', 'NOT'])

interface Token {
  value: string
  /** A `"…"` group the user closed themselves. Never prefix-matched. */
  phrase: boolean
}

export interface MatchQueryOptions {
  /**
   * Append `*` to the final bare term, so `redirec` finds `redirect` as it is typed.
   * Wanted in the palette, where every keystroke is a query; unwanted when the caller has
   * a complete query and means it literally.
   */
  prefixLastTerm?: boolean
}

/**
 * Build an FTS5 `MATCH` expression, or undefined when there is nothing to search for.
 *
 * Undefined is not an error — it is "the box is empty, or held only punctuation". Callers
 * return no results rather than running a query that cannot match.
 */
export function toMatchQuery(input: string, options: MatchQueryOptions = {}): string | undefined {
  const tokens = tokenise(input)
  if (tokens.length === 0) return undefined

  const parts: string[] = []

  for (const [index, token] of tokens.entries()) {
    if (!token.phrase && OPERATORS.has(token.value)) {
      // An operator is only an operator between two terms. Leading, trailing or doubled,
      // it is noise the user is still typing — dropping it beats both raising and
      // silently searching for the literal word "OR".
      const previous = parts.at(-1)
      const hasLeft = previous !== undefined && !OPERATORS.has(previous)
      const hasRight = tokens.slice(index + 1).some((t) => t.phrase || !OPERATORS.has(t.value))
      if (hasLeft && hasRight) parts.push(token.value)
      continue
    }

    const last = index === tokens.length - 1
    const prefix = options.prefixLastTerm === true && last && !token.phrase
    parts.push(`${quote(token.value)}${prefix ? '*' : ''}`)
  }

  // A query that is nothing but operators has no terms left once they are dropped.
  while (parts.length > 0 && OPERATORS.has(parts[parts.length - 1] ?? '')) parts.pop()
  return parts.length === 0 ? undefined : parts.join(' ')
}

/**
 * Split into quoted phrases and bare words.
 *
 * An unclosed quote takes the rest of the input as one phrase, which is what someone
 * halfway through typing `"exact phrase` means — and it is the case that raises
 * `unterminated string` if passed through.
 */
function tokenise(input: string): Token[] {
  const tokens: Token[] = []
  const pattern = /"([^"]*)"|([^\s"]+)|"(.*)$/gs

  for (const match of input.matchAll(pattern)) {
    const [, closed, bare, unclosed] = match
    if (closed !== undefined) push(tokens, closed, true)
    else if (bare !== undefined) push(tokens, bare, false)
    else if (unclosed !== undefined) push(tokens, unclosed, true)
  }

  return tokens
}

function push(tokens: Token[], raw: string, phrase: boolean): void {
  const value = raw.trim()
  // Punctuation-only terms tokenise to nothing, so FTS5 matches no row for them. Kept,
  // they would AND the entire result set away; `c++ --` would find nothing at all.
  if (value.length === 0 || !hasWordCharacter(value)) return
  tokens.push({ value, phrase })
}

function hasWordCharacter(value: string): boolean {
  for (const character of value) {
    if (/\p{L}|\p{N}/u.test(character)) return true
  }
  return false
}

/** FTS5 escapes a double quote inside a phrase by doubling it. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
