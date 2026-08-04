/**
 * Reducing a tool call to the one thing worth reading at a glance.
 *
 * A collapsed transcript lives or dies on this. `Edit` with a 40-line `new_string` has to
 * collapse to `Edit  src/parse/records.ts`, or progressive disclosure discloses nothing.
 *
 * Tool names and argument shapes are Claude Code's, not ours, and they change. Everything
 * here degrades to the bare tool name rather than throwing — an unrecognised tool is a tool
 * we haven't met yet, which is the same stance the parser takes on record types.
 */

import type { JsonValue } from '../types.js'

export type ToolKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'task' | 'todo' | 'other'

export interface ToolSummary {
  name: string
  kind: ToolKind
  /** The tool's subject — a path, a command, a pattern. Absent when it has none. */
  target?: string
  /** A second field worth showing on the collapsed line, such as a search's scope. */
  detail?: string
}

export interface EditPreview {
  filePath: string
  before: string
  after: string
  /** Set when one call carries several edits, so they can be told apart. */
  label?: string
}

function field(input: JsonValue, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const value = (input as Record<string, JsonValue>)[key]
  return typeof value === 'string' ? value : undefined
}

function arrayField(input: JsonValue, key: string): JsonValue[] | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const value = (input as Record<string, JsonValue>)[key]
  return Array.isArray(value) ? value : undefined
}

export function summariseTool(name: string, input: JsonValue): ToolSummary {
  const with_ = (kind: ToolKind, target?: string, detail?: string): ToolSummary => ({
    name,
    kind,
    ...(target !== undefined && target.length > 0 && { target }),
    ...(detail !== undefined && detail.length > 0 && { detail }),
  })

  switch (name) {
    case 'Read':
      return with_('read', field(input, 'file_path'))
    case 'Edit':
    case 'MultiEdit':
      return with_('edit', field(input, 'file_path'))
    case 'Write':
      return with_('write', field(input, 'file_path'))
    case 'NotebookEdit':
      return with_('edit', field(input, 'notebook_path'))
    case 'Bash':
      return with_('run', field(input, 'command'), field(input, 'description'))
    case 'Glob':
      return with_('search', field(input, 'pattern'), field(input, 'path'))
    case 'Grep':
      return with_('search', field(input, 'pattern'), field(input, 'path') ?? field(input, 'glob'))
    // `Agent` is what the subagent-spawning tool is called at 2.1.198; `Task` is the older
    // name. Both appear in real corpora depending on when the session ran, and this is the
    // one row that must never degrade to a bare name — it is the header of a whole
    // sub-thread. Counted across 8.8k real tool calls: `Agent` 54, `Task` 0.
    case 'Agent':
    case 'Task':
      return with_('task', field(input, 'description'), field(input, 'subagent_type'))
    case 'WebFetch':
      return with_('read', field(input, 'url'), field(input, 'prompt'))
    case 'WebSearch':
      return with_('search', field(input, 'query'))
    case 'Skill':
      return with_('task', field(input, 'skill'), field(input, 'args'))
    case 'ToolSearch':
      return with_('search', field(input, 'query'))
    case 'AskUserQuestion':
      return with_('other', firstQuestion(input))
    // Task tracking replaced `TodoWrite` with one call per task; `TodoWrite` is kept for
    // transcripts written before the change.
    case 'TaskCreate':
      return with_('todo', field(input, 'subject'))
    case 'TaskUpdate':
      return with_(
        'todo',
        field(input, 'subject') ?? field(input, 'taskId'),
        field(input, 'status'),
      )
    case 'TaskStop':
    case 'TaskOutput':
    case 'TaskGet':
      return with_('todo', field(input, 'taskId'))
    case 'TodoWrite': {
      const todos = arrayField(input, 'todos')
      return with_('todo', todos === undefined ? undefined : `${todos.length} items`)
    }
    default:
      // An unfamiliar tool still gets its most path-like or command-like argument shown.
      return with_(
        'other',
        field(input, 'file_path') ?? field(input, 'path') ?? field(input, 'command'),
      )
  }
}

/**
 * The before/after pairs a tool call implies, or undefined when it changes no file.
 *
 * `Write` has no before text at all, which is not a missing value — it is the statement
 * that everything in the file is new. It diffs against the empty string and reads as all
 * additions, which is what happened.
 */
export function editPreviews(name: string, input: JsonValue): EditPreview[] | undefined {
  switch (name) {
    case 'Edit': {
      const filePath = field(input, 'file_path')
      const before = field(input, 'old_string')
      const after = field(input, 'new_string')
      if (filePath === undefined || before === undefined || after === undefined) return undefined
      return [{ filePath, before, after }]
    }

    case 'Write': {
      const filePath = field(input, 'file_path')
      const content = field(input, 'content')
      if (filePath === undefined || content === undefined) return undefined
      return [{ filePath, before: '', after: content }]
    }

    case 'MultiEdit': {
      const filePath = field(input, 'file_path')
      const edits = arrayField(input, 'edits')
      if (filePath === undefined || edits === undefined) return undefined

      const previews: EditPreview[] = []
      for (const [index, edit] of edits.entries()) {
        const before = field(edit, 'old_string')
        const after = field(edit, 'new_string')
        if (before === undefined || after === undefined) continue
        previews.push({ filePath, before, after, label: `edit ${index + 1} of ${edits.length}` })
      }
      return previews.length > 0 ? previews : undefined
    }

    default:
      return undefined
  }
}

/** `AskUserQuestion` carries its questions in an array; the first one is the summary. */
function firstQuestion(input: JsonValue): string | undefined {
  const questions = arrayField(input, 'questions')
  const first = questions?.[0]
  return first === undefined ? undefined : (field(first, 'question') ?? field(first, 'header'))
}

/** Collapse a command or path to one line for the closed state, keeping the informative end. */
export function truncateMiddle(value: string, max = 96): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${oneLine.slice(0, head)}…${oneLine.slice(oneLine.length - tail)}`
}
