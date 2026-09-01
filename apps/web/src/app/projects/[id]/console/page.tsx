import { notFound } from 'next/navigation'
import { findProject } from '@/lib/project'
import { storeDetail, storeLabel } from '@/lib/store-groups'

export const dynamic = 'force-dynamic'

/**
 * The CONSOLE tab, without a console.
 *
 * The route exists ahead of the terminal on purpose. `TerminalLayer` mounts in the root
 * layout and shows itself when the path matches `/projects/<id>/console` — so the path has
 * to be real, and the layout above it has to already survive a project switch, before there
 * is anything to mount. PRs 17–20 fill this pane; nothing here opens a socket or spawns a
 * process.
 *
 * What it does show is the spawn decision, which is checkable now and is the part that has
 * historically been wrong: which `claude` a terminal here would use. That comes from the
 * store, never from the working directory — see ADR 0005.
 */
export default async function ProjectConsolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = findProject(id)
  if (project === undefined) notFound()

  const known = project.store !== null

  return (
    <section className="py-10">
      <div className="rounded-sm border border-dashed border-rule p-6">
        <p className="band-label">Console</p>
        <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-muted">
          A live terminal for this project will run here. It is not built yet — this tab is the
          route it will mount into.
        </p>

        <dl className="mt-6 grid max-w-xl gap-3 font-mono text-[12px] sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="band-label">would launch</dt>
            <dd className="mt-1 truncate text-muted" title={storeDetail(project.store)}>
              {known ? storeDetail(project.store) : '—'}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="band-label">in store</dt>
            <dd className="mt-1 truncate text-muted">{storeLabel(project.store)}</dd>
          </div>
        </dl>

        {!known && (
          <p className="mt-6 max-w-xl text-[13px] leading-relaxed text-muted">
            This project was indexed before Sightline recorded which{' '}
            <span className="font-mono text-text">~/.claude</span> each session came from, so there
            is no honest answer to which <span className="font-mono text-text">claude</span> would
            reopen it. Rescan and it will know.
          </p>
        )}
      </div>
    </section>
  )
}
