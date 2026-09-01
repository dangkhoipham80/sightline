/**
 * Quoting, for the two shells we ever have to write a literal into.
 *
 * These exist because a working directory is user data. It contains spaces, apostrophes
 * and — on at least one machine we have looked at — a `$`. Building a command line by
 * concatenation works right up until it doesn't, and the failure is a shell running
 * something nobody wrote.
 *
 * Both functions produce a *literal*: whatever goes in comes back out with no expansion,
 * no globbing, no substitution.
 */

/** Characters that survive a POSIX shell untouched, so an unquoted value is safe. */
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Single-quote for `sh`/`bash`. Inside single quotes nothing is special except the
 * closing quote itself, which is escaped by leaving the quoted region, emitting an
 * escaped quote, and re-entering: `'` → `'\''`.
 */
export function quotePosix(value: string): string {
  if (POSIX_SAFE.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Single-quote for PowerShell. A single-quoted PowerShell string is fully literal — `$`,
 * backtick and backslash all mean themselves, which is what makes it the right choice for
 * Windows paths — and an embedded quote is escaped by doubling it.
 *
 * Always quoted, even when it looks safe: PowerShell's unquoted argument parsing has
 * enough special cases that "looks safe" is not worth reasoning about per call site.
 */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
