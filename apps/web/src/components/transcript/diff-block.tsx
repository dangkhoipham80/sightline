import type { DiffView } from '@sightline/core'
import { shortPath } from '@/lib/format'

/**
 * An edit rendered as a change rather than as two walls of text.
 *
 * Sign characters carry the meaning, not colour — the `+`/`-` gutter is the accessible
 * channel, and the tint behind it is reinforcement. Line numbers come from the diff so a
 * hunk can be located in the real file, which is the first thing you want to do with one.
 */
export function DiffBlock({ view }: { view: DiffView }) {
  const { stat } = view.diff

  return (
    <figure className="mt-2 overflow-hidden rounded-sm border border-rule">
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule bg-panel px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted"
          title={view.filePath}
        >
          {shortPath(view.filePath)}
        </span>
        {view.label !== undefined && (
          <span className="font-mono text-[11px] text-dim">{view.label}</span>
        )}
        <span className="font-mono text-[11px]">
          <span className="text-act-4">+{stat.added}</span>{' '}
          <span className="text-muted">−{stat.removed}</span>
        </span>
      </figcaption>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
          <tbody>
            {view.diff.hunks.map((hunk, hunkIndex) => (
              // Hunks have no id of their own; position within a computed diff is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: no stable identity exists here
              <Hunk key={hunkIndex} skipped={hunk.skippedBefore} lines={hunk.lines} />
            ))}
          </tbody>
        </table>
      </div>

      {(view.clipped || stat.truncated) && (
        <p className="border-t border-rule px-3 py-2 font-mono text-[11px] text-dim">
          {stat.truncated
            ? 'too large to align line by line — shown as a wholesale replacement'
            : 'later hunks not shown'}
        </p>
      )}
    </figure>
  )
}

function Hunk({
  skipped,
  lines,
}: {
  skipped: number
  lines: DiffView['diff']['hunks'][number]['lines']
}) {
  return (
    <>
      {skipped > 0 && (
        <tr>
          <td colSpan={4} className="bg-panel/60 px-3 py-1 text-[11px] text-dim">
            ⋯ {skipped} unchanged {skipped === 1 ? 'line' : 'lines'}
          </td>
        </tr>
      )}
      {lines.map((line, index) => (
        <tr
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity beyond its position
          key={index}
          className={
            line.kind === 'add' ? 'bg-act-4/10' : line.kind === 'remove' ? 'bg-muted/10' : undefined
          }
        >
          <td className="w-10 select-none border-r border-rule px-2 text-right text-dim tabular-nums">
            {line.oldLine ?? ''}
          </td>
          <td className="w-10 select-none border-r border-rule px-2 text-right text-dim tabular-nums">
            {line.newLine ?? ''}
          </td>
          <td
            className={`w-5 select-none pl-2 text-center ${
              line.kind === 'add'
                ? 'text-act-4'
                : line.kind === 'remove'
                  ? 'text-muted'
                  : 'text-dim'
            }`}
          >
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
          </td>
          <td className="whitespace-pre px-2 text-text">{line.text === '' ? ' ' : line.text}</td>
        </tr>
      ))}
    </>
  )
}
