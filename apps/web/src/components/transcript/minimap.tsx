'use client'

import type { TurnView } from '@sightline/core'
import { useEffect, useState } from 'react'

/**
 * The shape of the session, at a glance.
 *
 * One mark per turn, its length set by how much work the turn contained. What this is for
 * is the question you actually arrive with — *where in this session did the real work
 * happen* — which a scrollbar cannot answer and a table of contents answers badly, because
 * turn titles are prompts and prompts are short.
 *
 * Magnitude is encoded as length first and tint second. Nothing here is meaningful by
 * colour alone.
 */

const RAMP = ['bg-act-1', 'bg-act-2', 'bg-act-3', 'bg-act-4'] as const

export function Minimap({ turns }: { turns: readonly TurnView[] }) {
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set())

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          const next = new Set(previous)
          for (const entry of entries) {
            const index = Number(entry.target.id.replace('turn-', ''))
            if (Number.isNaN(index)) continue
            if (entry.isIntersecting) next.add(index)
            else next.delete(index)
          }
          return next
        })
      },
      { rootMargin: '-8% 0px -8% 0px' },
    )

    for (const turn of turns) {
      const element = document.getElementById(`turn-${turn.index}`)
      if (element !== null) observer.observe(element)
    }

    return () => observer.disconnect()
  }, [turns])

  const busiest = Math.max(1, ...turns.map(weight))

  return (
    <nav
      aria-label="Session minimap"
      className="sticky top-[calc(var(--spacing-bar)+1.5rem)] hidden lg:block"
    >
      <p className="band-label">Shape</p>
      <ol className="mt-3 flex flex-col gap-[3px]">
        {turns.map((turn) => {
          const share = weight(turn) / busiest
          const tint = RAMP[Math.min(RAMP.length - 1, Math.floor(share * RAMP.length))] ?? RAMP[0]

          return (
            <li key={turn.index}>
              <a
                href={`#turn-${turn.index}`}
                title={label(turn)}
                aria-current={visible.has(turn.index) ? 'true' : undefined}
                className={`flex h-[7px] items-center rounded-[1px] ${
                  visible.has(turn.index) ? 'outline outline-1 outline-signal' : ''
                }`}
              >
                <span
                  className={`h-full rounded-[1px] ${turn.toolCallCount === 0 ? 'bg-rule' : tint}`}
                  // Minimum width keeps a zero-tool turn clickable rather than invisible.
                  style={{ width: `${Math.max(12, share * 100)}%` }}
                />
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Tool calls are the closest deterministic proxy for "how much happened here". */
function weight(turn: TurnView): number {
  return turn.toolCallCount + turn.subagentCount * 4
}

function label(turn: TurnView): string {
  const prompt = turn.prompt?.text.split('\n')[0] ?? 'no prompt'
  return `${turn.index + 1}. ${prompt.slice(0, 80)} — ${turn.toolCallCount} tools`
}
