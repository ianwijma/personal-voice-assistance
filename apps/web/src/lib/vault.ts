import { type FieldSource, MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS, type ModuleInfo, type SecretState, type VaultInfo } from "@pva/protocol"
import type { NavGroup, SettingsPath } from "./settingsTree.ts"

/**
 * The keys and vault logic, independent of where a UI shows it (the settings
 * screen's Keys & vault pages, the engine banner, the page headers' inline
 * unlock): which controls a page offers for the vault's state,
 * password checks before sending, and the retry countdown. Pure functions;
 * the actions are `AssistantClient.setupVault` / `unlockVault` / `lockVault` /
 * `changeVaultPassword`, and the state is `ClientState.vault`.
 */

/** The settings page that holds the controls (links to it say "Unlock to change"). */
export const KEYS_PATH: SettingsPath = ["keys", "access"]

/**
 * - `setup`: no vault yet: offer to set a password.
 * - `unlock`: the vault is locked: a password field with Unlock.
 * - `unlocked`: Lock and Change password.
 *
 * Since protocol 5 these controls are on the admin page only, behind the admin login; the vault password no longer
 * grants anything but the keys.
 */
export type KeysView = "setup" | "unlock" | "unlocked"

export const keysView = (vault: VaultInfo): KeysView =>
  vault.state === "none" ? "setup" : vault.state === "locked" ? "unlock" : "unlocked"

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

/** The locked view's explanation: why the keys are locked, worded for the case. */
export const lockedExplanation = (vault: VaultInfo): string => {
  const then = "Type the password so the engines and modules can use their keys again."
  if (vault.lockReason === "manual") return `The keys were locked from a page (Lock now). ${then}`
  if (vault.lockReason === "start") return `The assistant was restarted, and the keys stay locked until the password is typed. ${then}`
  return `The keys are locked. ${then}`
}

/** How a secret field describes its state, with the vault in mind (`source`: the field's, to tell .env from the process). */
export const secretStatus = (
  state: { readonly set: boolean; readonly source: "env" | "store" | "none" },
  vault: VaultInfo,
  envName: string | undefined,
  source?: FieldSource
): string => {
  if (state.source === "env") {
    return source === "env-process"
      ? `Set by ${envName ?? "an environment variable"} in the environment (not protected)`
      : `Set by ${envName ?? "an environment variable"} in .env (not protected)`
  }
  if (state.source === "store") return vault.state === "none" ? "Set (saved here)" : "Set (in the key vault)"
  if (vault.state === "locked") return "Keys are locked"
  return "Not set"
}

/** One key of the Keys page: its state and the pages that use it. */
export interface KeyEntry {
  readonly id: string
  readonly label: string
  /** The environment variable that also provides it. */
  readonly env?: string
  readonly state: SecretState
  readonly source?: FieldSource
  readonly usedBy: ReadonlyArray<{ readonly title: string; readonly path: SettingsPath }>
}

/**
 * Every key the settings know, from the navigation tree: assistant keys are stored by key (one vault entry, maybe
 * shown on several pages), module keys per module. No values: the server never sends them.
 */
export const keysList = (tree: ReadonlyArray<NavGroup>, modules: Readonly<Record<string, ModuleInfo>>): ReadonlyArray<KeyEntry> => {
  const entries = new Map<string, { -readonly [K in keyof KeyEntry]: KeyEntry[K] } & { usedBy: Array<{ title: string; path: SettingsPath }> }>()
  for (const group of tree) {
    for (const page of group.pages) {
      const forms = page.source.kind === "server"
        ? [
            ...page.source.sections.map((s) => ({ form: s.form, scope: "", name: "" })),
            ...page.source.moduleIds.flatMap((id) => (modules[id] !== undefined ? [{ form: modules[id]!.settings, scope: `${id}.`, name: modules[id]!.name }] : []))
          ]
        : []
      for (const { form, scope, name } of forms) {
        for (const field of form.fields) {
          if (field.type !== "secret") continue
          const id = `${scope}${field.key}`
          const entry = entries.get(id) ?? {
            id,
            label: scope === "" ? field.label : `${name}: ${field.label}`,
            ...(field.env !== undefined ? { env: field.env } : {}),
            state: form.secrets[field.key] ?? { set: false, source: "none" as const },
            ...(field.source !== undefined ? { source: field.source } : {}),
            usedBy: []
          }
          if (!entry.usedBy.some((u) => u.path[0] === group.slug && u.path[1] === page.id)) {
            entry.usedBy.push({ title: `${group.title} › ${page.title}`, path: [group.slug, page.id] })
          }
          entries.set(id, entry)
        }
      }
    }
  }
  return [...entries.values()]
}
