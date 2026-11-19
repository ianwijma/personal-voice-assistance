// The phrase command and the list presentation of "who is home" (docs/PHRASES.md, docs/PRESENTING.md), through the real
// host: the phrase matcher, the gateway, the privacy rule and the Presenter of the test kit. Home Assistant is the same
// programmed stub as in presence.test.ts.
import { assert, describe, it, vi } from "@effect/vitest"
import { provide, startTestModule, stubService } from "@pva/core/testing"
import { type HaChange, type HaConnection, type HaEntity, HomeAssistant, type HomeAssistantService } from "@pva/module-contracts"
import { type Cause, Effect, Queue, Stream } from "effect"
import { cutText, presenceModule } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })

const HOUR = 3_600_000
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

const makeHa = (initial: ReadonlyArray<HaEntity>, connection: HaConnection = "connected") =>
  Effect.gen(function*() {
    const world = { connection, entities: new Map(initial.map((e) => [e.entityId, e])) }
    const subscriptions = new Set<Queue.Queue<HaChange, Cause.Done>>()
    const stub = stubService<HomeAssistantService>("home-assistant", {
      connection: () => world.connection,
      entities: () => [...world.entities.values()],
      entity: (id: string) => world.entities.get(id),
      areas: () => [],
      people: () => [...world.entities.values()].filter((e) => e.domain === "person").map((e) => ({ entityId: e.entityId, name: e.name, state: e.state, since: e.lastChanged })),
      changes: () =>
        Stream.unwrap(Effect.gen(function*() {
          const q = yield* Queue.unbounded<HaChange, Cause.Done>()
          Queue.offerUnsafe(q, { _tag: "snapshot", reason: "subscribed", connection: world.connection, entities: [...world.entities.values()], areas: [] })
          subscriptions.add(q)
          return Stream.fromQueue(q).pipe(Stream.ensuring(Effect.sync(() => void subscriptions.delete(q))))
        }))
    })
    const move = (entityId: string, state: string, at: number) => {
      const previous = world.entities.get(entityId)
      const entity = person(entityId, state, at)
      world.entities.set(entityId, entity)
      for (const q of subscriptions) Queue.offerUnsafe(q, { _tag: "changed", entity, previous })
    }
    return { stub, move, provided: provide("home-assistant", { services: [HomeAssistant.of(stub.service)] }) }
  })

const links = [
  { haPerson: "person.sam", member: "p-sam" },
  { haPerson: "person.robin", member: "p-robin" },
  { haPerson: "person.alex", member: "p-alex" }
]
const world = () => [person("person.sam", "home", START - 3 * HOUR), person("person.robin", "not_home", START - 26 * HOUR), person("person.alex", "work", START - HOUR)]

const KITCHEN = "kitchen-display" // shared, Sam's
const PHONE = "robins-phone" // private
const HALL = "hall-screen" // public

const start = (options: { readonly settings?: object; readonly household?: object } = {}) =>
  Effect.gen(function*() {
    const ha = yield* makeHa(world())
    const kit = yield* startTestModule(presenceModule, { settings: { people: links }, provide: [ha.provided], ...options } as never)
    return { ha, kit }
  })

const listOf = (kit: { readonly present: { readonly shown: (d?: string) => ReadonlyArray<{ readonly content: unknown; readonly id: string }> } }, device: string) =>
  kit.present.shown(device).map((p) => p.content as { kind: string; title: string; items: ReadonlyArray<{ id: string; text: string; done?: boolean }> })

describe("who is home: the phrase command", () => {
  it.effect("each phrase runs the action in both languages, with its own sentences; a near miss goes on to the assistant", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      for (const phrase of ["Who is home?", "who is at home", "Who's home", "is anyone home"]) {
        const said = yield* kit.phrases.say(phrase, { device: PHONE })
        assert.isTrue(said.taken, phrase)
      }
      assert.deepStrictEqual(kit.phrases.spoken.at(-1)?.text, "Sam has been home since seven o'clock. Robin is out. Alex is out.")
      for (const near of ["who is home please", "is Sam home", "who is out", "who is at the home", "home"]) {
        assert.deepStrictEqual(yield* kit.phrases.say(near, { device: PHONE }), { taken: false }, near)
      }
      const nl = yield* start({ household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      for (const phrase of ["Wie is er thuis?", "wie is thuis", "is er iemand thuis"]) {
        assert.isTrue((yield* nl.kit.phrases.say(phrase, { device: PHONE })).taken, phrase)
      }
      assert.strictEqual(nl.kit.phrases.spoken.at(-1)?.text, "Sam is sinds zeven uur thuis. Robin is weg. Alex is weg.")
      assert.deepStrictEqual(yield* nl.kit.phrases.say("wie is er thuis alsjeblieft", { device: PHONE }), { taken: false })
      // The other language's phrases are not this household's.
      assert.deepStrictEqual(yield* nl.kit.phrases.say("who is home", { device: PHONE }), { taken: false })
    }))

  it.effect("the action's refusals are reached through the phrase: privacy, nobody linked, Home Assistant off", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      yield* kit.phrases.say("who is home", { device: HALL })
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "I don't say where people are from this device.")
      yield* kit.phrases.say("who is home", { device: KITCHEN })
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Sam has been home since seven o'clock. Where 2 other people are is not said here.")
      const unlinked = yield* startTestModule(presenceModule, { provide: [(yield* makeHa(world())).provided] })
      yield* unlinked.phrases.say("who is home", { device: PHONE })
      assert.match(unlinked.phrases.spoken.at(-1)!.text, /^I don't know who is home yet/)
      const off = yield* startTestModule(presenceModule, { settings: { people: links } })
      yield* off.phrases.say("who is home", { device: PHONE })
      assert.strictEqual(off.phrases.spoken.at(-1)?.text, "The Home Assistant module is off.")
      assert.deepStrictEqual(off.present.shown(PHONE), [])
    }))
})

describe("who is home: the list", () => {
  it.effect("shows what the answer said, on the device that asked, by the privacy rule of that device", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({
        household: {
          people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }, { id: "p-alex", name: "Alex" }],
          devices: [
            { id: KITCHEN, name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
            { id: PHONE, name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
            { id: HALL, name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: "p-sam" },
            { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "private", defaultPerson: "p-robin", capabilities: { v: 1, speaker: { media: ["speech"] } } }
          ]
        }
      })
      let turn = 10
      const ask = (device: string) => kit.phrases.say("who is home", { device, turnId: ++turn } as never)
      // Private: everyone, with the times the tool gives.
      yield* ask(PHONE)
      yield* kit.present.settle
      const [phone] = listOf(kit, PHONE)
      assert.strictEqual(phone?.kind, "list")
      assert.deepStrictEqual(phone?.items, [
        { id: "p-sam", text: "Sam: home since 07:00", done: false },
        { id: "p-robin", text: "Robin: out", done: false },
        { id: "p-alex", text: "Alex: out", done: false }
      ])
      assert.strictEqual(kit.present.shown(PHONE)[0]?.lifetime, "transient")
      // Shared: Sam's only, and how many are not said here; nothing of the others.
      yield* ask(KITCHEN)
      yield* kit.present.settle
      const [kitchen] = listOf(kit, KITCHEN)
      assert.deepStrictEqual(kitchen?.items.map((i) => i.text), ["Sam: home since 07:00", "Where 2 other people are is not said here."])
      assert.notInclude(JSON.stringify(kit.present.shown(KITCHEN)), "Robin")
      // Public, with people it could name: nothing, not even a list that says nobody.
      yield* ask(HALL)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(HALL), [])
      assert.isFalse(kit.present.messages.some((m) => m.deviceId === HALL))
      // A device without a screen: the answer is the same, nothing is shown, and the decision says why.
      const before = kit.phrases.spoken.length
      yield* ask("office-speaker")
      yield* kit.present.settle
      assert.strictEqual(kit.phrases.spoken.length, before + 1)
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show))
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Sam has been home since seven o'clock. Robin is out. Alex is out.")
    }))

  it.effect("the same list in Dutch, personal to the first person it names", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* kit.phrases.say("wie is er thuis", { device: PHONE })
      yield* kit.present.settle
      const [list] = listOf(kit, PHONE)
      assert.strictEqual(list?.title, "Wie is thuis")
      assert.deepStrictEqual(list?.items.map((i) => i.text), ["Sam: thuis sinds 07:00", "Robin: weg", "Alex: weg"])
      assert.strictEqual(kit.present.engine.live()[0]?.owner, "p-sam")
    }))

  it.effect("a change of the data takes it down; the next answer replaces it; an empty answer withdraws it", () =>
    Effect.gen(function*() {
      const { kit, ha } = yield* start()
      let turn = 20
      const ask = (device: string, params: Record<string, unknown> = {}) => kit.action("who_is_home", params, { device, turnId: ++turn })
      yield* ask(PHONE)
      yield* kit.present.settle
      const first = kit.present.shown(PHONE)[0]!.id
      // Someone arrives: what was shown is no longer true, so it comes down (nothing is rewritten out of a turn).
      ha.move("person.robin", "home", START)
      yield* kit.advance(10)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(PHONE), [])
      // Asked again: the new answer, a new show.
      yield* ask(PHONE)
      yield* kit.present.settle
      const second = kit.present.shown(PHONE)
      assert.strictEqual(second.length, 1)
      assert.notStrictEqual(second[0]!.id, first)
      // Asked again with nothing changed: the one shown is replaced, never two.
      yield* ask(PHONE)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(PHONE).length, 1)
      // An empty answer on the shared kitchen display (Robin is not Sam's to tell) withdraws the list it showed.
      yield* ask(KITCHEN)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(KITCHEN).length, 1)
      assert.deepStrictEqual((yield* ask(KITCHEN, { person: "p-robin" })).ok && true, true)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
      // The other device is not touched by it.
      assert.strictEqual(kit.present.shown(PHONE).length, 1)
    }))

  it.effect("the same turn on the same device is shown once; two new turns show twice", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      const shows = () => kit.present.messages.filter((m) => m.deviceId === PHONE && m.message.type === "present.show").length
      yield* kit.action("who_is_home", {}, { device: PHONE, turnId: 31 })
      yield* kit.present.settle
      assert.strictEqual(shows(), 1)
      const replay = yield* kit.action("who_is_home", {}, { device: PHONE, turnId: 31 })
      yield* kit.present.settle
      assert.isTrue(replay.ok)
      assert.strictEqual(shows(), 1)
      yield* kit.action("who_is_home", {}, { device: PHONE, turnId: 32 })
      yield* kit.present.settle
      assert.strictEqual(shows(), 2)
    }))

  it.effect("a restart of the module takes the list down, and the module shows again afterwards", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      yield* kit.action("who_is_home", {}, { device: PHONE, turnId: 41 })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(PHONE).length, 1)
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(PHONE), [])
      // The turn id repeats after a restart: the record of it is gone with the part, so it shows again.
      yield* kit.action("who_is_home", {}, { device: PHONE, turnId: 41 })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(PHONE).length, 1)
    }))

  it.effect("many people with long names and emoji at the limit: a valid list, cut by whole items, with an honest 'and N more'", () =>
    Effect.gen(function*() {
      const members = Array.from({ length: 16 }, (_, i) => ({ id: `p-${i}`, name: `${"🙂".repeat(29)}${String(i).padStart(2, "0")}` }))
      const entities = members.map((m) => person(`person.n${m.id.slice(2)}`, "home", START - HOUR))
      const ha = yield* makeHa(entities)
      const kit = yield* startTestModule(presenceModule, {
        settings: { people: members.map((m) => ({ haPerson: `person.n${m.id.slice(2)}`, member: m.id })) },
        provide: [ha.provided],
        household: { people: members, devices: [{ id: PHONE, name: "Phone", room: "Bed", privacy: "private", defaultPerson: "p-0" }] }
      } as never)
      yield* kit.phrases.say("who is home", { device: PHONE })
      yield* kit.present.settle
      const shown = kit.present.shown(PHONE)
      assert.strictEqual(shown.length, 1, "the list was accepted as a valid presentation")
      const items = (shown[0]!.content as { items: ReadonlyArray<{ text: string }> }).items
      assert.strictEqual(items.length, 12)
      assert.strictEqual(items.at(-1)?.text, "and 5 more")
      for (const i of items) assert.isAtMost(i.text.length, 80)
      // No lone surrogate anywhere: every text survives a round trip through UTF-8.
      assert.strictEqual(new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(shown[0]))), JSON.stringify(shown[0]))
    }))
})

describe("cutText", () => {
  it("never splits a code point at the limit", () => {
    for (let max = 2; max < 8; max++) {
      const cut = cutText("🙂".repeat(10), max)
      assert.isAtMost(cut.length, max)
      assert.notMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    }
    assert.strictEqual(cutText("short", 10), "short")
  })
})
