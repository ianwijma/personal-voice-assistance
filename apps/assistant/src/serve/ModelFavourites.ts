import { MAX_FAVOURITE_NAME_CHARS, MAX_FAVOURITES, type ModelFavourite, type ModelRefJson, modelKey, parseModelKey, type PickerKind } from "@pva/protocol"
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Favourite models (docs/MODEL-PICKERS.md §4.6): one list per picker kind on the server, the same for every device
 * and page, in `<data>/model-favourites-<kind>.json` (atomic writes, mode 0600), as the voice favourites are
 * (`Favourites.ts`). Only the serving process writes them (it holds the data directory's writer lock: `writable`).
 */

export const modelFavouritesFile = (kind: PickerKind) => `model-favourites-${kind}.json`

export type ModelFavouriteResult =
  | { readonly ok: true; readonly favourite: ModelFavourite }
  | { readonly ok: false; readonly code: "limit_reached" | "internal"; readonly message: string }

export interface ModelFavourites {
  readonly list: () => ReadonlyArray<ModelFavourite>
  readonly has: (ref: ModelRefJson) => boolean
  /** Add (or rename, when the name differs) a favourite. */
  readonly add: (ref: ModelRefJson, name: string) => ModelFavouriteResult
  /** `false` when it was not a favourite. Throws when the file cannot be written. */
  readonly remove: (ref: ModelRefJson) => boolean
}

interface FileShape {
  readonly version: 1
  readonly favourites: ReadonlyArray<{ readonly model: ModelRefJson; readonly name: string; readonly addedAt: number }>
}

const clean = (raw: unknown): Array<ModelFavourite> => {
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) throw new Error("not a favourites file")
  const list = (raw as { favourites?: unknown }).favourites
  if (!Array.isArray(list)) throw new Error("not a favourites file")
  const out: Array<ModelFavourite> = []
  const seen = new Set<string>()
  for (const item of list) {
    const model = (item as { model?: { provider?: unknown; modelId?: unknown } } | null)?.model
    if (typeof model?.provider !== "string" || typeof model.modelId !== "string") continue
    const ref = parseModelKey(modelKey({ provider: model.provider, modelId: model.modelId }))
    if (ref === undefined || seen.has(modelKey(ref))) continue
    seen.add(modelKey(ref))
    const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim().slice(0, MAX_FAVOURITE_NAME_CHARS) : ref.modelId
    const addedAt = typeof item.addedAt === "number" && Number.isFinite(item.addedAt) && item.addedAt >= 0 ? item.addedAt : 0
    out.push({ model: ref, key: modelKey(ref), name, addedAt })
  }
  return out.slice(0, MAX_FAVOURITES)
}

export const makeModelFavourites = (options: {
  readonly dataDir: string
  readonly kind: PickerKind
  readonly writable: () => boolean
  readonly log: (line: string) => void
  readonly now?: () => number
}): ModelFavourites => {
  const path = join(options.dataDir, modelFavouritesFile(options.kind))
  const now = options.now ?? Date.now
  let items: Array<ModelFavourite> = []
  if (existsSync(path)) {
    try {
      items = clean(JSON.parse(readFileSync(path, "utf8")))
    } catch (error) {
      const aside = `${path}.bad-${now()}`
      options.log(`The model favourites (${path}) could not be read (${(error as Error).name}); moved to ${aside}, starting empty.`)
      try {
        renameSync(path, aside)
      } catch {
        // left in place: the next write replaces it
      }
    }
  }

  const save = (next: Array<ModelFavourite>) => {
    if (!options.writable()) throw new Error("the data directory is not writable by this process")
    const body: FileShape = { version: 1, favourites: next.map((f) => ({ model: f.model, name: f.name, addedAt: f.addedAt })) }
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
    items = next
  }

  const find = (ref: ModelRefJson) => items.findIndex((f) => f.model.provider === ref.provider && f.model.modelId === ref.modelId)
  const failed = (error: unknown) => ({ ok: false as const, code: "internal" as const, message: `The favourites could not be saved: ${(error as Error).message}` })

  return {
    list: () => items,
    has: (ref) => find(ref) >= 0,
    add: (ref, name) => {
      const at = find(ref)
      const clipped = name.trim().slice(0, MAX_FAVOURITE_NAME_CHARS) || ref.modelId
      if (at >= 0) {
        const existing = items[at]!
        if (existing.name === clipped) return { ok: true, favourite: existing }
        const renamed = { ...existing, name: clipped }
        try {
          save(items.map((f, i) => (i === at ? renamed : f)))
        } catch (error) {
          return failed(error)
        }
        return { ok: true, favourite: renamed }
      }
      if (items.length >= MAX_FAVOURITES) return { ok: false, code: "limit_reached", message: `There are already ${MAX_FAVOURITES} favourites: remove one first` }
      const favourite: ModelFavourite = { model: { provider: ref.provider, modelId: ref.modelId }, key: modelKey(ref), name: clipped, addedAt: now() }
      try {
        save([...items, favourite])
      } catch (error) {
        return failed(error)
      }
      return { ok: true, favourite }
    },
    remove: (ref) => {
      const at = find(ref)
      if (at < 0) return false
      save(items.filter((_, i) => i !== at))
      return true
    }
  }
}
