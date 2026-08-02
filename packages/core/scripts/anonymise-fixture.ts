#!/usr/bin/env tsx
/**
 * Turn a real Claude Code transcript into a committable test fixture.
 *
 *   pnpm --filter @sightline/core exec tsx scripts/anonymise-fixture.ts \
 *     ~/.claude/projects/<folder>/<session>.jsonl \
 *     src/__fixtures__/<case-name> [--keep-text]
 *
 * The contract, in priority order:
 *
 *   1. **Structure is preserved exactly.** Same line count, same record types, same uuid
 *      graph, same tool names, same usage numbers. A fixture that has been structurally
 *      "tidied" no longer tests anything real.
 *   2. **Nothing identifying survives.** Usernames, hostnames, emails, repo URLs and
 *      anything that looks like a credential are rewritten deterministically.
 *   3. **Prose is replaced by default.** Transcripts are conversations about real work;
 *      even in a private repo, committing them verbatim is a bad default. `--keep-text`
 *      opts out when the content is genuinely benign and the test needs it.
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
]

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
      // `text`, `thinking` and free-form content are prose. Paths, ids, tool names and
      // numbers are structure and must survive untouched.
      const isProse =
        key === 'text' ||
        key === 'thinking' ||
        key === 'content' ||
        key === 'lastPrompt' ||
        key === 'aiTitle' ||
        key === 'summary' ||
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
      'usage: anonymise-fixture.ts <transcript.jsonl> <output-dir> [--keep-text] [--replace old=new ...]',
    )
    process.exit(1)
  }
  const keepText = flags.includes('--keep-text')

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

  for (const line of lines) {
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
- Lines: ${out.length} (${malformed} deliberately malformed)
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

main()
