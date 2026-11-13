import { MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS, type VaultInfo } from "@pva/protocol"

/**
 * The "Keys & access" logic, independent of where a UI shows it (today a tab of
 * the options drawer): which controls a page offers for the vault's state,
 * password checks before sending, and the retry countdown. Pure functions;
 * the actions are `AssistantClient.setupVault` / `unlockVault` / `lockVault` /
 * `changeVaultPassword`, and the state is `ClientState.vault`.
 */

/** Id of the options tab that holds the controls (links to it say "Unlock to change"). */
export const KEYS_TAB = "keys"

/**
 * - `setup`: no vault yet: offer to set a password.
 * - `unlock`: the vault is locked: a password field with Unlock.
 * - `elevate`: unlocked, but this page may not change protected settings: a password field for edit access.
 * - `admin`: this page may change everything: Lock and Change password.
 */
export type KeysView = "setup" | "unlock" | "elevate" | "admin"

export const keysView = (vault: VaultInfo): KeysView =>
  vault.state === "none" ? "setup" : vault.state === "locked" ? "unlock" : vault.admin ? "admin" : "elevate"

/** A new password and its confirmation: what is wrong with them, if anything (checked again by the server). */
export const newPasswordProblem = (password: string, confirm: string): string | undefined => {
  if (password.length < MIN_PASSWORD_CHARS) return `Use at least ${MIN_PASSWORD_CHARS} characters.`
  if (password.length > MAX_PASSWORD_CHARS) return `Use at most ${MAX_PASSWORD_CHARS} characters.`
  if (password !== confirm) return "The two passwords are not the same."
  return undefined
}

/** A password typed to unlock or confirm: only the length limits (the server says whether it is right). */
export const passwordProblem = (password: string): string | undefined =>
  password.length === 0 ? "Type the password." : password.length > MAX_PASSWORD_CHARS ? `At most ${MAX_PASSWORD_CHARS} characters.` : undefined

/** Whole seconds left of a `retryAfterMs` received at `receivedAt` (same clock as `now`). */
export const retrySecondsLeft = (retryAfterMs: number | undefined, receivedAt: number, now: number): number =>
  retryAfterMs === undefined ? 0 : Math.max(0, Math.ceil((retryAfterMs - (now - receivedAt)) / 1000))

/** How a secret field describes its state, with the vault in mind. */
export const secretStatus = (
  state: { readonly set: boolean; readonly source: "env" | "store" | "none" },
  vault: VaultInfo,
  envName: string | undefined
): string => {
  if (state.source === "env") return `Set by ${envName ?? "an environment variable"} in .env (not protected)`
  if (state.source === "store") return vault.state === "none" ? "Set (saved here)" : "Set (in the key vault)"
  if (vault.state === "locked") return "Keys are locked"
  return "Not set"
}
