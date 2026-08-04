'use client'

import type { TurnView } from '@sightline/core'
import { useState } from 'react'
import type { Density } from '@/components/transcript/step'
import { Step } from '@/components/transcript/step'
import { count, duration, shortPath, stamp } from '@/lib/format'

/**
 * Rough rendered height, in pixels, used only as a hint to the browser.
 *
 * See `.turn-window` in `globals.css`: off-screen turns are skipped, and without an
 * estimate the scrollbar would jump every time one came into view. It does not have to be
 * right, only stable and the right order of magnitude.
 */
function estimateHeight(turn: TurnView): number {
  const prompt = Math.min(200, 40 + (turn.prompt?.text.length ?? 0) / 3)
  const body = turn.steps.reduce((total, step) => {
    if (step.type === 'tool') return total + 26
    if (step.type === 'system') return total + 20
    return total + Math.min(600, 30 + step.body.text.length / 2.2)
  }, 0)
  return Math.round(prompt + body + 48)
}

export function TurnBlock({
  turn,
  density,
  isLast,
}: {
  turn: TurnView
  density: Density
  isLast: boolean
}) {
  // Per-turn override of the global density, reset whenever that global moves — the
  // control has to win, or "collapse all" leaves whatever you opened by hand still open.
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const [lastDensity, setLastDensity] = useState(density)
  if (lastDensity !== density) {
    setLastDensity(density)
    setOpen(undefined)
  }

  const expanded = open ?? density !== 'prompts'
  const promptText = turn.prompt?.text ?? ''

  return (
    <article
      id={`turn-${turn.index}`}
      // Anchored scrolling has to clear both sticky bars, or a minimap jump lands the
      // turn's header underneath them.
      className={`turn-window scroll-mt-28 px-4 py-5 lg:px-6 ${isLast ? '' : 'border-b border-rule'}`}
      style={{ containIntrinsicSize: `auto ${estimateHeight(turn)}px` }}
      aria-label={`Turn ${turn.index + 1}`}
    >
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="group flex w-full items-baseline gap-3 text-left"
      >
        {/* `text-dim`, not `text-rule`: the rule colour is for borders, and at 11px it
            renders the index effectively unreadable — 08 and 98 become the same shape. */}
        <span className="shrink-0 font-mono text-[11px] text-dim tabular-nums">
          {String(turn.index + 1).padStart(2, '0')}
        </span>
        <span className="min-w-0 flex-1">
          {promptText.length > 0 ? (
            <span
              className={`block font-display text-[15px] font-medium text-text ${
                expanded ? 'whitespace-pre-wrap' : 'truncate'
              }`}
            >
              {promptText}
            </span>
          ) : (
            <span className="block font-mono text-[12px] text-dim">
              {turn.index === 0 ? 'session opening' : 'continued without a new prompt'}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-dim group-hover:text-signal">
          {expanded ? '−' : '+'}
        </span>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 font-mono text-[11px] text-dim">
        {turn.startedAt !== undefined && <span>{stamp(turn.startedAt)}</span>}
        {turn.durationMs !== undefined && <span>{duration(turn.durationMs)}</span>}
        {turn.toolCallCount > 0 && <span>{count(turn.toolCallCount)} tools</span>}
        {turn.subagentCount > 0 && (
          <span className="text-muted">
            {count(turn.subagentCount)} {turn.subagentCount === 1 ? 'subagent' : 'subagents'}
          </span>
        )}
        {turn.filesTouched.map((path) => (
          <span key={path} className="text-muted" title={path}>
            {shortPath(path)}
          </span>
        ))}
      </div>

      {expanded && turn.steps.length > 0 && (
        <div className="mt-3 pl-8">
          {turn.steps.map((step) => (
            <Step key={step.id} step={step} density={density} />
          ))}
        </div>
      )}
    </article>
  )
}
