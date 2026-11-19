// The phrase command and the list presentation of "who is home" (docs/PHRASES.md, docs/PRESENTING.md), through the real
// host: the phrase matcher, the gateway, the privacy rule and the Presenter of the test kit. Home Assistant is the same
// programmed stub as in presence.test.ts.
import { assert, describe, it, vi } from "@effect/vitest"
import { provide, startTestModule, stubService } from "@pva/core/testing"
import { type HaChange, type HaConnection, type HaEntity, HomeAssistant, type HomeAssistantService } from "@pva/module-contracts"
import { type Cause, Effect, Queue, Stream } from "effect"
import { PRESENT_OWNER, presentations } from "@pva/core"
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

/** What the Presenter stored for the live presentations: the fallback sentence is the only place `spoken` can be read. */
const storedSpoken = (kit: any): Effect.Effect<Array<string>> =>
  Effect.map(kit.store.forCore(PRESENT_OWNER).collection(presentations).list({ limit: 5 }).pipe(Effect.orDie) as Effect.Effect<any>, (rows: any) => rows.map((r: any) => r.value.spoken as string))

const LONG = (c: string, i: number) => `${c.repeat(55)}${i}` // 56 characters
const sixLong = Array.from({ length: 6 }, (_, i) => ({ id: `p-${i}`, name: LONG("abcdef"[i]!, i) }))
const startSix = (home: object = {}, connection: HaConnection = "reconnecting") =>
  Effect.gen(function*() {
    const ha = yield* makeHa(sixLong.map((m) => person(`person.n${m.id.slice(2)}`, "home", START - HOUR)), connection)
    const kit = yield* startTestModule(presenceModule, {
      settings: { people: sixLong.map((m) => ({ haPerson: `person.n${m.id.slice(2)}`, member: m.id })) },
      provide: [ha.provided],
      household: {
        ...home,
        people: sixLong,
        devices: [
          { id: PHONE, name: "Phone", room: "Bed", privacy: "private", defaultPerson: "p-0" },
          { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "private", defaultPerson: "p-0", capabilities: { v: 1, speaker: { media: ["speech"] } } }
        ]
      }
    } as never)
    return { ha, kit }
  })

describe("who is home: the list", () => {
  it.effect("shows what the answer said when it names one person, by the privacy rule of the device; several people are only spoken", () =>
    Effect.gen(function*() {
      const household = {
        people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }, { id: "p-alex", name: "Alex" }],
        devices: [
          { id: KITCHEN, name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
          { id: PHONE, name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
          { id: HALL, name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: "p-sam" },
          { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "private", defaultPerson: "p-robin", capabilities: { v: 1, speaker: { media: ["speech"] } } }
        ]
      }
      const { kit } = yield* start({ household })
      let turn = 10
      const ask = (device: string) => kit.phrases.say("who is home", { device, turnId: ++turn } as never)
      // The private phone, three people named: the answer says them, no list (a list has one owner).
      yield* ask(PHONE)
      yield* kit.present.settle
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Sam has been home since seven o'clock. Robin is out. Alex is out.")
      assert.deepStrictEqual(kit.present.shown(PHONE), [])
      // A reconnect of that page shows nothing either: no list exists for anyone to be shown.
      yield* kit.notify.disconnect(PHONE)
      yield* kit.notify.connect(PHONE)
      assert.deepStrictEqual(kit.present.shown(PHONE), [])
      assert.deepStrictEqual(kit.present.engine.live(), [])
      // Shared: the reduced form (Sam's line and the count of the others) is one person's list, personal to Sam.
      yield* ask(KITCHEN)
      yield* kit.present.settle
      const [kitchen] = listOf(kit, KITCHEN)
      assert.deepStrictEqual(kitchen?.items.map((i) => i.text), ["Sam: home since 07:00", "Where 2 other people are is not said here."])
      assert.strictEqual(kit.present.engine.live()[0]?.owner, "p-sam")
      assert.notInclude(JSON.stringify(kit.present.shown(KITCHEN)), "Robin")
      assert.deepStrictEqual(yield* storedSpoken(kit), ["Sam has been home since seven o'clock. Where 2 other people are is not said here."])
      // Public, with people it could name: nothing.
      yield* ask(HALL)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(HALL), [])
      assert.isFalse(kit.present.messages.some((m) => m.deviceId === HALL))
      // No screen: the same answer, nothing shown, the decision says why (a one-person answer, so a list was made).
      const lone = yield* start({ household })
      const solo = yield* startTestModule(presenceModule, { settings: { people: [links[1]!] }, provide: [lone.ha.provided], household } as never)
      yield* solo.phrases.say("who is home", { device: "office-speaker", turnId: 77 } as never)
      yield* solo.present.settle
      assert.strictEqual(solo.phrases.spoken.at(-1)?.text, "Robin is out.")
      assert.deepStrictEqual(solo.present.shown("office-speaker"), [])
      assert.isTrue(solo.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show))
      yield* solo.phrases.say("who is home", { device: PHONE, turnId: 78 } as never)
      yield* solo.present.settle
      assert.deepStrictEqual(listOf(solo, PHONE)[0]?.items.map((i) => i.text), ["Robin: out"])
    }))

  it.effect("a list the page could not show is still withdrawn by a change, an empty answer or a stop (the page gains a screen later)", () =>
    Effect.gen(function*() {
      const household = {
        people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }, { id: "p-alex", name: "Alex" }],
        devices: [{ id: "robins-tablet", name: "Tablet", room: "Hall", privacy: "private", defaultPerson: "p-robin", capabilities: { v: 1, speaker: { media: ["speech"] } } }]
      }
      const ha = yield* makeHa(world())
      const kit = yield* startTestModule(presenceModule, { settings: { people: [links[1]!] }, provide: [ha.provided], household } as never)
      yield* kit.phrases.say("who is home", { device: "robins-tablet", turnId: 5 } as never)
      yield* kit.present.settle
      assert.strictEqual(kit.present.engine.live().length, 1, "stored although nothing shows it")
      assert.deepStrictEqual(kit.present.shown("robins-tablet"), [])
      ha.move("person.robin", "home", START)
      yield* kit.advance(10)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.engine.live(), [], "the change withdrew it")
      // An empty answer withdraws one too.
      yield* kit.phrases.say("who is home", { device: "robins-tablet", turnId: 6 } as never)
      yield* kit.present.settle
      assert.strictEqual(kit.present.engine.live().length, 1)
      yield* kit.action("who_is_home", { person: "p-sam" }, { device: "robins-tablet", turnId: 7 })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.engine.live(), [])
    }))

  it.effect("a phrase answer fits a phrase's reply, whole items with the warning and the count kept, in both languages; a model call does not shrink", () =>
    Effect.gen(function*() {
      const en = yield* startSix()
      yield* en.kit.phrases.say("who is home", { device: PHONE })
      const spoken = en.kit.phrases.spoken.at(-1)!.text
      assert.isAtMost(spoken.length, 300)
      assert.notInclude(spoken, "…")
      assert.match(spoken, /and 4 more\./)
      assert.include(spoken, "I lost the connection to Home Assistant")
      assert.include(spoken, sixLong[0]!.name)
      assert.notInclude(spoken, sixLong[2]!.name)
      yield* en.kit.phrases.say("who is home", { device: "office-speaker" })
      assert.strictEqual(en.kit.phrases.spoken.at(-1)?.text, spoken)
      const nl = yield* startSix({ home: { HOME_LANGUAGE: "nl-NL" } })
      yield* nl.kit.phrases.say("wie is er thuis", { device: PHONE })
      const gesproken = nl.kit.phrases.spoken.at(-1)!.text
      assert.isAtMost(gesproken.length, 300)
      assert.notInclude(gesproken, "…")
      assert.match(gesproken, /en nog \d+\./)
      assert.include(gesproken, "Ik ben de verbinding met Home Assistant kwijt")
      // Outside a phrase turn the answer is as it always was: four names and "and 2 more", whatever the length.
      const direct = yield* en.kit.action("who_is_home", {}, { device: PHONE, turnId: 9 })
      assert.match((direct as { say: string }).say, /and 2 more\./)
      assert.include((direct as { say: string }).say, sixLong[3]!.name)
    }))

  it.effect("the list is the answer: the same people, the same overflow line, every note", () =>
    Effect.gen(function*() {
      // Three long names do not fit a phrase's reply: the answer names two or one; here one fits with the warning.
      const { kit } = yield* startSix()
      yield* kit.phrases.say("who is home", { device: PHONE })
      yield* kit.present.settle
      const said = kit.phrases.spoken.at(-1)!.text
      // The answer names two people, so it is not a one-owner list: nothing is shown.
      assert.deepStrictEqual(kit.present.shown(PHONE), [])
      // Make the names longer so that only one person fits the 300 characters: the list is that one answer.
      const wide = Array.from({ length: 6 }, (_, i) => ({ id: `p-${i}`, name: `${"abcdef"[i]!.repeat(99)}${i}` }))
      const ha = yield* makeHa(wide.map((m) => person(`person.n${m.id.slice(2)}`, "home", START - HOUR)), "reconnecting")
      const two = yield* startTestModule(presenceModule, {
        settings: { people: wide.map((m) => ({ haPerson: `person.n${m.id.slice(2)}`, member: m.id })) },
        provide: [ha.provided],
        household: { people: wide, devices: [{ id: PHONE, name: "Phone", room: "Bed", privacy: "private", defaultPerson: "p-0" }] }
      } as never)
      yield* two.phrases.say("who is home", { device: PHONE })
      yield* two.present.settle
      const answer = two.phrases.spoken.at(-1)!.text
      const [list] = listOf(two, PHONE)
      assert.deepStrictEqual(list?.items.map((i) => i.id), ["p-0", ":more", ":stale"])
      assert.deepStrictEqual(list?.items.slice(1).map((i) => i.text), ["and 5 more", "I lost the connection to Home Assistant, so this is what I heard last."])
      assert.include(answer, "and 5 more.")
      assert.include(answer, wide[0]!.name)
      assert.notInclude(answer, wide[1]!.name)
      assert.notInclude(JSON.stringify(list), wide[1]!.name)
      assert.isAtLeast(said.length, 1)
    }))

  it.effect("the same list in Dutch, personal to the person it names", () =>
    Effect.gen(function*() {
      const ha = yield* makeHa(world())
      const kit = yield* startTestModule(presenceModule, { settings: { people: [links[1]!] }, provide: [ha.provided], household: { home: { HOME_LANGUAGE: "nl-NL" } } } as never)
      yield* kit.phrases.say("wie is er thuis", { device: PHONE })
      yield* kit.present.settle
      const [list] = listOf(kit, PHONE)
      assert.strictEqual(list?.title, "Wie is thuis")
      assert.deepStrictEqual(list?.items.map((i) => i.text), ["Robin: weg"])
      assert.strictEqual(kit.present.engine.live()[0]?.owner, "p-robin")
    }))

  it.effect("a change of the data takes it down; the next answer replaces it; an empty answer withdraws it", () =>
    Effect.gen(function*() {
      const household = {
        people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin" }, { id: "p-alex", name: "Alex" }],
        devices: [
          { id: KITCHEN, name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
          { id: "robin-tablet", name: "Robin's tablet", room: "Bedroom", privacy: "shared", defaultPerson: "p-robin" }
        ]
      }
      const { kit, ha } = yield* start({ household })
      let turn = 20
      const ask = (device: string, params: Record<string, unknown> = {}) => kit.action("who_is_home", params, { device, turnId: ++turn })
      yield* ask(KITCHEN)
      yield* ask("robin-tablet")
      yield* kit.present.settle
      const first = kit.present.shown(KITCHEN)[0]!.id
      assert.strictEqual(kit.present.shown("robin-tablet").length, 1)
      // Someone arrives: what was shown is no longer true, so it all comes down.
      ha.move("person.robin", "home", START)
      yield* kit.advance(10)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
      assert.deepStrictEqual(kit.present.shown("robin-tablet"), [])
      // Asked again: a new show, and asked once more the one shown is replaced, never two.
      yield* ask(KITCHEN)
      yield* ask("robin-tablet")
      yield* kit.present.settle
      assert.notStrictEqual(kit.present.shown(KITCHEN)[0]!.id, first)
      yield* ask(KITCHEN)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(KITCHEN).length, 1)
      // An empty answer on the kitchen display (Robin is not Sam's to tell) withdraws its list, and only its list.
      assert.isTrue((yield* ask(KITCHEN, { person: "p-robin" })).ok)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
      assert.strictEqual(kit.present.shown("robin-tablet").length, 1)
    }))

  it.effect("a repeated phrase turn is shown once; a model's second call on the same turn is shown again", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ household: { devices: [{ id: KITCHEN, name: "Kitchen", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" }] } })
      const shows = () => kit.present.messages.filter((m) => m.deviceId === KITCHEN && m.message.type === "present.show").length
      const phrase = (turnId: number) => kit.action("who_is_home", {}, { device: KITCHEN, turnId, source: "phrase" })
      yield* phrase(31)
      yield* kit.present.settle
      assert.strictEqual(shows(), 1)
      assert.isTrue((yield* phrase(31)).ok)
      yield* kit.present.settle
      assert.strictEqual(shows(), 1)
      yield* phrase(32)
      yield* kit.present.settle
      assert.strictEqual(shows(), 2)
      // The model calls it twice in one turn on purpose: each call runs.
      yield* kit.action("who_is_home", {}, { device: KITCHEN, turnId: 33, source: "voice" })
      yield* kit.present.settle
      yield* kit.action("who_is_home", {}, { device: KITCHEN, turnId: 33, source: "voice" })
      yield* kit.present.settle
      assert.strictEqual(shows(), 4)
    }))

  it.effect("a restart of the module takes the list down, and the module shows again afterwards", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ household: { devices: [{ id: KITCHEN, name: "Kitchen", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" }] } })
      yield* kit.action("who_is_home", {}, { device: KITCHEN, turnId: 41, source: "phrase" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(KITCHEN).length, 1)
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
      yield* kit.action("who_is_home", {}, { device: KITCHEN, turnId: 41, source: "phrase" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(KITCHEN).length, 1)
    }))

  it.effect("a name with a lone surrogate is repaired before the list is checked: the list appears and no text holds an unpaired surrogate", () =>
    Effect.gen(function*() {
      const bad = `Zo${String.fromCharCode(0xd800)}e`
      const ha = yield* makeHa([person("person.zoe", "home", START - HOUR)])
      const kit = yield* startTestModule(presenceModule, {
        settings: { people: [{ haPerson: "person.zoe", member: "p-zoe" }] },
        provide: [ha.provided],
        household: { people: [{ id: "p-zoe", name: bad }], devices: [{ id: PHONE, name: "Phone", room: "Bed", privacy: "private", defaultPerson: "p-zoe" }] }
      } as never)
      yield* kit.phrases.say("who is home", { device: PHONE })
      yield* kit.present.settle
      const [list] = listOf(kit, PHONE)
      assert.strictEqual(list?.kind, "list", "the list appeared")
      const unpaired = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
      const texts = [list!.title, ...list!.items.map((i) => i.text), ...(yield* storedSpoken(kit))]
      assert.isTrue(texts.some((t) => t.includes("Zo\ufffde")), "repaired, not dropped")
      for (const t of texts) assert.isFalse(unpaired.test(t), t)
      // The check itself rejects what it is meant to reject.
      assert.isTrue(unpaired.test(bad))
    }))

  it.effect("a name of emoji at the limit is a valid list, cut at a code point", () =>
    Effect.gen(function*() {
      const name = "🙂".repeat(30)
      const ha = yield* makeHa([person("person.e", "home", START - HOUR)])
      const kit = yield* startTestModule(presenceModule, {
        settings: { people: [{ haPerson: "person.e", member: "p-e" }] },
        provide: [ha.provided],
        household: { people: [{ id: "p-e", name }], devices: [{ id: PHONE, name: "Phone", room: "Bed", privacy: "private", defaultPerson: "p-e" }] }
      } as never)
      yield* kit.phrases.say("who is home", { device: PHONE })
      yield* kit.present.settle
      const [list] = listOf(kit, PHONE)
      assert.strictEqual(list?.kind, "list")
      assert.isAtMost(list!.items[0]!.text.length, 80)
      assert.strictEqual(new TextDecoder().decode(new TextEncoder().encode(list!.items[0]!.text)), list!.items[0]!.text)
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
