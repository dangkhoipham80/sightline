import type { ProjectRow } from '@sightline/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { ProjectTabs } from '@/components/project-tabs'
import { findProject } from '@/lib/project'
import { storeDetail, storeLabel } from '@/lib/store-groups'

export const dynamic = 'force-dynamic'

/**
 * The frame every project view shares: identity above, REVIEW / CONSOLE below.
 *
 * A layout rather than a component each page renders, so that switching tabs re-renders
 * only the pane. That matters more than it looks: the console tab will host a terminal,
 * and a header that remounts on every tab change would take the terminal with it.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const project = findProject(id)
  if (project === undefined) notFound()

  return (
    <main className="mx-auto max-w-[1400px] px-4 pb-24 lg:px-6">
      <nav className="pt-6">
        <Link href="/" className="font-mono text-[11px] text-dim hover:text-signal">
          ← projects
        </Link>
      </nav>

      <header className="py-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h1 className="font-display text-2xl font-medium text-text">{project.displayName}</h1>
          {project.orphaned && (
            <span className="rounded-sm border border-rule px-1.5 py-px font-mono text-[10px] text-dim">
              directory gone
            </span>
          )}
        </div>

        <dl className="mt-4 grid gap-2 font-mono text-[12px] sm:grid-cols-2 lg:grid-cols-4">
          <Field label="cwd" value={project.realCwd} />
          <Field label="git root" value={project.gitRoot ?? 'none found'} />
          <Field label="remote" value={project.repoUrl ?? '—'} />
          {/*
           * Both, side by side, because they are different facts and this is the page where
           * their disagreement is worth seeing: `path` is the shape of the working directory,
           * `store` is which `claude` can reopen the work. A Windows session with a UNC cwd
           * reads `wsl` on the left and `Windows` on the right, and that is correct. See
           * ADR 0005 — deriving either from the other is the bug the ADR was written for.
           */}
          <Field label="path" value={pathKind(project)} />
          <Field
            label="store"
            value={`${storeLabel(project.store)} · ${storeDetail(project.store)}`}
          />
        </dl>

        {project.folderKeys.length > 1 && (
          <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-muted">
            Claude Code filed this repository under {project.folderKeys.length} separate folders.
            They are one project here because they resolve to one git root.
          </p>
        )}
      </header>

      <div className="border-b border-rule">
        <ProjectTabs projectId={project.id} />
      </div>

      {children}
    </main>
  )
}

function pathKind(project: ProjectRow): string {
  return project.distro === null ? project.hostKind : `${project.hostKind} · ${project.distro}`
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="band-label">{label}</dt>
      <dd className="mt-1 truncate text-muted" title={value}>
        {value}
      </dd>
    </div>
  )
}
