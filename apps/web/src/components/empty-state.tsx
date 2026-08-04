import { ScanButton } from '@/components/scan-button'

/**
 * An empty screen is an invitation to act, so this one says exactly what will happen and
 * what will not. "Nothing is written to Claude Code's own files" is the first thing a
 * reasonable person wants to know about a tool that reads their transcripts.
 */
export function EmptyState({ indexPath }: { indexPath: string }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-24">
      <p className="band-label">No index yet</p>
      <h1 className="mt-4 font-display text-3xl font-medium text-text">
        Sightline has not read your transcripts yet.
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-muted">
        Reading builds a local index of every Claude Code session on this machine — projects,
        timings, tool calls, subagents. Claude Code&rsquo;s own files are opened read-only and never
        modified.
      </p>

      <dl className="mt-8 space-y-2 border-t border-rule pt-6 font-mono text-[12px]">
        <div className="flex gap-4">
          <dt className="w-20 shrink-0 text-dim">reads</dt>
          <dd className="text-muted">~/.claude/projects</dd>
        </div>
        <div className="flex gap-4">
          <dt className="w-20 shrink-0 text-dim">writes</dt>
          <dd className="text-muted">{indexPath}</dd>
        </div>
      </dl>

      <div className="mt-8">
        <ScanButton label="Read transcripts" />
      </div>
    </div>
  )
}
