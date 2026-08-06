import { describe, expect, it } from 'vitest'
import { MATCH_CLOSE, MATCH_OPEN, splitSnippet } from './snippet.js'

const wrap = (text: string): string => `${MATCH_OPEN}${text}${MATCH_CLOSE}`

describe('splitSnippet', () => {
  it('separates a match from the text around it', () => {
    expect(splitSnippet(`fix the ${wrap('redirect')} loop`)).toEqual([
      { text: 'fix the ', match: false },
      { text: 'redirect', match: true },
      { text: ' loop', match: false },
    ])
  })

  it('handles several matches in one snippet', () => {
    const result = splitSnippet(`${wrap('auth')} and ${wrap('auth')} again`)
    expect(result.filter((s) => s.match)).toHaveLength(2)
  })

  it('returns one plain segment when nothing matched', () => {
    expect(splitSnippet('no markers here')).toEqual([{ text: 'no markers here', match: false }])
  })

  it('handles a match at each end without emitting empty segments', () => {
    expect(splitSnippet(`${wrap('start')} middle ${wrap('end')}`)).toEqual([
      { text: 'start', match: true },
      { text: ' middle ', match: false },
      { text: 'end', match: true },
    ])
  })

  /** A snippet cut mid-marker still has to render as something readable. */
  it('emits the remainder as plain text when a marker is left unclosed', () => {
    expect(splitSnippet(`tail ${MATCH_OPEN}truncated`)).toEqual([
      { text: `tail ${MATCH_OPEN}truncated`, match: false },
    ])
  })

  it('is empty for an empty snippet', () => {
    expect(splitSnippet('')).toEqual([])
  })

  /**
   * The reason the markers are control characters. Guillemets appear in real transcripts —
   * French prose, quoting conventions — and using them would highlight the wrong run.
   */
  it('does not treat readable punctuation as a marker', () => {
    expect(splitSnippet('a «quoted» phrase')).toEqual([{ text: 'a «quoted» phrase', match: false }])
  })
})
