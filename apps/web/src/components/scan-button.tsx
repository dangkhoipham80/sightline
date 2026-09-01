'use client'

import { useState, useTransition } from 'react'
import type { ScanReport } from '@/app/actions'
import { scanTranscripts } from '@/app/actions'
import { count } from '@/lib/format'

export function ScanButton({ label = 'Rescan' }: { label?: string }) {
  const [pending, startTransition] = useTransition()
  const [report, setReport] = useState<ScanReport | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  function run() {
    setFailed(false)
    startTransition(async () => {
      try {
        setReport(await scanTranscripts())
      } catch {
        setFailed(true)
      }
    })
  }

  return (
    <div className="flex items-center gap-3">
      {report !== undefined && !pending && (
        <span className="font-mono text-[11px] text-muted">
          {count(report.ingested)} indexed
          <span className="text-dim"> · {count(report.skipped)} unchanged</span>
          {/* Only worth saying once there is more than one — on a machine without WSL the
              store count is always 1 and naming it every scan is noise. */}
          {report.stores > 1 && <span className="text-dim"> · {report.stores} stores</span>}
          {report.failed > 0 && <span className="text-signal"> · {report.failed} failed</span>}
          {/* A store we declined to read is history the owner has and this index does not.
              Naming it is the entire reason discovery reports skips instead of just
              returning a shorter list. */}
          {report.gaps.map((gap) => (
            <span key={gap.label} className="text-signal" title={`${gap.label}: ${gap.detail}`}>
              {' '}
              · {gap.label} not indexed
            </span>
          ))}
        </span>
      )}
      {failed && (
        <span className="font-mono text-[11px] text-signal">
          Scan failed. Check that ~/.claude/projects is readable.
        </span>
      )}
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-sm border border-rule px-3 py-1.5 font-mono text-[11px] text-muted transition-colors hover:border-signal hover:text-signal disabled:border-rule disabled:text-dim"
      >
        {pending ? 'Reading transcripts…' : label}
      </button>
    </div>
  )
}
