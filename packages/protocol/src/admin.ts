import { Schema } from "effect"
import { NonNegativeFinite, NonNegativeInt } from "./common.ts"

/**
 * Admin access (docs/FRONTENDS-AND-ACTIVATION.md §1, protocol 5).
 *
 * The server has one admin password, `PVA_ADMIN_PASSWORD` in `.env` (unset = admin is disabled and nothing can be
 * configured from a browser). A connection becomes admin with `admin.login` (the password) or by sending a valid
 * session token in `hello.adminToken`. Every change to server settings, modules, the vault, jobs, models, `.env`
 * moves, front-end defaults and devices needs an admin connection; any of those requests from another connection is
 * answered with error code `admin_required`. Admin login does not unlock the key vault (that has its own password).
 */

/** A session token: 32 random bytes, base64url without padding (43 characters). Kept in `sessionStorage`. */
export const AdminToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))
export type AdminToken = typeof AdminToken.Type

/** Shortest admin password the server accepts in `PVA_ADMIN_PASSWORD` (shorter = admin disabled, logged). */
export const MIN_ADMIN_PASSWORD_CHARS = 8
/** A session ends this long after login, whatever happens. */
export const ADMIN_SESSION_MAX_MS = 12 * 60 * 60 * 1000
/** A session ends after this long without an admin action (a request that needs admin). */
export const ADMIN_SESSION_IDLE_MS = 30 * 60 * 1000

/** Returned on the `result` of a successful `admin.login` (and only there). */
export const AdminSession = Schema.Struct({
  token: AdminToken,
  /** Epoch milliseconds when the session ends at the latest (`ADMIN_SESSION_MAX_MS` after login). Idle ends it sooner. */
  expiresAt: NonNegativeFinite
})
export type AdminSession = typeof AdminSession.Type

/** Admin access as one connection sees it (`snapshot.admin`, `admin.state`). */
export const AdminState = Schema.Struct({
  /** `false`: no (valid) `PVA_ADMIN_PASSWORD`; the admin front end shows how to set it and nothing else. */
  enabled: Schema.Boolean,
  /** This connection is admin now. */
  loggedIn: Schema.Boolean,
  /** Login attempts are refused for this long (wrong passwords; the same back-off as vault unlocks). */
  retryAfterMs: Schema.optionalKey(NonNegativeInt),
  /** While logged in: epoch milliseconds when the session ends at the latest. */
  expiresAt: Schema.optionalKey(NonNegativeFinite),
  /**
   * Why the session just ended (sent once, with `loggedIn: false`): `logout` (this or another connection of the
   * session logged out), `expired` (12 h), `idle` (30 min without an admin action), `token` (the `hello` token was
   * not valid: unknown, ended, or the server restarted).
   */
  endReason: Schema.optionalKey(Schema.Literals(["logout", "expired", "idle", "token"]))
})
export type AdminState = typeof AdminState.Type
