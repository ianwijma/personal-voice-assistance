import { isVoiceRef, type VoiceRef, voiceKey } from "@pva/core"
import { type Favourite, MAX_FAVOURITE_NAME_CHARS, MAX_FAVOURITES } from "@pva/protocol"
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Favourite voices (docs/VOICE-PROVIDERS.md §4.5): one list on the server, the same for every device and page, in
 * `<data>/voice-favourites.json` (atomic writes, mode 0600). Only the serving process writes it (it holds the data
 * directory's writer lock: `writable`).
 */

export const FAVOURITES_FILE = "voice-favourites.json"

export type FavouriteResult =
  | { readonly ok: true; readonly favourite: Favourite }
  | { readonly ok: false; readonly code: "limit_reached" | "internal"; readonly message: string }

export interface Favourites {
  readonly list: () => ReadonlyArray<Favourite>
  readonly has: (ref: VoiceRef) => boolean
  /** Add (or rename, when `name` is given) a favourite. */
  readonly add: (ref: VoiceRef, name: string) => FavouriteResult
  /** `false` when it was not a favourite. Throws when the file cannot be written (`internal`). */
  readonly remove: (ref: VoiceRef) => boolean
}

interface FileShape {
  readonly version: 1
  readonly favourites: ReadonlyArray<{ readonly voice: VoiceRef; readonly name: string; readonly addedAt: number }>
}

const clean = (raw: unknown): Array<Favourite> => {
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) throw new Error("not a favourites file")
  const list = (raw as { favourites?: unknown }).favourites
  if (!Array.isArray(list)) throw new Error("not a favourites file")
  const out: Array<Favourite> = []
  const seen = new Set<string>()
  for (const item of list) {
    const voice = (item as { voice?: unknown })?.voice as VoiceRef | undefined
    if (typeof voice?.provider !== "string" || typeof voice.voiceId !== "string" || !isVoiceRef(voice)) continue
    const key = voiceKey(voice)
    if (seen.has(key)) continue
    seen.add(key)
    const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim().slice(0, MAX_FAVOURITE_NAME_CHARS) : voice.voiceId
    const addedAt = typeof item.addedAt === "number" && Number.isFinite(item.addedAt) && item.addedAt >= 0 ? item.addedAt : 0
    out.push({ voice: { provider: voice.provider, voiceId: voice.voiceId }, key, name, addedAt })
  }
  return out.slice(0, MAX_FAVOURITES)
}

export const makeFavourites = (options: {
  readonly dataDir: string
  /** The data directory's writer lock is held. */
  readonly writable: () => boolean
  readonly log: (line: string) => void
  readonly now?: () => number
}): Favourites => {
  const path = join(options.dataDir, FAVOURITES_FILE)
  const now = options.now ?? Date.now
  let items: Array<Favourite> = []
  if (existsSync(path)) {
    try {
      items = clean(JSON.parse(readFileSync(path, "utf8")))
    } catch (error) {
      const aside = `${path}.bad-${now()}`
      options.log(`The voice favourites (${path}) could not be read (${(error as Error).name}); moved to ${aside}, starting empty.`)
      try {
        renameSync(path, aside)
      } catch {
        // left in place: the next write replaces it
      }
    }
  }

  const save = (next: Array<Favourite>) => {
    if (!options.writable()) throw new Error("the data directory is not writable by this process")
    const body: FileShape = { version: 1, favourites: next.map((f) => ({ voice: f.voice, name: f.name, addedAt: f.addedAt })) }
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
    items = next
  }

  const find = (ref: VoiceRef) => items.findIndex((f) => f.voice.provider === ref.provider && f.voice.voiceId === ref.voiceId)

  return {
    list: () => items,
    has: (ref) => find(ref) >= 0,
    add: (ref, name) => {
      const at = find(ref)
      const clipped = name.trim().slice(0, MAX_FAVOURITE_NAME_CHARS) || ref.voiceId
      if (at >= 0) {
        const existing = items[at]!
        if (existing.name === clipped) return { ok: true, favourite: existing }
        const renamed = { ...existing, name: clipped }
        try {
          save(items.map((f, i) => (i === at ? renamed : f)))
        } catch (error) {
          return { ok: false, code: "internal", message: `The favourites could not be saved: ${(error as Error).message}` }
        }
        return { ok: true, favourite: renamed }
      }
      if (items.length >= MAX_FAVOURITES) return { ok: false, code: "limit_reached", message: `There are already ${MAX_FAVOURITES} favourites: remove one first` }
      const favourite: Favourite = { voice: { provider: ref.provider, voiceId: ref.voiceId }, key: voiceKey(ref), name: clipped, addedAt: now() }
      try {
        save([...items, favourite])
      } catch (error) {
        return { ok: false, code: "internal", message: `The favourites could not be saved: ${(error as Error).message}` }
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
