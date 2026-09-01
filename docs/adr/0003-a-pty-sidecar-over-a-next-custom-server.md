# ADR 0003 — A PTY sidecar process, not a Next.js custom server

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The cockpit runs a real `claude` process per project, rendered in the browser. That needs
a PTY, a WebSocket, and a process whose lifetime is measured in hours.

`apps/web` is Next.js 15 App Router. An App Router route handler receives a web-standard
`Request` and must return a `Response`; it never sees the underlying `net.Socket`, which is
what `ws` needs for `handleUpgrade`. Next also installs its own `upgrade` listener for HMR.
Official support is [RFC #95514](https://github.com/vercel/next.js/discussions/95514),
opened July 2026 and still a draft.

So the options were: a custom `http.createServer` + `next()` + `ws` server, the `next-ws`
package (which rewrites the installed Next.js with `jscodeshift` and needs a `prepare`
script to survive `pnpm install`), SSE + POST inside route handlers, or a separate process.

## Decision

**A separate long-lived Node process, `packages/terminal`, owning every PTY.** It binds
`127.0.0.1`, speaks WebSocket, and the browser dials it directly. Next.js mints
authentication tickets and otherwise never touches a socket.

## Rationale

The decisive argument is not aesthetic, and it is not about Next.js's API surface.

**In `next dev`, HMR tears down and re-instantiates module state on every file save.** A
PTY held in a module-level `Map` inside the Next process dies every time a developer hits
save — or worse, survives as an orphaned detached `claude` with no owner. Both the custom
server and `next-ws` keep the PTY inside that blast radius. A separate process makes PTY
lifetime independent of HMR, of `next build`, and of restarting the web server at all.

That independence is not a workaround; it *is* the feature. "Close the tab, the agent keeps
working" and "edit the UI without killing four running sessions" are the same property.

Secondary reasons: identical behaviour under `next dev` and `next start` with no patching;
a shell-spawning surface kept out of the Next process, where it can be reviewed on its own
(see [ADR 0004](0004-terminal-authentication.md)); and the native `@lydell/node-pty` addon
never entering webpack's graph, avoiding the `serverExternalPackages` + explicit
`externals` dance `better-sqlite3` already requires in `apps/web/next.config.ts`.

SSE + POST was the serious alternative and would have stayed inside route handlers. It
loses on interactivity: one HTTP round-trip per keystroke, base64 for binary, and the
~6-connections-per-origin cap on HTTP/1.1. Acceptable for a log tail, poor for a TUI.

## Consequences

- Two processes in `pnpm dev`. Turbo runs both as persistent tasks; `sightline serve` will
  later either fork the bin or `import` the library, which is why the package splits
  `main.ts` (process) from `index.ts` (library).
- The browser makes a cross-origin WebSocket handshake to a different port. Browsers do not
  apply CORS to WS handshakes, so this is not free — it is the entire subject of ADR 0004.
- Port and token must reach the client without a boot race. The sidecar owns both, writing
  `~/.sightline/terminal.json` and `~/.sightline/terminal.secret`; Next reads them **per
  request**, never at module init, so there is nothing to race.
- **The sidecar's `dev` script must not watch.** `tsx watch` would restart the process on
  every save and kill every PTY — reintroducing precisely the failure mode this decision
  exists to avoid. Restarting the sidecar is a deliberate act.
- Killing the sidecar must kill its children. On Windows `IPty.kill(signal)` throws and
  `kill()` is not a process-group kill, so a `taskkill /pid <pid> /T /F` fallback and a
  `pty-pids/` directory for reaping orphans across restarts are both mandatory, not
  polish.

## Revisit when

RFC #95514 ships behind a flag *and* Next gains a documented way to hold state across HMR
boundaries. The first without the second does not change this decision.
