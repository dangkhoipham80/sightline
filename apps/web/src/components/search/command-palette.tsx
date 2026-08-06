'use client'

import type { SearchHit } from '@sightline/db'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { splitSnippet } from '@/lib/snippet'

/**
 * Search from anywhere, without leaving the keyboard.
 *
 * The PRD's v0.1 target is "find a thing you remember doing sometime last month in under
 * 30 seconds". Thirty seconds is not a lot of navigation, which is why this opens over
 * whatever you are looking at rather than sending you to a page first.
 *
 * Scope follows context: on a project page it searches that project, because that is
 * almost always what you meant, and Tab flips it to everything.
 */

interface SessionSuggestion {
  id: string
  title: string | null
  projectId: string
  startedAt: string | null
  messageCount: number
}

interface Results {
  sessions: SessionSuggestion[]
  hits: SearchHit[]
  total: number
}

const EMPTY: Results = { sessions: [], hits: [], total: 0 }

/** Long enough that a fast typist issues one query, short enough to feel immediate. */
const DEBOUNCE_MS = 120

export function CommandPalette() {
  const router = useRouter()
  const pathname = usePathname()
  const listId = useId()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results>(EMPTY)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [scoped, setScoped] = useState(true)

  const inputRef = useRef<HTMLInputElement>(null)

  // The project to scope to, taken from the URL. A session page does not name its project
  // in the path, so scoping is offered where it can be honoured and not faked elsewhere.
  const projectId = pathname.startsWith('/projects/') ? pathname.split('/')[2] : undefined
  const scopeTo = scoped ? projectId : undefined

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((previous) => !previous)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else {
      setQuery('')
      setResults(EMPTY)
      setActive(0)
    }
  }, [open])

  // Close on navigation, so following a result does not leave the palette hanging over
  // the page it just took you to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the point is to react to the path changing
  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults(EMPTY)
      setBusy(false)
      return
    }

    setBusy(true)
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const url = new URL('/api/search', window.location.origin)
        url.searchParams.set('q', trimmed)
        if (scopeTo !== undefined) url.searchParams.set('project', scopeTo)

        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(String(response.status))
        setResults((await response.json()) as Results)
        setActive(0)
      } catch (error) {
        // An aborted request is the expected outcome of typing another character, not a
        // failure worth showing.
        if ((error as Error)?.name !== 'AbortError') setResults(EMPTY)
      } finally {
        setBusy(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, scopeTo])

  const trimmed = query.trim()
  const shown = results.sessions.length + results.hits.length

  const rows: Array<{
    key: string
    href: string
    session?: SessionSuggestion
    hit?: SearchHit
    all?: number
  }> = [
    ...results.sessions.map((session) => ({
      key: `s-${session.id}`,
      href: `/sessions/${session.id}`,
      session,
    })),
    ...results.hits.map((hit) => ({
      key: `m-${hit.sessionId}-${hit.messageUuid}`,
      href: `/sessions/${hit.sessionId}?m=${encodeURIComponent(hit.messageUuid)}`,
      hit,
    })),
  ]

  // "See all" is a row rather than a footer hint, because Enter opens whatever is
  // highlighted — and the first row is highlighted by default. A footer promising
  // "↵ for all" would be describing a keystroke that does something else.
  if (trimmed.length > 0 && results.total > shown) {
    rows.push({ key: 'all', href: searchHref(trimmed, scopeTo), all: results.total })
  }

  const go = useCallback(
    (href: string) => {
      setOpen(false)
      router.push(href)
    },
    [router],
  )

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        break
      case 'ArrowDown':
        event.preventDefault()
        setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length))
        break
      case 'Tab':
        if (projectId !== undefined) {
          event.preventDefault()
          setScoped((s) => !s)
        }
        break
      case 'Enter': {
        event.preventDefault()
        const row = rows[active]
        // With no rows at all, Enter still runs the full search — the palette caps at 20,
        // and "nothing here" should not be a dead end.
        if (row === undefined) {
          if (trimmed.length > 0) go(searchHref(trimmed, scopeTo))
        } else go(row.href)
        break
      }
      default:
        break
    }
  }

  if (!open) return <PaletteHint onOpen={() => setOpen(true)} />

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/70 px-4 pt-[12vh] backdrop-blur-sm">
      {/* Clicking away closes. A button rather than a div so it is reachable and announced. */}
      <button
        type="button"
        aria-label="Close search"
        onClick={() => setOpen(false)}
        className="absolute inset-0 cursor-default"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="relative w-full max-w-2xl overflow-hidden rounded-md border border-rule bg-panel shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-rule px-4 py-3">
          <span className="font-mono text-[11px] text-dim">⌕</span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search every session…"
            className="min-w-0 flex-1 bg-transparent font-sans text-[15px] text-text outline-none placeholder:text-dim"
          />
          {projectId !== undefined && (
            <span className="shrink-0 rounded-sm border border-rule px-1.5 py-px font-mono text-[10px] text-dim">
              {scoped ? 'this project' : 'everything'} · tab
            </span>
          )}
        </div>

        <ul id={listId} className="max-h-[52vh] overflow-y-auto">
          {rows.map((row, index) => (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => go(row.href)}
                onMouseEnter={() => setActive(index)}
                aria-current={index === active ? 'true' : undefined}
                className={`block w-full border-b border-rule px-4 py-2.5 text-left ${
                  index === active ? 'bg-raised' : ''
                }`}
              >
                {row.all !== undefined ? (
                  <span className="font-mono text-[12px] text-signal">
                    See all {row.all} matches →
                  </span>
                ) : row.session !== undefined ? (
                  <SessionRowContent session={row.session} />
                ) : (
                  <HitRowContent hit={row.hit} />
                )}
              </button>
            </li>
          ))}

          {rows.length === 0 && trimmed.length > 0 && !busy && (
            <li className="px-4 py-6 text-[13px] text-muted">
              Nothing matched <span className="font-mono text-text">{query}</span>. Terms are
              combined with AND, so fewer words find more.
            </li>
          )}
        </ul>

        <div className="flex items-center justify-between border-t border-rule px-4 py-2 font-mono text-[10px] text-dim">
          <span>↑↓ move · ↵ open · esc close</span>
          <span>{busy ? 'searching…' : shown > 0 ? `${results.total} matches` : ''}</span>
        </div>
      </div>
    </div>
  )
}

function SessionRowContent({ session }: { session: SessionSuggestion }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="shrink-0 font-mono text-[10px] text-dim">session</span>
      <span className="min-w-0 flex-1 truncate font-display text-[14px] text-text">
        {session.title ?? session.id}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-dim">{session.messageCount} msgs</span>
    </div>
  )
}

function HitRowContent({ hit }: { hit: SearchHit | undefined }) {
  if (hit === undefined) return null

  return (
    <>
      <div className="flex items-baseline gap-2 font-mono text-[10px] text-dim">
        <span>{hit.kind}</span>
        <span className="min-w-0 flex-1 truncate">{hit.sessionTitle ?? hit.sessionId}</span>
        {hit.isSidechain && <span className="shrink-0 text-muted">subagent</span>}
        <span className="shrink-0">{hit.projectName}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted">
        {splitSnippet(hit.snippet).map((segment, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: segments have no identity beyond position
            key={index}
            className={segment.match ? 'rounded-[2px] bg-signal/25 text-text' : undefined}
          >
            {segment.text}
          </span>
        ))}
      </p>
    </>
  )
}

/** The affordance. A palette nobody knows about is a palette nobody uses. */
function PaletteHint({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-2 rounded-sm border border-rule px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:border-signal hover:text-signal"
    >
      <span>⌕ search</span>
      <kbd className="rounded-[2px] border border-rule px-1 text-[10px]">⌘K</kbd>
    </button>
  )
}

/**
 * The results page for a query the palette is showing.
 *
 * `prefix=1` carries the palette's own matching rule across, so the count on the "see all"
 * row is the count the page then reports. Without it the palette says 45 and the page says
 * 42 — the palette completes the last term as you type and the page does not. A URL typed
 * by hand has no flag and stays exact, which is the right default for a deliberate query.
 */
export function searchHref(query: string, projectId?: string): string {
  const params = new URLSearchParams({ q: query.trim(), prefix: '1' })
  if (projectId !== undefined) params.set('project', projectId)
  return `/search?${params.toString()}`
}
