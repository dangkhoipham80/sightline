/**
 * Render a `TranscriptView` as Markdown.
 *
 * This lives in `core` rather than in the CLI because it is pure — a view over a view —
 * and because `sightline export` is not the only caller it will have: PR 8's MCP server
 * hands transcripts to an agent, and an agent reading a second, subtly different rendering
 * of the same session is a bug that would take a long time to notice.
 *
 * The output is deliberately lossy in exactly the places the web viewer is: clipped text
 * stays clipped and says so, diffs past `DIFF_LINE_LIMIT` say so. An export that silently
 * looked complete while dropping half a turn is the failure mode worth designing against —
 * every truncation here is annotated, so a reader can tell "nothing happened" from
 * "something happened and we are not showing it".
 */

import type { ClippedText, DiffView, StepView, SubagentView, TranscriptView } from './model.js'

export interface MarkdownExportMeta {
  /** Front-matter fields, emitted in insertion order. Values are written verbatim. */
  title?: string
  projectName?: string
  startedAt?: string
  endedAt?: string
  cwd?: string
  gitBranch?: string
  models?: readonly string[]
  /** Where the transcript was read from, so an export can be traced back to its source. */
  filePath?: string
}

export interface RenderMarkdownOptions {
  /** Include `thinking` blocks. Off by default: they are long and rarely what you export. */
  includeThinking?: boolean
  /** Include tool *results*. On by default — a tool call with no result reads as a no-op. */
  includeToolResults?: boolean
}

export function renderMarkdown(
  view: TranscriptView,
  meta: MarkdownExportMeta = {},
  options: RenderMarkdownOptions = {},
): string {
  const includeThinking = options.includeThinking === true
  const includeToolResults = options.includeToolResults !== false

  const out: string[] = []

  out.push(...frontMatter(view, meta))
  out.push(`# ${meta.title ?? `Session ${view.sessionId}`}`, '')

  for (const turn of view.turns) {
    out.push(`## Turn ${turn.index + 1}${turnTiming(turn.startedAt, turn.durationMs)}`, '')

    if (turn.prompt !== undefined) {
      out.push(...quote(clipped(turn.prompt)), '')
    }

    out.push(...steps(turn.steps, { includeThinking, includeToolResults }))
  }

  if (view.unattachedSubagents.length > 0) {
    out.push('## Subagents with no spawning call', '')
    // Not an appendix of leftovers: for a session driven by the Workflow tool this is
    // where nearly all of the work is, since none of those agents carry a `toolUseId`.
    out.push(
      'These agents ran as part of this session but have no `tool_use` call in this file to',
      'sit beside. The work happened; only its anchor is missing.',
      '',
    )
    for (const agent of view.unattachedSubagents) {
      out.push(...subagent(agent, 3, { includeThinking, includeToolResults }))
    }
  }

  if (view.malformedCount > 0) {
    out.push(
      `> ${view.malformedCount} line${view.malformedCount === 1 ? '' : 's'} in the transcript could not be parsed and ${view.malformedCount === 1 ? 'is' : 'are'} not shown.`,
      '',
    )
  }

  // One trailing newline, never a run of blank lines: every block above appends its own
  // separator, so joining and collapsing here beats each block guessing what follows it.
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function frontMatter(view: TranscriptView, meta: MarkdownExportMeta): string[] {
  const fields: Array<[string, string]> = [['session_id', yamlString(view.sessionId)]]

  const add = (key: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) fields.push([key, yamlString(value)])
  }

  add('title', meta.title)
  add('project', meta.projectName)
  add('started_at', meta.startedAt)
  add('ended_at', meta.endedAt)
  add('cwd', meta.cwd)
  add('git_branch', meta.gitBranch)
  if (meta.models !== undefined && meta.models.length > 0) {
    fields.push(['models', `[${meta.models.map(yamlString).join(', ')}]`])
  }
  add('source', meta.filePath)
  fields.push(['turns', String(view.turns.length)])
  fields.push(['tool_calls', String(view.toolCallCount)])

  return ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---', '']
}

/**
 * Always quoted, with quotes and backslashes escaped.
 *
 * Windows paths are the reason this is not conditional: `cwd: D:\Management_Vibe_Coding`
 * is valid YAML for a *different* string, and a session title routinely contains a colon.
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

interface StepOptions {
  includeThinking: boolean
  includeToolResults: boolean
}

function steps(list: readonly StepView[], options: StepOptions, depth = 3): string[] {
  const out: string[] = []

  for (const step of list) {
    switch (step.type) {
      case 'prose':
        out.push(
          `**${step.role === 'assistant' ? 'Assistant' : 'User'}**`,
          '',
          clipped(step.body),
          '',
        )
        break

      case 'thinking':
        if (!options.includeThinking) break
        out.push(
          '<details><summary>Thinking</summary>',
          '',
          clipped(step.body),
          '',
          '</details>',
          '',
        )
        break

      case 'system':
        out.push(
          `_System${step.subtype === undefined ? '' : ` (${step.subtype})`}:_ ${inline(clipped(step.body))}`,
          '',
        )
        break

      case 'tool': {
        const { summary } = step
        const target = summary.target === undefined ? '' : ` \`${inline(summary.target)}\``
        const detail = summary.detail === undefined ? '' : ` — ${inline(summary.detail)}`
        out.push(`- **${summary.name}**${target}${detail}`)

        if (step.diffs !== undefined) {
          for (const view of step.diffs) out.push('', ...diff(view))
        }

        if (options.includeToolResults && step.result !== undefined) {
          if (step.result.isError) out.push('', '_The tool reported an error._')
          out.push('', ...fence(clipped(step.result.body), 'text'))
        }

        if (step.subagents !== undefined) {
          for (const agent of step.subagents) out.push('', ...subagent(agent, depth + 1, options))
        }

        out.push('')
        break
      }
    }
  }

  return out
}

function subagent(agent: SubagentView, depth: number, options: StepOptions): string[] {
  const heading = '#'.repeat(Math.min(depth, 6))
  const label = agent.agentType ?? 'agent'
  const description = agent.description === undefined ? '' : `: ${inline(agent.description)}`

  return [
    `${heading} Subagent \`${agent.agentId}\` (${label})${description}`,
    '',
    `_${agent.messageCount} message${agent.messageCount === 1 ? '' : 's'}_`,
    '',
    ...steps(agent.steps, options, depth + 1),
  ]
}

function diff(view: DiffView): string[] {
  const { added, removed, truncated } = view.diff.stat
  const label = view.label === undefined ? '' : ` (${inline(view.label)})`
  const out = [`  \`${inline(view.filePath)}\`${label} — +${added} −${removed}`, '', '```diff']

  for (const hunk of view.diff.hunks) {
    if (hunk.skippedBefore > 0) out.push(`@@ ${hunk.skippedBefore} unchanged lines @@`)
    for (const line of hunk.lines) {
      out.push(`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`)
    }
  }

  out.push('```')
  if (view.clipped) out.push('', '_Diff truncated; the counts above cover the whole change._')
  if (truncated)
    out.push('', '_Too large to align line by line; shown as a wholesale replacement._')
  out.push('')

  return out
}

/** Clipped text, with the fact that it was clipped stated rather than left to be guessed. */
function clipped(text: ClippedText): string {
  if (text.clipped === 0) return text.text
  return `${text.text}\n\n_… ${text.clipped.toLocaleString('en-US')} more characters not shown._`
}

function quote(body: string): string[] {
  return body.split('\n').map((line) => (line.length === 0 ? '>' : `> ${line}`))
}

/**
 * Fence with enough backticks to survive the content.
 *
 * Transcripts are full of Markdown, and a body containing ``` closes a three-backtick
 * fence early — everything after it renders as prose and the export looks mangled in a way
 * that is easy to blame on the parser.
 */
function fence(body: string, info = ''): string[] {
  const longest = [...body.matchAll(/`{3,}/g)].reduce((n, m) => Math.max(n, m[0].length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return [`${ticks}${info}`, body, ticks, '']
}

/** Collapse to one line for the places that must stay on one — headings, list items. */
function inline(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function turnTiming(startedAt: string | undefined, durationMs: number | undefined): string {
  const parts: string[] = []
  if (startedAt !== undefined) parts.push(startedAt)
  if (durationMs !== undefined) parts.push(duration(durationMs))
  return parts.length === 0 ? '' : ` — ${parts.join(', ')}`
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}
