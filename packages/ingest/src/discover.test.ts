import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadTranscript } from './discover.js'

let sessionRoot: string
let transcriptPath: string

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), 'sightline-discover-'))
  transcriptPath = join(sessionRoot, 'session.jsonl')
  writeFileSync(transcriptPath, `${JSON.stringify({ type: 'mode', mode: 'normal' })}\n`, 'utf8')
})

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true })
})

/** `<session>/subagents/<...segments>/agent-<id>.jsonl`, plus its `meta.json`. */
function writeAgent(agentId: string, segments: string[] = [], meta?: unknown): void {
  const dir = join(sessionRoot, 'session', 'subagents', ...segments)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({
      type: 'assistant',
      uuid: `u-${agentId}`,
      isSidechain: true,
      message: { id: `msg-${agentId}`, model: 'claude-opus-5', content: [] },
    })}\n`,
    'utf8',
  )
  if (meta !== undefined) {
    writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta), 'utf8')
  }
}

const load = () => loadTranscript({ filePath: transcriptPath })

describe('loadTranscript', () => {
  it('reads agents sitting directly in subagents/', () => {
    writeAgent('atop', [], { agentType: 'Explore', toolUseId: 'toolu_1', spawnDepth: 1 })

    const { subagents } = load()
    expect(subagents.map((a) => a.agentId)).toEqual(['atop'])
    expect(subagents[0]?.meta).toEqual({
      agentType: 'Explore',
      toolUseId: 'toolu_1',
      spawnDepth: 1,
    })
  })

  /**
   * The bug this file exists for. Workflow-spawned agents are nested a directory deeper,
   * and the original flat `readdirSync` found none of them — 177 transcripts on the
   * reference machine whose tokens were missing from every total that included them.
   */
  it('descends into workflows/wf_<id>/ for the agents nested there', () => {
    writeAgent('atop', [], { agentType: 'Explore', toolUseId: 'toolu_1', spawnDepth: 1 })
    writeAgent('anested', ['workflows', 'wf_abc'], {
      agentType: 'workflow-subagent',
      spawnDepth: 1,
    })

    const { subagents } = load()
    expect(subagents.map((a) => a.agentId).sort()).toEqual(['anested', 'atop'])
  })

  it('reads a nested agent’s meta from beside it, not from the top level', () => {
    writeAgent('anested', ['workflows', 'wf_abc'], {
      agentType: 'workflow-subagent',
      spawnDepth: 1,
    })

    const { subagents } = load()
    expect(subagents[0]?.meta).toEqual({ agentType: 'workflow-subagent', spawnDepth: 1 })
  })

  /**
   * `journal.jsonl` is the Workflow tool's own log — `started`/`result` records with no
   * transcript envelope — and it lives in the same directory as the agents. Reaching the
   * nested files by widening the glob to `*.jsonl` would swallow it, and its records carry
   * an `agentId`, so the result would look plausible rather than obviously wrong.
   */
  it('ignores journal.jsonl in a workflow directory', () => {
    writeAgent('anested', ['workflows', 'wf_abc'], {
      agentType: 'workflow-subagent',
      spawnDepth: 1,
    })
    writeFileSync(
      join(sessionRoot, 'session', 'subagents', 'workflows', 'wf_abc', 'journal.jsonl'),
      `${JSON.stringify({ type: 'started', key: 'v2:abc', agentId: 'anested' })}\n`,
      'utf8',
    )

    const { subagents } = load()
    expect(subagents.map((a) => a.agentId)).toEqual(['anested'])
  })

  it('walks a workflow directory that holds nothing but a journal', () => {
    writeAgent('atop', [], { agentType: 'Explore', toolUseId: 'toolu_1', spawnDepth: 1 })
    const empty = join(sessionRoot, 'session', 'subagents', 'workflows', 'wf_empty')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(empty, 'journal.jsonl'), `${JSON.stringify({ type: 'started' })}\n`, 'utf8')

    expect(load().subagents.map((a) => a.agentId)).toEqual(['atop'])
  })

  it('collects agents from several workflow directories at once', () => {
    writeAgent('aone', ['workflows', 'wf_one'], { agentType: 'workflow-subagent', spawnDepth: 1 })
    writeAgent('atwo', ['workflows', 'wf_one'], { agentType: 'workflow-subagent', spawnDepth: 1 })
    writeAgent('athree', ['workflows', 'wf_two'], { agentType: 'workflow-subagent', spawnDepth: 1 })

    expect(
      load()
        .subagents.map((a) => a.agentId)
        .sort(),
    ).toEqual(['aone', 'athree', 'atwo'])
  })

  /**
   * `subagents` is keyed `(session_id, agent_id)` and inserted without an upsert, so a
   * repeated id inside one session would abort that session's ingest entirely. No
   * collision exists on the reference corpus; this keeps a future one costing one sidechain
   * instead of the whole session.
   */
  it('keeps one agent per id, preferring the shallower file', () => {
    writeAgent('adupe', [], { agentType: 'Explore', toolUseId: 'toolu_1', spawnDepth: 1 })
    writeAgent('adupe', ['workflows', 'wf_abc'], {
      agentType: 'workflow-subagent',
      spawnDepth: 1,
    })

    const { subagents } = load()
    expect(subagents).toHaveLength(1)
    expect(subagents[0]?.meta).toMatchObject({ agentType: 'Explore' })
  })

  it('stops descending before an unbounded tree can be walked', () => {
    writeAgent('adeep', ['a', 'b', 'c', 'd', 'e', 'f'])
    expect(load().subagents).toEqual([])
  })

  it('returns no subagents when the session has no sidechain directory', () => {
    expect(load().subagents).toEqual([])
  })
})
