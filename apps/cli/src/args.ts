/**
 * A deliberately small flag parser.
 *
 * `node:util`'s `parseArgs` would do this, but it throws on an unknown option and the
 * message it throws is not one a user of `sightline` should have to read. Six commands do
 * not justify a dependency either. What matters here is that an unrecognised flag is
 * *reported*, not ignored: a silently dropped `--force` on a scan looks like a scan that
 * ran, and the second-worst outcome after wrong data is stale data that looks fresh.
 */

export interface ParsedArgs {
  positionals: string[]
  /** `--flag value` and `--flag=value` both land here; a bare `--flag` stores `true`. */
  flags: Map<string, string | true>
}

/**
 * Options that take a value. Everything else is a boolean switch.
 *
 * Needed because `--force --index x` and `--index --force` are indistinguishable without
 * it: greedily consuming the next token would eat the second flag as `--force`'s value.
 */
export function parseArgs(argv: readonly string[], valued: readonly string[] = []): ParsedArgs {
  const takesValue = new Set(valued)
  const positionals: string[] = []
  const flags = new Map<string, string | true>()

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue

    if (token === '--') {
      positionals.push(...argv.slice(i + 1).filter((t): t is string => t !== undefined))
      break
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }

    const eq = token.indexOf('=')
    if (eq !== -1) {
      flags.set(token.slice(0, eq).replace(/^-+/, ''), token.slice(eq + 1))
      continue
    }

    const name = token.replace(/^-+/, '')
    if (takesValue.has(name)) {
      const next = argv[i + 1]
      // A missing value stores `true` rather than swallowing the following flag. The
      // command reports it, because only the command knows what the option meant.
      if (next === undefined || next.startsWith('-')) flags.set(name, true)
      else {
        flags.set(name, next)
        i += 1
      }
      continue
    }

    flags.set(name, true)
  }

  return { positionals, flags }
}

/** Flags the caller did not declare. Empty is the only acceptable result. */
export function unknownFlags(parsed: ParsedArgs, known: readonly string[]): string[] {
  const allowed = new Set(known)
  return [...parsed.flags.keys()].filter((name) => !allowed.has(name))
}

/** A `--flag` given without a value reads as `true`, which is never a usable string. */
export function stringFlag(parsed: ParsedArgs, name: string): string | undefined | 'missing-value' {
  const value = parsed.flags.get(name)
  if (value === undefined) return undefined
  return value === true ? 'missing-value' : value
}

export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true
}

/**
 * A port, or the reason it is not one.
 *
 * `--port 0` is rejected rather than honoured. The OS reads it as "any free port", which
 * would start a server on an address nobody was told about — including the browser this
 * command is about to open.
 */
export function parsePort(raw: string): number | string {
  if (!/^\d+$/.test(raw)) return `not a number: ${JSON.stringify(raw)}`
  const port = Number(raw)
  if (port < 1 || port > 65535) return `out of range: ${raw}`
  return port
}
