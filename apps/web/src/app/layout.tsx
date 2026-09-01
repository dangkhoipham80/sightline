import { listProjects } from '@sightline/db'
import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from 'next/font/google'
import type { ReactNode } from 'react'
import { InstrumentBar } from '@/components/instrument-bar'
import { ProjectSidebar } from '@/components/project-sidebar'
import { getDatabase, indexExists, indexPath } from '@/lib/db'
import { buildUsageMeter } from '@/lib/usage'
import './globals.css'

// The index changes under us whenever Claude Code writes, and the sidebar reads it on every
// navigation, so this layout is no more cacheable than the pages inside it.
export const dynamic = 'force-dynamic'

/*
 * Three roles, deliberately. Plex Sans and Plex Mono are one family designed for technical
 * documentation, which is what a transcript index is; Space Grotesk appears only on the
 * wordmark and page titles, where its mechanical letterforms do the work a serif would do
 * on a magazine and would do wrong here.
 */
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-space-grotesk',
})

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
})

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
})

export const metadata: Metadata = {
  title: 'Sightline',
  description: 'Every Claude Code session you have run, in one place.',
}

/**
 * The application shell: instrument bar on top, project sidebar down the side.
 *
 * Both used to be per-page — `InstrumentBar` was imported and rendered by four separate
 * pages — which meant they remounted on every navigation. Hoisting them here is what makes
 * the sidebar *persistent* rather than merely repeated, and it is a precondition for the
 * terminal: switching projects is a navigation, which remounts `<main>`, so anything that
 * has to survive the switch cannot live under a route. `TerminalLayer` mounts here later,
 * positioned over the content region.
 *
 * The chrome appears only once there is something to navigate. With no index — or an index
 * with no projects — the dashboard renders its own empty state, and framing it with a bar
 * whose Rescan button duplicates the button already in that empty state would be noise.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const projects = indexExists() ? listProjects(getDatabase()) : []
  const shell = projects.length > 0
  // Built here rather than inside the sidebar so the layout stays the one place that reads
  // the index for the chrome, and so it is skipped entirely when there is no chrome.
  const meter = shell ? buildUsageMeter() : undefined

  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        {shell && meter !== undefined && (
          <>
            <InstrumentBar indexPath={indexPath()} />
            <ProjectSidebar projects={projects} meter={meter} />
          </>
        )}
        {/* The sidebar is `fixed`, so it occupies no width in the flow and the content
            region reserves it here. Padding rather than a margin so a full-bleed border
            inside a page still reaches the sidebar's edge. */}
        <div className={shell ? 'lg:ps-sidebar' : undefined}>{children}</div>
      </body>
    </html>
  )
}
