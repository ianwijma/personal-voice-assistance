import { RouteTokenError, type RouteTokens, type RouteTokenStore } from "@pva/core"
import { MAX_ROUTE_TOKENS_PER_MODULE, RouteTokenInfo } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { ROUTE_TOKENS_ENTRY, type SettingsStore } from "./SettingsStore.ts"

/**
 * Route tokens (docs/UI-AND-MODULES.md §1.11): bearer tokens for module routes with a `token` guard, one per caller,
 * kept with the module secrets (`ROUTE_TOKENS_ENTRY`), so in the key vault once there is one (before that in
 * `data/secrets.json`, 0600, like every other secret). Only a SHA-256 of the secret is stored; the secret is returned
 * once, by `mint`. A presented token is hashed and compared with each stored hash of the route's module and name in
 * constant time (`timingSafeEqual`). While the vault is locked nothing can be checked, listed or minted: token routes
 * answer 503. Revoking a token removes it at once. When it was last used is kept in memory only.
 *
 * A stored record counts only if its id and metadata are what the wire allows (`RouteTokenInfo`) and its module holds
 * no more than `MAX_ROUTE_TOKENS_PER_MODULE` before it; any other (a hand-edited file) is ignored for authentication
 * and listing alike, and `report` is told how many were ignored (a Health issue).
 */

interface Stored {
  readonly moduleId: string
  readonly name: string
  readonly label: string
  /** SHA-256 of the secret, hex. */
  readonly hash: string
  readonly createdAt: number
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/

const parse = (text: string): Stored | undefined => {
  try {
    const v = JSON.parse(text) as Partial<Stored>
    return typeof v.moduleId === "string" && typeof v.name === "string" && typeof v.label === "string" &&
        typeof v.hash === "string" && /^[a-f0-9]{64}$/.test(v.hash) && typeof v.createdAt === "number"
      ? (v as Stored)
      : undefined
  } catch {
    return undefined
  }
}

const isTokenInfo = Schema.is(RouteTokenInfo)

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest()

export type TokenCheck =
  | { readonly ok: true; readonly token: { readonly id: string; readonly name: string; readonly label: string } }
  | { readonly ok: false; readonly reason: "locked" | "invalid" }

export interface RouteTokenKeeper extends RouteTokenStore {
  /** Is the presented secret a live token of `moduleId` named `name`? */
  readonly check: (moduleId: string, name: string, presented: string) => TokenCheck
  /** The tokens can be read now (no vault, or an unlocked one). */
  readonly readable: () => boolean
  /** Read the stored tokens now (when they can be), so that `report` says how many are ignored. */
  readonly audit: () => void
}

export const makeRouteTokens = (options: {
  readonly store: Pick<SettingsStore, "secrets" | "saveRouteTokens" | "blocked">
  /** The key vault exists and is locked. */
  readonly locked: () => boolean
  readonly now?: () => number
  /** How many stored records are ignored now (called when that number changes; 0 once none is). */
  readonly report?: (ignored: number) => void
}): RouteTokenKeeper => {
  const now = options.now ?? Date.now
  const lastUsed = new Map<string, number>()
  let reported = 0
  /** The stored tokens that count: valid as the wire says, at most the bound per module (the first ones). */
  const all = (): ReadonlyArray<readonly [string, Stored]> => {
    const held = new Map<string, number>()
    const entries = Object.entries(options.store.secrets().modules[ROUTE_TOKENS_ENTRY] ?? {})
    const admitted = entries.flatMap(([id, text]) => {
      const stored = typeof text === "string" ? parse(text) : undefined
      if (stored === undefined) return []
      if (!isTokenInfo({ id, moduleId: stored.moduleId, name: stored.name, label: stored.label, createdAt: stored.createdAt })) return []
      const n = held.get(stored.moduleId) ?? 0
      if (n >= MAX_ROUTE_TOKENS_PER_MODULE) return []
      held.set(stored.moduleId, n + 1)
      return [[id, stored] as const]
    })
    const ignored = entries.length - admitted.length
    if (ignored !== reported) {
      reported = ignored
      options.report?.(ignored)
    }
    return admitted
  }
  const infoOf = (id: string, t: Stored): RouteTokenInfo => ({
    id,
    moduleId: t.moduleId,
    name: t.name,
    label: t.label,
    createdAt: t.createdAt,
    ...(lastUsed.has(id) ? { lastUsedAt: lastUsed.get(id)! } : {})
  })
  const lockedError = () => new RouteTokenError({ reason: "locked", message: "The key vault is locked: unlock it in Settings → Keys & access first" })
  const whenReadable = <A>(f: () => Effect.Effect<A, RouteTokenError>) => Effect.suspend(() => (options.locked() ? Effect.fail(lockedError()) : f()))
  /** A change is refused while the settings are damaged (the store checks again inside its serialized save). */
  const whenWritable = <A>(f: () => Effect.Effect<A, RouteTokenError>) =>
    whenReadable(() => {
      const blocked = options.store.blocked()
      return blocked === undefined
        ? f()
        : Effect.fail(new RouteTokenError({ reason: "blocked", message: `Tokens cannot be changed until the settings are saved once: ${blocked}` }))
    })
  /** A save refused because the vault locked meanwhile (checked again inside the store's serialized save) is `locked`. */
  const saveFailed = (e: { readonly message: string }) => (options.locked() ? lockedError() : new RouteTokenError({ reason: "failed", message: e.message }))

  const forModule = (moduleId: string): RouteTokens => ({
    list: whenReadable(() => Effect.succeed(all().filter(([, t]) => t.moduleId === moduleId).map(([id, t]) => infoOf(id, t)))),
    mint: (name, label) =>
      whenWritable(() => {
        const text = label.trim()
        if (!NAME.test(name)) return Effect.fail(new RouteTokenError({ reason: "invalid", message: `A token name must match ${NAME}` }))
        if (text.length === 0 || text.length > 80) return Effect.fail(new RouteTokenError({ reason: "invalid", message: "Say who the token is for, in 1 to 80 characters" }))
        const secret = randomBytes(32).toString("base64url")
        const id = randomBytes(6).toString("hex")
        const stored: Stored = { moduleId, name, label: text, hash: sha256(secret).toString("hex"), createdAt: now() }
        // The limit is judged on the committed tokens inside the store's serialized save, so two mints at once cannot
        // both take the last place.
        let full = false
        return options.store.saveRouteTokens((committed) => {
          const held = Object.values(committed).filter((t) => parse(t)?.moduleId === moduleId).length
          full = held >= MAX_ROUTE_TOKENS_PER_MODULE
          return full ? committed : { ...committed, [id]: JSON.stringify(stored) }
        }).pipe(
          Effect.mapError(saveFailed),
          Effect.flatMap(() =>
            full
              ? Effect.fail(new RouteTokenError({ reason: "limit", message: `A module may hold at most ${MAX_ROUTE_TOKENS_PER_MODULE} tokens; revoke one first` }))
              : Effect.succeed({ token: infoOf(id, stored), secret })
          )
        )
      }),
    revoke: (id) =>
      whenWritable(() => {
        const found = all().some(([tid, t]) => tid === id && t.moduleId === moduleId)
        if (!found) return Effect.succeed(false)
        lastUsed.delete(id)
        return options.store.saveRouteTokens((committed) => {
          const { [id]: _gone, ...rest } = committed
          return rest
        }).pipe(Effect.mapError(saveFailed), Effect.as(true))
      })
  })

  return {
    forModule,
    readable: () => !options.locked(),
    audit: () => {
      if (!options.locked()) all()
    },
    check: (moduleId, name, presented) => {
      if (options.locked()) return { ok: false, reason: "locked" }
      const digest = sha256(presented)
      let match: { id: string; stored: Stored } | undefined
      // Every candidate is compared (no early exit), each in constant time.
      for (const [id, stored] of all()) {
        if (stored.moduleId !== moduleId || stored.name !== name) continue
        if (timingSafeEqual(digest, Buffer.from(stored.hash, "hex")) && match === undefined) match = { id, stored }
      }
      if (match === undefined) return { ok: false, reason: "invalid" }
      lastUsed.set(match.id, now())
      return { ok: true, token: { id: match.id, name: match.stored.name, label: match.stored.label } }
    }
  }
}
