// P5 (docs/MODULES-PLAN.md §4): people found by a spoken name, diets, `Privacy.mayReveal` row by row, "the best other
// screen", the per-turn device line, and person-scoped household rows reaching voice pages only through the privacy rule.
import { describe, expect, it } from "@effect/vitest"
import { BUILT_IN_PLACE, type DeviceCapabilities, type DevicePlace } from "@pva/protocol"
import { Effect, Schema } from "effect"
import {
  type CatchUp,
  CurrentTurn,
  defineCollection,
  deviceContextLine,
  effectiveDiet,
  findPerson,
  type KnownDevice,
  makeDevices,
  makeHouseholdFeed,
  makePrivacy,
  mayRevealItemTo,
  mayRevealScopeTo,
  mayRevealTo,
  newPersonId,
  type Person,
  type PrivacyPlace,
  rankOtherScreens,
  type Row,
  type Snapshot
} from "../src/index.ts"
import { makeMemoryHouseholdStore } from "../src/testing.ts"

const person = (id: string, name: string, aliases: ReadonlyArray<string> = [], diet: Partial<Person["diet"]> = {}): Person => ({
  id,
  name,
  aliases,
  pronunciation: "",
  diet: { allergies: [], diets: [], dislikes: [], ...diet }
})
const sam = person("p-sam", "Sam", ["Sammie"], { allergies: ["nuts"] })
const samJones = person("p-samj", "Sam Jones")
const geoff = person("p-geoff", "Geoff")
const robin = person("p-robin", "Robin Smith", ["Rob"])

describe("People: finding a person by a spoken name", () => {
  it("the whole name or an alias, ignoring case, accents and a possessive", () => {
    const people = [sam, geoff, robin]
    expect(findPerson(people, "sam")).toEqual({ kind: "found", person: sam })
    expect(findPerson(people, "SAMMIE")).toEqual({ kind: "found", person: sam })
    expect(findPerson(people, "Sam's")).toEqual({ kind: "found", person: sam })
    expect(findPerson(people, "Robin Smith")).toEqual({ kind: "found", person: robin })
    expect(findPerson(people, "rob")).toEqual({ kind: "found", person: robin })
  })

  it("a first name, then the same sound, then one letter off (four letters or more)", () => {
    expect(findPerson([robin, geoff], "Robin")).toEqual({ kind: "found", person: robin })
    expect(findPerson([robin, geoff], "Jeff")).toEqual({ kind: "found", person: geoff })
    expect(findPerson([robin, geoff], "Robyn")).toEqual({ kind: "found", person: robin })
    expect(findPerson([robin, geoff], "Bob")).toEqual({ kind: "none" })
  })

  it("returns ambiguity instead of guessing, and an exact name beats a first name", () => {
    const people = [sam, samJones, geoff]
    // "Sam" is Sam's whole name: Sam Jones's first name does not compete with it.
    expect(findPerson(people, "Sam")).toEqual({ kind: "found", person: sam })
    const twoSams = [person("p-a", "Sam Jones"), person("p-b", "Sam Smith")]
    const m = findPerson(twoSams, "Sam")
    expect(m.kind).toBe("ambiguous")
    expect(m.kind === "ambiguous" ? m.people.map((p) => p.id) : []).toEqual(["p-a", "p-b"])
    const shared = [person("p-1", "Alex", ["Mum"]), person("p-2", "Jo", ["Mum"])]
    expect(findPerson(shared, "mum").kind).toBe("ambiguous")
    expect(findPerson([], "Sam")).toEqual({ kind: "none" })
    expect(findPerson([sam], "  ")).toEqual({ kind: "none" })
  })

  it("a new id is not one that is taken", () => {
    let i = 0
    const random = () => [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0][i++ % 16]!
    const first = newPersonId(new Set(), random)
    expect(first).toMatch(/^p-[a-z0-9]{8}$/)
    const second = newPersonId(new Set([first]), random)
    expect(second).not.toBe(first)
  })
})

describe("People: diets", () => {
  const household = { allergies: ["shellfish"], diets: ["vegetarian"], dislikes: ["coriander"] }
  it("a person's own part wins; an empty part is the household's; nobody is the household", () => {
    expect(effectiveDiet(sam, household)).toEqual({ allergies: ["nuts"], diets: ["vegetarian"], dislikes: ["coriander"] })
    expect(effectiveDiet(geoff, household)).toEqual(household)
    expect(effectiveDiet(undefined, household)).toEqual(household)
  })
})

describe("Privacy.mayReveal (docs/MODULES-PLAN.md §2 row 8)", () => {
  const at = (privacy: PrivacyPlace["privacy"], defaultPerson: string | null = null): PrivacyPlace => ({ privacy, defaultPerson })
  it.each([
    ["private, anyone's", at("private"), "p-sam", true],
    ["private, someone else's default", at("private", "p-robin"), "p-sam", true],
    ["private, unknown owner", at("private", "p-sam"), undefined, true],
    ["shared, its default person is the owner", at("shared", "p-sam"), "p-sam", true],
    ["shared, another default person", at("shared", "p-robin"), "p-sam", false],
    ["shared, nobody's", at("shared"), "p-sam", false],
    ["shared, unknown owner is someone else's", at("shared", "p-sam"), undefined, false],
    ["shared, an empty owner is unknown", at("shared", "p-sam"), "", false],
    ["public, even its default person", at("public", "p-sam"), "p-sam", false],
    ["public, unknown owner", at("public"), undefined, false]
  ] as const)("%s", (_name, place, owner, expected) => {
    expect(mayRevealTo(owner, place)).toBe(expected)
    expect(mayRevealItemTo({ sensitivity: "personal", owner }, place)).toBe(expected)
    // A household item: always.
    expect(mayRevealItemTo({ sensitivity: "household" }, place)).toBe(true)
  })

  const places: Record<string, PrivacyPlace> = { "phone-0001": at("private", "p-sam"), "kitchen-01": at("shared", "p-sam"), "hall-0001": at("public") }
  /** An unknown device is judged from its type's defaults (shared, nobody's). */
  const privacy = makePrivacy((id) => (id !== undefined ? places[id] : undefined) ?? at("shared"))

  it("by device id, by a turn, and for an unknown device or none", () => {
    expect(privacy.mayReveal("p-robin", "phone-0001")).toBe(true)
    expect(privacy.mayReveal("p-sam", "kitchen-01")).toBe(true)
    expect(privacy.mayReveal("p-robin", "kitchen-01")).toBe(false)
    expect(privacy.mayReveal("p-sam", "hall-0001")).toBe(false)
    expect(privacy.mayReveal("p-sam", "never-seen-01")).toBe(false)
    expect(privacy.mayReveal("p-sam", undefined)).toBe(false)
    expect(privacy.mayReveal("p-sam", { deviceId: "kitchen-01" })).toBe(true)
    expect(privacy.mayRevealItem({ sensitivity: "household" }, "hall-0001")).toBe(true)
    expect(privacy.mayRevealItem({ sensitivity: "personal" }, "kitchen-01")).toBe(false)
  })

  it.effect("mayRevealHere reads the current turn", () =>
    Effect.gen(function*() {
      const here = privacy.mayRevealHere("p-sam")
      expect(yield* here.pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "text", deviceId: "kitchen-01" }))).toBe(true)
      expect(yield* here.pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "text", deviceId: "hall-0001" }))).toBe(false)
      expect(yield* here).toBe(false)
    }))
})

const screen = (cls: "compact" | "standard" | "large", extra: Partial<DeviceCapabilities> = {}): DeviceCapabilities => ({
  v: 1,
  display: { class: cls, widthPx: 1000, heightPx: 700, dpr: 1, touch: "coarse", colour: true },
  speaker: { media: ["speech"] },
  ...extra
})
const device = (id: string, name: string, o: { place?: Partial<DevicePlace>; caps?: DeviceCapabilities; connected?: boolean; visible?: boolean; at?: number } = {}): KnownDevice => {
  const place = { ...BUILT_IN_PLACE, ...o.place }
  return {
    id,
    name,
    kind: "web-voice",
    room: place.room.trim() === "" ? undefined : place.room.trim(),
    place,
    capabilities: o.caps ?? { v: 1 },
    declared: undefined,
    connected: o.connected ?? false,
    visible: (o.connected ?? false) && (o.visible ?? true),
    lastInteractionAt: o.at,
    lastSeen: 0
  }
}

describe("Devices: the best other screen (presentation §6.2)", () => {
  const speaker = device("speaker-01", "Kitchen speaker", { place: { room: "Kitchen", defaultPerson: "p-sam" }, caps: { v: 1, speaker: { media: ["speech"] } }, connected: true })
  const ipadOn = device("ipad-0001", "Kitchen iPad", { place: { room: "Kitchen" }, caps: screen("standard"), connected: true, visible: true })
  const ipadHidden = device("ipad-0002", "Kitchen tablet", { place: { room: "kitchen", alwaysOn: true }, caps: screen("standard"), connected: true, visible: false })
  const phone = device("phone-0001", "Sam's phone", { place: { privacy: "private", defaultPerson: "p-sam" }, caps: screen("compact", { openUrl: true }), connected: true })
  const tv = device("tv-000001", "Living room TV", { place: { room: "Living room" }, caps: screen("large"), connected: true, at: 5 })
  const tvOld = device("tv-000002", "Study screen", { place: { room: "Study" }, caps: screen("large"), connected: true, at: 1 })
  const refuses = device("hall-0001", "Hall screen", { place: { room: "Kitchen", acceptsFromOthers: false }, caps: screen("standard"), connected: true })
  const off = device("bed-00001", "Bedroom tablet", { place: { room: "Bedroom" }, caps: screen("standard") })
  const all = [speaker, ipadOn, ipadHidden, phone, tv, tvOld, refuses, off]

  it("same room and visible, same room and always on, the person's phone, then other connected shared screens by recency", () => {
    expect(rankOtherScreens(all, speaker).map((d) => d.id)).toEqual(["ipad-0001", "ipad-0002", "phone-0001", "tv-000001", "tv-000002"])
    // A screen that takes nothing from others, one that is off and not always on, and the asking device are left out.
    const devices = makeDevices(() => all)
    expect(devices.bestOtherScreen("speaker-01")?.id).toBe("ipad-0001")
    expect(devices.otherScreens({ deviceId: "speaker-01" }, { person: "p-robin" }).map((d) => d.id)).not.toContain("phone-0001")
    // From an unknown device: no room and nobody's phone, so every connected shared screen, the most recently used first.
    expect(devices.otherScreens("unknown-01").map((d) => d.id)).toEqual(["tv-000001", "tv-000002", "ipad-0001", "ipad-0002"])
    // A display taken away in admin (effective capabilities without it) is no screen.
    expect(rankOtherScreens([speaker, { ...ipadOn, capabilities: { v: 1, speaker: { media: ["speech"] } } }], speaker)).toEqual([])
  })

  it("one context line: this device, its room, what it can do, the other screens (same room, then on, then by name) and whether they are on", () => {
    const line = deviceContextLine(all, "speaker-01", (id) => (id === "p-sam" ? "Sam" : undefined))
    expect(line).toBe(
      "Device: Kitchen speaker (voice only, no screen, no microphone; room Kitchen; shared, usually Sam). " +
        "Other screens: Kitchen iPad (on), Kitchen tablet (off), Living room TV (on), Sam's phone (on), Study screen (on), Bedroom tablet (off)."
    )
    expect(deviceContextLine([speaker], "speaker-01")).toBe("Device: Kitchen speaker (voice only, no screen, no microphone; room Kitchen; shared). Other screens: none.")
    // The room is named when the device's name does not already say it.
    expect(deviceContextLine([speaker, device("tv-000003", "Big screen", { place: { room: "Den" }, caps: screen("large") })], "speaker-01")).toContain("Big screen in Den (off)")
    expect(deviceContextLine(all, undefined)).toMatch(/^Device: a voice page without a known device \(capabilities unknown\)\. Other screens: /)
    // At most six screens are named; the rest are counted.
    const many = Array.from({ length: 9 }, (_, i) => device(`screen-${i}0000`, `Screen ${i}`, { caps: screen("large") }))
    expect(deviceContextLine([speaker, ...many], "speaker-01")).toMatch(/Screen 5 \(off\) and 3 more\.$/)
  })
})

describe("household rows on voice pages: person scope through Privacy.mayReveal (P4 + P5)", () => {
  const Item = Schema.Struct({ text: Schema.String })
  const items = defineCollection({ name: "items", scope: "person", schema: Item, project: (row: Row<typeof Item.Type>) => ({ text: row.value.text }) })

  it("mayRevealScopeTo: a person's rows on a private device, on a shared one only for its default person, never on a public one", () => {
    const scope = { kind: "person", id: "p-sam" } as const
    expect(mayRevealScopeTo(scope, { id: "phone-0001", privacy: "private" })).toBe(true)
    expect(mayRevealScopeTo(scope, { id: "kitchen-01", privacy: "shared", defaultPerson: "p-sam" })).toBe(true)
    expect(mayRevealScopeTo(scope, { id: "kitchen-01", privacy: "shared", defaultPerson: "p-robin" })).toBe(false)
    expect(mayRevealScopeTo(scope, { id: "kitchen-01", privacy: "shared" })).toBe(false)
    expect(mayRevealScopeTo(scope, { id: "hall-0001", privacy: "public", defaultPerson: "p-sam" })).toBe(false)
    // A page without a device, or a device whose place is not known: shared and nobody's.
    expect(mayRevealScopeTo(scope, {})).toBe(false)
    expect(mayRevealScopeTo({ kind: "household" }, { privacy: "public" })).toBe(true)
  })

  it.effect("the snapshot and live changes carry a person's rows only where they may be shown", () =>
    Effect.gen(function*() {
      const store = makeMemoryHouseholdStore()
      yield* store.prepare([{ id: "lists", storage: { collections: [items] } }])
      const m = store.forModule("lists")
      yield* m.collection(items).insert({ text: "Sam's" }, { scope: { kind: "person", id: "p-sam" } })
      yield* m.collection(items).insert({ text: "Robin's" }, { scope: { kind: "person", id: "p-robin" } })
      const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "lists", collections: [items], events: [] }], people: () => ["p-sam", "p-robin"] })
      const texts = (s: Snapshot) => s.parts.flat().flatMap((c) => c.rows.map((r) => (r.value as { text: string }).text)).sort()
      expect(texts(yield* feed.snapshot({ id: "phone-0001", privacy: "private" }))).toEqual(["Robin's", "Sam's"])
      expect(texts(yield* feed.snapshot({ id: "kitchen-01", privacy: "shared", defaultPerson: "p-sam" }))).toEqual(["Sam's"])
      expect(texts(yield* feed.snapshot({ id: "kitchen-01", privacy: "shared" }))).toEqual([])
      expect(texts(yield* feed.snapshot({ id: "hall-0001", privacy: "public", defaultPerson: "p-sam" }))).toEqual([])
      // Changes: an update of Robin's row reaches the private phone and Robin's kitchen, not Sam's kitchen.
      const phone = { id: "phone-0001", privacy: "private" } as const
      const samKitchen = { id: "kitchen-01", privacy: "shared", defaultPerson: "p-sam" } as const
      const robinKitchen = { id: "kitchen-01", privacy: "shared", defaultPerson: "p-robin" } as const
      const cursors = {
        phone: (yield* feed.snapshot(phone)).cursor,
        sam: (yield* feed.snapshot(samKitchen)).cursor,
        robin: (yield* feed.snapshot(robinKitchen)).cursor
      }
      const row = (yield* m.collection(items).list({ scope: { kind: "person", id: "p-robin" }, limit: 5 }))[0]!
      yield* m.collection(items).update(row.id, () => ({ text: "Robin's 2" }), { scope: row.scope })
      const changes = (r: CatchUp) => (r.kind === "changes" ? r.events.map((e) => e.data) : [])
      expect(changes(yield* feed.catchUp(phone, cursors.phone))).toMatchObject([{ op: "put", value: { text: "Robin's 2" } }])
      expect(changes(yield* feed.catchUp(samKitchen, cursors.sam))).toEqual([])
      expect(changes(yield* feed.catchUp(robinKitchen, cursors.robin))).toMatchObject([{ op: "put" }])
    }))
})
