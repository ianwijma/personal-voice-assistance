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

/** The Members list (`HOUSEHOLD_MEMBERS`); its decoder is also the validation of `effectiveMembersOf`. */
const membersField = Setting.records({
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
})

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
    [MEMBERS_KEY]: membersField,
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

/** Every well-formed id a saved Members value mentions, valid as a whole or not (a fresh id is none of them). */
const mentionedIdsOf = (raw: unknown): ReadonlySet<string> =>
  new Set(Array.isArray(raw) ? raw.flatMap((m) => (isRecord(m) && typeof m.id === "string" && ID.test(m.id) ? [m.id] : [])) : [])

/** A deterministic fresh id for a record normalised at load (the same file gives the same ids at every start). */
const loadedId = (seed: string, taken: ReadonlySet<string>): string => {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
  for (let salt = 0; ; salt++) {
    const hash = createHash("sha256").update(`${salt}:${seed}`).digest()
    let id = "p-"
    for (let i = 0; i < 8; i++) id += letters[hash[i]! % letters.length]
    if (!taken.has(id)) return id
  }
}

/**
 * **The one authority on who is a member** (review round 4): Members as the server reads them from saved values.
 * Every reader derives from this and nothing else: `People` (`list`, `find`, `get`), the Members section's `load` (what
 * admin shows), `referenceableIdsOf`, and every membership predicate (device facts and the `Privacy` service, a
 * device's default person on save and at load, the gateway's check of a turn's or job's person, the feed's person rule
 * and the ambient facts, the boundary comparisons, the clean-up of dangling references).
 */
export interface EffectiveMembers {
  /** Whether the saved value passes the Members field's validation as a whole (absent: the empty default does). */
  readonly valid: boolean
  /**
   * The validated records (as the field decodes them), each with a unique, well-formed id that is not retired; empty
   * when the saved value is not valid.
   */
  readonly value: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly people: ReadonlyArray<Person>
  readonly byId: ReadonlyMap<string, Person>
  /** The ids of `people` (all distinct). */
  readonly ids: ReadonlySet<string>
  /** Ids that more than one saved record carried: the first keeps it, but no reference may name it. */
  readonly ambiguous: ReadonlySet<string>
  /**
   * The ids a reference may name (a device's default person, the owner of personal content, a turn's person): members
   * with an id of their own that is not ambiguous. Anything else is nobody.
   */
  readonly referenceable: ReadonlySet<string>
  /** The saved list is valid but differs from `value` (an id was issued at load): it is to be written back. */
  readonly repaired: boolean
}

const personOf = (m: Readonly<Record<string, unknown>>, id: string): Person => ({
  id,
  name: String(m.name).trim(),
  aliases: strings(m.aliases),
  pronunciation: typeof m.pronunciation === "string" ? m.pronunciation.trim() : "",
  diet: { allergies: strings(m.allergies), diets: strings(m.diets), dislikes: strings(m.dislikes) }
})

const membersOf = (value: ReadonlyArray<Readonly<Record<string, unknown>>>, ambiguous: ReadonlySet<string>, valid: boolean, repaired: boolean): EffectiveMembers => {
  const people = value.map((m) => personOf(m, m.id as string))
  const ids = new Set(people.map((p) => p.id))
  return {
    valid,
    value,
    people,
    byId: new Map(people.map((p) => [p.id, p])),
    ids,
    ambiguous,
    referenceable: new Set([...ids].filter((id) => !ambiguous.has(id))),
    repaired
  }
}

const NO_MEMBERS = membersOf([], new Set(), true, false)
const INVALID_MEMBERS = membersOf([], new Set(), false, false)
const effectiveCache = new WeakMap<object, { readonly retired: unknown; readonly members: EffectiveMembers }>()

/**
 * The effective Members of saved values (`EffectiveMembers`): the saved `HOUSEHOLD_MEMBERS` value is validated as a
 * whole by the field's own decoder (the validation admin applies); a value that does not pass gives no members at all.
 * Then each record's id is normalised: one that is malformed, retired (`RETIRED_KEY`) or repeats an earlier record's
 * id is replaced by a deterministic fresh id (none of the retired ids or ids the value mentions), and an id carried by
 * two records is ambiguous. Synchronous, and cached per saved array and retired value, so a read costs nothing.
 */
export const effectiveMembersOf = (assistant: Readonly<Record<string, unknown>>): EffectiveMembers => {
  const raw = assistant[MEMBERS_KEY]
  const retired = assistant[RETIRED_KEY]
  if (raw === undefined) return NO_MEMBERS
  if (!Array.isArray(raw)) return INVALID_MEMBERS
  const hit = effectiveCache.get(raw)
  if (hit !== undefined && hit.retired === retired) return hit.members
  const members = computeMembers(raw, retiredIdsOf(retired))
  effectiveCache.set(raw, { retired, members })
  return members
}

const computeMembers = (raw: ReadonlyArray<unknown>, retired: ReadonlySet<string>): EffectiveMembers => {
  const decoded = membersField.decode(raw)
  if (!decoded.ok) return INVALID_MEMBERS
  const records = decoded.value as ReadonlyArray<Readonly<Record<string, unknown>>>
  const taken = new Set<string>([...retired, ...mentionedIdsOf(raw)])
  const counts = new Map<string, number>()
  for (const m of records) if (typeof m.id === "string") counts.set(m.id, (counts.get(m.id) ?? 0) + 1)
  const ambiguous = new Set([...counts].flatMap(([id, n]) => (n > 1 && ID.test(id) ? [id] : [])))
  const seen = new Set<string>()
  let repaired = false
  const value = records.map((m, index) => {
    const id = typeof m.id === "string" ? m.id : ""
    if (ID.test(id) && !retired.has(id) && !seen.has(id)) {
      seen.add(id)
      return m
    }
    repaired = true
    const fresh = loadedId(`${index}:${id}:${String(m.name)}`, taken)
    taken.add(fresh)
    seen.add(fresh)
    return { ...m, id: fresh }
  })
  return membersOf(value, ambiguous, true, repaired)
}

/**
 * The person ids a reference may name in these saved values (`EffectiveMembers.referenceable`). Every check of a
 * device's default person and every membership predicate uses it (or `effectiveMembersOf` itself).
 */
export const referenceableIdsOf = (assistant: Readonly<Record<string, unknown>>): ReadonlySet<string> => effectiveMembersOf(assistant).referenceable

/**
 * Saved values with Members as the server reads them: the section's `load`, so admin shows the effective ids. A value
 * that is not valid as a whole is left as saved (admin shows its error and keeps it for correcting; it counts as no
 * members meanwhile).
 */
export const withLoadedMembers = (stored: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const members = effectiveMembersOf(stored)
  return members.valid && members.repaired ? { ...stored, [MEMBERS_KEY]: members.value } : stored
}

/**
 * Saved values with an id for every person, all issued by the server: an incoming id is kept only when it is the id of
 * a member of the committed effective Members (`effectiveMembersOf(committed)`, so never a retired one), for the first
 * row that carries it; any other row gets a fresh id, whatever it supplied (a new row, a copied row, a stale tab's row
 * of a person removed since, an id pasted into the file). Every id the committed values mention that the new list
 * does not keep is added to `RETIRED_KEY`, and a fresh id is none of the committed, mentioned, retired or supplied
 * ones: an id is never issued twice in the life of the settings file. Other keys are left as they are.
 */
export const withPersonIds = (
  values: Readonly<Record<string, SettingValue>>,
  committed: Readonly<Record<string, unknown>>,
  random?: () => number
): Readonly<Record<string, SettingValue>> => {
  const list = values[MEMBERS_KEY]
  const members = effectiveMembersOf(committed)
  const retiredBefore = retiredIdsOf(committed[RETIRED_KEY])
  const mentioned = new Set([...members.ids, ...mentionedIdsOf(committed[MEMBERS_KEY])])
  if (!Array.isArray(list)) return { ...values, [RETIRED_KEY]: [...retiredBefore] }
  const supplied = new Set(list.flatMap((m) => (isRecord(m) && typeof m.id === "string" ? [m.id] : [])))
  const used = new Set<string>()
  const next = list.map((m) => {
    if (!isRecord(m)) return m
    const id = typeof m.id === "string" ? m.id : undefined
    if (id !== undefined && members.ids.has(id) && !retiredBefore.has(id) && !used.has(id)) {
      used.add(id)
      return m
    }
    const fresh = newPersonId(new Set([...mentioned, ...retiredBefore, ...supplied, ...used]), random)
    used.add(fresh)
    return { ...m, id: fresh }
  })
  const retired = [...retiredBefore, ...[...mentioned].filter((id) => !used.has(id) && !retiredBefore.has(id))]
  const sameList = next.every((m, i) => m === list[i])
  return {
    ...values,
    ...(sameList ? {} : { [MEMBERS_KEY]: next as unknown as SettingValue }),
    [RETIRED_KEY]: retired
  }
}

export const householdDietFrom = (value: (key: string) => unknown): Diet => ({
  allergies: strings(value(DIET_KEYS.allergies)),
  diets: strings(value(DIET_KEYS.diets)),
  dislikes: strings(value(DIET_KEYS.dislikes))
})

export interface PeopleSource {
  /** The effective value of a shared setting (`Sections.value`): the household diet. */
  readonly value: (key: string) => unknown
  /** The effective Members now (`effectiveMembersOf` of the committed settings): the only source of people. */
  readonly members: () => EffectiveMembers
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
 * The `People` service over the Members section: every read is of the effective Members (`effectiveMembersOf`, cached
 * per saved array), so a turn's lookups cost nothing.
 */
export const makePeopleService = (source: PeopleSource): PeopleService & { readonly nameOf: (id: string) => string | undefined } => {
  const people = () => source.members()
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
            // The person must be one of the effective Members now (`effectiveMembersOf`); the form's value has the same ids.
            const raw = value(MEMBERS_KEY)
            const list = Array.isArray(raw) ? raw : []
            const index = people().ids.has(person) ? list.findIndex((m) => isRecord(m) && m.id === person) : -1
            if (index < 0) return { refused: `There is no person ${person} in Members`, code: "unknown_person" }
            const next = list.map((m, i) => (i === index && isRecord(m) ? { ...m, ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, [...v]])) } : m))
            return { values: { [MEMBERS_KEY]: next as unknown as SettingValue }, secrets: {} }
          }),
          (r) => (r.ok ? Effect.void : Effect.fail(peopleError(r.code ?? "not_saved", r.message)))
        )
      })
  }
}
