// Presence and people through the real host, gateway, scheduler and privacy rule of the test kit. The Home Assistant
// transport is a programmed stub of the contract (docs/MODULES.md §13); the module makes no request of its own, so no
// test needs the network.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault, provide, startTestModule, stubService } from "@pva/core/testing"
import { type HaChange, type HaConnection, type HaEntity, HomeAssistant, type HomeAssistantService } from "@pva/module-contracts"
import { Effect, Queue, Stream } from "effect"
import { catalog, presenceModule, texts } from "../src/index.ts"

const HOUR = 3_600_000
/** The test clock starts here: Wednesday 18 November 2026, 10:00 in Amsterdam. */
const START = Date.parse("2026-11-18T09:00:00Z")

const person = (entityId: string, state: string, lastChanged: number): HaEntity => ({
  entityId,
  domain: "person",
  name: entityId.slice("person.".length),
  aliases: [],
  state,
  attributes: {},
  attributesCut: false,
  lastChanged
})

/** Home Assistant as a test programs it: what the cache says, and the stream of changes it sends. */
const makeHa = (initial: ReadonlyArray<HaEntity>, connection: HaConnection = "connected") =>
  Effect.gen(function*() {
    const queue = yield* Queue.unbounded<HaChange>()
    const world = { connection, entities: new Map(initial.map((e) => [e.entityId, e])) }
    const stub = stubService<HomeAssistantService>("home-assistant", {
      connection: () => world.connection,
      entities: () => [...world.entities.values()],
      entity: (id: string) => world.entities.get(id),
      areas: () => [],
      people: () => [...world.entities.values()].filter((e) => e.domain === "person").map((e) => ({ entityId: e.entityId, name: e.name, state: e.state, since: e.lastChanged })),
      changes: () => Stream.fromQueue(queue)
    })
    /** Home Assistant says a person's state changed (the cache follows, then the change is sent). */
    const move = (entityId: string, state: string, at: number) => {
      const previous = world.entities.get(entityId)
      const entity = person(entityId, state, at)
      world.entities.set(entityId, entity)
      Queue.offerUnsafe(queue, { _tag: "changed", entity, previous })
    }
    const snapshot = (reason: "subscribed" | "reconnected" | "overflow") =>
      Queue.offerUnsafe(queue, { _tag: "snapshot", reason, connection: world.connection, entities: [...world.entities.values()], areas: [] })
    return { stub, world, queue, move, snapshot, provided: provide("home-assistant", { services: [HomeAssistant.of(stub.service)] }) }
  })

const links = [
  { haPerson: "person.sam", member: "Sam" },
  { haPerson: "person.robin", member: "Robin" },
  { haPerson: "person.alex", member: "p-alex" }
]

const world = (now: number) => [person("person.sam", "home", now - 3 * HOUR), person("person.robin", "not_home", now - 26 * HOUR), person("person.alex", "work", now - HOUR)]

const KITCHEN = { device: "kitchen-display" } // shared, Sam's
const PHONE = { device: "robins-phone" } // private
const HALL = { device: "hall-screen" } // public

describe("@pva/module-presence", () => {
  it.effect("is off by default and passes the conformance check, with its texts in both languages", () =>
    Effect.gen(function*() {
      const ha = yield* makeHa([])
      yield* expectOffByDefault(catalog)
      for (const definition of catalog) yield* checkModule(definition, { texts, provide: [ha.provided] })
      assert.strictEqual(presenceModule.enabledByDefault, false)
    }))

  describe("presence_where", () => {
    it.effect("answers on the asker's own shared device: the default person's whereabouts, and nothing about others", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        const sam = yield* kit.tool("presence_where", { person: "Sam" }, KITCHEN)
        assert.deepStrictEqual(sam.value, { people: [{ name: "Sam", at: "home", since: "07:00" }], owner: "p-sam" })
        const everyone = yield* kit.tool("presence_where", {}, KITCHEN)
        assert.deepStrictEqual(everyone.value, {
          people: [{ name: "Sam", at: "home", since: "07:00" }],
          withheld: "Where 2 other people are is not said here.",
          owner: "p-sam"
        })
        const robin = yield* kit.tool("presence_where", { person: "Robin" }, KITCHEN)
        assert.deepStrictEqual(robin.value, { spoken: "I don't say where people are from this device." })
        assert.notInclude(robin.content, "not_home")
      }))

    it.effect("a private device may be told every member's whereabouts; a date is added when it was not today", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        const all = yield* kit.tool("presence_where", {}, PHONE)
        assert.deepStrictEqual((all.value as { people: unknown }).people, [
          { name: "Sam", at: "home", since: "07:00" },
          { name: "Robin", at: "out", since: "2026-11-17 08:00" },
          { name: "Alex", at: "out", since: "09:00" }
        ])
        // Alex is linked by id: a zone name ("work") is not said, only that Alex is out.
        assert.notInclude(all.content, "work")
      }))

    it.effect("a public device says nothing about anyone, not even the person who is its default", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        for (const input of [{}, { person: "Sam" }, { person: "Robin" }]) {
          const r = yield* kit.tool("presence_where", input, HALL)
          assert.deepStrictEqual(r.value, { spoken: "I don't say where people are from this device." })
        }
        const household = {
          people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }],
          devices: [
            { id: "screen-with-default", name: "Screen", room: "Hall", privacy: "public" as const, defaultPerson: "p-sam" },
            { id: "shared-nobody", name: "Table", room: "Kitchen", privacy: "shared" as const, defaultPerson: null }
          ]
        }
        const second = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided], household })
        for (const device of ["screen-with-default", "shared-nobody"]) {
          for (const input of [{}, { person: "Sam" }]) {
            const r = yield* second.tool("presence_where", input, { device })
            assert.deepStrictEqual(r.value, { spoken: "I don't say where people are from this device." })
            assert.notInclude(r.content, "home")
          }
        }
      }))

    it.effect("asks which one when a name fits two, and says so for a stranger and for a member who is not linked", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([person("person.sam", "home", START - HOUR)])
        const household = {
          people: [{ id: "p-sam", name: "Sam Jones" }, { id: "p-sem", name: "Sam Smith" }, { id: "p-kim", name: "Kim" }],
          devices: [{ id: "phone-of-sam", name: "Phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-sam" }]
        }
        const kit = yield* startTestModule(presenceModule, { settings: { people: [{ haPerson: "person.sam", member: "p-sam" }] }, provide: [ha.provided], household })
        const on = { device: "phone-of-sam" }
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Sam" }, on)).value, { spoken: "Which one: Sam Jones, Sam Smith?" })
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Zorro" }, on)).value, { spoken: "I don't know anyone called Zorro." })
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Kim" }, on)).value, {
          spoken: "I don't follow where Kim is. The owner can link Kim to a Home Assistant person in the module's settings."
        })
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Sam Jones" }, on)).value, { people: [{ name: "Sam Jones", at: "home", since: "09:00" }], owner: "p-sam" })
      }))

    it.effect("says what it does not know: no links, nothing heard yet, a person Home Assistant lacks, a link to nobody", () =>
      Effect.gen(function*() {
        const none = yield* makeHa(world(START))
        const unlinked = yield* startTestModule(presenceModule, { provide: [none.provided] })
        assert.deepStrictEqual((yield* unlinked.tool("presence_where", {}, PHONE)).value, {
          spoken: "I don't know who is home yet: no one is linked to a Home Assistant person in the module's settings."
        })
        const silent = yield* makeHa([], "unknown")
        const waiting = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [silent.provided] })
        assert.deepStrictEqual((yield* waiting.tool("presence_where", {}, PHONE)).value, { spoken: "I haven't heard from Home Assistant yet, so I don't know who is home." })
        // Home Assistant knows nobody the settings name, and one link names a member who does not exist.
        const strangers = yield* makeHa([person("person.ghost", "home", START)])
        const kit = yield* startTestModule(presenceModule, { settings: { people: [...links, { haPerson: "person.ghost", member: "Nobody At All" }] }, provide: [strangers.provided] })
        assert.deepStrictEqual((yield* kit.tool("presence_where", {}, PHONE)).value, { spoken: "None of the linked people is known to Home Assistant right now." })
      }))

    it.effect("a dropped connection is said, and the last known state is still given; rubbish states are 'unknown', never 'home'", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([person("person.sam", "home", START - HOUR), person("person.robin", "unavailable", START - HOUR), person("person.alex", "‮<script>", START - HOUR)], "reconnecting")
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        const r = (yield* kit.tool("presence_where", {}, PHONE)).value as { people: Array<{ name: string; at: string }>; stale: string }
        assert.strictEqual(r.stale, "I lost the connection to Home Assistant, so this is what I heard last.")
        assert.deepStrictEqual(r.people.map((p) => [p.name, p.at]), [["Sam", "home"], ["Robin", "unknown"], ["Alex", "out"]])
        assert.notInclude(JSON.stringify(r), "script")
      }))

    it.effect("speaks Dutch in a Dutch household", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const household = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } }
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided], household })
        const hall = yield* kit.tool("presence_where", {}, HALL)
        assert.deepStrictEqual(hall.value, { spoken: "Via dit apparaat zeg ik niet waar mensen zijn." })
        const say = yield* kit.action("who_is_home", {}, KITCHEN)
        assert.deepStrictEqual(say, { ok: true, say: "Sam is thuis. Waar 2 andere mensen zijn zeg ik hier niet." })
        const unlinked = yield* startTestModule(presenceModule, { provide: [ha.provided], household })
        assert.include(((yield* unlinked.tool("presence_where", {}, PHONE)).value as { spoken: string }).spoken, "gekoppeld")
      }))
  })

  describe("the where action", () => {
    it.effect("runs without the model, on the asking device's terms", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-sam" }, KITCHEN), { ok: true, say: "Sam is home." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-robin" }, KITCHEN), { ok: true, say: "I don't say where people are from this device." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-robin" }, PHONE), { ok: true, say: "Robin is out." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", {}, PHONE), { ok: true, say: "Sam is home. Robin is out. Alex is out." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", {}, HALL), { ok: true, say: "I don't say where people are from this device." })
        // The model is offered the tools, not a second copy of the action.
        assert.deepStrictEqual(kit.toolNames().sort(), ["people_list", "presence_where"])
      }))

    it.effect("names at most four people, then how many more", () =>
      Effect.gen(function*() {
        const names = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo"]
        const people = names.map((n) => ({ id: `p-${n.toLowerCase()}`, name: n }))
        const ha = yield* makeHa(names.map((n) => person(`person.${n.toLowerCase()}`, "home", START - HOUR)))
        const kit = yield* startTestModule(presenceModule, {
          settings: { people: names.map((n) => ({ haPerson: `person.${n.toLowerCase()}`, member: n })) },
          provide: [ha.provided],
          household: { people, devices: [{ id: "private-one", name: "Phone", room: "Hall", privacy: "private" as const, defaultPerson: null }] }
        })
        const r = yield* kit.action("who_is_home", {}, { device: "private-one" })
        assert.deepStrictEqual(r, { ok: true, say: "Ann is home. Bo is home. Cy is home. Di is home. and 2 more." })
      }))
  })

  describe("people_list", () => {
    it.effect("lists the household and who is followed, and never says where anyone is", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: [links[0]!] }, provide: [ha.provided] })
        const r = yield* kit.tool("people_list", {}, HALL)
        assert.deepStrictEqual(r.value, { members: [{ name: "Sam", followed: true }, { name: "Robin", followed: false }, { name: "Alex", followed: false }] })
        assert.notInclude(r.content, "home")
      }))
  })

  describe("settings and health", () => {
    it.effect("says so on the Health page when nobody is linked, and nothing when someone is", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([])
        const empty = yield* startTestModule(presenceModule, { provide: [ha.provided] })
        assert.deepStrictEqual((yield* empty.checkHealth).map((i) => i.id), ["presence.no-people"])
        const linked = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        assert.deepStrictEqual(yield* linked.checkHealth, [])
      }))

    it.effect("refuses settings that cannot be right: a bad entity, a person linked twice, a delay out of range", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([])
        for (const bad of [
          { people: [{ haPerson: "sam", member: "Sam" }] },
          { people: [{ haPerson: "person.sam", member: "Sam" }, { haPerson: "person.sam", member: "Robin" }] },
          { people: [{ haPerson: "person.sam", member: "Sam" }, { haPerson: "person.sam2", member: "sam" }] },
          { people: [{ haPerson: "person.sam", member: "" }] },
          { departureDelayMinutes: 61 },
          { departureDelayMinutes: -1 },
          { departureDelayMinutes: 2.5 }
        ]) {
          // The module is down, with the reason on its admin page, and offers nothing.
          const kit = yield* startTestModule(presenceModule, { settings: bad, provide: [ha.provided] })
          assert.strictEqual(kit.info()?.state, "error")
          assert.deepStrictEqual(kit.toolNames(), [])
        }
      }))
  })

  describe("arrivals and departures", () => {
    const events = (kit: { readonly events: ReadonlyArray<{ readonly type: string; readonly data?: unknown }> }, type: string) => kit.events.filter((e) => e.type === type).map((e) => e.data)

    it.effect("a departure is announced after the delay, as the person, with when it happened", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        const at = yield* kit.now
        ha.move("person.sam", "not_home", at)
        yield* kit.advance(1)
        const job = (yield* kit.jobs).find((j) => j.handler === "left")
        assert.isDefined(job)
        yield* kit.advance(2 * 60_000)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        yield* kit.advance(60_000)
        assert.deepStrictEqual(events(kit, "presence.left"), [{ person: "p-sam", at }])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
      }))

    it.effect("someone back within the delay neither left nor arrived", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(60_000)
        ha.move("person.sam", "home", yield* kit.now)
        yield* kit.advance(10 * 60_000)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
      }))

    it.effect("an arrival is announced at once, after a departure that was announced", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        // Robin was out already: coming home is an arrival, now.
        const at = yield* kit.now
        ha.move("person.robin", "home", at)
        yield* kit.advance(1)
        assert.deepStrictEqual(events(kit, "presence.arrived"), [{ person: "p-robin", at }])
        // Sam leaves and the departure is announced; the return is an arrival.
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(4 * 60_000)
        assert.strictEqual(events(kit, "presence.left").length, 1)
        ha.move("person.sam", "home", yield* kit.now)
        yield* kit.advance(1)
        assert.strictEqual(events(kit, "presence.arrived").length, 2)
      }))

    it.effect("a fresh snapshot is not news: not after a reconnect, an overflow, the first load or a state that goes from unknown", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        // Everyone is "home" in the snapshot after the connection came back, and nobody has just arrived.
        ha.world.entities.set("person.robin", person("person.robin", "home", START))
        ha.world.entities.set("person.sam", person("person.sam", "not_home", START))
        for (const reason of ["reconnected", "overflow", "subscribed"] as const) ha.snapshot(reason)
        yield* kit.advance(10 * 60_000)
        // From unknown or unavailable to a place is not an arrival or a departure either, nor is a new entity.
        ha.move("person.alex", "unavailable", START)
        ha.move("person.alex", "home", START)
        ha.move("person.alex", "unavailable", START)
        ha.move("person.alex", "not_home", START)
        Queue.offerUnsafe(ha.queue, { _tag: "changed", entity: person("person.alex", "home", START), previous: undefined })
        yield* kit.advance(10 * 60_000)
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
        assert.deepStrictEqual(events(kit, "presence.left"), [])
      }))

    it.effect("people who are not linked, and linked to nobody, are announced nowhere", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([...world(START), person("person.guest", "home", START), person("person.ghost", "home", START)])
        const kit = yield* startTestModule(presenceModule, { settings: { people: [...links, { haPerson: "person.ghost", member: "Nobody At All" }] }, provide: [ha.provided] })
        ha.move("person.guest", "not_home", yield* kit.now)
        ha.move("person.ghost", "not_home", yield* kit.now)
        yield* kit.advance(10 * 60_000)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        ha.move("person.guest", "home", yield* kit.now)
        ha.move("person.ghost", "home", yield* kit.now)
        yield* kit.advance(1)
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
      }))

    it.effect("a delay of nought announces the departure at once, and the setting is the one used", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links, departureDelayMinutes: 0 }, provide: [ha.provided] })
        const at = yield* kit.now
        ha.move("person.sam", "not_home", at)
        yield* kit.advance(1)
        assert.deepStrictEqual(events(kit, "presence.left"), [{ person: "p-sam", at }])
        const slow = yield* startTestModule(presenceModule, { settings: { people: links, departureDelayMinutes: 30 }, provide: [ha.provided] })
        ha.move("person.robin", "home", at)
        yield* slow.advance(1)
        ha.move("person.robin", "not_home", yield* slow.now)
        yield* slow.advance(29 * 60_000)
        assert.deepStrictEqual(events(slow, "presence.left"), [])
        yield* slow.advance(60_000)
        assert.strictEqual(events(slow, "presence.left").length, 1)
      }))

    it.effect("a departure waiting for its delay survives a restart; the restart itself announces nothing", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        const at = yield* kit.now
        ha.move("person.sam", "not_home", at)
        yield* kit.advance(60_000)
        yield* kit.restart
        // After the restart Home Assistant sends its state again, as a snapshot.
        ha.snapshot("reconnected")
        yield* kit.advance(1)
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        yield* kit.advance(2 * 60_000)
        assert.deepStrictEqual(events(kit, "presence.left"), [{ person: "p-sam", at }])
        // Once only.
        yield* kit.advance(HOUR)
        assert.strictEqual(events(kit, "presence.left").length, 1)
      }))

    it.effect("a departure whose person is home again when it falls due (no change was seen) is not announced", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(1)
        // The cache says home again without a change reaching the module (a missed one, a snapshot).
        ha.world.entities.set("person.sam", person("person.sam", "home", yield* kit.now))
        yield* kit.advance(5 * 60_000)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        // And a person Home Assistant has stopped knowing is not announced as gone.
        ha.move("person.robin", "home", yield* kit.now)
        yield* kit.advance(1)
        ha.move("person.robin", "not_home", yield* kit.now)
        yield* kit.advance(1)
        ha.world.entities.delete("person.robin")
        yield* kit.advance(5 * 60_000)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
      }))

    it.effect("the events say who and when, and nothing about where", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "the-clinic", yield* kit.now)
        ha.move("person.alex", "home", yield* kit.now)
        yield* kit.advance(5 * 60_000)
        const all = kit.events.filter((e) => e.type.startsWith("presence."))
        assert.strictEqual(all.length, 2)
        for (const e of all) assert.deepStrictEqual(Object.keys(e.data as object).sort(), ["at", "person"])
        assert.notInclude(JSON.stringify(all), "clinic")
      }))
  })
})
