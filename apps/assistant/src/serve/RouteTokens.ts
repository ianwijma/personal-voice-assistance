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
 * One canonical list (`keptTokens`) of the stored records decides everything: a record counts only if its id and
 * metadata are what the wire allows (`RouteTokenInfo`), its secret's hash is not one an earlier record has, and its
 * module holds no more than `MAX_ROUTE_TOKENS_PER_MODULE` before it, in a fixed order (by when it was made, then by
 * id). Authentication, listing, the limit, mint and revoke all work on that list; mint and revoke derive it from the
 * committed map inside the store's serialized change and persist exactly the list after the change, so a record that
 * was not admitted is dropped from the file then, and never revived. Any other record (a hand-edited file) is ignored
 * until then, and `report` is told how many are ignored (a Health issue).
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

/** A stored record the canonical list keeps: its id, what it says, and its text exactly as stored. */
type Kept = readonly [id: string, stored: Stored, text: string]

/**
 * The records of a committed map that count, in their fixed order (when made, then id): valid by the wire schema,
 * the first with a given hash, at most `MAX_ROUTE_TOKENS_PER_MODULE` per module; `ignored` counts the others.
 */
export const keptTokens = (committed: Readonly<Record<string, unknown>>): { readonly kept: ReadonlyArray<Kept>; readonly ignored: number } => {
  const entries = Object.entries(committed)
  const valid = entries.flatMap(([id, text]): Array<Kept> => {
    const stored = typeof text === "string" ? parse(text) : undefined
    if (stored === undefined || typeof text !== "string") return []
    return isTokenInfo({ id, moduleId: stored.moduleId, name: stored.name, label: stored.label, createdAt: stored.createdAt }) ? [[id, stored, text]] : []
  }).sort(([a, x], [b, y]) => x.createdAt - y.createdAt || (a < b ? -1 : a > b ? 1 : 0))
  const held = new Map<string, number>()
  const hashes = new Set<string>()
  const kept = valid.filter(([, stored]) => {
    const n = held.get(stored.moduleId) ?? 0
    if (n >= MAX_ROUTE_TOKENS_PER_MODULE || hashes.has(stored.hash)) return false
    held.set(stored.moduleId, n + 1)
    hashes.add(stored.hash)
    return true
  })
  return { kept, ignored: entries.length - kept.length }
}
/** The kept records as a map to persist (their texts as stored). */
const asMap = (kept: ReadonlyArray<Kept>): Record<string, string> => Object.fromEntries(kept.map(([id, , text]) => [id, text]))

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
  /** The stored tokens that count now (`keptTokens` of what the store holds); `report` hears how many do not. */
  const all = (): ReadonlyArray<Kept> => {
    const { kept, ignored } = keptTokens(options.store.secrets().modules[ROUTE_TOKENS_ENTRY] ?? {})
    if (ignored !== reported) {
      reported = ignored
      options.report?.(ignored)
    }
    return kept
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
        // The limit is judged on the canonical list of the committed tokens inside the store's serialized save (two
        // mints at once cannot both take the last place), and that list with the new token is what is saved.
        let full = false
        return options.store.saveRouteTokens((committed) => {
          const { kept } = keptTokens(committed)
          full = kept.filter(([, t]) => t.moduleId === moduleId).length >= MAX_ROUTE_TOKENS_PER_MODULE
          return full ? committed : { ...asMap(kept), [id]: JSON.stringify(stored) }
        }).pipe(
          Effect.tap(() => Effect.sync(all)),
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
        // Judged on the canonical list of the committed tokens inside the serialized save; what is saved is that list
        // without the token (a record that was not admitted is dropped with it, so none can take its place).
        let found = false
        return options.store.saveRouteTokens((committed) => {
          const { kept } = keptTokens(committed)
          found = kept.some(([tid, t]) => tid === id && t.moduleId === moduleId)
          return found ? asMap(kept.filter(([tid]) => tid !== id)) : committed
        }).pipe(
          Effect.tap(() => Effect.sync(() => {
            if (found) lastUsed.delete(id)
            all()
          })),
          Effect.mapError(saveFailed),
          Effect.map(() => found)
        )
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
