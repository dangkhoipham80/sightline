#!/usr/bin/env tsx
/**
 * Turn a real Claude Code transcript into a committable test fixture.
 *
 *   pnpm --filter @sightline/core exec tsx scripts/anonymise-fixture.ts \
 *     ~/.claude/projects/<folder>/<session>.jsonl \
 *     src/__fixtures__/<case-name> [--keep-text] [--lines 1-8,40-44]
 *
 * The contract, in priority order:
 *
 *   1. **Structure is preserved exactly.** Same record types, same uuid graph, same tool
 *      names, same usage numbers. A fixture that has been structurally "tidied" no longer
 *      tests anything real.
 *   2. **Nothing identifying survives.** Usernames, hostnames, emails, repo URLs, account
 *      identifiers and anything that looks like a credential are rewritten
 *      deterministically.
 *   3. **Prose is replaced by default.** Transcripts are conversations about real work;
 *      even in a private repo, committing them verbatim is a bad default. `--keep-text`
 *      opts out when the content is genuinely benign and the test needs it.
 *
 * `--lines` selects a subset of source lines, 1-based and inclusive, in source order. It
 * exists because some record types only ever appear in long sessions — the five
 * artifact/bridge types added around `2.1.238` live in a 970-line transcript, and a
 * 970-line fixture is one nobody will ever read. The README records the exact range so the
 * capture stays reproducible. Selecting whole lines is the *only* permitted way to shrink
 * a fixture; rewriting the contents of one is what rule 3 in `CLAUDE.md` forbids.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-REDACTED000000000000'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'ghp_REDACTED0000000000000000000000000000'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIAREDACTED00000000'],
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    'eyJREDACTED.REDACTED.REDACTED',
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY-----REDACTED-----END PRIVATE KEY-----',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'dev@example.com'],
  [/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g, 'https://github.com/acme/example'],
  [/\bgit@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g, 'git@github.com:acme/example'],
  // `gh api repos/<owner>/<repo>/…` and `gh pr view <owner>/<repo>` carry the account
  // name without ever spelling out github.com, so the URL rules above miss them.
  [/\brepos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g, 'repos/acme/example'],
]

/**
 * Keys whose *value* identifies an account rather than a conversation.
 *
 * Session, message and artifact uuids are random per-session and carry nothing, so they
 * survive — the fixture's uuid graph has to stay joinable. These four do not: they are
 * stable across every session the owner ever ran, so committing one publishes a durable
 * handle on the account. `bridge-session` records carry three of them on a single line.
 */
const IDENTITY_KEYS = new Set([
  'accountUuid',
  'ownerAccountUuid',
  'ownerOrganizationUuid',
  'bridgeSessionId',
])

/** Keys with a canonical stand-in, where preserving the *shape* matters more than length. */
const FIXED_VALUES = new Map([['prRepository', 'acme/example']])

/** A deterministic keystream long enough that a 1 KB signature doesn't visibly repeat. */
function keystream(seed: string, length: number): Buffer {
  const chunks: Buffer[] = []
  for (let i = 0; chunks.length * 64 < length; i += 1) {
    chunks.push(createHash('sha512').update(`${seed}:${i}`).digest())
  }
  return Buffer.concat(chunks)
}

/**
 * A `thinking` block's `signature` is base64 protobuf, and the organization uuid is
 * *inside* it — `Buffer.from(sig, 'base64')` recovers it as plain text. Every string rule
 * above operates on the encoded form and so sails straight past it.
 *
 * We replace the whole blob rather than trying to rewrite its innards: the parser drops
 * `signature` on read (trap 12), so nothing downstream can tell the difference. Length is
 * preserved because the one property a test might legitimately assert about a signature is
 * that it is long enough to be worth not counting.
 */
function scrubSignature(value: string): string {
  const stream = keystream(`signature:${value}`, value.length)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    out += alphabet[(stream[i] ?? 0) % alphabet.length]
  }
  return out
}

/**
 * A deterministic stand-in of the same shape, so schema tests still see a uuid where a
 * uuid was and a `cse_`-prefixed opaque id where one of those was.
 */
function surrogate(value: string): string {
  const digest = keystream(`surrogate:${value}`, Math.max(64, value.length))
  const hex = digest.toString('hex')

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  }

  // Everything else: keep any `prefix_` and the overall length, replace the rest.
  const underscore = value.indexOf('_')
  const prefix = underscore > 0 ? value.slice(0, underscore + 1) : ''
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < value.length - prefix.length; i += 1) {
    out += alphabet[(digest[i % digest.length] ?? 0) % alphabet.length]
  }
  return prefix + out
}

/** Identity fragments discovered in paths, rewritten wherever else they appear. */
function identityReplacements(source: string): Array<[RegExp, string]> {
  const found = new Set<string>()

  for (const match of source.matchAll(/(?:home|Users)[\\/]{1,2}([A-Za-z0-9._-]+)/g)) {
    const name = match[1]
    if (name !== undefined && name.length > 1) found.add(name)
  }

  return [...found]
    .sort((a, b) => b.length - a.length) // longest first, so substrings don't clobber
    .map((name) => [new RegExp(escapeRegExp(name), 'g'), 'dev'] as [RegExp, string])
}

const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split(
  ' ',
)

/**
 * Replace prose with deterministic filler of comparable shape. Word count and rough
 * length are preserved so that anything measuring size still measures something real.
 */
function scrubProse(value: string): string {
  if (value.length === 0) return value
  const seed = createHash('sha256').update(value).digest()
  const words = value.split(/\s+/).length

  const out: string[] = []
  for (let i = 0; i < words; i += 1) {
    const byte = seed[i % seed.length] ?? 0
    out.push(FILLER[byte % FILLER.length] ?? 'lorem')
  }
  return out.join(' ')
}

function scrubValue(
  value: unknown,
  replacements: Array<[RegExp, string]>,
  keepText: boolean,
  proseKey: boolean,
): unknown {
  if (typeof value === 'string') {
    let out = value
    for (const [pattern, replacement] of replacements) out = out.replace(pattern, replacement)
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
    if (proseKey && !keepText) out = scrubProse(out)
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, replacements, keepText, proseKey))
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        const fixed = FIXED_VALUES.get(key)
        if (fixed !== undefined) {
          out[key] = fixed
          continue
        }
        if (IDENTITY_KEYS.has(key)) {
          out[key] = surrogate(item)
          continue
        }
        if (key === 'signature') {
          out[key] = scrubSignature(item)
          continue
        }
      }
      // `text`, `thinking` and free-form content are prose. Paths, ids, tool names and
      // numbers are structure and must survive untouched. `stdout`/`stderr` are prose too:
      // a tool result is the output of the owner's real work, not transcript structure.
      const isProse =
        key === 'text' ||
        key === 'thinking' ||
        key === 'content' ||
        key === 'lastPrompt' ||
        key === 'aiTitle' ||
        key === 'summary' ||
        key === 'title' ||
        key === 'stdout' ||
        key === 'stderr' ||
        key === 'description'
      out[key] = scrubValue(item, replacements, keepText, isProse && typeof item === 'string')
    }
    return out
  }
  return value
}

function main(): void {
  const [inputPath, outputDir, ...flags] = process.argv.slice(2)
  if (inputPath === undefined || outputDir === undefined) {
    console.error(
      'usage: anonymise-fixture.ts <transcript.jsonl> <output-dir> [--keep-text] [--lines 1-8,40] [--replace old=new ...]',
    )
    process.exit(1)
  }
  const keepText = flags.includes('--keep-text')
  const lineSpec = flags[flags.indexOf('--lines') + 1]
  const selected = flags.includes('--lines') ? parseLineSpec(lineSpec ?? '') : null

  // Project and company names live in paths, so they survive identity scrubbing. Pass
  // them explicitly — the fixture only needs a plausible path shape, not the real one.
  const extra: Array<[RegExp, string]> = []
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] !== '--replace') continue
    const pair = flags[i + 1] ?? ''
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    extra.push([new RegExp(escapeRegExp(pair.slice(0, eq)), 'g'), pair.slice(eq + 1)])
  }

  const source = readFileSync(inputPath, 'utf8')
  const replacements = [...extra, ...identityReplacements(source)]
  const lines = source.split('\n')

  const out: string[] = []
  let malformed = 0
  const kinds = new Map<string, number>()
  let version = 'unknown'

  for (const [index, line] of lines.entries()) {
    if (selected !== null && !selected.has(index + 1)) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformed += 1
      out.push(trimmed) // keep it — malformed lines are a case worth testing
      continue
    }
    const scrubbed = scrubValue(parsed, replacements, keepText, false) as Record<string, unknown>
    const type = typeof scrubbed.type === 'string' ? scrubbed.type : 'unknown'
    kinds.set(type, (kinds.get(type) ?? 0) + 1)
    if (typeof scrubbed.version === 'string') version = scrubbed.version
    out.push(JSON.stringify(scrubbed))
  }

  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'transcript.jsonl'), `${out.join('\n')}\n`, 'utf8')

  // Subagent transcripts sit in a sibling directory named after the session. They are
  // where most of the real work is, so a fixture without them tests half the parser.
  const subagentDir = join(dirname(inputPath), basename(inputPath, '.jsonl'), 'subagents')
  let subagentCount = 0
  if (existsSync(subagentDir)) {
    const outDir = join(outputDir, 'subagents')
    mkdirSync(outDir, { recursive: true })
    for (const name of readdirSync(subagentDir)) {
      const contents = readFileSync(join(subagentDir, name), 'utf8')
      if (name.endsWith('.jsonl')) {
        subagentCount += 1
        const scrubbedLines = contents
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return JSON.stringify(scrubValue(JSON.parse(line), replacements, keepText, false))
            } catch {
              return line.trim()
            }
          })
        writeFileSync(join(outDir, name), `${scrubbedLines.join('\n')}\n`, 'utf8')
      } else {
        const scrubbed = scrubValue(JSON.parse(contents), replacements, keepText, false)
        writeFileSync(join(outDir, name), JSON.stringify(scrubbed, null, 2), 'utf8')
      }
    }
  }

  const breakdown = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `| \`${type}\` | ${count} |`)
    .join('\n')

  writeFileSync(
    join(outputDir, 'README.md'),
    `# Fixture: ${basename(outputDir)}

Derived from a real Claude Code transcript via \`scripts/anonymise-fixture.ts\`.
Structure is byte-for-byte faithful; identities, credentials and prose are not.

- Claude Code version: \`${version}\`
- Lines: ${out.length} (${malformed} deliberately malformed)${
      selected === null
        ? ''
        : `\n- Source lines selected: \`--lines ${lineSpec}\` of ${lines.length}`
    }
- Prose: ${keepText ? 'kept' : 'replaced with deterministic filler'}
- Subagent transcripts: ${subagentCount}

| Record type | Count |
| --- | ---: |
${breakdown}

## What this fixture is here to prove

<!-- Fill this in. A fixture without a stated purpose gets deleted in six months. -->
`,
    'utf8',
  )

  console.log(`wrote ${out.length} lines to ${outputDir}`)
}

/** `"1-8,40,44-46"` → the set `{1..8, 40, 44, 45, 46}`, 1-based and inclusive. */
function parseLineSpec(spec: string): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [fromRaw, toRaw] = part.trim().split('-')
    const from = Number.parseInt(fromRaw ?? '', 10)
    if (!Number.isFinite(from)) continue
    const to = toRaw === undefined ? from : Number.parseInt(toRaw, 10)
    for (let n = from; n <= (Number.isFinite(to) ? to : from); n += 1) out.add(n)
  }
  if (out.size === 0) {
    console.error(`--lines: nothing selected from ${JSON.stringify(spec)}`)
    process.exit(1)
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

main()
