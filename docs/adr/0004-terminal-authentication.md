# ADR 0004 — Authenticating a socket that spawns shells

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The terminal sidecar ([ADR 0003](0003-a-pty-sidecar-over-a-next-custom-server.md)) accepts
a WebSocket and spawns a shell. It is the highest-value target in the product: anything
that can reach it can run arbitrary code as the user.

The tempting reasoning is "it binds to `127.0.0.1`, so only local software can reach it."
That is false for browsers. **Browsers do not apply CORS to WebSocket handshakes**, so any
page the user happens to visit can open `ws://127.0.0.1:<port>` from their machine and
drive it. This is cross-site WebSocket hijacking, and 2026 produced a run of exactly this
CVE — nginx-ui (CVE-2026-34403), Mailpit (CVE-2026-67448), Dozzle
(`GHSA-j643-x8pv-8m67`, an exec endpoint reachable this way), and nanobot, where the
maintainers had *already* moved from `0.0.0.0` to `127.0.0.1` and still shipped the hole
because `Origin` went unvalidated.

Cookies do not help. They ride along automatically on the cross-origin handshake, which is
the vulnerability rather than the defence. `SameSite=Lax` is insufficient: on localhost,
every other port is same-site.

## Decision

**Three independent controls, all of them, checked in the `upgrade` handler before
`handleUpgrade`:**

1. **Bind `127.0.0.1` explicitly.** Omitting the host binds `0.0.0.0` and publishes a shell
   to the LAN.
2. **Exact-match `Origin` allowlist.** No regex, no `String.includes('localhost')` —
   `evil-localhost.com` matches a substring test. A `null` origin is rejected.
3. **A short-lived HMAC ticket**, minted by an `apps/web` route handler, carried in
   `Sec-WebSocket-Protocol`, compared with `timingSafeEqual` after a length check.

A ticket is scoped: `{scope, projectId, terminalId, exp, nonce}`. **`apps/web` only issues
one for a `projectId` that exists in the `projects` table**, and the sidecar re-checks
against its own read connection before spawning. There is no code path that spawns in an
arbitrary directory.

## Rationale

A token is the control that actually stops CSWSH, and it works for a reason worth stating:
a cross-origin page cannot read it (same-origin policy) and, unlike a cookie, the browser
will not attach it automatically. The `Origin` check is defence in depth against a token
leaking; the loopback bind is defence in depth against both.

`Sec-WebSocket-Protocol` rather than a query string because query strings land in server
logs, browser history, and referrer-adjacent places, and a shell token in a log file is a
shell token in a backup. base64url is a valid RFC 7230 token, so it needs no escaping —
but `handleProtocols` must echo the subprotocol back or the browser closes the socket
immediately.

Short expiry (30 s) and single scope mean a captured ticket is worth very little: it cannot
be replayed later and cannot be pointed at a different project.

This is roughly where the established tools landed. VS Code Server has required a
connection token since 1.62 (`--connection-token`, stored user-readable-only, random port,
`/version` the only unauthenticated path). `ttyd` ships `--check-origin`, is **read-only by
default** with `--writable` as an opt-in, and its own documentation recommends running it
against a container as a jail.

## Consequences

- The token never appears on a command line. argv is world-readable in the process table.
- `~/.sightline/terminal.secret` is written mode `0o600` and deleted on shutdown. It is the
  HMAC key, not a bearer token — clients never see it.
- Failed upgrades are counted per source; more than ten a minute gets a `429` and a one
  second delay, to blunt online guessing.
- Distinct close codes so the client can tell the cases apart: `4401` bad or expired
  ticket, `4403` project not permitted, `4404` unknown terminal, `4429` too many terminals.
- If a Content-Security-Policy is ever added to `apps/web`, `connect-src` must list the
  sidecar's `ws://127.0.0.1:<port>`. Easy to forget, breaks the terminal completely.
- The Origin allowlist is configuration (`SIGHTLINE_WEB_ORIGIN`), because a user who runs
  the web app on a different port must be able to say so — but it defaults closed.

## Revisit when

The sidecar needs to serve anything other than the local browser — remote access over
Tailscale, a mobile client, or a shared machine. Every one of those changes the threat
model, and the answer is likely a Unix domain socket or an SSH tunnel rather than a wider
allowlist. Do not widen the allowlist to solve a remote-access problem.
