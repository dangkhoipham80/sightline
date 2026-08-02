#!/usr/bin/env tsx
/**
 * Parse every transcript on this machine and report what the parser did with it.
 *
 *   pnpm --filter @sightline/core exec tsx scripts/check-corpus.ts [~/.claude/projects]
 *
 * This is the check that actually matters, and it deliberately isn't in CI — it needs
 * local data CI doesn't have. Run it before any parser PR and paste the output into the
 * PR body. Fixtures prove the parser handles the cases we already know about; the corpus
 * check is how we find the ones we don't.
 *
 * Pay attention to two numbers:
 *   - **malformed lines** should be 0, or explained (a live session's final line is
 *     legitimately truncated).
 *   - **unknown record types** should be 0. Anything listed there is a record type
 *     Claude Code has started emitting that we don't yet understand.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubagentInput } from '../src/parse/subagents.js'
import { agentIdFromFilename } from '../src/parse/subagents.js'
import { parseSession } from '../src/parse/transcript.js'

interface Totals {
  projects: number
  sessions: number
  bytes: number
  records: number
  messages: number
  subagents: number
  malformed: number
  orphans: number
  duplicateUuids: number
  cycles: number
  continuations: number
  unattachedSubagents: number
  unknownTypes: Map<string, number>
  versions: Map<string, number>
  failures: Array<{ file: string; error: string }>
}

function main(): void {
  const root = process.argv[2] ?? join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) {
    console.error(`no such directory: ${root}`)
    process.exit(1)
  }

  const totals: Totals = {
    projects: 0,
    sessions: 0,
    bytes: 0,
    records: 0,
    messages: 0,
    subagents: 0,
    malformed: 0,
    orphans: 0,
    duplicateUuids: 0,
    cycles: 0,
    continuations: 0,
    unattachedSubagents: 0,
    unknownTypes: new Map(),
    versions: new Map(),
    failures: [],
  }

  const started = process.hrtime.bigint()

  for (const projectDir of readdirSync(root, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue
    totals.projects += 1
    const projectPath = join(root, projectDir.name)

    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      checkSession(projectPath, entry.name, totals)
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  report(totals, elapsedMs, root)

  const fatal = totals.failures.length > 0
  process.exit(fatal ? 1 : 0)
}

function checkSession(projectPath: string, filename: string, totals: Totals): void {
  const filePath = join(projectPath, filename)
  const sessionId = filename.replace(/\.jsonl$/, '')

  try {
    const contents = readFileSync(filePath, 'utf8')
    totals.bytes += Buffer.byteLength(contents)
    const lines = contents.split('\n')

    const subagents: SubagentInput[] = []
    const subagentDir = join(projectPath, sessionId, 'subagents')
    if (existsSync(subagentDir)) {
      for (const name of readdirSync(subagentDir)) {
        const agentId = agentIdFromFilename(name)
        if (agentId === null) continue
        const metaPath = join(subagentDir, `agent-${agentId}.meta.json`)
        subagents.push({
          agentId,
          lines: readFileSync(join(subagentDir, name), 'utf8').split('\n'),
          ...(existsSync(metaPath) && { meta: JSON.parse(readFileSync(metaPath, 'utf8')) }),
        })
      }
    }

    const parsed = parseSession({ sessionId, lines, subagents })

    totals.sessions += 1
    totals.records += parsed.records.length
    totals.messages += parsed.summary.messageCount
    totals.subagents += parsed.subagents.length
    totals.malformed += parsed.summary.malformed.length
    totals.orphans += parsed.tree.orphanCount
    totals.duplicateUuids += parsed.tree.duplicateUuidCount
    totals.cycles += parsed.tree.cycleCount
    totals.unattachedSubagents += parsed.unattachedSubagentIds.length
    if (parsed.summary.continuesSessionId !== undefined) totals.continuations += 1

    const version = parsed.summary.version ?? 'unknown'
    totals.versions.set(version, (totals.versions.get(version) ?? 0) + 1)

    for (const record of parsed.records) {
      if (record.kind !== 'raw') continue
      const key = record.recordType === '' ? '(no type field)' : record.recordType
      totals.unknownTypes.set(key, (totals.unknownTypes.get(key) ?? 0) + 1)
    }
  } catch (error) {
    // Reaching here is itself the bug: the parser's contract is that it never throws.
    totals.failures.push({
      file: filePath,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
  }
}

function report(totals: Totals, elapsedMs: number, root: string): void {
  const mb = (totals.bytes / 1_048_576).toFixed(1)

  console.log(`corpus: ${root}`)
  console.log('')
  console.log(`  projects              ${totals.projects}`)
  console.log(`  sessions              ${totals.sessions}`)
  console.log(`  subagent transcripts  ${totals.subagents}`)
  console.log(`  bytes                 ${mb} MB`)
  console.log(`  records               ${totals.records.toLocaleString('en-US')}`)
  console.log(`  messages              ${totals.messages.toLocaleString('en-US')}`)
  console.log(`  elapsed               ${elapsedMs.toFixed(0)} ms`)
  console.log('')
  console.log(`  malformed lines       ${totals.malformed}`)
  console.log(`  orphaned parentUuid   ${totals.orphans}`)
  console.log(`  duplicate uuids       ${totals.duplicateUuids}`)
  console.log(`  broken cycles         ${totals.cycles}`)
  console.log(`  resume continuations  ${totals.continuations}`)
  console.log(`  unattached subagents  ${totals.unattachedSubagents}`)
  console.log('')

  console.log('  Claude Code versions seen:')
  for (const [version, count] of sorted(totals.versions)) {
    console.log(`    ${version.padEnd(12)} ${count}`)
  }
  console.log('')

  if (totals.unknownTypes.size === 0) {
    console.log('  unknown record types: none')
  } else {
    console.log('  unknown record types — the parser needs to learn these:')
    for (const [type, count] of sorted(totals.unknownTypes)) {
      console.log(`    ${type.padEnd(28)} ${count}`)
    }
  }
  console.log('')

  if (totals.failures.length === 0) {
    console.log('  OK — no file caused the parser to throw')
    return
  }

  console.log(`  FAILED — ${totals.failures.length} file(s) threw:`)
  for (const failure of totals.failures.slice(0, 20)) {
    console.log(`    ${failure.file}`)
    console.log(`      ${failure.error}`)
  }
}

function sorted(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

main()
