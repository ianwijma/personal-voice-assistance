import {
  type Diet,
  EMPTY_DIET,
  effectiveDiet,
  findPerson,
  newPersonId,
  NOT_ONE_LINE,
  type PeopleService,
  peopleError,
  type Person,
  Setting
} from "@pva/core"
import { checkMembersValue, MAX_MEMBERS, MEMBER_LIMITS, type SettingsPatch, type SettingValue } from "@pva/protocol"
import { Effect, Semaphore } from "effect"
import { createHash } from "node:crypto"
import type { SectionDefinition } from "./sectionDefinitions.ts"

/**
 * The household's members (docs/MODULES-PLAN.md §2 rows 1, 15; §4 P5): a shared settings section of the core,
 * "Members", edited in admin with the `records` and `textList` fields, and the `People` service modules use. Values are
 * stored flat by key like every shared setting; a person's id is made here when the person is added (`withPersonIds`)
 * and kept, hidden, in the record.
 *
 * **One serialized operation owns people and every reference to them** (`MembersGate`): a save of Members (admin, or
 * `People.setDiet`, whose read, check and write are one step), the clean-up of the devices and device types whose
 * default person was removed (inside the same operation, before anything else may run), and every save of a device or
 * device type, which checks its default person against the committed Members inside it. So a dangling reference is
 * never committed. The Members list is never read from the environment: people have ids the server makes, which an
 * environment variable cannot hold (`HOUSEHOLD_MEMBERS` is refused, `MEMBERS_ENV_REFUSED`).
 *
 * A person removed from Members keeps their person-scoped data in the household database, but it is delivered to no
 * page and no turn any more (the privacy rule refuses an owner who is not a member). Deleting it is a known gap: the
 * store has no command for one person's data yet (docs/ASSISTANTS.md §2.4).
 */

export const MEMBERS_KEY = "HOUSEHOLD_MEMBERS"
/**
 * Ids of people removed from Members, kept by the server beside the list (not a field: never shown or edited) so that
 * no id is issued twice in the life of the settings file (review round 3). Absent in older files: none known.
 */
export const RETIRED_KEY = "HOUSEHOLD_MEMBERS_RETIRED"
export const DIET_KEYS = {
  allergies: "HOUSEHOLD_DIET_ALLERGIES",
  diets: "HOUSEHOLD_DIET_DIETS",
  dislikes: "HOUSEHOLD_DIET_DISLIKES"
} as const
export const MEMBERS_SECTION_ID = "members"
export { MAX_MEMBERS }

/** Why `HOUSEHOLD_MEMBERS` is not read from the environment (the env view and the start-up log say it). */
export const MEMBERS_ENV_REFUSED =
  "Not read: the people of the household get ids the assistant makes and keeps, which an environment variable cannot hold. Add them in Shared settings › Members and remove this line."

/**
 * The one serialized operation over people and the references to them (see above). Every Members save and every
 * device or device type save runs inside `run`; a nested `run` is not allowed (it would wait for itself). Admission
 * can be interrupted; an admitted operation cannot (all-or-nothing, the caches included).
 */
export interface MembersGate {
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const makeMembersGate = (): MembersGate => {
  const lock = Semaphore.makeUnsafe(1)
  // Waiting to be admitted may be interrupted (nothing happened). Once admitted the operation is uninterruptible: a
  // Members save, the clean-up of the references it removed and the caches that follow the committed settings all
  // happen, or (interrupted before admission) none does.
  return { run: (effect) => lock.withPermit(Effect.uninterruptible(effect)) }
}

/** A one-line value (no line breaks, control characters or bidirectional overrides). */
const oneLine = (label: string) => (value: string): string | undefined =>
  NOT_ONE_LINE.test(value) ? `${label} must be one line, without control characters` : undefined

const dietList = (label: string, description: string, placeholder: string) =>
  Setting.textList({ label, description, maxItems: MEMBER_LIMITS.dietItems, itemMaxLength: MEMBER_LIMITS.dietItem, placeholder })

/** One record of `HOUSEHOLD_MEMBERS`. */
const memberItem = {
  id: Setting.text({ label: "Id", maxLength: MEMBER_LIMITS.id }),
  name: Setting.text({ label: "Name", description: "As the household says it: \"Sam\".", maxLength: MEMBER_LIMITS.name, placeholder: "Sam", check: oneLine("A name") }),
  aliases: Setting.textList({ label: "Also called", description: "Other names people use for them: \"Sammie\", \"Mum\".", maxItems: MEMBER_LIMITS.aliases, itemMaxLength: MEMBER_LIMITS.alias }),
  pronunciation: Setting.text({
    label: "Pronunciation",
    description: "How the voice should say the name, spelled as it sounds (\"Shiv-awn\"). Empty: as written.",
    maxLength: MEMBER_LIMITS.pronunciation,
    check: oneLine("A pronunciation")
  }),
  allergies: dietList("Allergies", "Never in their food: \"nuts\", \"shellfish\". Empty: the household's.", "nuts"),
  diets: dietList("Diets", "\"vegetarian\", \"halal\". Empty: the household's.", "vegetarian"),
  dislikes: dietList("Dislikes", "Left out where possible: \"coriander\". Empty: the household's.", "coriander")
}

/**
 * The Members list as a whole: `checkMembersValue` (protocol), the one check the server and the mock share (here after
 * each record's own fields were checked, so it adds the rules across records).
 */
const checkMembersList = (list: ReadonlyArray<unknown>) => checkMembersValue(list)

/** The "Members" section: shared settings › Members. */
export const membersSection: SectionDefinition = {
  id: MEMBERS_SECTION_ID,
  title: "Members",
  group: "modules",
  page: {
    id: "members",
    title: "Members",
    description: "The people who live here, and what they eat. A device's default person (Devices › a device › Place) says whose data a turn there means."
  },
  order: 6,
  spec: {
    [MEMBERS_KEY]: Setting.records({
      label: "People",
      description:
        "Each person's name, other names, and diet. A device points at one of them as its default person; removing someone clears that, and ends the session on every device (its pages reconnect and start a new conversation). Their stored data stays in the household database but is shown and told nowhere any more.",
      // Never from the environment (`MEMBERS_ENV_REFUSED`): ids are the server's.
      item: memberItem,
      itemLabel: "person",
      titleKey: "name",
      maxItems: MAX_MEMBERS,
      hiddenKeys: ["id"],
      check: checkMembersList
    }),
    [DIET_KEYS.allergies]: Setting.textList({
      label: "Household allergies",
      description: "For everyone who has none of their own: what the kitchen never suggests.",
      env: DIET_KEYS.allergies,
      maxItems: MEMBER_LIMITS.dietItems,
      itemMaxLength: MEMBER_LIMITS.dietItem,
      placeholder: "nuts"
    }),
    [DIET_KEYS.diets]: Setting.textList({
      label: "Household diets",
      description: "For everyone who has none of their own.",
      env: DIET_KEYS.diets,
      maxItems: MEMBER_LIMITS.dietItems,
      itemMaxLength: MEMBER_LIMITS.dietItem,
      placeholder: "vegetarian"
    }),
    [DIET_KEYS.dislikes]: Setting.textList({
      label: "Household dislikes",
      description: "For everyone who has none of their own.",
      env: DIET_KEYS.dislikes,
      maxItems: MEMBER_LIMITS.dietItems,
      itemMaxLength: MEMBER_LIMITS.dietItem,
      placeholder: "coriander"
    })
  },
  storedKeys: [RETIRED_KEY],
  load: (stored) => withLoadedMembers(stored),
  normalize: (values, committed) => withPersonIds(values, committed)
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const strings = (u: unknown): ReadonlyArray<string> => (Array.isArray(u) ? u.filter((x): x is string => typeof x === "string") : [])
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** The retired ids in saved values (`RETIRED_KEY`). */
export const retiredIdsOf = (value: unknown): ReadonlySet<string> =>
  new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && ID.test(x)) : [])

const validIdOf = (m: unknown): string | undefined => (isRecord(m) && typeof m.id === "string" && ID.test(m.id) ? m.id : undefined)

/**
 * Saved values with an id for every person, all issued by the server (review round 3): an incoming id is kept only
 * when it is the id of a person in the committed Members (`committed`, the values before this save), the first row
 * that carries it; any other row gets a fresh id, whatever it supplied (a new row, a copied row, a stale tab's row of
 * a person removed since). The ids of committed people who are not in the new list are added to `RETIRED_KEY`, and a
 * fresh id is none of the committed, retired or supplied ones: an id is never issued twice in the life of the
 * settings file. Other keys are left as they are.
 */
export const withPersonIds = (
  values: Readonly<Record<string, SettingValue>>,
  committed: Readonly<Record<string, unknown>>,
  random?: () => number
): Readonly<Record<string, SettingValue>> => {
  const list = values[MEMBERS_KEY]
  const before = Array.isArray(committed[MEMBERS_KEY]) ? (committed[MEMBERS_KEY] as ReadonlyArray<unknown>) : []
  const committedIds = new Set(before.flatMap((m) => validIdOf(m) ?? []))
  const retiredBefore = retiredIdsOf(committed[RETIRED_KEY])
  if (!Array.isArray(list)) return { ...values, [RETIRED_KEY]: [...retiredBefore] }
  const supplied = new Set(list.flatMap((m) => (isRecord(m) && typeof m.id === "string" ? [m.id] : [])))
  const used = new Set<string>()
  const next = list.map((m) => {
    if (!isRecord(m)) return m
    const id = validIdOf(m)
    if (id !== undefined && committedIds.has(id) && !used.has(id)) {
      used.add(id)
      return m
    }
    const fresh = newPersonId(new Set([...committedIds, ...retiredBefore, ...supplied, ...used]), random)
    used.add(fresh)
    return { ...m, id: fresh }
  })
  const retired = [...retiredBefore, ...[...committedIds].filter((id) => !used.has(id) && !retiredBefore.has(id))]
  const sameList = next.every((m, i) => m === list[i])
  return {
    ...values,
    ...(sameList ? {} : { [MEMBERS_KEY]: next as unknown as SettingValue }),
    [RETIRED_KEY]: retired
  }
}

/** A deterministic fresh id for a record repaired at load (the same file gives the same ids at every start). */
const loadedId = (seed: string, taken: ReadonlySet<string>): string => {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
  for (let salt = 0; ; salt++) {
    const hash = createHash("sha256").update(`${salt}:${seed}`).digest()
    let id = "p-"
    for (let i = 0; i < 8; i++) id += letters[hash[i]! % letters.length]
    if (!taken.has(id)) return id
  }
}

/** Members as the server reads them (`loadedMembers`). */
export interface LoadedMembers {
  /** The list with a unique valid id on every record. The same array as saved when nothing needed it. */
  readonly value: unknown
  /** Ids that more than one saved record carried: a reference to one (a device's default person) is cleared. */
  readonly ambiguous: ReadonlySet<string>
  /** Whether the saved list differs (it is to be written back). */
  readonly repaired: boolean
}

const loadedCache = new WeakMap<object, { readonly retired: unknown; readonly loaded: LoadedMembers }>()

/**
 * Members normalised synchronously, in memory, as they are read (review round 3): a hand-edited file may give a
 * record no id, or an id that an earlier record already has. A later record with an id already seen, or without a
 * valid one, gets a fresh id (deterministic, none of the saved or retired ids); the id seen twice is `ambiguous`,
 * and a device's reference to it counts as no default person until the references are cleared. Every reader of
 * Members (the settings, `People`, device contexts, the feed's person rule) reads this, never the saved list; writing
 * it back is ordinary persistence (serveMode). Cached per saved array, so a read costs nothing.
 */
export const loadedMembers = (raw: unknown, retired?: unknown): LoadedMembers => {
  if (!Array.isArray(raw)) return { value: raw, ambiguous: new Set(), repaired: false }
  const hit = loadedCache.get(raw)
  if (hit !== undefined && hit.retired === retired) return hit.loaded
  const taken = new Set<string>([...retiredIdsOf(retired), ...raw.flatMap((m) => (isRecord(m) && typeof m.id === "string" ? [m.id] : []))])
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  let repaired = false
  const value = raw.map((m, index) => {
    if (!isRecord(m)) return m
    const id = validIdOf(m)
    if (id !== undefined && !seen.has(id)) {
      seen.add(id)
      return m
    }
    if (id !== undefined) ambiguous.add(id)
    repaired = true
    const fresh = loadedId(`${index}:${String(m.id)}:${String(m.name)}`, taken)
    taken.add(fresh)
    seen.add(fresh)
    return { ...m, id: fresh }
  })
  const loaded: LoadedMembers = repaired ? { value, ambiguous, repaired } : { value: raw, ambiguous, repaired }
  loadedCache.set(raw, { retired, loaded })
  return loaded
}

/** Saved values with Members as the server reads them (`loadedMembers`): the section's `load`. */
export const withLoadedMembers = (stored: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const loaded = loadedMembers(stored[MEMBERS_KEY], stored[RETIRED_KEY])
  return loaded.repaired ? { ...stored, [MEMBERS_KEY]: loaded.value } : stored
}

const idsCache = new WeakMap<LoadedMembers, { readonly all: ReadonlySet<string>; readonly referenceable: ReadonlySet<string> }>()
const idsOfLoaded = (assistant: Readonly<Record<string, unknown>>) => {
  const loaded = loadedMembers(assistant[MEMBERS_KEY], assistant[RETIRED_KEY])
  let ids = idsCache.get(loaded)
  if (ids === undefined) {
    const all = new Set(peopleFrom(loaded.value).map((p) => p.id))
    ids = { all, referenceable: new Set([...all].filter((id) => !loaded.ambiguous.has(id))) }
    idsCache.set(loaded, ids)
  }
  return ids
}

/** The ids of the loaded Members (`loadedMembers`) in saved values. */
export const loadedPersonIdsOf = (assistant: Readonly<Record<string, unknown>>): ReadonlySet<string> => idsOfLoaded(assistant).all

/**
 * The person ids a device may name as its default person in these saved values: the loaded Members' ids without the
 * ambiguous ones. Every check of a device's default person uses it.
 */
export const referenceableIdsOf = (assistant: Readonly<Record<string, unknown>>): ReadonlySet<string> => idsOfLoaded(assistant).referenceable

/** The people in a saved `HOUSEHOLD_MEMBERS` value (records without a valid id or a name are left out). */
export const peopleFrom = (value: unknown): ReadonlyArray<Person> => {
  if (!Array.isArray(value)) return []
  return value.flatMap((m): Array<Person> => {
    if (!isRecord(m) || typeof m.id !== "string" || !ID.test(m.id) || typeof m.name !== "string" || m.name.trim() === "") return []
    return [{
      id: m.id,
      name: m.name.trim(),
      aliases: strings(m.aliases),
      pronunciation: typeof m.pronunciation === "string" ? m.pronunciation.trim() : "",
      diet: { allergies: strings(m.allergies), diets: strings(m.diets), dislikes: strings(m.dislikes) }
    }]
  })
}

export const householdDietFrom = (value: (key: string) => unknown): Diet => ({
  allergies: strings(value(DIET_KEYS.allergies)),
  diets: strings(value(DIET_KEYS.diets)),
  dislikes: strings(value(DIET_KEYS.dislikes))
})

/** The person ids in a members value (for the clean-up of devices after a person is removed). */
export const personIdsOf = (value: unknown): ReadonlySet<string> => new Set(peopleFrom(value).map((p) => p.id))

export interface PeopleSource {
  /** The effective value of a shared setting (`Sections.value`). */
  readonly value: (key: string) => unknown
  /**
   * Save the Members section like an admin edit, the patch made from the values as they are when the save runs
   * (`Sections.edit`, inside the `MembersGate`): `build` returns the patch, or a refusal.
   */
  readonly edit: (
    build: (value: (key: string) => unknown) => SettingsPatch | { readonly refused: string; readonly code: "unknown_person" }
  ) => Effect.Effect<{ readonly ok: true } | { readonly ok: false; readonly message: string; readonly code?: "unknown_person" }>
}

/** A diet's items as kept: one line each, trimmed, without repeats (ignoring case), at most 30 of 60 characters. */
const cleanDiet = (list: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
  if (list === undefined) return undefined
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const raw of list) {
    if (typeof raw !== "string") continue
    const item = raw.replace(new RegExp(NOT_ONE_LINE.source, "gu"), " ").replace(/\s+/gu, " ").trim().slice(0, 60).trim()
    if (item === "" || seen.has(item.toLowerCase())) continue
    seen.add(item.toLowerCase())
    out.push(item)
    if (out.length >= 30) break
  }
  return out
}

/**
 * The `People` service over the Members section. Reads are cached per value of `HOUSEHOLD_MEMBERS` (the same array
 * while nothing is saved), so a turn's lookups cost nothing.
 */
export const makePeopleService = (source: PeopleSource): PeopleService & { readonly nameOf: (id: string) => string | undefined } => {
  type Cache = { readonly raw: unknown; readonly people: ReadonlyArray<Person>; readonly byId: ReadonlyMap<string, Person> }
  let cache: Cache | undefined
  const people = (): Cache => {
    const raw = source.value(MEMBERS_KEY)
    if (cache === undefined || cache.raw !== raw) {
      const list = peopleFrom(raw)
      cache = { raw, people: list, byId: new Map(list.map((p) => [p.id, p])) }
    }
    return cache
  }
  const householdDiet = () => householdDietFrom(source.value)
  return {
    list: () => people().people,
    get: (id) => people().byId.get(id),
    nameOf: (id) => people().byId.get(id)?.name,
    find: (spoken) => findPerson(people().people, spoken),
    householdDiet,
    dietOf: (personId) => effectiveDiet(personId === undefined ? undefined : people().byId.get(personId), householdDiet()),
    setDiet: (owner, change) =>
      Effect.suspend(() => {
        const parts = Object.fromEntries(
          (Object.keys(EMPTY_DIET) as Array<keyof Diet>).flatMap((k) => {
            const v = cleanDiet(change?.[k])
            return v === undefined ? [] : [[k, v]]
          })
        ) as Partial<Record<keyof Diet, ReadonlyArray<string>>>
        const person = owner === "household" ? undefined : typeof owner === "object" && owner !== null ? owner.person : undefined
        if (owner !== "household" && typeof person !== "string") return Effect.fail(peopleError("unknown_person", "No person was named"))
        if (Object.keys(parts).length === 0) return Effect.void
        // Read, check and write in one step, inside the gate: a change in between (another diet, a removal) is seen.
        return Effect.flatMap(
          source.edit((value) => {
            if (person === undefined) {
              const values: Record<string, SettingValue> = {}
              for (const [k, v] of Object.entries(parts)) values[DIET_KEYS[k as keyof Diet]] = [...v]
              return { values, secrets: {} }
            }
            const raw = value(MEMBERS_KEY)
            const list = Array.isArray(raw) ? raw : []
            const index = list.findIndex((m) => isRecord(m) && m.id === person)
            if (index < 0) return { refused: `There is no person ${person} in Members`, code: "unknown_person" }
            const next = list.map((m, i) => (i === index && isRecord(m) ? { ...m, ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, [...v]])) } : m))
            return { values: { [MEMBERS_KEY]: next as unknown as SettingValue }, secrets: {} }
          }),
          (r) => (r.ok ? Effect.void : Effect.fail(peopleError(r.code ?? "not_saved", r.message)))
        )
      })
  }
}
