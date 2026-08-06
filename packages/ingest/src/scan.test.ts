import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeProjectFolderKey } from '@sightline/core'
import type { SightlineDatabase } from '@sightline/db'
import { listProjects, listSessions, openDatabase, search } from '@sightline/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scan } from './scan.js'

let root: string
let workspace: string
let db: SightlineDatabase

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sightline-scan-'))
  workspace = mkdtempSync(join(tmpdir(), 'sightline-work-'))
  db = openDatabase({ path: ':memory:' })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** Create a real directory tree so git-root resolution has something to find. */
function makeRepo(name: string, subdirs: string[] = []): string {
  const repo = join(workspace, name)
  mkdirSync(join(repo, '.git'), { recursive: true })
  for (const sub of subdirs) mkdirSync(join(repo, sub), { recursive: true })
  return repo
}

const line = (value: unknown): string => JSON.stringify(value)

/** Write a transcript into the fake projects root exactly as Claude Code lays it out. */
function writeTranscript(cwd: string, sessionId: string, records: unknown[]): string {
  const folderKey = encodeProjectFolderKey(cwd)
  const dir = join(root, folderKey)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${sessionId}.jsonl`)
  writeFileSync(filePath, `${records.map(line).join('\n')}\n`, 'utf8')
  return filePath
}

function conversation(cwd: string, text: string, timestamp = '2026-08-01T00:00:00.000Z') {
  return [
    { type: 'user', uuid: `u-${text}`, cwd, timestamp, message: { content: text } },
    {
      type: 'assistant',
      uuid: `a-${text}`,
      parentUuid: `u-${text}`,
      cwd,
      timestamp,
      message: {
        model: 'claude-opus-5',
        content: [
          { type: 'tool_use', id: `t-${text}`, name: 'Edit', input: { file_path: '/x.ts' } },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    },
  ]
}

describe('scan', () => {
  it('indexes discovered transcripts', () => {
    writeTranscript(makeRepo('r'), 'session-a', conversation(makeRepo('r'), 'alpha'))

    const result = scan(db, { root })

    expect(result.discovered).toBe(1)
    expect(result.ingested).toBe(1)
    expect(result.failed).toEqual([])
    expect(listSessions(db)).toHaveLength(1)
    expect(search(db, 'alpha')).toHaveLength(1)
  })

  /**
   * The headline behaviour. Claude Code creates a separate folder key per working
   * directory, so one repository worked on from its root, a subpackage and a mobile app
   * directory produces three folders. Grouping on the folder key would show three
   * unrelated projects; grouping on the resolved path shows the one that exists.
   */
  it('folds several folder keys of one repository into a single project', () => {
    const repo = makeRepo('app', ['mobile', 'api'])
    writeTranscript(repo, 'session-root', conversation(repo, 'root'))
    writeTranscript(
      join(repo, 'mobile'),
      'session-mobile',
      conversation(join(repo, 'mobile'), 'mobile'),
    )
    writeTranscript(join(repo, 'api'), 'session-api', conversation(join(repo, 'api'), 'api'))

    const result = scan(db, { root })

    const projects = listProjects(db)
    expect(projects).toHaveLength(1)
    expect(projects[0]?.sessionCount).toBe(3)
    expect(projects[0]?.folderKeys).toHaveLength(3)
    expect(projects[0]?.displayName).toBe('app')
    // The reported count is projects, not resolved directories — three cwds, one project.
    expect(result.projects).toBe(1)
  })

  it('keeps genuinely separate repositories apart', () => {
    const one = makeRepo('repo-one')
    const two = makeRepo('repo-two')
    writeTranscript(one, 'session-1', conversation(one, 'one'))
    writeTranscript(two, 'session-2', conversation(two, 'two'))

    scan(db, { root })
    expect(listProjects(db)).toHaveLength(2)
  })

  it('does not confuse a sibling whose name shares a prefix', () => {
    const repo = makeRepo('repo')
    const repo2 = makeRepo('repo2')
    writeTranscript(repo, 'session-1', conversation(repo, 'one'))
    writeTranscript(repo2, 'session-2', conversation(repo2, 'two'))

    scan(db, { root })
    expect(listProjects(db)).toHaveLength(2)
  })

  /**
   * Found by reading real scan output rather than by reasoning: `~/code/App_BlueOne_v2`
   * contains no `.git`, but `App_BlueOne_v2/blueone-v1` does. A session that started in
   * the container and moved into the repo was being filed under the empty container.
   */
  it('files a session under the repository it moved into, not the container it started in', () => {
    const container = join(workspace, 'container')
    mkdirSync(container, { recursive: true })
    const repo = makeRepo(join('container', 'inner'))

    writeTranscript(container, 'session-a', [
      { type: 'user', uuid: 'u1', cwd: container, message: { content: 'start here' } },
      { type: 'user', uuid: 'u2', cwd: repo, message: { content: 'work happens here' } },
    ])

    scan(db, { root })

    const projects = listProjects(db)
    expect(projects).toHaveLength(1)
    expect(projects[0]?.displayName).toBe('inner')
  })

  it('reads the repo URL out of .git/config', () => {
    const repo = makeRepo('app')
    writeFileSync(
      join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/app.git\n',
      'utf8',
    )
    writeTranscript(repo, 'session-1', conversation(repo, 'one'))

    scan(db, { root })
    expect(listProjects(db)[0]?.repoUrl).toBe('https://github.com/acme/app.git')
  })

  /**
   * The config above is the shape nobody actually has: one section, nothing after it. Any
   * repo with a branch checked out has stanzas following the remote, and the URL pattern
   * used to run straight past the newline and capture all of them — so `repoUrl` came out
   * as the entire tail of the file and the project page rendered it in full.
   */
  it('stops the repo URL at the end of its line, not the end of the file', () => {
    const repo = makeRepo('app')
    writeFileSync(
      join(repo, '.git', 'config'),
      [
        '[core]',
        '\trepositoryformatversion = 0',
        '[remote "origin"]',
        '\turl = https://github.com/acme/app.git',
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '[branch "main"]',
        '\tremote = origin',
        '\tmerge = refs/heads/main',
        '',
      ].join('\n'),
      'utf8',
    )
    writeTranscript(repo, 'session-1', conversation(repo, 'one'))

    scan(db, { root })
    expect(listProjects(db)[0]?.repoUrl).toBe('https://github.com/acme/app.git')
  })

  /** `pushurl` contains `url` — anchoring to the line start is what keeps them apart. */
  it('does not mistake pushurl for the remote URL', () => {
    const repo = makeRepo('app')
    writeFileSync(
      join(repo, '.git', 'config'),
      [
        '[remote "origin"]',
        '\tpushurl = git@github.com:acme/push-mirror.git',
        '\turl = https://github.com/acme/app.git',
        '',
      ].join('\n'),
      'utf8',
    )
    writeTranscript(repo, 'session-1', conversation(repo, 'one'))

    scan(db, { root })
    expect(listProjects(db)[0]?.repoUrl).toBe('https://github.com/acme/app.git')
  })

  /**
   * A known limitation, stated rather than hidden: when the working directory is gone
   * (deleted repo) or unreachable (a stopped WSL distro), there is no git root to group
   * on, so each directory becomes its own project. They are flagged `orphaned` so the UI
   * can say so instead of silently showing duplicates as if they were unrelated work.
   */
  it('marks projects orphaned when their directory is unreachable, and cannot group them', () => {
    writeTranscript('/deleted-repo', 'session-1', conversation('/deleted-repo', 'one'))
    writeTranscript('/deleted-repo/sub', 'session-2', conversation('/deleted-repo/sub', 'two'))

    scan(db, { root })

    const projects = listProjects(db)
    expect(projects).toHaveLength(2)
    expect(projects.every((p) => p.orphaned)).toBe(true)
  })

  it('skips transcripts whose size and mtime are unchanged', () => {
    writeTranscript(makeRepo('r'), 'session-a', conversation(makeRepo('r'), 'alpha'))

    expect(scan(db, { root })).toMatchObject({ ingested: 1, skipped: 0 })
    expect(scan(db, { root })).toMatchObject({ ingested: 0, skipped: 1 })
  })

  it('re-reads a transcript that grew', () => {
    const filePath = writeTranscript(
      makeRepo('r'),
      'session-a',
      conversation(makeRepo('r'), 'alpha'),
    )
    scan(db, { root })

    writeFileSync(
      filePath,
      `${[...conversation('/repo', 'alpha'), ...conversation('/repo', 'beta')]
        .map(line)
        .join('\n')}\n`,
      'utf8',
    )

    expect(scan(db, { root })).toMatchObject({ ingested: 1, skipped: 0 })
    expect(search(db, 'beta')).toHaveLength(1)
  })

  it('re-reads everything when forced, even if nothing changed', () => {
    writeTranscript(makeRepo('r'), 'session-a', conversation(makeRepo('r'), 'alpha'))
    scan(db, { root })
    expect(scan(db, { root, force: true })).toMatchObject({ ingested: 1, skipped: 0 })
  })

  /**
   * A file rewritten in place within the same millisecond keeps its mtime, and if the
   * length happens to match too, the signature is unchanged. This is the known blind spot
   * of size+mtime detection — documented here rather than pretended away. `--force` is
   * the escape hatch.
   */
  it('cannot detect a same-size, same-mtime rewrite without --force', () => {
    const filePath = writeTranscript('/repo', 'session-a', conversation('/repo', 'aaaaa'))
    scan(db, { root })

    const stamp = new Date('2026-08-01T00:00:00.000Z')
    writeFileSync(filePath, `${conversation('/repo', 'bbbbb').map(line).join('\n')}\n`, 'utf8')
    utimesSync(filePath, stamp, stamp)
    // Align mtime with what was stored so the signature genuinely matches.
    scan(db, { root })
    const stored = db.prepare('SELECT file_mtime_ms FROM sessions').get() as {
      file_mtime_ms: number
    }
    utimesSync(filePath, stamp, new Date(stored.file_mtime_ms))

    expect(scan(db, { root })).toMatchObject({ skipped: 1 })
    expect(scan(db, { root, force: true })).toMatchObject({ ingested: 1 })
    expect(search(db, 'bbbbb')).toHaveLength(1)
  })

  it('reads the working directory from records rather than the lossy folder name', () => {
    // `App_v2` and `App-v2` encode to the same folder key; the records disambiguate.
    writeTranscript('/code/App_v2', 'session-a', conversation('/code/App_v2', 'alpha'))

    scan(db, { root })
    expect(listProjects(db)[0]?.realCwd).toBe('/code/App_v2')
  })

  it('aggregates token usage and tool calls onto the session', () => {
    writeTranscript(makeRepo('r'), 'session-a', conversation(makeRepo('r'), 'alpha'))
    scan(db, { root })

    const session = listSessions(db)[0]
    expect(session?.tokensIn).toBe(5)
    expect(session?.tokensOut).toBe(7)
    expect(session?.toolCallCount).toBe(1)
    expect(session?.models).toEqual(['claude-opus-5'])
  })

  it('reports an empty result for a root that does not exist', () => {
    expect(scan(db, { root: join(root, 'nope') })).toMatchObject({ discovered: 0, ingested: 0 })
  })
})
