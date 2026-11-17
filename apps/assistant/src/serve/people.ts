import {
  type Diet,
  EMPTY_DIET,
  effectiveDiet,
  findPerson,
  newPersonId,
  type PeopleService,
  peopleError,
  type Person,
  Setting
} from "@pva/core"
import type { SettingsPatch, SettingValue } from "@pva/protocol"
import { Effect } from "effect"
import type { SectionDefinition } from "./sectionDefinitions.ts"

/**
 * The household's members (docs/MODULES-PLAN.md §2 rows 1, 15; §4 P5): a shared settings section of the core,
 * "Members", edited in admin with the `records` and `textList` fields, and the `People` service modules use. Values are
 * stored flat by key like every shared setting; a person's id is made here when the person is added (`withPersonIds`)
 * and kept, hidden, in the record.
 */

export const MEMBERS_KEY = "HOUSEHOLD_MEMBERS"
export const DIET_KEYS = {
  allergies: "HOUSEHOLD_DIET_ALLERGIES",
  diets: "HOUSEHOLD_DIET_DIETS",
  dislikes: "HOUSEHOLD_DIET_DISLIKES"
} as const
export const MEMBERS_SECTION_ID = "members"
export const MAX_MEMBERS = 24

const dietList = (label: string, description: string, placeholder: string) =>
  Setting.textList({ label, description, maxItems: 30, itemMaxLength: 60, placeholder })

/** One record of `HOUSEHOLD_MEMBERS`. */
const memberItem = {
  id: Setting.text({ label: "Id", maxLength: 40 }),
  name: Setting.text({ label: "Name", description: "As the household says it: \"Sam\".", maxLength: 60, placeholder: "Sam" }),
  aliases: Setting.textList({ label: "Also called", description: "Other names people use for them: \"Sammie\", \"Mum\".", maxItems: 10, itemMaxLength: 40 }),
  pronunciation: Setting.text({ label: "Pronunciation", description: "How the voice should say the name, spelled as it sounds (\"Shiv-awn\"). Empty: as written.", maxLength: 60 }),
  allergies: dietList("Allergies", "Never in their food: \"nuts\", \"shellfish\". Empty: the household's.", "nuts"),
  diets: dietList("Diets", "\"vegetarian\", \"halal\". Empty: the household's.", "vegetarian"),
  dislikes: dietList("Dislikes", "Left out where possible: \"coriander\". Empty: the household's.", "coriander")
}

/** Every person needs a name, and two people cannot have the same name. */
const checkMembers = (list: ReadonlyArray<{ readonly name: string }>): string | undefined => {
  const seen = new Set<string>()
  for (const [i, m] of list.entries()) {
    const name = m.name.trim().toLowerCase()
    if (name === "") return `Person ${i + 1} needs a name`
    if (seen.has(name)) return `Two people are called ${m.name.trim()}; give one of them another name (an alias can be shared)`
    seen.add(name)
  }
  return undefined
}

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
      description: "Each person's name, other names, and diet. A device points at one of them as its default person; removing someone clears that.",
      env: MEMBERS_KEY,
      item: memberItem,
      itemLabel: "person",
      titleKey: "name",
      maxItems: MAX_MEMBERS,
      hiddenKeys: ["id"],
      check: checkMembers
    }),
    [DIET_KEYS.allergies]: Setting.textList({
      label: "Household allergies",
      description: "For everyone who has none of their own: what the kitchen never suggests.",
      env: DIET_KEYS.allergies,
      maxItems: 30,
      itemMaxLength: 60,
      placeholder: "nuts"
    }),
    [DIET_KEYS.diets]: Setting.textList({
      label: "Household diets",
      description: "For everyone who has none of their own.",
      env: DIET_KEYS.diets,
      maxItems: 30,
      itemMaxLength: 60,
      placeholder: "vegetarian"
    }),
    [DIET_KEYS.dislikes]: Setting.textList({
      label: "Household dislikes",
      description: "For everyone who has none of their own.",
      env: DIET_KEYS.dislikes,
      maxItems: 30,
      itemMaxLength: 60,
      placeholder: "coriander"
    })
  },
  normalize: (values) => withPersonIds(values)
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const strings = (u: unknown): ReadonlyArray<string> => (Array.isArray(u) ? u.filter((x): x is string => typeof x === "string") : [])
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/

/**
 * Saved values with an id for every person: a new person (no id, or one that is not a valid id) gets a fresh one; a
 * second person with an id already used (a copied row) too. Other keys are left as they are.
 */
export const withPersonIds = (values: Readonly<Record<string, SettingValue>>, random?: () => number): Readonly<Record<string, SettingValue>> => {
  const list = values[MEMBERS_KEY]
  if (!Array.isArray(list)) return values
  const taken = new Set<string>()
  for (const m of list) if (isRecord(m) && typeof m.id === "string" && ID.test(m.id)) taken.add(m.id)
  const used = new Set<string>()
  let changed = false
  const next = list.map((m) => {
    if (!isRecord(m)) return m
    const id = typeof m.id === "string" ? m.id : ""
    if (ID.test(id) && !used.has(id)) {
      used.add(id)
      return m
    }
    const fresh = newPersonId(new Set([...taken, ...used]), random)
    used.add(fresh)
    changed = true
    return { ...m, id: fresh }
  })
  return changed ? { ...values, [MEMBERS_KEY]: next as unknown as SettingValue } : values
}

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
  /** Save a patch of the Members section like an admin edit (`Sections.update`). */
  readonly update: (patch: SettingsPatch) => Effect.Effect<{ readonly ok: true } | { readonly ok: false; readonly message: string }>
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
  const clean = (list: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
    if (list === undefined) return undefined
    const seen = new Set<string>()
    const out: Array<string> = []
    for (const item of list.map((s) => s.trim()).filter((s) => s !== "")) {
      if (seen.has(item.toLowerCase())) continue
      seen.add(item.toLowerCase())
      out.push(item)
    }
    return out
  }
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
            const v = clean(change[k])
            return v === undefined ? [] : [[k, v]]
          })
        ) as Partial<Record<keyof Diet, ReadonlyArray<string>>>
        let patch: SettingsPatch
        if (owner === "household") {
          const values: Record<string, SettingValue> = {}
          for (const [k, v] of Object.entries(parts)) values[DIET_KEYS[k as keyof Diet]] = [...v]
          patch = { values, secrets: {} }
        } else {
          const raw = source.value(MEMBERS_KEY)
          const list = Array.isArray(raw) ? raw : []
          const index = list.findIndex((m) => isRecord(m) && m.id === owner.person)
          if (index < 0) return Effect.fail(peopleError("unknown_person", `There is no person ${owner.person} in Members`))
          const next = list.map((m, i) => (i === index && isRecord(m) ? { ...m, ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, [...v]])) } : m))
          patch = { values: { [MEMBERS_KEY]: next as unknown as SettingValue }, secrets: {} }
        }
        if (Object.keys(parts).length === 0) return Effect.void
        return Effect.flatMap(source.update(patch), (r) => (r.ok ? Effect.void : Effect.fail(peopleError("not_saved", r.message))))
      })
  }
}
