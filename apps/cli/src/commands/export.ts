/**
 * `sightline export` — one session as Markdown, on stdout or in a file.
 *
 * The rendering itself is `renderMarkdown` in `core`. This file is the I/O around it:
 * resolve what the user typed to a session, re-read the transcript, write the result.
 *
 * Re-reading rather than rendering from the index is not an optimisation left on the
 * table — the index stores summaries, never message bodies. There is exactly one copy of
 * the conversation and it is the file under `~/.claude`.
 */

import { existsSync, writeFileSync } from 'node:fs'
import type { MarkdownExportMeta } from '@sightline/core'
import { buildTranscriptView, parseSession, renderMarkdown } from '@sightline/core'
import type { SessionRow, SightlineDatabase } from '@sightline/db'
import {
  defaultIndexPath,
  findSessionsByTitle,
  getSession,
  listProjects,
  openDatabase,
} from '@sightline/db'
import { loadTranscript } from '@sightline/ingest'
import type { ParsedArgs } from '../args.js'
import { boolFlag, stringFlag, unknownFlags } from '../args.js'

const KNOWN = ['out', 'index', 'thinking', 'no-tool-results', 'help', 'h']

export function exportCommand(parsed: ParsedArgs): number {
  const unknown = unknownFlags(parsed, KNOWN)
  if (unknown.length > 0) {
    process.stderr.write(`sightline export: unknown option --${unknown[0]}\n${EXPORT_USAGE}`)
    return 1
  }
  if (boolFlag(parsed, 'help') || boolFlag(parsed, 'h')) {
    process.stdout.write(EXPORT_USAGE)
    return 0
  }

  const query = parsed.positionals[0]
  if (query === undefined) {
    process.stderr.write(`sightline export: needs a session id or title\n\n${EXPORT_USAGE}`)
    return 1
  }

  const out = stringFlag(parsed, 'out')
  if (out === 'missing-value') {
    process.stderr.write('sightline export: --out needs a path\n')
    return 1
  }

  const index = stringFlag(parsed, 'index')
  if (index === 'missing-value') {
    process.stderr.write('sightline export: --index needs a path\n')
    return 1
  }

  const path = index ?? process.env['SIGHTLINE_INDEX'] ?? defaultIndexPath()
  if (!existsSync(path)) {
    process.stderr.write(`sightline export: no index at ${path}. Run \`sightline scan\` first.\n`)
    return 1
  }

  const db = openDatabase({ path })

  try {
    const resolved = resolveSession(db, query)
    if (resolved.kind === 'none') {
      process.stderr.write(`sightline export: no session matching ${JSON.stringify(query)}\n`)
      return 1
    }
    if (resolved.kind === 'ambiguous') {
      // Listed rather than resolved to the newest. Exporting the wrong session succeeds
      // silently, and a Markdown file is not something you re-read closely enough to notice.
      const shown = resolved.matches.slice(0, AMBIGUOUS_LIMIT)
      const count =
        resolved.matches.length > AMBIGUOUS_LIMIT
          ? `more than ${AMBIGUOUS_LIMIT}`
          : String(resolved.matches.length)

      process.stderr.write(
        [
          `sightline export: ${JSON.stringify(query)} matches ${count} sessions:`,
          ...shown.map((s) => `  ${s.id}  ${s.startedAt ?? '—'}  ${s.title ?? '(untitled)'}`),
          ...(resolved.matches.length > AMBIGUOUS_LIMIT ? ['  … and more'] : []),
          'Re-run with one of the ids.',
          '',
        ].join('\n'),
      )
      return 1
    }

    const session = resolved.session
    if (!existsSync(session.filePath)) {
      // The index row outlives the file it describes; that is a real state, not corruption.
      process.stderr.write(
        `sightline export: the transcript for ${session.id} is gone (${session.filePath}).\n`,
      )
      return 1
    }

    const { lines, subagents } = loadTranscript({ filePath: session.filePath })
    const view = buildTranscriptView(parseSession({ sessionId: session.id, lines, subagents }))

    const project = listProjects(db, { includeArchived: true }).find(
      (p) => p.id === session.projectId,
    )

    const markdown = renderMarkdown(view, metaFor(session, project?.displayName), {
      includeThinking: boolFlag(parsed, 'thinking'),
      includeToolResults: !boolFlag(parsed, 'no-tool-results'),
    })

    if (out === undefined) process.stdout.write(markdown)
    else {
      writeFileSync(out, markdown, 'utf8')
      process.stderr.write(`sightline: wrote ${out}\n`)
    }

    return 0
  } finally {
    db.close()
  }
}

function metaFor(session: SessionRow, projectName: string | undefined): MarkdownExportMeta {
  // `exactOptionalPropertyTypes` is on, so an absent field has to be absent rather than
  // explicitly undefined — hence the spreads instead of `title: session.title ?? undefined`.
  return {
    ...(session.title !== null && { title: session.title }),
    ...(projectName !== undefined && { projectName }),
    ...(session.startedAt !== null && { startedAt: session.startedAt }),
    ...(session.endedAt !== null && { endedAt: session.endedAt }),
    ...(session.cwd !== null && { cwd: session.cwd }),
    ...(session.gitBranch !== null && { gitBranch: session.gitBranch }),
    ...(session.models.length > 0 && { models: session.models }),
    filePath: session.filePath,
  }
}

type Resolved =
  | { kind: 'one'; session: SessionRow }
  | { kind: 'ambiguous'; matches: SessionRow[] }
  | { kind: 'none' }

/** How many ambiguous matches to list. One more is fetched, so "and more" is never a guess. */
const AMBIGUOUS_LIMIT = 10

/** An exact id first, then a title match — ids are unambiguous and titles are not. */
function resolveSession(db: SightlineDatabase, query: string): Resolved {
  const byId = getSession(db, query)
  if (byId !== undefined) return { kind: 'one', session: byId }

  const matches = findSessionsByTitle(db, query, { limit: AMBIGUOUS_LIMIT + 1 })
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1 && matches[0] !== undefined) {
    return { kind: 'one', session: matches[0] }
  }
  return { kind: 'ambiguous', matches }
}

export const EXPORT_USAGE = `sightline export <session-id-or-title> — one session as Markdown

  --out <path>         write to a file instead of stdout
  --index <path>       index to read (default $SIGHTLINE_INDEX, then ~/.sightline/index.db)
  --thinking           include thinking blocks (omitted by default)
  --no-tool-results    tool calls only, without their output

Subagents are included, including the workflow agents that have no spawning call to sit
beside — leaving those out drops most of the work in a session that delegated.
`
