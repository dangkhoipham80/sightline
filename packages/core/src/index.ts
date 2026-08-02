/**
 * `@sightline/core` — the domain layer.
 *
 * Everything that understands Claude Code's on-disk format lives here, and nothing
 * here touches a database, a network, or a UI. Keeping it that way is what lets the
 * parser be exhaustively tested against real transcript fixtures.
 *
 * The transcript parser itself lands in `feat/transcript-parser`; see
 * `docs/TRANSCRIPT-FORMAT.md` for the reverse-engineered spec it implements.
 */

export { PRODUCT_NAME, SIGHTLINE_SCHEMA_VERSION } from './constants.js'
