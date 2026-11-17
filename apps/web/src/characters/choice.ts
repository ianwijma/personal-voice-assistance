/**
 * The stored character choice (docs/CHARACTERS.md §4.4): parsing it leniently from storage, and the voice page's
 * address-bar syntax for trying characters, the lab's: `?character=<id>&opt.<id>=<value>` (repeated; host-level
 * settings as `opt.$you`, `opt.$voice`, `opt.$sensitivity`).
 *
 * Nothing here knows which characters exist or what their options are: values are kept as given and validated
 * by the host on every load, so a choice saved for a character this build does not have survives untouched.
 */
import type { CharacterChoice, OptionValues } from "./contract.ts"

/** The baseline character's id: the default choice, and the fallback (docs/CHARACTERS.md §4.6). */
export const BASELINE_ID = "sine-lines"

const MAX_ID = 64
const MAX_OPTIONS = 64
const MAX_VALUE = 256

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isKey = (k: string): boolean => k !== "" && k.length <= MAX_ID && k !== "__proto__"

/** Option values: only numbers, booleans and short strings survive, other entries are dropped. */
const parseValues = (v: unknown): OptionValues | undefined => {
  if (!isPlain(v)) return undefined
  const out: { [id: string]: number | boolean | string } = {}
  let n = 0
  for (const [k, x] of Object.entries(v)) {
    if (!isKey(k) || n >= MAX_OPTIONS) continue
    if ((typeof x === "number" && Number.isFinite(x)) || typeof x === "boolean" || (typeof x === "string" && x.length <= MAX_VALUE)) {
      out[k] = x
      n++
    }
  }
  return out
}

/** A stored choice, or undefined when it is not one (then the default character applies). */
export const parseCharacterChoice = (v: unknown): CharacterChoice | undefined => {
  if (!isPlain(v) || typeof v.character !== "string" || v.character.trim() === "" || v.character.length > MAX_ID) return undefined
  const options = parseValues(v.options)
  return {
    character: v.character,
    ...(typeof v.version === "string" && v.version.length <= MAX_ID ? { version: v.version } : {}),
    ...(options !== undefined ? { options } : {})
  }
}

const OPT = "opt."

/**
 * The choice the address bar asks for, and the query string without those parameters (to put back with
 * `history.replaceState`). `?character=<id>` replaces the choice (its options are the `opt.*` given, the rest
 * default); `opt.*` alone changes options of the current choice. Undefined when the URL says nothing about it.
 */
export const choiceFromSearch = (search: string, current: CharacterChoice | undefined): { readonly choice: CharacterChoice; readonly search: string } | undefined => {
  const params = new URLSearchParams(search)
  const id = params.get("character")
  const opts: { [id: string]: string } = {}
  let any = id !== null
  for (const [k, v] of params) {
    if (!k.startsWith(OPT)) continue
    any = true
    const key = k.slice(OPT.length)
    if (isKey(key) && v.length <= MAX_VALUE) opts[key] = v
  }
  if (!any) return undefined
  params.delete("character")
  for (const k of [...params.keys()]) if (k.startsWith(OPT)) params.delete(k)
  const rest = params.toString()
  const search2 = rest === "" ? "" : `?${rest}`
  if (id !== null) {
    const name = id.trim()
    return { choice: { character: name !== "" && name.length <= MAX_ID ? name : BASELINE_ID, options: opts }, search: search2 }
  }
  const base = current ?? { character: BASELINE_ID }
  return { choice: { ...base, options: { ...(base.options ?? {}), ...opts } }, search: search2 }
}

/**
 * A try-out from the address bar (`?character=<id>&opt.<id>=<value>`), for one page load (docs/LOOKS-AND-VOICES.md §3):
 * `character` names the character to show instead of the configured look (absent: the configured look, with the
 * `opt.*` values over its options). Values are kept as given (strings) and validated on load like any other.
 */
export interface Tryout {
  readonly character?: string
  readonly options: { readonly [id: string]: string }
}

/** The try-out the address bar asks for, and the query string without those parameters; undefined when it asks for none. */
export const tryoutFromSearch = (search: string): { readonly tryout: Tryout; readonly search: string } | undefined => {
  const asked = choiceFromSearch(search, undefined)
  if (asked === undefined) return undefined
  const options = (asked.choice.options ?? {}) as { readonly [id: string]: string }
  return new URLSearchParams(search).has("character")
    ? { tryout: { character: asked.choice.character, options }, search: asked.search }
    : { tryout: { options }, search: asked.search }
}

/** The choice to show: the configured one (undefined = the baseline), with a try-out over it (the try-out wins). */
export const withTryout = (configured: CharacterChoice | undefined, tryout: Tryout | undefined): CharacterChoice | undefined => {
  if (tryout === undefined) return configured
  if (tryout.character !== undefined) return { character: tryout.character, options: tryout.options }
  const base = configured ?? { character: BASELINE_ID }
  return { ...base, options: { ...(base.options ?? {}), ...tryout.options } }
}
