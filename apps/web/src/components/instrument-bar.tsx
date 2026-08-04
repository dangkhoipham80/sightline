import Link from 'next/link'
import { ScanButton } from '@/components/scan-button'

export function InstrumentBar({ indexPath }: { indexPath: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-ink/95 backdrop-blur">
      {/* A fixed height rather than padding: the session viewer sticks its own toolbar
          directly underneath this bar, and needs to know how far down that is. */}
      <div className="mx-auto flex h-bar max-w-[1400px] items-center gap-x-6 px-4 lg:px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-display text-[15px] font-bold tracking-[0.14em] text-text">
            SIGHTLINE
          </span>
          <span className="hidden font-mono text-[11px] text-dim sm:inline">
            every session, one axis
          </span>
        </Link>

        <div className="ms-auto flex items-center gap-4">
          <span className="hidden font-mono text-[11px] text-dim md:inline" title={indexPath}>
            {indexPath}
          </span>
          <ScanButton />
        </div>
      </div>
    </header>
  )
}
