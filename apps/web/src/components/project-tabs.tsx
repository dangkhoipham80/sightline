'use client'

import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'

/**
 * REVIEW / CONSOLE, per project.
 *
 * Reads the route segment rather than parsing `usePathname()`, so it cannot disagree with
 * which page is actually rendered — the index route reports `null`, the console route
 * reports `'console'`. A pathname prefix check would also match `/projects/abc-console`.
 */
export function ProjectTabs({ projectId }: { projectId: string }) {
  const segment = useSelectedLayoutSegment()

  return (
    <nav className="-mb-px flex gap-6" aria-label="Project views">
      <Tab href={`/projects/${projectId}`} label="Review" active={segment === null} />
      <Tab href={`/projects/${projectId}/console`} label="Console" active={segment === 'console'} />
    </nav>
  )
}

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`band-label border-b-2 pb-2 transition-colors ${
        active
          ? 'border-b-signal text-signal'
          : 'border-b-transparent hover:border-b-rule hover:text-muted'
      }`}
    >
      {label}
    </Link>
  )
}
