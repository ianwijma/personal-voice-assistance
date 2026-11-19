// Presence and people through the real host, gateway, scheduler and privacy rule of the test kit. The Home Assistant
// transport is a programmed stub of the contract (docs/MODULES.md §13): each `changes()` is a stream of its own that
// starts with a snapshot of the cache, as the contract says every subscription does. The module makes no request of
// its own, so no test needs the network.
import { assert, describe, it } from "@effect/vitest"
import { ModuleStopped } from "@pva/core"
import { provide, startTestModule, stubService } from "@pva/core/testing"
import { type HaChange, type HaConnection, type HaEntity, HomeAssistant, type HomeAssistantService } from "@pva/module-contracts"
import { type Cause, Effect, Queue, Stream } from "effect"
import { makePresenceModule, presenceModule } from "../src/index.ts"

const MINUTE = 60_000
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

/**
 * Home Assistant as a test programs it: what the cache says, and the changes it sends. Every `changes()` makes a new
 * subscription, whose stream starts with a `subscribed` snapshot of the cache then; `endStreams` ends every one (the
 * provider stopped), and `replace` is a new provider: the old streams end and the cache is another one.
 */
const makeHa = (initial: ReadonlyArray<HaEntity>, connection: HaConnection = "connected") =>
  Effect.gen(function*() {
    const world = { connection, entities: new Map(initial.map((e) => [e.entityId, e])) }
    const subscriptions = new Set<Queue.Queue<HaChange, Cause.Done>>()
    const snapshotOf = (reason: "subscribed" | "reconnected" | "overflow"): HaChange => ({
      _tag: "snapshot",
      reason,
      connection: world.connection,
      entities: [...world.entities.values()],
      areas: []
    })
    const send = (change: HaChange) => {
      for (const q of subscriptions) Queue.offerUnsafe(q, change)
    }
    const stub = stubService<HomeAssistantService>("home-assistant", {
      connection: () => world.connection,
      entities: () => [...world.entities.values()],
      entity: (id: string) => world.entities.get(id),
      areas: () => [],
      people: () => [...world.entities.values()].filter((e) => e.domain === "person").map((e) => ({ entityId: e.entityId, name: e.name, state: e.state, since: e.lastChanged })),
      changes: () =>
        Stream.unwrap(Effect.gen(function*() {
          const q = yield* Queue.unbounded<HaChange, Cause.Done>()
          Queue.offerUnsafe(q, snapshotOf("subscribed"))
          subscriptions.add(q)
          return Stream.fromQueue(q).pipe(Stream.ensuring(Effect.sync(() => void subscriptions.delete(q))))
        }))
    })
    /** Home Assistant says a person's state changed (the cache follows, then the change is sent). */
    const move = (entityId: string, state: string, at: number) => {
      const previous = world.entities.get(entityId)
      const entity = person(entityId, state, at)
      world.entities.set(entityId, entity)
      send({ _tag: "changed", entity, previous })
    }
    const snapshot = (reason: "subscribed" | "reconnected" | "overflow") => send(snapshotOf(reason))
    const setConnection = (c: HaConnection) => {
      world.connection = c
      send({ _tag: "connection", connection: c })
    }
    const endStreams = () => {
      for (const q of [...subscriptions]) Queue.endUnsafe(q)
    }
    const replace = (entities: ReadonlyArray<HaEntity>, c: HaConnection = "connected") => {
      endStreams()
      world.connection = c
      world.entities = new Map(entities.map((e) => [e.entityId, e]))
    }
    return {
      stub,
      world,
      move,
      send,
      snapshot,
      setConnection,
      endStreams,
      replace,
      subscriptions: () => subscriptions.size,
      provided: provide("home-assistant", { services: [HomeAssistant.of(stub.service)] })
    }
  })

const links = [
  { haPerson: "person.sam", member: "p-sam" },
  { haPerson: "person.robin", member: "p-robin" },
  { haPerson: "person.alex", member: "p-alex" }
]

const world = (now: number) => [person("person.sam", "home", now - 3 * HOUR), person("person.robin", "not_home", now - 26 * HOUR), person("person.alex", "work", now - HOUR)]

const KITCHEN = { device: "kitchen-display" } // shared, Sam's
const PHONE = { device: "robins-phone" } // private
const HALL = { device: "hall-screen" } // public

const stopped = () => {
  throw new ModuleStopped({ message: "Provider closed." })
}

describe("@pva/module-presence", () => {
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
        const ha = yield* makeHa([person("person.sam", "home", START - 26 * HOUR), ...world(START).slice(1)])
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        const all = yield* kit.tool("presence_where", {}, PHONE)
        // Robin and Alex were away before the module saw them: when they went is not known, so none is given.
        assert.deepStrictEqual((all.value as { people: unknown }).people, [
          { name: "Sam", at: "home", since: "2026-11-17 08:00" },
          { name: "Robin", at: "out" },
          { name: "Alex", at: "out" }
        ])
        // Alex is in a zone ("work"): its name is not said, only that Alex is out.
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
        const second = yield* startTestModule(presenceModule, { settings: { people: links.slice(0, 2) }, provide: [ha.provided], household })
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

    it.effect("says what it does not know: no links, nothing heard yet, people Home Assistant lacks, a link to nobody", () =>
      Effect.gen(function*() {
        const none = yield* makeHa(world(START))
        const unlinked = yield* startTestModule(presenceModule, { provide: [none.provided] })
        assert.deepStrictEqual((yield* unlinked.tool("presence_where", {}, PHONE)).value, {
          spoken: "I don't know who is home yet: no one is linked to a Home Assistant person in the module's settings."
        })
        const silent = yield* makeHa([], "unknown")
        const waiting = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [silent.provided] })
        assert.deepStrictEqual((yield* waiting.tool("presence_where", {}, PHONE)).value, { spoken: "I haven't heard from Home Assistant yet, so I don't know who is home." })
        // Home Assistant knows nobody the settings name, and one link names someone who is not a member: the members
        // are each unknown, by name, and the link to nobody is not mentioned at all.
        const strangers = yield* makeHa([person("person.ghost", "home", START)])
        const kit = yield* startTestModule(presenceModule, { settings: { people: [...links, { haPerson: "person.ghost", member: "p-nobody" }] }, provide: [strangers.provided] })
        const r = yield* kit.tool("presence_where", {}, PHONE)
        assert.deepStrictEqual((r.value as { people: unknown }).people, [{ name: "Sam", at: "unknown" }, { name: "Robin", at: "unknown" }, { name: "Alex", at: "unknown" }])
        assert.notInclude(r.content, "ghost")
        // Only links to nobody: said so.
        const onlyGhost = yield* startTestModule(presenceModule, { settings: { people: [{ haPerson: "person.ghost", member: "p-nobody" }] }, provide: [strangers.provided] })
        assert.deepStrictEqual((yield* onlyGhost.tool("presence_where", {}, PHONE)).value, { spoken: "None of the linked people is in the household's list of people now." })
      }))

    it.effect("privacy first, then what Home Assistant lacks: a linked person it does not expose is 'unknown', by name, wherever that person may be told about", () =>
      Effect.gen(function*() {
        // Every member is linked; Home Assistant exposes only Sam's person.
        const onlySam = yield* makeHa([person("person.sam", "home", START - 3 * HOUR)])
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [onlySam.provided] })
        // Private: a named question is about that person only, and says that person is unknown.
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Robin" }, PHONE)).value, { people: [{ name: "Robin", at: "unknown" }], owner: "p-robin" })
        // Private, everyone: who is unknown is said.
        assert.deepStrictEqual((yield* kit.tool("presence_where", {}, PHONE)).value, {
          people: [{ name: "Sam", at: "home", since: "07:00" }, { name: "Robin", at: "unknown" }, { name: "Alex", at: "unknown" }],
          owner: "p-sam"
        })
        assert.deepStrictEqual(yield* kit.action("who_is_home", {}, PHONE), {
          ok: true,
          say: "Sam has been home since seven o'clock. I don't know where Robin is. I don't know where Alex is."
        })
        // Shared and Sam's: Robin is refused before anything is looked up, so it says no more than for anyone else.
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Robin" }, KITCHEN)).value, { spoken: "I don't say where people are from this device." })
        assert.deepStrictEqual((yield* kit.tool("presence_where", {}, KITCHEN)).value, {
          people: [{ name: "Sam", at: "home", since: "07:00" }],
          withheld: "Where 2 other people are is not said here.",
          owner: "p-sam"
        })
        // Public: nothing, whoever is missing.
        for (const input of [{}, { person: "Robin" }, { person: "Sam" }]) {
          assert.deepStrictEqual((yield* kit.tool("presence_where", input, HALL)).value, { spoken: "I don't say where people are from this device." })
        }
        // Sam not exposed, Robin and Alex are: on Sam's shared display Sam is unknown, the others are only counted.
        const noSam = yield* makeHa(world(START).slice(1))
        const other = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [noSam.provided] })
        assert.deepStrictEqual((yield* other.tool("presence_where", { person: "Sam" }, KITCHEN)).value, { people: [{ name: "Sam", at: "unknown" }], owner: "p-sam" })
        assert.deepStrictEqual((yield* other.tool("presence_where", {}, KITCHEN)).value, {
          people: [{ name: "Sam", at: "unknown" }],
          withheld: "Where 2 other people are is not said here.",
          owner: "p-sam"
        })
        assert.deepStrictEqual(yield* other.action("who_is_home", {}, KITCHEN), { ok: true, say: "I don't know where Sam is. Where 2 other people are is not said here." })
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
        assert.deepStrictEqual(say, { ok: true, say: "Sam is sinds zeven uur thuis. Waar 2 andere mensen zijn zeg ik hier niet." })
        const unlinked = yield* startTestModule(presenceModule, { provide: [ha.provided], household })
        assert.include(((yield* unlinked.tool("presence_where", {}, PHONE)).value as { spoken: string }).spoken, "gekoppeld")
      }))

    it.effect("the time away is the one the module saw begin: a change of zone does not move it", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        // Sam leaves at 10:00, reaches work at 10:01 and goes on at 10:05.
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(MINUTE)
        ha.move("person.sam", "work", yield* kit.now)
        yield* kit.advance(4 * MINUTE)
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(1)
        const sam = yield* kit.tool("presence_where", { person: "Sam" }, PHONE)
        assert.deepStrictEqual(sam.value, { people: [{ name: "Sam", at: "out", since: "10:00" }], owner: "p-sam" })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-sam" }, PHONE), { ok: true, say: "Sam has been out since ten o'clock." })
        // Robin was away before the module saw anything: no time.
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Robin" }, PHONE)).value, { people: [{ name: "Robin", at: "out" }], owner: "p-robin" })
        // Through unknown, the time away begins again unknown: none is given.
        ha.move("person.sam", "unavailable", yield* kit.now)
        yield* kit.advance(1)
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(1)
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Sam" }, PHONE)).value, { people: [{ name: "Sam", at: "out" }], owner: "p-sam" })
      }))

    it.effect("a time away survives a snapshot only when the snapshot says exactly what the module knew", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(10 * MINUTE)
        ha.snapshot("overflow")
        yield* kit.advance(1)
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Sam" }, PHONE)).value, { people: [{ name: "Sam", at: "out", since: "10:00" }], owner: "p-sam" })
        // A reconnect after which Sam's last change is another one (Sam came back and left again unseen): no time.
        ha.world.entities.set("person.sam", person("person.sam", "not_home", (yield* kit.now) - MINUTE))
        ha.snapshot("reconnected")
        yield* kit.advance(1)
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Sam" }, PHONE)).value, { people: [{ name: "Sam", at: "out" }], owner: "p-sam" })
      }))
  })

  describe("links by member id", () => {
    it.effect("a member removed and another added with the same name gets nothing of the old link", () =>
      Effect.gen(function*() {
        // The links were made for an earlier Sam (p-sam), and one written as a name-like id ("sam"). That Sam has
        // left Members; a new Sam (p-new-sam) has joined, whose shared tablet this is.
        const household = {
          people: [{ id: "p-new-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }],
          devices: [
            { id: "sams-tablet", name: "Tablet", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-new-sam" },
            { id: "robins-phone", name: "Phone", room: "Hall", privacy: "private" as const, defaultPerson: "p-robin" }
          ]
        }
        const ha = yield* makeHa([person("person.sam", "home", START - HOUR), person("person.sammy", "home", START - HOUR), person("person.robin", "home", START - HOUR)])
        const stale = [{ haPerson: "person.sam", member: "p-sam" }, { haPerson: "person.sammy", member: "sam" }, { haPerson: "person.robin", member: "p-robin" }]
        const kit = yield* startTestModule(presenceModule, { settings: { people: stale }, provide: [ha.provided], household })
        const tablet = { device: "sams-tablet" }
        // The new Sam is not linked to anyone, by any link.
        assert.deepStrictEqual((yield* kit.tool("presence_where", { person: "Sam" }, tablet)).value, {
          spoken: "I don't follow where Sam is. The owner can link Sam to a Home Assistant person in the module's settings."
        })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-new-sam" }, tablet), {
          ok: true,
          say: "I don't follow where Sam is. The owner can link Sam to a Home Assistant person in the module's settings."
        })
        // On a private device only Robin is answered for: the old links name nobody.
        assert.deepStrictEqual((yield* kit.tool("presence_where", {}, PHONE)).value, { people: [{ name: "Robin", at: "home", since: "09:00" }], owner: "p-robin" })
        assert.deepStrictEqual(((yield* kit.tool("people_list", {}, tablet)).value as { members: unknown }).members, [{ name: "Sam", followed: false }, { name: "Robin", followed: true }])
        // And no event carries the new Sam's id for the old Home Assistant people.
        ha.move("person.sam", "not_home", yield* kit.now)
        ha.move("person.sammy", "not_home", yield* kit.now)
        ha.move("person.robin", "not_home", yield* kit.now)
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(kit.events.filter((e) => e.type.startsWith("presence.")).map((e) => e.data), [{ person: "p-robin", at: START }])
      }))

    it.effect("the module's page lists each member with their id, and names the links to nobody; Health names them too", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const definition = makePresenceModule()
        const good = yield* startTestModule(definition, { settings: { people: links }, provide: [ha.provided] })
        assert.strictEqual(good.info()?.settings.values.members, "Sam: p-sam · Robin: p-robin · Alex: p-alex")
        assert.deepStrictEqual(yield* good.checkHealth, [])
        yield* good.stop
        const other = makePresenceModule()
        const kit = yield* startTestModule(other, { settings: { people: [...links.slice(0, 2), { haPerson: "person.alex", member: "p-alexander" }] }, provide: [ha.provided] })
        assert.strictEqual(kit.info()?.settings.values.members, "Sam: p-sam · Robin: p-robin · Alex: p-alex — Not a member now, ignored: person.alex → p-alexander")
        const issues = yield* kit.checkHealth
        assert.deepStrictEqual(issues.map((i) => [i.id, i.severity]), [["presence.not-members", "warning"]])
        assert.include(issues[0]!.detail, "person.alex (p-alexander)")
      }))
  })

  describe("the where action", () => {
    it.effect("runs without the model, on the asking device's terms, with the time said in words", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-sam" }, KITCHEN), { ok: true, say: "Sam has been home since seven o'clock." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-robin" }, KITCHEN), { ok: true, say: "I don't say where people are from this device." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-robin" }, PHONE), { ok: true, say: "Robin is out." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", {}, PHONE), { ok: true, say: "Sam has been home since seven o'clock. Robin is out. Alex is out." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", {}, HALL), { ok: true, say: "I don't say where people are from this device." })
        // The model is offered the tools, not a second copy of the action.
        assert.deepStrictEqual(kit.toolNames().sort(), ["people_list", "presence_where"])
      }))

    it.effect("says the day too when it was not today, in both languages", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([person("person.sam", "home", START - 26 * HOUR + 30 * MINUTE)])
        const en = yield* startTestModule(presenceModule, { settings: { people: links.slice(0, 1) }, provide: [ha.provided] })
        assert.deepStrictEqual(yield* en.action("who_is_home", {}, PHONE), { ok: true, say: "Sam has been home since yesterday at half past eight." })
        const nl = yield* startTestModule(presenceModule, { settings: { people: links.slice(0, 1) }, provide: [ha.provided], household: { home: { HOME_LANGUAGE: "nl-NL" } } })
        assert.deepStrictEqual(yield* nl.action("who_is_home", {}, PHONE), { ok: true, say: "Sam is sinds gisteren om half negen thuis." })
        ha.move("person.sam", "not_home", yield* nl.now)
        yield* nl.advance(1)
        assert.deepStrictEqual(yield* nl.action("who_is_home", {}, PHONE), { ok: true, say: "Sam is sinds tien uur weg." })
      }))

    it.effect("names at most four people, then how many more", () =>
      Effect.gen(function*() {
        const names = ["Ann", "Bo", "Cy", "Di", "Ed", "Flo"]
        const people = names.map((n) => ({ id: `p-${n.toLowerCase()}`, name: n }))
        const ha = yield* makeHa(names.map((n) => person(`person.${n.toLowerCase()}`, "home", START - HOUR)))
        const kit = yield* startTestModule(presenceModule, {
          settings: { people: names.map((n) => ({ haPerson: `person.${n.toLowerCase()}`, member: `p-${n.toLowerCase()}` })) },
          provide: [ha.provided],
          household: { people, devices: [{ id: "private-one", name: "Phone", room: "Hall", privacy: "private" as const, defaultPerson: null }] }
        })
        const r = yield* kit.action("who_is_home", {}, { device: "private-one" })
        assert.deepStrictEqual(r, {
          ok: true,
          say: "Ann has been home since nine o'clock. Bo has been home since nine o'clock. Cy has been home since nine o'clock. Di has been home since nine o'clock. and 2 more."
        })
      }))
  })

  describe("Home Assistant off or stopping", () => {
    it.effect("a provider that stops during a tool call or the action gives the provider-off sentence, in both languages", () =>
      Effect.gen(function*() {
        for (const [household, sentence] of [[{}, "The Home Assistant module is off."], [{ home: { HOME_LANGUAGE: "nl-NL" } }, "De module Home Assistant staat uit."]] as const) {
          for (const method of ["connection", "people"] as const) {
            const ha = yield* makeHa(world(START))
            const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided], household })
            ha.stub.answer(method, stopped)
            const tool = yield* kit.tool("presence_where", {}, PHONE)
            assert.deepStrictEqual(tool.value, { spoken: sentence })
            assert.isTrue(tool.ok)
            assert.deepStrictEqual(yield* kit.action("who_is_home", {}, PHONE), { ok: true, say: sentence })
            assert.deepStrictEqual(yield* kit.action("who_is_home", { person: "p-robin" }, PHONE), { ok: true, say: sentence })
          }
        }
      }))

    it.effect("with no provider at all, it says so", () =>
      Effect.gen(function*() {
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [provide("home-assistant", {})] })
        assert.deepStrictEqual((yield* kit.tool("presence_where", {}, PHONE)).value, { spoken: "The Home Assistant module is off." })
        assert.deepStrictEqual(yield* kit.action("who_is_home", {}, PHONE), { ok: true, say: "The Home Assistant module is off." })
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
        const empty = yield* startTestModule(makePresenceModule(), { provide: [ha.provided] })
        assert.deepStrictEqual((yield* empty.checkHealth).map((i) => i.id), ["presence.no-people"])
        const linked = yield* startTestModule(makePresenceModule(), { settings: { people: links }, provide: [ha.provided] })
        assert.deepStrictEqual(yield* linked.checkHealth, [])
      }))

    it.effect("refuses settings that cannot be right: a bad entity, a name for a member, a person or member linked twice, a delay out of range", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([])
        for (const bad of [
          { people: [{ haPerson: "sam", member: "p-sam" }] },
          // A member is linked by id, never by name.
          { people: [{ haPerson: "person.sam", member: "Sam" }] },
          { people: [{ haPerson: "person.sam", member: "Sam Jones" }] },
          { people: [{ haPerson: "person.sam", member: "" }] },
          // The same Home Assistant person twice.
          { people: [{ haPerson: "person.sam", member: "p-sam" }, { haPerson: "person.sam", member: "p-robin" }] },
          // The same member twice, by id, and once by name and once by id.
          { people: [{ haPerson: "person.sam", member: "p-sam" }, { haPerson: "person.other", member: "p-sam" }] },
          { people: [{ haPerson: "person.sam", member: "Sam" }, { haPerson: "person.other", member: "p-sam" }] },
          { departureDelayMinutes: 61 },
          { departureDelayMinutes: -1 },
          { departureDelayMinutes: 2.5 }
        ]) {
          // The module is down, with the reason on its admin page, and offers nothing.
          const kit = yield* startTestModule(presenceModule, { settings: bad, provide: [ha.provided] })
          assert.strictEqual(kit.info()?.state, "error", JSON.stringify(bad))
          assert.deepStrictEqual(kit.toolNames(), [])
        }
      }))
  })

  describe("arrivals and departures", () => {
    const events = (kit: { readonly events: ReadonlyArray<{ readonly type: string; readonly data?: unknown }> }, type: string) => kit.events.filter((e) => e.type === type).map((e) => e.data)

    it.effect("a departure is announced after the delay, as the person, with when it happened; nothing is scheduled or stored", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        const at = yield* kit.now
        ha.move("person.sam", "not_home", at)
        yield* kit.advance(1)
        // The wait is in memory: no job holds who left or when.
        assert.deepStrictEqual(yield* kit.jobs, [])
        yield* kit.advance(2 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        yield* kit.advance(MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [{ person: "p-sam", at }])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
        assert.deepStrictEqual(yield* kit.jobs, [])
      }))

    it.effect("someone back within the delay neither left nor arrived", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(MINUTE)
        ha.move("person.sam", "home", yield* kit.now)
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
      }))

    it.effect("an arrival is announced at once, after a departure that was announced", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        // Robin was out already (the snapshot said so): coming home is an arrival, now.
        const at = yield* kit.now
        ha.move("person.robin", "home", at)
        yield* kit.advance(1)
        assert.deepStrictEqual(events(kit, "presence.arrived"), [{ person: "p-robin", at }])
        // Sam leaves and the departure is announced; the return is an arrival.
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(4 * MINUTE)
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
        yield* kit.advance(10 * MINUTE)
        // From unknown or unavailable to a place is not an arrival or a departure either, nor is a new entity.
        ha.move("person.alex", "unavailable", START)
        ha.move("person.alex", "home", START)
        ha.move("person.alex", "unavailable", START)
        ha.move("person.alex", "not_home", START)
        ha.send({ _tag: "changed", entity: person("person.alex", "home", START), previous: undefined })
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
        assert.deepStrictEqual(events(kit, "presence.left"), [])
      }))

    it.effect("people who are not linked, and linked to nobody, are announced nowhere", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa([...world(START), person("person.guest", "home", START), person("person.ghost", "home", START)])
        const kit = yield* startTestModule(presenceModule, { settings: { people: [...links, { haPerson: "person.ghost", member: "p-nobody" }] }, provide: [ha.provided] })
        ha.move("person.guest", "not_home", yield* kit.now)
        ha.move("person.ghost", "not_home", yield* kit.now)
        yield* kit.advance(10 * MINUTE)
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
        yield* slow.advance(29 * MINUTE)
        assert.deepStrictEqual(events(slow, "presence.left"), [])
        yield* slow.advance(MINUTE)
        assert.strictEqual(events(slow, "presence.left").length, 1)
      }))

    it.effect("a departure waiting across a disconnect is not announced, even if Home Assistant says away again", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(MINUTE)
        // The socket drops; the cache still says away, and is stale.
        ha.setConnection("reconnecting")
        yield* kit.advance(5 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        // It comes back, with Sam still away: a snapshot, which is not news either.
        ha.world.connection = "connected"
        ha.send({ _tag: "connection", connection: "connected" })
        ha.snapshot("reconnected")
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
      }))

    it.effect("a departure waiting across a snapshot is not announced, whatever the snapshots say", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(MINUTE)
        // A snapshot shows Sam home at 10:01, the next one away at 10:02.
        ha.world.entities.set("person.sam", person("person.sam", "home", yield* kit.now))
        ha.snapshot("reconnected")
        yield* kit.advance(MINUTE)
        ha.world.entities.set("person.sam", person("person.sam", "not_home", yield* kit.now))
        ha.snapshot("overflow")
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        // A snapshot that changes nothing calls the wait off too.
        ha.move("person.robin", "home", yield* kit.now)
        yield* kit.advance(1)
        ha.move("person.robin", "not_home", yield* kit.now)
        yield* kit.advance(1)
        ha.snapshot("overflow")
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
      }))

    it.effect("a departure waiting across unknown or unavailable is not announced", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        for (const noise of ["unavailable", "unknown"]) {
          ha.move("person.sam", "not_home", yield* kit.now)
          yield* kit.advance(MINUTE)
          ha.move("person.sam", noise, yield* kit.now)
          yield* kit.advance(MINUTE)
          ha.move("person.sam", "not_home", yield* kit.now)
          yield* kit.advance(10 * MINUTE)
          assert.deepStrictEqual(events(kit, "presence.left"), [])
          ha.move("person.sam", "home", yield* kit.now)
          yield* kit.advance(1)
        }
        // Coming home from a known away state with no departure waiting is an arrival, even one whose departure was
        // never announced (nothing may depend on an event, docs/MODULES.md §13); from unknown it is not.
        assert.strictEqual(events(kit, "presence.arrived").length, 2)
        ha.move("person.sam", "unknown", yield* kit.now)
        yield* kit.advance(1)
        ha.move("person.sam", "home", yield* kit.now)
        yield* kit.advance(1)
        assert.strictEqual(events(kit, "presence.arrived").length, 2)
        // And an entity that disappears from Home Assistant takes its wait with it.
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(1)
        ha.world.entities.delete("person.sam")
        ha.send({ _tag: "removed", entityId: "person.sam" })
        ha.world.entities.set("person.sam", person("person.sam", "not_home", yield* kit.now))
        ha.send({ _tag: "changed", entity: person("person.sam", "not_home", yield* kit.now), previous: undefined })
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
      }))

    it.effect("nothing waiting survives a restart of this module; the restart itself announces nothing", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(MINUTE)
        yield* kit.restart
        yield* kit.advance(1)
        // The new part subscribed again, and its first snapshot is only the baseline.
        assert.strictEqual(ha.subscriptions(), 1)
        yield* kit.advance(HOUR)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
        // After it, changes are followed as before.
        ha.move("person.sam", "home", yield* kit.now)
        yield* kit.advance(1)
        assert.deepStrictEqual(events(kit, "presence.arrived"), [{ person: "p-sam", at: (yield* kit.now) - 1 }])
      }))

    it.effect("a new provider: the module subscribes again, nothing waiting survives, and its changes are followed", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        assert.strictEqual(ha.stub.calls.changes?.length, 1)
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(MINUTE)
        // Home Assistant's module restarts: its stream ends, and the new one has a cache of its own (Sam still away).
        ha.replace([person("person.sam", "not_home", START), person("person.robin", "not_home", START - 26 * HOUR), person("person.alex", "home", START)])
        yield* kit.advance(5 * MINUTE)
        assert.strictEqual(ha.stub.calls.changes?.length, 2)
        assert.strictEqual(ha.subscriptions(), 1)
        // Neither the old wait nor the new snapshot (Alex home now) is news.
        yield* kit.advance(HOUR)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [])
        // The new stream's changes are followed.
        const at = yield* kit.now
        ha.move("person.alex", "not_home", at)
        ha.move("person.robin", "home", at)
        yield* kit.advance(4 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [{ person: "p-alex", at }])
        assert.deepStrictEqual(events(kit, "presence.arrived"), [{ person: "p-robin", at }])
      }))

    it.effect("a provider that is gone while a departure waits: nothing, and it is looked for again", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(MINUTE)
        // It stops: every call dies with ModuleStopped, and its stream ends.
        ha.stub.answer("changes", stopped)
        ha.stub.answer("connection", stopped)
        ha.stub.answer("entity", stopped)
        ha.endStreams()
        yield* kit.advance(10 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        const tries = ha.stub.calls.changes?.length ?? 0
        assert.isAbove(tries, 1)
      }))

    it.effect("a departure whose person is home again when it falls due (no change was seen) is not announced", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "not_home", yield* kit.now)
        yield* kit.advance(1)
        // The cache says home again without a change reaching the module (a missed one).
        ha.world.entities.set("person.sam", person("person.sam", "home", yield* kit.now))
        yield* kit.advance(5 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
        // And a person Home Assistant has stopped knowing is not announced as gone.
        ha.move("person.robin", "home", yield* kit.now)
        yield* kit.advance(1)
        ha.move("person.robin", "not_home", yield* kit.now)
        yield* kit.advance(1)
        ha.world.entities.delete("person.robin")
        yield* kit.advance(5 * MINUTE)
        assert.deepStrictEqual(events(kit, "presence.left"), [])
      }))

    it.effect("the events say who and when, and nothing about where", () =>
      Effect.gen(function*() {
        const ha = yield* makeHa(world(START))
        const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided] })
        ha.move("person.sam", "the-clinic", yield* kit.now)
        ha.move("person.alex", "home", yield* kit.now)
        yield* kit.advance(5 * MINUTE)
        const all = kit.events.filter((e) => e.type.startsWith("presence."))
        assert.strictEqual(all.length, 2)
        for (const e of all) assert.deepStrictEqual(Object.keys(e.data as object).sort(), ["at", "person"])
        assert.notInclude(JSON.stringify(all), "clinic")
      }))
  })
})
