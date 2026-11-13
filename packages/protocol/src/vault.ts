import { Schema } from "effect"
import { NonNegativeInt } from "./common.ts"

/**
 * The key vault and admin access (docs/UI-AND-MODULES.md §1.6, "Keys & access").
 *
 * API keys and tokens live in an encrypted file outside the project, unlocked
 * with the owner's password after each server start. Typing that password on a
 * page also gives that page (that WebSocket connection only) admin access:
 * only admin pages may change protected settings (anything with a secret, the
 * language model and speech engines, and agent modules). Everything else stays
 * open to every page.
 */

/** Longest password accepted. Passwords are never echoed back or logged. */
export const MAX_PASSWORD_CHARS = 256
/** Shortest password accepted when one is set (enforced by the server, with a clear error). */
export const MIN_PASSWORD_CHARS = 8

export const Password = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PASSWORD_CHARS))

/**
 * - `none`: no vault yet; keys are kept as before (`data/secrets.json`) and every page may change every setting.
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
   * This page may change protected settings. Always true while there is no vault (there is no password to ask for).
   * Otherwise granted by typing the password on this page; ends when the page disconnects, locks, or after
   * 15 minutes without an admin action.
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
