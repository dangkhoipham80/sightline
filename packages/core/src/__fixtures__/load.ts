import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubagentInput } from '../parse/subagents.js'
import { agentIdFromFilename } from '../parse/subagents.js'

/**
 * Read a committed fixture the way `@sightline/ingest` reads a real session.
 *
 * Test support only. It lives under `__fixtures__/` because that directory is excluded
 * from `tsconfig.build.json` — `core` is the package with no I/O dependencies, and an
 * `fs`-reading module in its `dist` would be exactly the sort of quiet erosion the
 * one-way dependency rule exists to prevent.
 *
 * There were three near-identical copies of this walk before it was extracted, and the
 * flat version of it is the bug this file's newest fixture pins down — so having one
 * copy is not tidiness, it is the difference between fixing that once and fixing it
 * wherever someone remembers to look.
 */

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url))

export interface FixtureInput {
  lines: string[]
  subagents: SubagentInput[]
}

export function readFixture(name: string): FixtureInput {
  const dir = join(FIXTURES_DIR, name)
  const lines = readFileSync(join(dir, 'transcript.jsonl'), 'utf8').split('\n')

  const subagents: SubagentInput[] = []
  const subagentDir = join(dir, 'subagents')
  if (existsSync(subagentDir)) collectAgents(subagentDir, subagents)

  return { lines, subagents }
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

/**
 * Recurses for the same reason `loadTranscript` does: Workflow-spawned agents sit in
 * `subagents/workflows/wf_<id>/`, and a flat read finds none of them. Selection is by the
 * `agent-*.jsonl` filename, which is also what keeps the Workflow tool's own
 * `journal.jsonl` out at any depth.
 */
function collectAgents(dir: string, out: SubagentInput[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectAgents(join(dir, entry.name), out)
      continue
    }
    const agentId = agentIdFromFilename(entry.name)
    if (agentId === null) continue
    const metaPath = join(dir, `agent-${agentId}.meta.json`)
    out.push({
      agentId,
      lines: readFileSync(join(dir, entry.name), 'utf8').split('\n'),
      ...(existsSync(metaPath) && { meta: JSON.parse(readFileSync(metaPath, 'utf8')) }),
    })
  }
}
