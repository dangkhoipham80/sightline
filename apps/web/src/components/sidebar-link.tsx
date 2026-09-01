'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * One project in the sidebar.
 *
 * A client component only because the active state needs the current path. It stays this
 * small deliberately: the sidebar reads the database and does the grouping on the server,
 * and shipping the whole project list to the client to highlight one row would be a poor
 * trade.
 */
export function SidebarLink({
  href,
  label,
  meta,
  title,
}: {
  href: string
  label: string
  meta: string
  title: string
}) {
  const pathname = usePathname()
  // Matches the project's console tab as well as its review tab — both are "this project",
  // and the sidebar answers where you are, not which tab you are on.
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      title={title}
      className={`flex items-baseline gap-2 border-s-2 py-1.5 pe-3 ps-3 transition-colors ${
        active
          ? 'border-s-signal bg-raised/60 text-text'
          : 'border-s-transparent text-muted hover:border-s-rule hover:text-text'
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <span className="shrink-0 font-mono text-[10px] text-dim">{meta}</span>
    </Link>
  )
}
