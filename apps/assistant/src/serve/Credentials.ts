import { CredentialError, type CredentialStore, MAX_CREDENTIALS_PER_MODULE } from "@pva/core"
import { Effect } from "effect"
import { CREDENTIALS_ENTRY, type SettingsStore } from "./SettingsStore.ts"

/**
 * Module credentials (`host.credentials`, docs/MODULES.md): secrets a module obtained itself, kept with the module
 * secrets under the entry `CREDENTIALS_ENTRY` as `moduleId/name` to value, so in the key vault once there is one (before
 * that in `data/secrets.json`, 0600, like every other secret and like route tokens). A module sees only keys with its
 * own id as prefix. While the vault is locked every call fails `locked`: a missing value is `undefined`, never confused
 * with that. The value is neither logged nor shown: the vault's values are in the log redaction (`knownSecrets`), and
 * no admin API output carries this entry. A module's credentials stay when the module is removed (like its other
 * secrets and route tokens), so reinstalling it finds them.
 */
export const makeCredentials = (options: {
  readonly store: Pick<SettingsStore, "secrets" | "saveCredentials" | "blocked">
  /** The key vault exists and is locked. */
  readonly locked: () => boolean
}): CredentialStore => {
  const lockedError = () => new CredentialError({ reason: "locked", message: "The key vault is locked: unlock it in Settings → Keys & access first" })
  const whenReadable = <A>(f: () => Effect.Effect<A, CredentialError>) => Effect.suspend(() => (options.locked() ? Effect.fail(lockedError()) : f()))
  const whenWritable = <A>(f: () => Effect.Effect<A, CredentialError>) =>
    whenReadable(() => {
      const blocked = options.store.blocked()
      return blocked === undefined
        ? f()
        : Effect.fail(new CredentialError({ reason: "blocked", message: `Credentials cannot be changed until the settings are saved once: ${blocked}` }))
    })
  /** A save refused because the vault locked meanwhile is `locked`. */
  const saveFailed = (e: { readonly message: string }) => (options.locked() ? lockedError() : new CredentialError({ reason: "failed", message: e.message }))
  const committed = (): Readonly<Record<string, string>> => options.store.secrets().modules[CREDENTIALS_ENTRY] ?? {}

  return {
    forModule: (moduleId) => {
      const prefix = `${moduleId}/`
      const mine = (all: Readonly<Record<string, string>>) => Object.keys(all).filter((k) => k.startsWith(prefix))
      return {
        get: (name) => whenReadable(() => Effect.sync(() => {
          const v = committed()[prefix + name]
          return typeof v === "string" ? v : undefined
        })),
        set: (name, value) =>
          whenWritable(() => {
            let full = false
            return options.store.saveCredentials((all) => {
              full = all[prefix + name] === undefined && mine(all).length >= MAX_CREDENTIALS_PER_MODULE
              return full ? all : { ...all, [prefix + name]: value }
            }).pipe(
              Effect.mapError(saveFailed),
              Effect.flatMap(() =>
                full
                  ? Effect.fail(new CredentialError({ reason: "limit", message: `A module may hold at most ${MAX_CREDENTIALS_PER_MODULE} credentials; clear one first` }))
                  : Effect.void
              )
            )
          }),
        clear: (name) =>
          whenWritable(() => {
            let found = false
            return options.store.saveCredentials((all) => {
              found = all[prefix + name] !== undefined
              if (!found) return all
              const { [prefix + name]: _gone, ...rest } = all
              return rest
            }).pipe(Effect.mapError(saveFailed), Effect.map(() => found))
          })
      }
    }
  }
}
