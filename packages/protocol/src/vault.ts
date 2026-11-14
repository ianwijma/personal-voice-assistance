import { Schema } from "effect"
import { NonNegativeInt } from "./common.ts"

/**
 * The key vault (docs/UI-AND-MODULES.md §1.6, "Keys & access").
 *
 * API keys and tokens live in an encrypted file outside the project, unlocked
 * with the owner's password after each server start.
 *
 * Protocol 5 (docs/FRONTENDS-AND-ACTIVATION.md): admin access no longer comes from the vault password. A
 * connection is admin after `admin.login` (see `admin.ts`); every `vault.*` request needs an admin connection, and
 * `vault` / `snapshot.vault` go to admin connections only. Typing the vault password unlocks the keys and nothing
 * else; "no vault = everyone is admin" is gone too.
 */

/** Longest password accepted. Passwords are never echoed back or logged. */
export const MAX_PASSWORD_CHARS = 256
/** Shortest password accepted when one is set (enforced by the server, with a clear error). */
export const MIN_PASSWORD_CHARS = 8

export const Password = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PASSWORD_CHARS))

/**
 * - `none`: no vault yet; keys are kept as before (`data/secrets.json`).
 * - `locked`: the vault exists but the server does not have the password (always the state after a start, unless
 *   `PVA_VAULT_PASSWORD` unlocked it). Providers and modules that need a key cannot get it.
 * - `unlocked`: the keys are available to the engines and modules.
 */
export const VaultState = Schema.Literals(["none", "locked", "unlocked"])
export type VaultState = typeof VaultState.Type

/** The vault as one page sees it (`admin` is per connection). */
export const VaultInfo = Schema.Struct({
  state: VaultState,
  /**
   * This connection is admin. Since protocol 5 it equals `AdminState.loggedIn` of the same connection (admin comes
   * from `admin.login`, not from the vault password) and is kept only so the settings screen's existing checks keep
   * working; new code reads `AdminState`.
   */
  admin: Schema.Boolean,
  /** Where the vault file is (shown so the owner knows what to back up, or delete if the password is lost). */
  location: Schema.optionalKey(Schema.String),
  /** Keys from the old `data/secrets.json` were moved into the vault and that file was deleted (set once, after setup or unlock). */
  importedLegacySecrets: Schema.optionalKey(NonNegativeInt),
  /** Unlock attempts are refused for this long (too many wrong passwords). */
  retryAfterMs: Schema.optionalKey(NonNegativeInt),
  /**
   * Why it is locked (only while `locked`): `start` = locked since the assistant started (no `PVA_VAULT_PASSWORD`,
   * or it did not fit); `manual` = a page pressed "Lock now". Absent = not known.
   */
  lockReason: Schema.optionalKey(Schema.Literals(["start", "manual"]))
})
export type VaultInfo = typeof VaultInfo.Type
