import { parseSession } from '@sightline/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SightlineDatabase } from './database.js'
import { getMeta, openDatabase, resetDerivedTables } from './database.js'
import {
  countSearchResults,
  findSessionsByTitle,
  getSession,
  getSessionSignature,
  listContinuations,
  listProjects,
  listSessions,
  search,
} from './queries.js'
import type { ProjectInput } from './writer.js'
import { upsertProject, writeSession } from './writer.js'

const line = (value: unknown): string => JSON.stringify(value)

function seedProject(db: SightlineDatabase, id = 'proj-1'): string {
  upsertProject(db, {
    id,
    realCwd: '/repo',
    folderKeys: ['-repo'],
    displayName: 'repo',
    hostKind: 'unix',
    orphaned: false,
  })
  return id
}

function seedSession(
  db: SightlineDatabase,
  projectId: string,
  sessionId: string,
  lines: string[],
  signature = { fileSize: 100, fileMtimeMs: 1000 },
): void {
  writeSession(db, {
    projectId,
    filePath: `/tmp/${sessionId}.jsonl`,
    fileSize: signature.fileSize,
    fileMtimeMs: signature.fileMtimeMs,
    parsed: parseSession({ sessionId, lines }),
  })
}

let db: SightlineDatabase

beforeEach(() => {
  db = openDatabase({ path: ':memory:' })
})

describe('migrations', () => {
  it('are idempotent', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
    openDatabase({ path: ':memory:' })
    const after = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('records the schema version', () => {
    expect(getMeta(db, 'schema_version')).toBe('1')
  })

  it('enables foreign keys so deleting a session removes its rows', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
    ])

    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})

describe('upsertProject', () => {
  const base: ProjectInput = {
    id: 'proj-1',
    realCwd: '/repo',
    displayName: 'repo',
    folderKeys: ['-repo'],
    hostKind: 'unix',
    orphaned: false,
  }

  /**
   * The watcher re-indexes one session at a time and can only name that session's folder
   * key. Replacing the stored set would collapse a repository worked on from three
   * directories down to whichever one happened to change last.
   */
  it('accumulates folder keys across calls instead of replacing them', () => {
    upsertProject(db, { ...base, folderKeys: ['-repo'] })
    upsertProject(db, { ...base, folderKeys: ['-repo-mobile'] })
    upsertProject(db, { ...base, folderKeys: ['-repo-api'] })
    // A key already stored must not be duplicated.
    upsertProject(db, { ...base, folderKeys: ['-repo'] })

    expect(listProjects(db)[0]?.folderKeys).toEqual(['-repo', '-repo-api', '-repo-mobile'])
  })

  it('keeps a known repo URL when a later call has none', () => {
    upsertProject(db, { ...base, repoUrl: 'https://github.com/acme/repo.git' })
    upsertProject(db, base)

    expect(listProjects(db)[0]?.repoUrl).toBe('https://github.com/acme/repo.git')
  })
})

describe('writeSession', () => {
  it('is idempotent — rewriting replaces rather than duplicates', () => {
    const projectId = seedProject(db)
    const lines = [
      line({ type: 'user', uuid: 'u1', message: { content: 'first' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [] } }),
    ]

    seedSession(db, projectId, 's1', lines)
    seedSession(db, projectId, 's1', lines)

    const counts = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(counts.n).toBe(2)
    expect(listSessions(db)).toHaveLength(1)
  })

  it('stores attachments so parent_uuid chains stay walkable in SQL', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'u1', message: { content: 'prompt' } }),
      line({ type: 'attachment', uuid: 'att', parentUuid: 'u1', attachment: { type: 'x' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'att', message: { content: [] } }),
    ])

    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
          WHERE m.parent_uuid IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.uuid = m.parent_uuid)`,
      )
      .get() as { n: number }
    expect(orphans.n).toBe(0)
  })

  it('does not store file-history-snapshot records', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'real', message: { content: 'x' } }),
      line({ type: 'file-history-snapshot', messageId: 'real' }),
    ])

    const kinds = db.prepare('SELECT DISTINCT kind FROM messages').all() as Array<{ kind: string }>
    expect(kinds.map((k) => k.kind)).toEqual(['user'])
  })

  it('records tool calls and flags the ones whose result came back as an error', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } },
            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }],
        },
      }),
    ])

    const rows = db
      .prepare('SELECT id, name, is_error FROM tool_calls ORDER BY id')
      .all() as Array<{ id: string; name: string; is_error: number }>

    expect(rows).toEqual([
      { id: 't1', name: 'Edit', is_error: 0 },
      { id: 't2', name: 'Bash', is_error: 1 },
    ])
  })

  it('tracks project activity from session timestamps, not from scan time', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-01T00:00:00Z',
        message: { content: 'a' },
      }),
    ])
    seedSession(db, projectId, 's2', [
      line({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-08-01T00:00:00Z',
        message: { content: 'b' },
      }),
    ])

    const project = listProjects(db)[0]
    expect(project?.firstSeen).toBe('2026-07-01T00:00:00Z')
    expect(project?.lastActive).toBe('2026-08-01T00:00:00Z')
    expect(project?.sessionCount).toBe(2)
  })

  it('exposes the file signature used to skip unchanged transcripts', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [], { fileSize: 4242, fileMtimeMs: 999 })
    expect(getSessionSignature(db, 's1')).toEqual({ fileSize: 4242, fileMtimeMs: 999 })
    expect(getSessionSignature(db, 'never-seen')).toBeUndefined()
  })
})

describe('getSession', () => {
  it('returns the row with the transcript path a viewer needs to re-read it', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
    ])

    expect(getSession(db, 's1')?.filePath).toBe('/tmp/s1.jsonl')
  })

  it('returns undefined for an id it has never seen, rather than throwing', () => {
    expect(getSession(db, 'nope')).toBeUndefined()
  })
})

describe('listContinuations', () => {
  /**
   * A resumed session is a *new* file whose first record still carries the old id. The
   * viewer needs the link in both directions, or one stretch of work reads as several
   * unrelated sessions that each stop mid-thought.
   */
  it('finds the sessions that continue a given one, oldest first', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 'original', [
      line({ type: 'user', uuid: 'u1', message: { content: 'start' } }),
    ])

    for (const [id, ts] of [
      ['later', '2026-08-02T00:00:00Z'],
      ['sooner', '2026-08-01T00:00:00Z'],
    ] as const) {
      seedSession(db, projectId, id, [
        line({
          type: 'user',
          uuid: `u-${id}`,
          sessionId: 'original',
          timestamp: ts,
          message: { content: 'resumed' },
        }),
      ])
    }

    expect(listContinuations(db, 'original').map((s) => s.id)).toEqual(['sooner', 'later'])
    expect(listContinuations(db, 'later')).toEqual([])
  })
})

describe('search', () => {
  beforeEach(() => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'u1', message: { content: 'fix the auth redirect loop' } }),
      line({ type: 'user', uuid: 'u2', message: { content: 'deploy the staging database' } }),
    ])
  })

  it('finds messages by keyword and reports where they came from', () => {
    const hits = search(db, 'redirect')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.messageUuid).toBe('u1')
    expect(hits[0]?.projectName).toBe('repo')
    expect(hits[0]?.snippet).toContain('«redirect»')
  })

  it('stems, so a search for a related form still matches', () => {
    expect(search(db, 'deployed')).toHaveLength(1)
  })

  /**
   * FTS5 external-content tables keep their own copy of the index. If the delete trigger
   * is missing or wrong, removed messages keep matching forever — a failure that is
   * completely invisible until someone searches for something they deleted.
   */
  it('drops messages from the index when their session is deleted', () => {
    expect(search(db, 'redirect')).toHaveLength(1)
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(search(db, 'redirect')).toHaveLength(0)
  })

  it('re-indexes cleanly after a rewrite of the same session', () => {
    const projectId = 'proj-1'
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'u1', message: { content: 'completely different words' } }),
    ])
    expect(search(db, 'redirect')).toHaveLength(0)
    expect(search(db, 'different')).toHaveLength(1)
  })

  it('scopes to a project when asked', () => {
    upsertProject(db, {
      id: 'proj-2',
      realCwd: '/other',
      folderKeys: [],
      displayName: 'other',
      hostKind: 'unix',
      orphaned: false,
    })
    seedSession(db, 'proj-2', 's2', [
      line({ type: 'user', uuid: 'x1', message: { content: 'redirect elsewhere' } }),
    ])

    expect(search(db, 'redirect')).toHaveLength(2)
    expect(search(db, 'redirect', { projectId: 'proj-2' })).toHaveLength(1)
  })
})

describe('search, on input a person actually types', () => {
  beforeEach(() => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'u1', message: { content: 'the c++ interop notes' } }),
      line({ type: 'user', uuid: 'u2', message: { content: 'fix the auth redirect loop' } }),
    ])
  })

  /**
   * These raise when handed to FTS5 verbatim. A search box is precisely where they get
   * typed, and `a-b` fails with "no such column: b" — which reads like a bug in Sightline.
   */
  it.each(['c++', 'a-b', 'fix"', '"unbalanced', 'auth OR', 'NOT auth', '*', '--', '('])(
    'does not raise on %j',
    (query) => {
      expect(() => search(db, query)).not.toThrow()
      expect(() => countSearchResults(db, query)).not.toThrow()
    },
  )

  it('finds a term FTS5 would choke on', () => {
    expect(search(db, 'c++').map((h) => h.messageUuid)).toEqual(['u1'])
  })

  it('returns nothing for a query with nothing searchable in it', () => {
    expect(search(db, '   ')).toEqual([])
    expect(search(db, '---')).toEqual([])
    expect(countSearchResults(db, '---')).toBe(0)
  })

  it('carries the context a result needs to be worth clicking', () => {
    const [hit] = search(db, 'redirect')
    expect(hit).toMatchObject({
      messageUuid: 'u2',
      projectName: 'repo',
      isSidechain: false,
    })
    expect(hit?.seq).toBeGreaterThanOrEqual(0)
  })

  it('counts every match, not just the page returned', () => {
    expect(search(db, 'the', { limit: 1 })).toHaveLength(1)
    expect(countSearchResults(db, 'the')).toBe(2)
  })

  it('pages without repeating a result', () => {
    const first = search(db, 'the', { limit: 1, offset: 0 })
    const second = search(db, 'the', { limit: 1, offset: 1 })
    expect(first[0]?.messageUuid).not.toBe(second[0]?.messageUuid)
  })

  it('completes the last word when asked, for search-as-you-type', () => {
    expect(search(db, 'redirec')).toEqual([])
    expect(search(db, 'redirec', { prefixLastTerm: true })).toHaveLength(1)
  })

  it('scopes to one session', () => {
    seedSession(db, 'proj-1', 's2', [
      line({ type: 'user', uuid: 'x1', message: { content: 'another redirect entirely' } }),
    ])
    expect(search(db, 'redirect')).toHaveLength(2)
    expect(search(db, 'redirect', { sessionId: 's2' })).toHaveLength(1)
  })
})

describe('findSessionsByTitle', () => {
  beforeEach(() => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'ai-title', aiTitle: 'Fix the auth redirect loop' }),
      line({ type: 'user', uuid: 'u1', message: { content: 'unrelated body text' } }),
    ])
  })

  it('finds a session by part of its title', () => {
    expect(findSessionsByTitle(db, 'redirect').map((s) => s.id)).toEqual(['s1'])
    expect(findSessionsByTitle(db, 'auth red').map((s) => s.id)).toEqual(['s1'])
  })

  it('is case-insensitive, because nobody types the title back exactly', () => {
    expect(findSessionsByTitle(db, 'FIX THE AUTH')).toHaveLength(1)
  })

  /** A bare `%` would otherwise match every session and look like a broken search. */
  it('treats LIKE wildcards as literal characters', () => {
    expect(findSessionsByTitle(db, '%')).toHaveLength(0)
    expect(findSessionsByTitle(db, '_')).toHaveLength(0)
  })

  it('returns nothing for an empty query rather than everything', () => {
    expect(findSessionsByTitle(db, '   ')).toEqual([])
  })
})

describe('resetDerivedTables', () => {
  it('empties the index and leaves no stale search postings behind', () => {
    const projectId = seedProject(db)
    seedSession(db, projectId, 's1', [
      line({ type: 'user', uuid: 'u1', message: { content: 'searchable' } }),
    ])

    resetDerivedTables(db)

    expect(listProjects(db)).toHaveLength(0)
    expect(listSessions(db)).toHaveLength(0)
    expect(search(db, 'searchable')).toHaveLength(0)
  })
})
