import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { encodeProjectFolderKey } from '@sightline/core'
import { openDatabase, type SightlineDatabase } from '@sightline/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scan } from './scan.js'

/**
 * Rule 2 in `CLAUDE.md`, enforced rather than asserted in prose: **Sightline never writes
 * to Claude Code's data directory.**
 *
 * This used to be checked in CI by grepping source for `writeFile` near the string
 * `.claude`. That check could not work — it fired on a *comment* in `watch.ts` explaining
 * why there is deliberately no `unlink` handler, and it would equally have missed a real
 * write built from a variable. A heuristic over source text cannot answer a question
 * about runtime behaviour.
 *
 * So this does the only thing that actually settles it: builds a directory shaped like a
 * real `~/.claude`, fingerprints every byte in it, runs a full ingest over it, and
 * fingerprints again. Any write, truncation, deletion or touch shows up as a diff.
 */

let claudeDir: string
let db: SightlineDatabase

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), 'sightline-readonly-'))
  db = openDatabase({ path: ':memory:' })
})

afterEach(() => {
  rmSync(claudeDir, { recursive: true, force: true })
})

interface Fingerprint {
  size: number
  mtimeMs: number
  sha256: string
}

/** Every file under `dir`, keyed by its path relative to `dir`. */
function fingerprint(dir: string): Map<string, Fingerprint> {
  const files = new Map<string, Fingerprint>()

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      const stats = statSync(path)
      files.set(relative(dir, path), {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      })
    }
  }

  walk(dir)
  return files
}

const line = (value: unknown): string => JSON.stringify(value)

/**
 * Lay out a `~/.claude` the way Claude Code does, including the parts ingest has no
 * business touching: settings, the prompt log, file-history backups, and the live session
 * registry. A check that only covers transcripts would miss the writes most worth fearing.
 */
function buildClaudeDirectory(): void {
  const cwd = 'D:\\deleted-project'
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const projectDir = join(claudeDir, 'projects', encodeProjectFolderKey(cwd))
  const subagentDir = join(projectDir, sessionId, 'subagents')

  mkdirSync(subagentDir, { recursive: true })
  mkdirSync(join(claudeDir, 'file-history', 'abc'), { recursive: true })
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true })

  const timestamp = '2026-08-01T00:00:00.000Z'
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    `${[
      { type: 'user', uuid: 'u-1', cwd, timestamp, message: { content: 'hello' } },
      {
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: 'u-1',
        cwd,
        timestamp,
        message: {
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 't-1', name: 'Task', input: {} }],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      },
      { type: 'ai-title', aiTitle: 'a read-only session' },
    ]
      .map(line)
      .join('\n')}\n`,
    'utf8',
  )

  writeFileSync(
    join(subagentDir, 'agent-aaa111.jsonl'),
    `${line({
      type: 'assistant',
      uuid: 's-1',
      isSidechain: true,
      agentId: 'aaa111',
      cwd,
      timestamp,
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'sidechain' }] },
    })}\n`,
    'utf8',
  )
  writeFileSync(
    join(subagentDir, 'agent-aaa111.meta.json'),
    line({ agentType: 'general-purpose', toolUseId: 't-1', spawnDepth: 1 }),
    'utf8',
  )

  writeFileSync(join(claudeDir, 'settings.json'), line({ cleanupPeriodDays: 30 }), 'utf8')
  writeFileSync(join(claudeDir, 'history.jsonl'), `${line({ display: 'hello' })}\n`, 'utf8')
  writeFileSync(join(claudeDir, 'file-history', 'abc', 'deadbeef@v1'), 'before the edit', 'utf8')
  writeFileSync(
    join(claudeDir, 'sessions', '4242.json'),
    line({ pid: 4242, sessionId, cwd, status: 'busy' }),
    'utf8',
  )
}

describe("Claude Code's data directory", () => {
  it('is byte-for-byte unchanged by a full ingest', () => {
    buildClaudeDirectory()
    const before = fingerprint(claudeDir)
    // A directory worth checking: if the fixture ever stops being written, an empty
    // comparison would pass vacuously and this test would guard nothing.
    expect(before.size).toBeGreaterThan(5)

    const result = scan(db, { root: join(claudeDir, 'projects') })
    expect(result.ingested).toBe(1)
    expect(result.failed).toEqual([])

    const after = fingerprint(claudeDir)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, fingerprintBefore] of before) {
      expect(after.get(path), path).toEqual(fingerprintBefore)
    }
  })

  it('is still unchanged by a forced re-ingest, which reparses instead of skipping', () => {
    buildClaudeDirectory()
    scan(db, { root: join(claudeDir, 'projects') })
    const before = fingerprint(claudeDir)

    // `force` is the path that does the most work per file, so it is the one most likely
    // to touch something. Without it a second scan skips on the size+mtime signature and
    // proves considerably less.
    const result = scan(db, { root: join(claudeDir, 'projects'), force: true })
    expect(result.ingested).toBe(1)
    expect(result.skipped).toBe(0)

    expect(fingerprint(claudeDir)).toEqual(before)
  })
})
