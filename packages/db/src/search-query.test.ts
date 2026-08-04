import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { toMatchQuery } from './search-query.js'

/**
 * The assertions that matter here run the produced expression through a real FTS5 table.
 * Checking the generated string against what I expected it to be tests my assumptions;
 * the engine is the thing with an opinion, and it is the thing that raises.
 */
let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE VIRTUAL TABLE docs USING fts5(text, tokenize='porter unicode61');
    INSERT INTO docs(text) VALUES
      ('fix the auth redirect loop'),
      ('deploy the staging database'),
      ('notes on c++ and c# interop'),
      ('a "quoted" thing');
  `)
})

function run(input: string, options?: Parameters<typeof toMatchQuery>[1]): number {
  const match = toMatchQuery(input, options)
  if (match === undefined) return 0
  return (
    db.prepare('SELECT COUNT(*) AS n FROM docs WHERE docs MATCH ?').get(match) as { n: number }
  ).n
}

/**
 * Every one of these raises when passed to FTS5 verbatim — several of them with messages
 * that read like a bug in Sightline rather than a typo, `a-b` producing
 * "no such column: b" being the worst offender.
 */
const HAZARDS = [
  'c++',
  'a-b',
  'fix"',
  '"unbalanced',
  'AND',
  'NOT auth',
  'auth OR',
  'a OR',
  '(',
  ')',
  ':',
  '--',
  '*',
  '""',
  'NEAR(a b)',
  'auth AND OR redirect',
  '^^^',
  '\\',
  'x AND',
  '   ',
]

describe('toMatchQuery', () => {
  it.each(HAZARDS)('never lets FTS5 raise on %j', (input) => {
    expect(() => run(input)).not.toThrow()
    expect(() => run(input, { prefixLastTerm: true })).not.toThrow()
  })

  it('finds the obvious thing', () => {
    expect(run('redirect')).toBe(1)
    expect(run('auth redirect')).toBe(1)
  })

  it('ANDs bare terms, so more words narrow rather than widen', () => {
    expect(run('auth redirect')).toBe(1)
    expect(run('auth staging')).toBe(0)
  })

  /** Porter stemming is why this works, and why it is worth keeping the tokeniser. */
  it('still stems', () => {
    expect(run('deployed')).toBe(1)
  })

  it('searches a term FTS5 would otherwise choke on', () => {
    expect(run('c++')).toBe(1)
  })

  it('keeps a closed phrase together', () => {
    expect(run('"auth redirect"')).toBe(1)
    expect(run('"redirect auth"')).toBe(0)
  })

  it('treats an unclosed quote as the phrase the user is still typing', () => {
    expect(toMatchQuery('"auth redirect')).toBe('"auth redirect"')
    expect(run('"auth redirect')).toBe(1)
  })

  it('escapes a quote inside a phrase rather than ending it', () => {
    expect(toMatchQuery('a "quoted" thing')).toBe('"a" "quoted" "thing"')
    expect(run('a "quoted" thing')).toBe(1)
  })

  describe('operators', () => {
    it('honours AND, OR and NOT between two terms', () => {
      expect(toMatchQuery('auth OR staging')).toBe('"auth" OR "staging"')
      expect(run('auth OR staging')).toBe(2)
      expect(run('auth NOT redirect')).toBe(0)
    })

    /**
     * A trailing operator is someone mid-keystroke, not a syntax error to shout about.
     * FTS5 answers `auth OR` with `syntax error near ""`, which helps nobody.
     */
    it('drops an operator that has nothing to operate on', () => {
      expect(toMatchQuery('auth OR')).toBe('"auth"')
      expect(toMatchQuery('NOT auth')).toBe('"auth"')
      expect(toMatchQuery('auth AND OR staging')).toBe('"auth" AND "staging"')
      expect(toMatchQuery('OR')).toBeUndefined()
    })

    it('leaves a quoted operator alone, because then it is a word', () => {
      expect(toMatchQuery('"OR"')).toBe('"OR"')
    })
  })

  describe('prefix matching', () => {
    it('completes the last term as it is typed', () => {
      expect(toMatchQuery('redirec', { prefixLastTerm: true })).toBe('"redirec"*')
      expect(run('redirec', { prefixLastTerm: true })).toBe(1)
    })

    it('only prefixes the last term, so earlier words stay exact', () => {
      expect(toMatchQuery('auth redirec', { prefixLastTerm: true })).toBe('"auth" "redirec"*')
    })

    it('does not prefix a phrase the user closed deliberately', () => {
      expect(toMatchQuery('"auth redirect"', { prefixLastTerm: true })).toBe('"auth redirect"')
    })

    it('is off by default, so a submitted query means what it says', () => {
      expect(toMatchQuery('redirec')).toBe('"redirec"')
      expect(run('redirec')).toBe(0)
    })
  })

  describe('nothing to search for', () => {
    it.each(['', '   ', '--', '***', '()', '""'])('returns undefined for %j', (input) => {
      expect(toMatchQuery(input)).toBeUndefined()
    })

    /** Punctuation matches no row, so keeping it would AND away every real result. */
    it('ignores a punctuation-only term beside a real one', () => {
      expect(toMatchQuery('auth --')).toBe('"auth"')
      expect(run('auth --')).toBe(1)
    })
  })

  it('handles a query long enough to be a paste rather than a search', () => {
    const long = 'auth '.repeat(500)
    expect(() => run(long)).not.toThrow()
  })
})
