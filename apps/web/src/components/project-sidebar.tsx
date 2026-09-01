import type { ProjectRow } from '@sightline/db'
import { SidebarLink } from '@/components/sidebar-link'
import { compact } from '@/lib/format'
import { groupByStore } from '@/lib/store-groups'

/**
 * The persistent project list, grouped by the `~/.claude` each project's work lives in.
 *
 * `fixed` rather than a flex sibling of `<main>`, for a reason that outlives this PR. The
 * session viewer sticks its own toolbar at `top-bar` and its minimap below that, and both
 * depend on the document being the scrolling element. A flex row with a scrolling column
 * would make the sidebar its own scroll container and quietly break them. Taking the
 * sidebar out of flow entirely leaves the page scrolling exactly as it did, and it is also
 * the shape `TerminalLayer` needs — it will be positioned against this same edge.
 *
 * Hidden below `lg`, where there is no room for it and the dashboard is the navigation.
 */
export function ProjectSidebar({ projects }: { projects: readonly ProjectRow[] }) {
  const groups = groupByStore(projects)

  return (
    <nav
      aria-label="Projects"
      className="fixed bottom-0 start-0 top-bar z-10 hidden w-sidebar overflow-y-auto border-e border-rule bg-panel lg:block"
    >
      <div className="py-3">
        {groups.map((group) => (
          <section key={group.key} className="mb-4">
            {/* Stacked, not side by side. `band-label` is uppercase with 0.18em tracking,
                so a distro name and its command do not both fit in 15rem — measured, and
                `Ubuntu-24.04` was clipped to `UBUNTU-24.…`, which is exactly the word that
                has to stay readable for the heading to mean anything. */}
            <div className="px-3 pb-1.5">
              <h2 className="band-label truncate" title={group.label}>
                {group.label}
              </h2>
              {/* The launch command, not the path kind. A heading that says `Ubuntu-24.04`
                  is only useful if it also says which shell opens there — that is the
                  distinction ADR 0005 exists to keep visible. */}
              <p className="truncate font-mono text-[10px] text-dim" title={group.detail}>
                {group.detail}
              </p>
            </div>

            {group.projects.map((project) => (
              <SidebarLink
                key={project.id}
                href={`/projects/${project.id}`}
                label={project.displayName}
                meta={compact(project.sessionCount)}
                title={`${project.displayName} — ${project.realCwd}`}
              />
            ))}
          </section>
        ))}
      </div>
    </nav>
  )
}
