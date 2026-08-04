/**
 * Splitting an FTS5 snippet into plain and matched runs.
 *
 * `snippet()` wraps matches in whatever delimiters you hand it, and hands back one string.
 * Rendering that string with the delimiters still in it is what makes a search result look
 * like a debug dump, so they are split out and the matched runs become `<mark>`.
 *
 * The delimiters are control characters rather than the readable `«…»`, because the corpus
 * being searched is *developer transcripts*: guillemets show up in real French prose and in
 * Rust turbofish discussions, and a message containing one would silently mis-highlight.
 * U+0001 and U+0002 cannot appear in a transcript that parsed as JSON text.
 */

export const MATCH_OPEN = ''
export const MATCH_CLOSE = ''

/** Passed straight to `search`'s `markers` option. */
export const SNIPPET_MARKERS: [string, string] = [MATCH_OPEN, MATCH_CLOSE]

export interface SnippetSegment {
  text: string
  /** True when this run is one of the query's matches. */
  match: boolean
}

export function splitSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = []
  let index = 0

  while (index < snippet.length) {
    const open = snippet.indexOf(MATCH_OPEN, index)
    if (open === -1) break

    const close = snippet.indexOf(MATCH_CLOSE, open + 1)
    // An unclosed marker means a truncated snippet. Emit the rest as plain text rather
    // than dropping it — half a result still tells the reader what they found.
    if (close === -1) break

    if (open > index) segments.push({ text: snippet.slice(index, open), match: false })
    segments.push({ text: snippet.slice(open + 1, close), match: true })
    index = close + 1
  }

  if (index < snippet.length) segments.push({ text: snippet.slice(index), match: false })
  return segments.filter((segment) => segment.text.length > 0)
}
