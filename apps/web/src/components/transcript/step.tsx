import type { ClippedText, StepView, SubagentView, ToolKind } from '@sightline/core'
import { truncateMiddle } from '@sightline/core'
import { DiffBlock } from '@/components/transcript/diff-block'
import { count, duration, shortPath } from '@/lib/format'

/**
 * How much of a step is showing.
 *
 * `prompts` is the skim — what did I ask for. `prose` is the read — what did it say back,
 * with every tool call collapsed to one line. `all` opens the machinery. The three levels
 * exist because the same transcript answers three different questions, and a viewer that
 * only does the third is the thing everyone already has.
 */
export type Density = 'prompts' | 'prose' | 'all'

/** A glyph per tool kind, so the eye can skip to the writes without reading names. */
const GLYPH: Record<ToolKind, string> = {
  read: '◇',
  edit: '◆',
  write: '◆',
  run: '$',
  search: '⌕',
  task: '⊕',
  todo: '☰',
  other: '·',
}

export function Step({ step, density }: { step: StepView; density: Density }) {
  switch (step.type) {
    case 'prose':
      return (
        <div className="prose-block whitespace-pre-wrap py-2 text-[14px] leading-[1.7] text-text">
          <Clipped value={step.body} />
        </div>
      )

    case 'thinking':
      return (
        <details
          // Remounted when density changes so the control actually moves the disclosure,
          // while leaving anything the reader opened by hand alone in between.
          key={density}
          open={density === 'all'}
          className="border-l-2 border-rule py-1 pl-3"
        >
          <summary className="cursor-pointer font-mono text-[11px] text-dim marker:text-rule hover:text-muted">
            thinking · {count(step.body.text.length)} chars
          </summary>
          <div className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.7] text-muted">
            <Clipped value={step.body} />
          </div>
        </details>
      )

    case 'system':
      return (
        <p className="py-1 font-mono text-[11px] text-dim">
          {step.subtype !== undefined && <span className="text-rule">{step.subtype} </span>}
          {truncateMiddle(step.body.text, 160)}
        </p>
      )

    case 'tool':
      return <ToolStep step={step} density={density} />
  }
}

function ToolStep({
  step,
  density,
}: {
  step: Extract<StepView, { type: 'tool' }>
  density: Density
}) {
  const { summary } = step
  const failed = step.result?.isError === true
  const hasBody =
    step.diffs !== undefined || step.result !== undefined || step.subagents !== undefined

  return (
    <details key={density} open={density === 'all'} className="group py-1">
      <summary className="flex cursor-pointer items-baseline gap-2 font-mono text-[12px] marker:text-rule">
        <span className={failed ? 'text-signal' : 'text-dim'}>{GLYPH[summary.kind]}</span>
        <span className={failed ? 'text-signal' : 'text-muted'}>{summary.name}</span>
        {summary.target !== undefined && (
          <span className="min-w-0 flex-1 truncate text-dim" title={summary.target}>
            {summary.kind === 'read' || summary.kind === 'edit' || summary.kind === 'write'
              ? shortPath(summary.target)
              : truncateMiddle(summary.target)}
          </span>
        )}
        {summary.detail !== undefined && (
          <span className="hidden shrink-0 text-rule sm:inline">
            {truncateMiddle(summary.detail, 40)}
          </span>
        )}
        {failed && <span className="shrink-0 text-signal">error</span>}
        {step.subagents !== undefined && (
          <span className="shrink-0 text-dim">{step.subagents.length}↳</span>
        )}
      </summary>

      <div className="ml-4 border-l border-rule pl-4">
        {step.diffs?.map((diff, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: several edits to one file differ only by order
          <DiffBlock key={`${diff.filePath}-${index}`} view={diff} />
        ))}

        {step.subagents?.map((subagent) => (
          <SubagentThread key={subagent.agentId} subagent={subagent} density={density} />
        ))}

        {step.result !== undefined && step.result.body.text.length > 0 && (
          <Payload label={failed ? 'error' : 'result'} value={step.result.body} tone={failed} />
        )}

        {/*
         * The arguments are the last resort, so they open last. `Edit` already showed its
         * diff and `Bash` already showed its command in the summary — repeating the raw
         * JSON above the thing it produced would bury it.
         */}
        {(!hasBody || density === 'all') && step.input.text.length > 0 && (
          <Payload label="input" value={step.input} />
        )}
      </div>
    </details>
  )
}

function SubagentThread({ subagent, density }: { subagent: SubagentView; density: Density }) {
  // Falls through to the id rather than the type: a workflow's agents all share one
  // `agentType` and have no `description`, so labelling by type makes every thread in the
  // session read the same. The id is the only thing that tells them apart.
  const label = subagent.description ?? subagent.agentId
  const ran = span(subagent.startedAt, subagent.endedAt)

  return (
    <details open className="mt-2 rounded-sm border border-rule bg-panel/40">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 px-3 py-2 font-mono text-[11px] marker:text-rule">
        <span className="text-dim">subagent</span>
        <span className="min-w-0 flex-1 truncate text-muted" title={label}>
          {label}
        </span>
        {subagent.agentType !== undefined && <span className="text-dim">{subagent.agentType}</span>}
        <span className="text-dim">
          {count(subagent.messageCount)} msgs{ran === null ? '' : ` · ${ran}`}
        </span>
      </summary>

      <div className="border-t border-rule px-3 py-2">
        {subagent.steps.length === 0 ? (
          <p className="font-mono text-[11px] text-dim">no readable records</p>
        ) : (
          subagent.steps.map((step) => <Step key={step.id} step={step} density={density} />)
        )}
      </div>
    </details>
  )
}

function Payload({
  label,
  value,
  tone = false,
}: {
  label: string
  value: ClippedText
  tone?: boolean
}) {
  return (
    <div className="mt-2">
      <p className="band-label">{label}</p>
      <pre
        className={`mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm border px-3 py-2 text-[12px] leading-[1.6] ${
          tone ? 'border-signal/40 text-signal' : 'border-rule text-muted'
        }`}
      >
        <Clipped value={value} />
      </pre>
    </div>
  )
}

/**
 * Text plus an honest note about what was left out.
 *
 * A viewer that silently truncates is worse than one that shows nothing: it reads as the
 * whole record. The count is the difference between "that's all there was" and "there is
 * more in the file".
 */
function Clipped({ value }: { value: ClippedText }) {
  return (
    <>
      {value.text}
      {value.clipped > 0 && (
        <span className="mt-1 block font-mono text-[11px] text-dim">
          … {count(value.clipped)} more characters in the transcript
        </span>
      )}
    </>
  )
}

function span(from: string | undefined, to: string | undefined): string | null {
  if (from === undefined || to === undefined) return null
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isNaN(ms) || ms <= 0 ? null : duration(ms)
}
