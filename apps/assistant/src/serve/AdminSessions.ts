import { ADMIN_SESSION_IDLE_MS, ADMIN_SESSION_MAX_MS, MIN_ADMIN_PASSWORD_CHARS } from "@pva/protocol"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { FIRST_WAIT_MS, MAX_FAILURES_BEFORE_WAIT, MAX_WAIT_MS } from "./Vault.ts"

/**
 * Admin sessions (docs/FRONTENDS-AND-ACTIVATION.md §1): one password, `PVA_ADMIN_PASSWORD` (read once at start by
 * serve mode, at least `MIN_ADMIN_PASSWORD_CHARS`; shorter or unset = admin disabled). `login` with it returns a
 * random token (32 bytes, base64url) that a page sends in `hello.adminToken` to stay logged in across reloads.
 *
 * Tokens live in memory only. A session ends at `logout`, `ADMIN_SESSION_MAX_MS` after login, after
 * `ADMIN_SESSION_IDLE_MS` without an admin action (`touch`), and at restart. Passwords are compared in constant time
 * over SHA-256 digests; tokens are looked up by their SHA-256 digest, so no raw token is ever compared. Wrong
 * passwords back off like vault unlocks: after 5 in a row, refused for 30 s, every further one doubles the wait
 * (capped at an hour). The password is never logged or kept anywhere but here.
 *
 * Which connection is admin belongs to `SessionHub`: it holds the token per connection and asks `check`.
 */

export type SessionEndReason = "logout" | "expired" | "idle"

export interface AdminSessionInfo {
  readonly token: string
  readonly expiresAt: number
}

export type LoginResult =
  | { readonly ok: true; readonly session: AdminSessionInfo }
  | { readonly ok: false; readonly reason: "disabled" | "wrong" | "rate_limited"; readonly message: string; readonly retryAfterMs?: number }

export interface AdminSessions {
  /** A valid `PVA_ADMIN_PASSWORD` is set. */
  readonly enabled: boolean
  readonly login: (password: string) => LoginResult
  /** The session of this token, if it is still valid (does not count as an action). */
  readonly check: (token: string) => AdminSessionInfo | undefined
  /** An admin action: restarts the idle limit. `false` when the session is no longer valid. */
  readonly touch: (token: string) => boolean
  readonly logout: (token: string) => void
  /** Milliseconds until a login attempt is accepted again (0 = now). */
  readonly retryAfterMs: () => number
  /** Called when a session ends (`logout`, `expired`, `idle`), with its token. */
  readonly onEnd: (listener: (token: string, reason: SessionEndReason) => void) => void
  /** Ends every session silently (server shutdown). */
  readonly dispose: () => void
}

export interface AdminSessionsOptions {
  /** `PVA_ADMIN_PASSWORD`; undefined, empty or shorter than `MIN_ADMIN_PASSWORD_CHARS` = disabled. */
  readonly password: string | undefined
  /** Tests: shorter limits. */
  readonly maxMs?: number
  readonly idleMs?: number
  /** Default `Date.now` (epoch ms; `expiresAt` is sent to pages). */
  readonly now?: () => number
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest()

/** Why admin is disabled for this value of `PVA_ADMIN_PASSWORD` (`undefined`: it is valid). */
export const adminPasswordProblem = (password: string | undefined): string | undefined =>
  password === undefined || password === ""
    ? "PVA_ADMIN_PASSWORD is not set: the admin page (/admin/) is disabled and nothing can be configured from a browser. " +
      "Set it in .env (at least 8 characters) and restart."
    : [...password].length < MIN_ADMIN_PASSWORD_CHARS
    ? `PVA_ADMIN_PASSWORD is shorter than ${MIN_ADMIN_PASSWORD_CHARS} characters: the admin page (/admin/) is disabled. ` +
      "Set a longer one in .env and restart."
    : undefined

interface Session {
  readonly token: string
  readonly expiresAt: number
  lastAction: number
  timer: ReturnType<typeof setTimeout> | undefined
}

export const makeAdminSessions = (options: AdminSessionsOptions): AdminSessions => {
  const now = options.now ?? Date.now
  const maxMs = options.maxMs ?? ADMIN_SESSION_MAX_MS
  const idleMs = options.idleMs ?? ADMIN_SESSION_IDLE_MS
  const enabled = adminPasswordProblem(options.password) === undefined
  const expected = enabled ? digest(options.password!) : undefined
  /** By the token's SHA-256 digest (hex). */
  const sessions = new Map<string, Session>()
  const listeners: Array<(token: string, reason: SessionEndReason) => void> = []
  let failures = 0
  let blockedUntil = 0

  const keyOf = (token: string) => digest(token).toString("hex")
  const retryAfterMs = () => Math.max(0, blockedUntil - now())

  const end = (key: string, reason: SessionEndReason) => {
    const session = sessions.get(key)
    if (session === undefined) return
    sessions.delete(key)
    if (session.timer !== undefined) clearTimeout(session.timer)
    for (const listener of listeners) {
      try {
        listener(session.token, reason)
      } catch {
        // A listener must not keep a session alive.
      }
    }
  }

  /** The reason a session is over at `t`, or undefined while valid. */
  const over = (session: Session, t: number): SessionEndReason | undefined =>
    t >= session.expiresAt ? "expired" : t - session.lastAction >= idleMs ? "idle" : undefined

  const arm = (key: string, session: Session) => {
    if (session.timer !== undefined) clearTimeout(session.timer)
    const due = Math.min(session.expiresAt, session.lastAction + idleMs)
    session.timer = setTimeout(() => {
      session.timer = undefined
      const reason = over(session, now())
      if (reason !== undefined) end(key, reason)
      else arm(key, session)
    }, Math.max(0, due - now()) + 1)
    session.timer.unref?.()
  }

  const valid = (token: string): { key: string; session: Session } | undefined => {
    const key = keyOf(token)
    const session = sessions.get(key)
    if (session === undefined) return undefined
    const reason = over(session, now())
    if (reason !== undefined) {
      end(key, reason)
      return undefined
    }
    return { key, session }
  }

  return {
    enabled,
    login: (password) => {
      if (!enabled || expected === undefined) {
        return { ok: false, reason: "disabled", message: adminPasswordProblem(options.password)! }
      }
      const wait = retryAfterMs()
      if (wait > 0) {
        return { ok: false, reason: "rate_limited", message: `Too many wrong passwords: try again in ${Math.ceil(wait / 1000)} s`, retryAfterMs: wait }
      }
      if (!timingSafeEqual(digest(password), expected)) {
        failures++
        if (failures >= MAX_FAILURES_BEFORE_WAIT) {
          const next = Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (failures - MAX_FAILURES_BEFORE_WAIT))
          blockedUntil = now() + next
          return {
            ok: false,
            reason: "wrong",
            message: `Wrong password. Too many attempts: try again in ${Math.ceil(next / 1000)} s`,
            retryAfterMs: next
          }
        }
        return { ok: false, reason: "wrong", message: "Wrong password" }
      }
      failures = 0
      const token = randomBytes(32).toString("base64url")
      const t = now()
      const session: Session = { token, expiresAt: t + maxMs, lastAction: t, timer: undefined }
      const key = keyOf(token)
      sessions.set(key, session)
      arm(key, session)
      return { ok: true, session: { token, expiresAt: session.expiresAt } }
    },
    check: (token) => {
      const found = valid(token)
      return found === undefined ? undefined : { token: found.session.token, expiresAt: found.session.expiresAt }
    },
    touch: (token) => {
      const found = valid(token)
      if (found === undefined) return false
      found.session.lastAction = now()
      arm(found.key, found.session)
      return true
    },
    logout: (token) => end(keyOf(token), "logout"),
    retryAfterMs,
    onEnd: (listener) => {
      listeners.push(listener)
    },
    dispose: () => {
      for (const session of sessions.values()) if (session.timer !== undefined) clearTimeout(session.timer)
      sessions.clear()
    }
  }
}
