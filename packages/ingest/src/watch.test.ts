import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeProjectFolderKey } from '@sightline/core'
import type { SightlineDatabase } from '@sightline/db'
import { listSessions, openDatabase, search } from '@sightline/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeStore } from './discover.js'
import { storeAt } from './discover.js'
import { scan } from './scan.js'
import type { IndexedEvent, Watcher } from './watch.js'
import { pollingOptionsFor, resolveWatchTarget, watch } from './watch.js'

let claudeDir: string
let store: ClaudeStore
let workspace: string
let db: SightlineDatabase
let watcher: Watcher | undefined

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), 'sightline-watch-'))
  store = storeAt(claudeDir)
  // chokidar cannot watch a directory that is not there yet, and a real `~/.claude` has
  // `projects/` before it has a transcript in it.
  mkdirSync(store.projectsRoot, { recursive: true })
  workspace = mkdtempSync(join(tmpdir(), 'sightline-wwork-'))
  db = openDatabase({ path: ':memory:' })
})

afterEach(async () => {
  await watcher?.close()
  watcher = undefined
  rmSync(claudeDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function makeRepo(name: string): string {
  const repo = join(workspace, name)
  mkdirSync(join(repo, '.git'), { recursive: true })
  return repo
}

const line = (value: unknown): string => JSON.stringify(value)

function conversation(cwd: string, text: string, timestamp = '2026-08-01T00:00:00.000Z') {
  return [
    { type: 'user', uuid: `u-${text}`, cwd, timestamp, message: { content: text } },
    {
      type: 'assistant',
      uuid: `a-${text}`,
      parentUuid: `u-${text}`,
      cwd,
      timestamp,
      // Deliberately does not echo `text`: these tests count full-text hits, and an
      // assistant reply repeating the prompt would double every one of them.
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'acknowledged' }] },
    },
  ]
}

function transcriptPath(cwd: string, sessionId: string): string {
  const dir = join(store.projectsRoot, encodeProjectFolderKey(cwd))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${sessionId}.jsonl`)
}

function writeRecords(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, `${records.map(line).join('\n')}\n`, 'utf8')
}

function appendRecords(filePath: string, records: unknown[]): void {
  appendFileSync(filePath, `${records.map(line).join('\n')}\n`, 'utf8')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `probe` returns something, so tests never depend on a fixed wait. */
async function eventually<T>(probe: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the watcher')
    await sleep(20)
  }
}

interface Harness {
  events: IndexedEvent[]
  errors: unknown[]
}

async function startWatching(options: { debounceMs?: number; maxDelayMs?: number } = {}) {
  const harness: Harness = { events: [], errors: [] }
  watcher = watch(db, {
    store,
    debounceMs: options.debounceMs ?? 40,
    maxDelayMs: options.maxDelayMs ?? 5_000,
    onIndexed: (event) => harness.events.push(event),
    onError: (error) => harness.errors.push(error),
  })
  await watcher.ready
  return harness
}

describe('resolveWatchTarget', () => {
  const root = join('/tmp', 'projects')

  it('maps a transcript to its own session', () => {
    expect(resolveWatchTarget(root, join(root, '-repo', 'sess-1.jsonl'))).toMatchObject({
      sessionId: 'sess-1',
      folderKey: '-repo',
      isSubagent: false,
    })
  })

  /**
   * The load-bearing case. Subagent work lives in sibling files, and the parent session's
   * aggregates are a function of the transcript *plus* its sidechains — so a sidechain
   * write has to re-index the parent, not register as a session of its own.
   */
  it('maps a subagent file to its parent session', () => {
    const changed = join(root, '-repo', 'sess-1', 'subagents', 'agent-abc.jsonl')
    expect(resolveWatchTarget(root, changed)).toEqual({
      sessionId: 'sess-1',
      folderKey: '-repo',
      filePath: join(root, '-repo', 'sess-1.jsonl'),
      isSubagent: true,
    })
  })

  it('maps a subagent meta file to its parent session', () => {
    const changed = join(root, '-repo', 'sess-1', 'subagents', 'agent-abc.meta.json')
    expect(resolveWatchTarget(root, changed)?.filePath).toBe(join(root, '-repo', 'sess-1.jsonl'))
  })

  it.each([
    ['a non-transcript file', join(root, '-repo', 'notes.txt')],
    ['a stray file at the root', join(root, 'stray.jsonl')],
    ['a non-agent file in subagents', join(root, '-repo', 's', 'subagents', 'other.jsonl')],
    ['an unknown nesting depth', join(root, '-repo', 's', 'deeper', 'x', 'y.jsonl')],
    ['a path outside the root', join('/tmp', 'elsewhere', 'x.jsonl')],
  ])('ignores %s', (_label, changed) => {
    expect(resolveWatchTarget(root, changed)).toBeUndefined()
  })
})

describe('watch', () => {
  it('indexes a transcript that appears after it started', async () => {
    const harness = await startWatching()
    const repo = makeRepo('r')

    writeRecords(transcriptPath(repo, 'session-a'), conversation(repo, 'alpha'))

    await eventually(() => harness.events.find((e) => e.sessionId === 'session-a'))
    expect(search(db, 'alpha')).toHaveLength(1)
    expect(harness.errors).toEqual([])
  })

  it('picks up messages appended to a transcript it already indexed', async () => {
    const repo = makeRepo('r')
    const filePath = transcriptPath(repo, 'session-a')
    writeRecords(filePath, conversation(repo, 'alpha'))
    scan(db, { store })

    const harness = await startWatching()
    appendRecords(filePath, conversation(repo, 'beta'))

    await eventually(() => harness.events.find((e) => e.sessionId === 'session-a'))
    expect(search(db, 'beta')).toHaveLength(1)
  })

  /**
   * A sidechain write leaves the parent transcript's size and mtime untouched, so the
   * signature check that makes scanning cheap would skip this forever. Watching without
   * this is watching that silently loses most of what a delegating session did.
   */
  it('re-indexes the parent session when a subagent file is written', async () => {
    const repo = makeRepo('r')
    const filePath = transcriptPath(repo, 'session-a')
    writeRecords(filePath, conversation(repo, 'alpha'))
    scan(db, { store })
    expect(listSessions(db)[0]?.subagentCount).toBe(0)

    const harness = await startWatching()
    const subagentDir = join(filePath.slice(0, -'.jsonl'.length), 'subagents')
    mkdirSync(subagentDir, { recursive: true })
    writeRecords(join(subagentDir, 'agent-xyz.jsonl'), conversation(repo, 'delegated'))

    await eventually(() => harness.events.find((e) => e.sessionId === 'session-a'))
    expect(listSessions(db)[0]?.subagentCount).toBe(1)
    expect(search(db, 'delegated')).toHaveLength(1)
  })

  it('coalesces a burst of appends into a single re-index', async () => {
    const repo = makeRepo('r')
    const filePath = transcriptPath(repo, 'session-a')
    writeRecords(filePath, conversation(repo, 'alpha'))
    scan(db, { store })

    const harness = await startWatching({ debounceMs: 250 })
    for (let i = 0; i < 5; i += 1) appendRecords(filePath, conversation(repo, `burst${i}`))

    await eventually(() => (harness.events.length > 0 ? harness.events : undefined))
    await sleep(300)
    expect(harness.events).toHaveLength(1)
    expect(search(db, 'burst4')).toHaveLength(1)
  })

  /**
   * A long agent run never goes quiet, and a pure debounce would therefore never fire —
   * the index would stall for exactly as long as something interesting was happening.
   * The debounce here is deliberately longer than the test's patience: only `maxDelayMs`
   * can produce an event while the appends are still coming.
   */
  it('still re-indexes a transcript that never stops being appended to', async () => {
    const repo = makeRepo('r')
    const filePath = transcriptPath(repo, 'session-a')
    writeRecords(filePath, conversation(repo, 'alpha'))
    scan(db, { store })

    const harness = await startWatching({ debounceMs: 10_000, maxDelayMs: 100 })
    let n = 0
    const ticker = setInterval(() => {
      n += 1
      appendRecords(filePath, conversation(repo, `tick${n}`))
    }, 25)

    try {
      await eventually(() => harness.events[0], 4_000)
    } finally {
      clearInterval(ticker)
    }
  })

  it('keeps indexed rows when a transcript is deleted', async () => {
    const repo = makeRepo('r')
    const filePath = transcriptPath(repo, 'session-a')
    writeRecords(filePath, conversation(repo, 'alpha'))
    scan(db, { store })

    await startWatching()
    unlinkSync(filePath)
    await sleep(300)

    expect(listSessions(db)).toHaveLength(1)
    expect(search(db, 'alpha')).toHaveLength(1)
  })

  it('stops indexing once closed', async () => {
    const repo = makeRepo('r')
    const harness = await startWatching()
    await watcher?.close()
    watcher = undefined

    writeRecords(transcriptPath(repo, 'session-a'), conversation(repo, 'alpha'))
    await sleep(300)

    expect(harness.events).toEqual([])
    expect(listSessions(db)).toEqual([])
  })

  /**
   * Catching a transcript mid-append is the normal case, not the exceptional one: the
   * watcher fires on a write that may have landed half a JSON line. A truncated tail must
   * cost that one line and nothing else.
   */
  it('indexes a transcript whose last line is still being written', async () => {
    const repo = makeRepo('r')
    const harness = await startWatching()
    const filePath = transcriptPath(repo, 'session-a')

    const records = conversation(repo, 'alpha').map(line).join('\n')
    writeFileSync(filePath, `${records}\n{"type":"user","uuid":"u-hal`, 'utf8')

    const event = await eventually(() => harness.events.find((e) => e.sessionId === 'session-a'))
    expect(event.malformedLines).toBe(1)
    expect(search(db, 'alpha')).toHaveLength(1)
    expect(harness.errors).toEqual([])
  })
})

/**
 * Verified on the reference machine (chokidar 5, Node 22, Windows 11): watching
 * `\wsl.localhost\Ubuntu-24.04\…` natively throws `EISDIR` twice and then reports zero
 * events for appends made inside the distro; the identical trial with `usePolling` caught
 * 2 of 2. Because `watch()` swallows watcher errors into `onError`, getting this wrong
 * looks exactly like a quiet session, so the choice is asserted rather than assumed.
 */
describe('pollingOptionsFor', () => {
  it('polls a WSL store, which cannot be watched natively over 9P', () => {
    expect(
      pollingOptionsFor(
        storeAt('\\wsl.localhostUbuntu-24.04homeme.claude', {
          host: 'wsl',
          distro: 'Ubuntu-24.04',
        }),
      ),
    ).toEqual({ usePolling: true, interval: expect.any(Number) })
  })

  it('leaves a local store on native events, which must not pay the polling cost', () => {
    expect(pollingOptionsFor(storeAt('C:Usersme.claude', { host: 'windows' }))).toEqual({})
    expect(pollingOptionsFor(storeAt('/home/me/.claude', { host: 'unix' }))).toEqual({})
  })
})
