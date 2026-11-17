import { RouteTokenError, type RouteTokens, type RouteTokenStore } from "@pva/core"
import { MAX_ROUTE_TOKENS_PER_MODULE, type RouteTokenInfo } from "@pva/protocol"
import { Effect } from "effect"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { ROUTE_TOKENS_ENTRY, type SettingsStore } from "./SettingsStore.ts"

/**
 * Route tokens (docs/UI-AND-MODULES.md §1.11): bearer tokens for module routes with a `token` guard, one per caller,
 * kept with the module secrets (`ROUTE_TOKENS_ENTRY`), so in the key vault once there is one (before that in
 * `data/secrets.json`, 0600, like every other secret). Only a SHA-256 of the secret is stored; the secret is returned
 * once, by `mint`. A presented token is hashed and compared with each stored hash of the route's module and name in
 * constant time (`timingSafeEqual`). While the vault is locked nothing can be checked, listed or minted: token routes
 * answer 503. Revoking a token removes it at once. When it was last used is kept in memory only.
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

const sha256 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest()

export type TokenCheck =
  | { readonly ok: true; readonly token: { readonly id: string; readonly name: string; readonly label: string } }
  | { readonly ok: false; readonly reason: "locked" | "invalid" }

export interface RouteTokenKeeper extends RouteTokenStore {
  /** Is the presented secret a live token of `moduleId` named `name`? */
  readonly check: (moduleId: string, name: string, presented: string) => TokenCheck
  /** The tokens can be read now (no vault, or an unlocked one). */
  readonly readable: () => boolean
}

export const makeRouteTokens = (options: {
  readonly store: Pick<SettingsStore, "secrets" | "saveRouteTokens">
  /** The key vault exists and is locked. */
  readonly locked: () => boolean
  readonly now?: () => number
}): RouteTokenKeeper => {
  const now = options.now ?? Date.now
  const lastUsed = new Map<string, number>()
  const all = (): ReadonlyArray<readonly [string, Stored]> =>
    Object.entries(options.store.secrets().modules[ROUTE_TOKENS_ENTRY] ?? {}).flatMap(([id, text]) => {
      const stored = parse(text)
      return stored === undefined ? [] : [[id, stored] as const]
    })
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
  const saveFailed = (e: { readonly message: string }) => new RouteTokenError({ reason: "failed", message: e.message })

  const forModule = (moduleId: string): RouteTokens => ({
    list: whenReadable(() => Effect.succeed(all().filter(([, t]) => t.moduleId === moduleId).map(([id, t]) => infoOf(id, t)))),
    mint: (name, label) =>
      whenReadable(() => {
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
      whenReadable(() => {
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
