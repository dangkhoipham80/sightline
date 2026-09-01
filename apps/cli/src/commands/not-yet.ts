/**
 * Commands the roadmap promises and this binary cannot yet honour.
 *
 * `summarize` needs `packages/ai` (roadmap PR 7) and `mcp` needs `packages/mcp` (PR 8).
 * Neither package exists. They are here, failing loudly, rather than absent, because the
 * two alternatives are both worse: omitting them makes `sightline summarize` an "unknown
 * command", which reads as a typo, and stubbing them to exit 0 makes a command that does
 * nothing look like a command that worked.
 *
 * Delete each entry when its package lands. The exit code is 1 — a script that pipes
 * `sightline summarize` should fail, not proceed with an empty result.
 */

export interface NotYet {
  command: string
  /** The roadmap row that has to ship first, named so it can be looked up. */
  blockedBy: string
  needs: string
}

export const NOT_YET: readonly NotYet[] = [
  { command: 'summarize', blockedBy: 'roadmap PR 7 (feat/ai-summaries)', needs: 'packages/ai' },
  { command: 'mcp', blockedBy: 'roadmap PR 8 (feat/mcp-server)', needs: 'packages/mcp' },
]

export function notYet(entry: NotYet): number {
  process.stderr.write(
    [
      `sightline ${entry.command}: not implemented yet.`,
      '',
      `It needs ${entry.needs}, which ${entry.blockedBy} builds. Until that ships there is`,
      'nothing for this command to call, and pretending otherwise would be worse than saying so.',
      '',
      'See docs/ROADMAP.md.',
      '',
    ].join('\n'),
  )
  return 1
}
