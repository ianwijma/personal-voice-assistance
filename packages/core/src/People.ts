import type { Effect } from "effect"
import { ServiceKey } from "./ModuleApi.ts"
import { editDistance, normalizePhrase, phoneticKey, stem, words } from "./TextMatching.ts"

/**
 * The household's people (docs/MODULES-PLAN.md §2 rows 1, 9, 15; §4 P5). `Person` records live in the core's household
 * settings section "Members", edited in admin; a device's `place.defaultPerson` is the one link between a device and
 * a person. There is no voice identification, no adult/child field and no trusted flag: a person selects whose data a
 * turn means, never what it may do. Data without a known person is household data.
 *
 * The `People` service (`host.service(People)`) is how modules read them and record a diet ("Sam is allergic to nuts"):
 * a diet write goes through the settings store exactly like an admin edit.
 */

/** Allergies, diets and dislikes, each a short list of text ("nuts"; "vegetarian"; "coriander"). */
export interface Diet {
  readonly allergies: ReadonlyArray<string>
  readonly diets: ReadonlyArray<string>
  readonly dislikes: ReadonlyArray<string>
}

export const EMPTY_DIET: Diet = { allergies: [], diets: [], dislikes: [] }

export interface Person {
  /** Made by the server when the person is added; stable (devices and stored data refer to it). */
  readonly id: string
  readonly name: string
  /** Other names the person answers to ("Sammie"). */
  readonly aliases: ReadonlyArray<string>
  /** How to say the name, for the voice ("Shiv-awn"); "" = as written. */
  readonly pronunciation: string
  /** The person's own diet. An empty part means "the household's" (`effectiveDiet`). */
  readonly diet: Diet
}

/** The outcome of finding a person by a spoken name: one, several equally good (ask which), or nobody. */
export type PersonMatch =
  | { readonly kind: "found"; readonly person: Person }
  | { readonly kind: "ambiguous"; readonly people: ReadonlyArray<Person> }
  | { readonly kind: "none" }

/** Which diet a change is for: a person's, or the household's default. */
export type DietOwner = { readonly person: string } | "household"

export type PeopleErrorCode = "unknown_person" | "invalid" | "not_saved"

export interface PeopleError {
  readonly _tag: "PeopleError"
  readonly code: PeopleErrorCode
  readonly message: string
}

export const peopleError = (code: PeopleErrorCode, message: string): PeopleError => ({ _tag: "PeopleError", code, message })

export interface PeopleService {
  /** Every person, in the admin's order. */
  readonly list: () => ReadonlyArray<Person>
  readonly get: (id: string) => Person | undefined
  /** By a spoken name: the name, a first name or an alias; ambiguity is returned, never guessed. */
  readonly find: (spoken: string) => PersonMatch
  /** The household's default diet. */
  readonly householdDiet: () => Diet
  /** A person's diet with the household's default for every part they left empty; unknown person: the household's. */
  readonly dietOf: (personId: string | undefined) => Diet
  /**
   * Replace one diet (a person's, or the household's): the parts given replace the stored ones, the others stay.
   * Saved through the settings store like an admin edit, so admin and the next turn see it.
   */
  readonly setDiet: (owner: DietOwner, change: Partial<Diet>) => Effect.Effect<void, PeopleError>
}

/** `host.service(People)`: provided by the core in serve mode. */
export const People = ServiceKey<PeopleService>("core.people")

/** A person's diet over the household's: each part the person left empty is the household's. */
export const effectiveDiet = (person: Pick<Person, "diet"> | undefined, household: Diet): Diet => {
  if (person === undefined) return household
  const pick = (own: ReadonlyArray<string>, fallback: ReadonlyArray<string>) => (own.length > 0 ? own : fallback)
  return {
    allergies: pick(person.diet.allergies, household.allergies),
    diets: pick(person.diet.diets, household.diets),
    dislikes: pick(person.diet.dislikes, household.dislikes)
  }
}

/** Drop a trailing possessive ("Sam's" → "sam", "James'" → "james"). */
const withoutPossessive = (text: string): string => text.replace(/['’]s?\s*$/u, "").trim()

/**
 * Find a person by a spoken name. Tried in order, and the first tier that matches decides: (1) the whole name or an
 * alias, as written (case, accents and punctuation ignored); (2) a first name; (3) the same sound (`phoneticKey`, so
 * "Jeff" finds "Geoff"); (4) one letter off in a name of four letters or more. Two or more people in the deciding tier
 * is `ambiguous`; nothing is `none`.
 */
export const findPerson = (people: ReadonlyArray<Person>, spoken: string): PersonMatch => {
  const query = normalizePhrase(withoutPossessive(spoken))
  if (query === "") return { kind: "none" }
  const stemmed = query.split(" ").map(stem).join(" ")
  const names = (p: Person) => [p.name, ...p.aliases].map(normalizePhrase).filter((n) => n !== "")
  const decide = (matches: (p: Person) => boolean): PersonMatch | undefined => {
    const hits = people.filter(matches)
    if (hits.length === 0) return undefined
    return hits.length === 1 ? { kind: "found", person: hits[0]! } : { kind: "ambiguous", people: hits }
  }
  const firstWord = (n: string) => n.split(" ")[0]!
  const sound = phoneticKey(query)
  const close = (a: string, b: string) => a.length >= 4 && b.length >= 4 && editDistance(a, b, 2) <= 1
  return decide((p) => names(p).some((n) => n === query || n === stemmed)) ??
    decide((p) => names(p).some((n) => firstWord(n) === query || firstWord(n) === stemmed)) ??
    (sound === "" ? undefined : decide((p) => names(p).some((n) => phoneticKey(n) === sound || phoneticKey(firstWord(n)) === sound))) ??
    (words(query).length === 1 ? decide((p) => names(p).some((n) => close(n, query) || close(firstWord(n), query))) : undefined) ??
    { kind: "none" }
}

/** A new person id: `p-` and eight random letters and digits, not one of `taken`. */
export const newPersonId = (taken: ReadonlySet<string>, random: () => number = Math.random): string => {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
  for (;;) {
    let id = "p-"
    for (let i = 0; i < 8; i++) id += letters[Math.floor(random() * letters.length)]
    if (!taken.has(id)) return id
  }
}
