import { describe, expect, it } from 'vitest'
import { boolFlag, parseArgs, parsePort, stringFlag, unknownFlags } from './args.js'

describe('parseArgs', () => {
  it('reads both spellings of a valued flag', () => {
    expect(stringFlag(parseArgs(['--port', '5000'], ['port']), 'port')).toBe('5000')
    expect(stringFlag(parseArgs(['--port=5000'], ['port']), 'port')).toBe('5000')
  })

  it('does not let a valued flag swallow the flag after it', () => {
    // `--index --force` means "--index was given no value", not "--index=--force".
    const parsed = parseArgs(['--index', '--force'], ['index'])

    expect(stringFlag(parsed, 'index')).toBe('missing-value')
    expect(boolFlag(parsed, 'force')).toBe(true)
  })

  it('treats an undeclared flag as a switch, so the command can report it', () => {
    const parsed = parseArgs(['--frce', 'x'], ['index'])

    expect(boolFlag(parsed, 'frce')).toBe(true)
    // The value-taking rule is what keeps `x` a positional here rather than --frce's value.
    expect(parsed.positionals).toEqual(['x'])
    expect(unknownFlags(parsed, ['force', 'index'])).toEqual(['frce'])
  })

  it('collects positionals and stops flag parsing at --', () => {
    const parsed = parseArgs(['abc', '--out', 'f.md', '--', '--not-a-flag'], ['out'])

    expect(parsed.positionals).toEqual(['abc', '--not-a-flag'])
    expect(stringFlag(parsed, 'out')).toBe('f.md')
  })

  it('accepts an empty value after =', () => {
    expect(stringFlag(parseArgs(['--out='], ['out']), 'out')).toBe('')
  })

  it('reports nothing for a flag that was not given', () => {
    const parsed = parseArgs([], ['index'])

    expect(stringFlag(parsed, 'index')).toBeUndefined()
    expect(boolFlag(parsed, 'force')).toBe(false)
    expect(unknownFlags(parsed, [])).toEqual([])
  })
})

describe('parsePort', () => {
  it('accepts a port in range', () => {
    expect(parsePort('4317')).toBe(4317)
    expect(parsePort('1')).toBe(1)
    expect(parsePort('65535')).toBe(65535)
  })

  it('rejects 0 rather than binding an address nobody was told', () => {
    expect(parsePort('0')).toContain('out of range')
  })

  it('rejects out-of-range and non-numeric values', () => {
    expect(parsePort('65536')).toContain('out of range')
    expect(parsePort('-1')).toContain('not a number')
    expect(parsePort('4317x')).toContain('not a number')
    expect(parsePort('')).toContain('not a number')
  })
})
