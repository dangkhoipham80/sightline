'use client'

import type { TranscriptView, UnattachedReason } from '@sightline/core'
import { useEffect, useState } from 'react'
import { Minimap } from '@/components/transcript/minimap'
import type { Density } from '@/components/transcript/step'
import { Step } from '@/components/transcript/step'
import { TurnBlock } from '@/components/transcript/turn-block'
import { count } from '@/lib/format'

const LEVELS: Array<{ value: Density; label: string; hint: string }> = [
  { value: 'prompts', label: 'prompts', hint: 'Only what you asked for' },
  { value: 'prose', label: 'replies', hint: 'Prompts and replies, tool calls collapsed' },
  { value: 'all', label: 'everything', hint: 'Thinking, tool inputs, results and diffs' },
]

/**
 * Subagents with nowhere to sit, grouped by *why*.
 *
 * These two used to share one paragraph, which said the session had been resumed. That is
 * true of the second group and simply false of the first: a Workflow-spawned agent has no
 * `toolUseId` at all and never had a `Task` call to be separated from. Telling a reader
 * their session was resumed when it was not is the kind of confident wrong answer this
 * project exists to catch.
 */
const UNATTACHED_GROUPS: Array<{
  reason: UnattachedReason
  heading: string
  explanation: string
}> = [
  {
    reason: 'no-spawning-call',
    heading: 'Workflow agents',
    explanation:
      'Spawned by the Workflow tool rather than by a Task call, so there is no single step to show them under. Their tokens count towards this session all the same.',
  },
  {
    reason: 'spawning-call-elsewhere',
    heading: 'Subagents without a spawning call',
    explanation:
      'Their spawning call is not in this file, which usually means the session was resumed after they finished. The work is theirs all the same.',
  },
]

export function Transcript({ view, focusTurn }: { view: TranscriptView; focusTurn?: number }) {
  // A hit inside a subagent resolves to the turn that spawned it, and that turn's tool
  // calls are collapsed at the default density — so arriving from search opens everything.
  // Landing on a turn whose match is hidden inside a closed <details> is the same as not
  // having navigated at all.
  const [density, setDensity] = useState<Density>(focusTurn === undefined ? 'prose' : 'all')

  useEffect(() => {
    if (focusTurn === undefined) return
    // After paint: the target turn may still be a `content-visibility` placeholder, and
    // scrolling to it before it has been laid out lands in the wrong place.
    const timer = setTimeout(() => {
      document.getElementById(`turn-${focusTurn}`)?.scrollIntoView({ block: 'start' })
    }, 120)
    return () => clearTimeout(timer)
  }, [focusTurn])

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_7rem] lg:gap-8">
      <div className="min-w-0">
        {/* Sticks *below* the instrument bar, which owns `top-0` and a higher stacking
            order. Sharing `top-0` puts these controls under it and makes them unclickable
            the moment the page scrolls. */}
        <div className="sticky top-bar z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-ink/95 px-4 py-3 backdrop-blur lg:px-6">
          <fieldset className="flex items-center gap-2 border-0 p-0">
            <legend className="band-label float-left me-2">Show</legend>
            {LEVELS.map((level) => (
              <button
                key={level.value}
                type="button"
                onClick={() => setDensity(level.value)}
                title={level.hint}
                aria-pressed={density === level.value}
                className={`rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors ${
                  density === level.value
                    ? 'border-signal text-signal'
                    : 'border-rule text-dim hover:text-muted'
                }`}
              >
                {level.label}
              </button>
            ))}
          </fieldset>

          <span className="ms-auto font-mono text-[11px] text-dim">
            {count(view.turns.length)} turns · {count(view.toolCallCount)} tools
          </span>
        </div>

        {view.malformedCount > 0 && (
          <p className="border-b border-rule px-4 py-3 font-mono text-[11px] text-dim lg:px-6">
            {count(view.malformedCount)} unreadable {view.malformedCount === 1 ? 'line' : 'lines'}{' '}
            skipped. A transcript written by a live session routinely ends mid-line.
          </p>
        )}

        {view.turns.length === 0 ? (
          <p className="px-4 py-10 text-[14px] text-muted lg:px-6">
            This transcript has no conversation records — only bookkeeping.
          </p>
        ) : (
          view.turns.map((turn, index) => (
            <TurnBlock
              key={turn.index}
              turn={turn}
              density={density}
              focused={turn.index === focusTurn}
              isLast={index === view.turns.length - 1 && view.unattachedSubagents.length === 0}
            />
          ))
        )}

        {UNATTACHED_GROUPS.map(({ reason, heading, explanation }) => {
          const group = view.unattachedSubagents.filter((s) => s.reason === reason)
          if (group.length === 0) return null
          return (
            <section key={reason} className="border-t border-rule px-4 py-5 lg:px-6">
              <h2 className="band-label">{heading}</h2>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">{explanation}</p>
              <div className="mt-3">
                {group.map((subagent) => (
                  <Step
                    key={subagent.agentId}
                    density={density}
                    step={{
                      id: subagent.agentId,
                      type: 'tool',
                      summary: {
                        name: 'Agent',
                        kind: 'task',
                        // Workflow agents carry no `description`, so without this every row
                        // in a 135-agent session collapses to the identical word "Agent".
                        target: subagent.description ?? subagent.agentId,
                        ...(subagent.agentType !== undefined && { detail: subagent.agentType }),
                      },
                      input: { text: '', clipped: 0 },
                      subagents: [subagent],
                    }}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <aside className="hidden lg:block">
        <Minimap turns={view.turns} />
      </aside>
    </div>
  )
}
