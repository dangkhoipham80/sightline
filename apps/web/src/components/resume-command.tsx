'use client'

import { useEffect, useState } from 'react'

/**
 * Hand back the command that reopens this session where it ran.
 *
 * `claude --resume` scopes to the directory you are standing in, which is exactly why a
 * session found here is otherwise awkward to get back into: you have to know where it was.
 * The `cd` is half the value of the button.
 */
export function ResumeCommand({ sessionId, cwd }: { sessionId: string; cwd: string | null }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const command =
    cwd === null ? `claude --resume ${sessionId}` : `cd ${cwd} && claude --resume ${sessionId}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      // A denied clipboard permission is the user's call, not an error to shout about.
      // The command is in the title attribute either way.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={command}
      className="rounded-sm border border-rule px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:border-signal hover:text-signal"
    >
      {copied ? 'copied' : 'copy resume command'}
    </button>
  )
}
