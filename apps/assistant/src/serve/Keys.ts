import type { HostResult, ModuleHost } from "@pva/core"
import type { ErrorInfo, VaultInfo, VaultState } from "@pva/protocol"
import { Effect } from "effect"
import type { SettingsStore } from "./SettingsStore.ts"
import type { Vault, VaultFailure } from "./Vault.ts"

/**
 * The key vault as the server uses it (docs/UI-AND-MODULES.md §1.6): setting it
 * up, unlocking, locking and changing the password, and what follows each:
 * the keys of the old `data/secrets.json` move in, the module host gets (or
 * loses) the module secrets, and listeners hear about the change (the hub
 * tells every page, serve mode reloads failed engines after an unlock).
 *
 * Admin access is not here: it belongs to a connection (`SessionHub`).
 */

export interface Keys {
  readonly state: () => VaultState
  /** The vault as one page sees it (`admin`: that page is an admin connection; protocol 5: `VaultInfo.admin`). */
  readonly info: (admin: boolean) => VaultInfo
  readonly setup: (password: string) => Effect.Effect<HostResult>
  /** Unlock (or, when already unlocked, check the password). */
  readonly unlock: (password: string) => Effect.Effect<HostResult>
  readonly lock: Effect.Effect<HostResult>
  readonly changePassword: (oldPassword: string, newPassword: string) => Effect.Effect<HostResult>
  /** `PVA_VAULT_PASSWORD` at start: unlock with it, or log why not. Never logs the password. */
  readonly autoUnlock: (password: string) => Effect.Effect<void>
  /** Called after every change of state (setup, unlock, lock). */
  readonly subscribe: (listener: (state: VaultState) => void) => () => void
}

const failure = (code: ErrorInfo["code"], message: string): HostResult => ({ ok: false, error: { code, message } })

const fromVault = (f: VaultFailure): HostResult => {
  switch (f.reason) {
    case "wrong_password":
    case "rate_limited":
    case "too_short":
      return failure("bad_password", f.message)
    case "exists":
      return failure("busy", f.message)
    case "no_vault":
    case "locked":
      return failure("locked", f.message)
    case "damaged":
    case "io":
      return failure("internal", f.message)
  }
}

export const makeKeys = (options: {
  readonly vault: Vault
  readonly store: SettingsStore
  readonly host: ModuleHost
}): Keys => {
  const { vault, store, host } = options
  const listeners = new Set<(state: VaultState) => void>()
  let imported: number | undefined
  // Why the vault is locked, for the page's wording: since the start, or a page pressed "Lock now".
  let lockReason: "start" | "manual" = "start"

  const changed = () => {
    const state = vault.state()
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // A listener must not break the vault.
      }
    }
  }

  /** After the vault opened: move old keys in, hand the module secrets to the host, tell everyone. */
  const opened = Effect.gen(function*() {
    const legacy = store.legacySecretCount()
    const moved = yield* Effect.result(store.importLegacySecrets())
    if (moved._tag === "Failure") {
      yield* Effect.logError(moved.failure.message, moved.failure.cause)
    } else if (moved.success > 0 || legacy > 0) {
      imported = (imported ?? 0) + moved.success
      yield* Effect.logWarning(
        `Moved ${moved.success} key(s) from ${store.directory}/secrets.json into the key vault (${vault.path}) and deleted that file.`
      )
    }
    changed()
    yield* host.setSecrets(store.secrets().modules)
  })

  const run = (op: () => Promise<{ readonly ok: true } | ({ readonly ok: false } & VaultFailure)>, after: Effect.Effect<void>) =>
    Effect.gen(function*() {
      const result = yield* Effect.promise(op)
      if (!result.ok) return fromVault(result)
      yield* after
      return { ok: true } as HostResult
    })

  return {
    state: () => vault.state(),
    info: (admin) => {
      const state = vault.state()
      const retry = vault.retryAfterMs()
      return {
        state,
        admin,
        location: vault.path,
        ...(imported !== undefined ? { importedLegacySecrets: imported } : {}),
        ...(retry > 0 ? { retryAfterMs: retry } : {}),
        ...(state === "locked" ? { lockReason } : {})
      }
    },
    setup: (password) =>
      run(
        () => vault.setup(password, { modules: {}, assistant: {} }, store.revision()),
        Effect.andThen(Effect.logInfo(`Key vault created at ${vault.path}; the password is needed after every restart.`), opened)
      ),
    unlock: (password) =>
      Effect.suspend(() => {
        const wasUnlocked = vault.state() === "unlocked"
        return run(
          () => vault.unlock(password),
          wasUnlocked ? Effect.void : Effect.andThen(Effect.logInfo("Key vault unlocked."), opened)
        )
      }),
    lock: Effect.gen(function*() {
      if (vault.state() === "none") return failure("locked", "There is no key vault yet: set a password first")
      vault.lock()
      lockReason = "manual"
      yield* Effect.logInfo("Key vault locked.")
      changed()
      yield* host.setSecrets({})
      return { ok: true } as HostResult
    }),
    changePassword: (oldPassword, newPassword) =>
      Effect.suspend(() => {
        const wasUnlocked = vault.state() === "unlocked"
        return run(
          () => vault.changePassword(oldPassword, newPassword),
          Effect.andThen(Effect.logInfo("Key vault password changed."), wasUnlocked ? Effect.sync(changed) : opened)
        )
      }),
    autoUnlock: (password) =>
      Effect.gen(function*() {
        if (vault.state() === "none") {
          yield* Effect.logWarning("PVA_VAULT_PASSWORD is set but there is no key vault yet: set a password in Settings → Keys & access.")
          return
        }
        if (vault.state() === "unlocked") return
        const result = yield* run(() => vault.unlock(password), opened)
        if (result.ok) yield* Effect.logInfo(`Key vault unlocked at start with PVA_VAULT_PASSWORD (${vault.path}).`)
        else {
          yield* Effect.logError(
            `PVA_VAULT_PASSWORD did not unlock the key vault: ${result.error.message}. The keys stay locked; unlock them in Settings → Keys & access.`
          )
        }
      }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
