/**
 * The characters as the admin's look editor sees them (docs/LOOKS-AND-VOICES.md §4): each loaded on demand from the
 * registry (its own chunk, as on the voice page), checked with the same manifest checks the host runs, and kept for
 * the page's life. A character whose chunk fails or whose manifest is incomplete is "unavailable": the picker shows
 * it without a preview, and the host would show the baseline for it.
 *
 * Host side: a character never imports this.
 */
import { BASELINE_ID } from "./choice.ts"
import type { Character } from "./contract.ts"
import { manifestProblems } from "./manifest.ts"
import { registry as defaultRegistry, type Registry } from "./registry.ts"

export type Loaded = { readonly kind: "ready"; readonly character: Character } | { readonly kind: "unavailable"; readonly reason: string }

const results = new Map<string, Loaded>()
const pending = new Map<string, Promise<Loaded>>()

/** A character's id in words until its manifest has loaded: "sine-lines" → "Sine lines". */
export const prettyId = (id: string): string => {
  const words = id.replace(/[-_]+/g, " ").trim()
  return words === "" ? id : words.charAt(0).toUpperCase() + words.slice(1)
}

/** What is known of `id` without loading anything (the baseline is bundled). */
export const loadedNow = (id: string, reg: Registry = defaultRegistry): Loaded | undefined => {
  if (id === BASELINE_ID && reg === defaultRegistry) return { kind: "ready", character: reg.baseline }
  return reg === defaultRegistry ? results.get(id) : undefined
}

/** Load and check one character (cached for the page; a test passes its own registry, which is not cached). */
export const loadCharacter = (id: string, reg: Registry = defaultRegistry): Promise<Loaded> => {
  const now = loadedNow(id, reg)
  if (now !== undefined) return Promise.resolve(now)
  const cache = reg === defaultRegistry
  const inFlight = cache ? pending.get(id) : undefined
  if (inFlight !== undefined) return inFlight
  const load = reg.load(id)
  const p: Promise<Loaded> = (load === undefined ? Promise.resolve<Loaded>({ kind: "unavailable", reason: `no character "${id}" in this version` }) : load.then(
    (mod): Loaded => {
      const problems = manifestProblems(mod, id)
      return problems.length > 0 ? { kind: "unavailable", reason: problems.join("; ") } : { kind: "ready", character: mod as Character }
    },
    (e: unknown): Loaded => ({ kind: "unavailable", reason: e instanceof Error ? e.message : String(e) })
  )).then((r) => {
    if (cache) {
      results.set(id, r)
      pending.delete(id)
    }
    return r
  })
  if (cache) pending.set(id, p)
  return p
}

/** The name to show for `id`: its manifest's once loaded, else the id in words. */
export const characterName = (id: string): string => {
  const now = loadedNow(id)
  return now?.kind === "ready" ? now.character.name : prettyId(id)
}
