import { Effect, Schema } from "effect"

/**
 * Module credentials (`host.credentials`, docs/MODULES.md): a secret a module obtained itself, such as an OAuth refresh
 * token from a callback route. Owner-typed secrets are settings fields; these are written by the module's own code.
 * Kept in the key vault (serve mode), one namespace per module: a module can never read another's. Never logged, never
 * in a snapshot, a diagnostic or the admin API, never sent to a page (the page boundary remembers every value a part
 * reads or writes). No Node dependency: the app supplies the `CredentialStore`.
 */

/** A name is a short slug. */
export const CREDENTIAL_NAME = /^[a-z][a-z0-9-]{0,31}$/
/** A module may keep at most this many names. */
export const MAX_CREDENTIALS_PER_MODULE = 8
/** A value is at most this many bytes (UTF-8). */
export const MAX_CREDENTIAL_BYTES = 4096

/** Why a credential operation could not be done. */
export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", {
  /**
   * `unavailable`: no vault (not serve mode). `locked`: the key vault is locked (the credential may exist; it cannot
   * be read or changed now). `invalid`: the name or value breaks the rules. `limit`: the module holds 8 names already.
   * `blocked`: the settings files are damaged and wait for the owner. `failed`: it could not be saved.
   */
  reason: Schema.Literals(["locked", "unavailable", "invalid", "limit", "blocked", "failed"]),
  /** One sentence for the owner (never the value). */
  message: Schema.String
}) {}

/** A module's own credentials. `get` answers `undefined` when none is set (a locked vault is a `locked` failure). */
export interface ModuleCredentials {
  readonly get: (name: string) => Effect.Effect<string | undefined, CredentialError>
  /** Replaces any earlier value. */
  readonly set: (name: string, value: string) => Effect.Effect<void, CredentialError>
  /** True when it existed. */
  readonly clear: (name: string) => Effect.Effect<boolean, CredentialError>
}

/**
 * Where the app keeps credentials (`ModuleHostOptions.credentials`): one view per module. The store persists; the
 * host checks the name and the value size before it asks, the store enforces the count of names.
 */
export interface CredentialStore {
  readonly forModule: (moduleId: string) => ModuleCredentials
}

/** The first rule a name or value breaks, or `undefined`. */
export const credentialProblem = (name: string, value?: string): string | undefined => {
  if (!CREDENTIAL_NAME.test(name)) return `A credential name must match ${CREDENTIAL_NAME}`
  if (value !== undefined && new TextEncoder().encode(value).length > MAX_CREDENTIAL_BYTES) return `A credential value is at most ${MAX_CREDENTIAL_BYTES} bytes`
  return undefined
}

/**
 * An in-memory store (the module test kit, tests). `lock()` and `unlock()` model the vault: while locked every call
 * fails `locked`.
 */
export const makeMemoryCredentialStore = (): CredentialStore & {
  readonly lock: () => void
  readonly unlock: () => void
  /** What is held, as `moduleId/name` to value (for assertions). */
  readonly dump: () => Readonly<Record<string, string>>
} => {
  const held = new Map<string, Map<string, string>>()
  let locked = false
  const lockedFail = () => new CredentialError({ reason: "locked", message: "The key vault is locked: unlock it in Settings → Keys & access first" })
  const own = (id: string) => {
    let m = held.get(id)
    if (m === undefined) held.set(id, (m = new Map()))
    return m
  }
  return {
    lock: () => void (locked = true),
    unlock: () => void (locked = false),
    dump: () => Object.fromEntries([...held].flatMap(([id, m]) => [...m].map(([n, v]) => [`${id}/${n}`, v]))),
    forModule: (moduleId) => ({
      get: (name) => Effect.suspend(() => (locked ? Effect.fail(lockedFail()) : Effect.succeed(own(moduleId).get(name)))),
      set: (name, value) =>
        Effect.suspend(() => {
          if (locked) return Effect.fail(lockedFail())
          const m = own(moduleId)
          if (!m.has(name) && m.size >= MAX_CREDENTIALS_PER_MODULE) {
            return Effect.fail(new CredentialError({ reason: "limit", message: `A module may hold at most ${MAX_CREDENTIALS_PER_MODULE} credentials; clear one first` }))
          }
          m.set(name, value)
          return Effect.void
        }),
      clear: (name) => Effect.suspend(() => (locked ? Effect.fail(lockedFail()) : Effect.succeed(own(moduleId).delete(name))))
    })
  }
}
