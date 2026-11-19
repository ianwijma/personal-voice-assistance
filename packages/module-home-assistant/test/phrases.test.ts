// Phrase commands and the "what is on" list, through the real host (the test kit): each phrase in both languages (matched,
// not matched for a near miss, the action's own refusals reached through the phrase), and the transient list on the
// shared, private and public devices of a household, on a device without a screen, its update and its withdrawal.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule, type TestDevice } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { homeAssistantModule } from "../src/index.ts"
import { cutText } from "../src/whatsOn.ts"
import { configured, defaultAreas, defaultEntities, type FakeEntity, makeFakeHa } from "./fakeHa.ts"

// Most of these tests start a whole test household and poll the fake house more than once.
vi.setConfig({ testTimeout: 30_000 })

const SPEAKER = { v: 1 as const, speaker: { media: ["speech" as const] } }
const DEVICES: ReadonlyArray<TestDevice> = [
  { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-sam" },
  { id: "living-display", name: "Living display", room: "Living room", privacy: "shared" as const },
  { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-robin" },
  { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: null },
  { id: "garage-speaker", name: "Garage speaker", room: "Garage", capabilities: SPEAKER },
  { id: "kitchen-speaker", name: "Kitchen speaker", room: "Kitchen", capabilities: SPEAKER },
  { id: "node-roomless", name: "Node" }
]

/** A Dutch household names its rooms in Dutch: the owner's other names (the module page says so). */
const DUTCH_NAMES = "Living room: lounge, woonkamer\nKitchen: keuken\nBedroom: slaapkamer"

const start = (options: { readonly dutch?: boolean; readonly aliases?: string; readonly entities?: Record<string, FakeEntity>; readonly areas?: Record<string, string>; readonly devices?: ReadonlyArray<TestDevice>; readonly refreshMs?: number } = {}) =>
  Effect.gen(function*() {
    const ha = makeFakeHa({ ...(options.entities !== undefined ? { entities: options.entities } : {}), ...(options.areas !== undefined ? { areas: options.areas } : {}) })
    const kit = yield* startTestModule(homeAssistantModule({ net: ha.net, ...(options.refreshMs !== undefined ? { refreshMs: options.refreshMs } : {}) }), {
      ...configured({ aliases: options.aliases ?? (options.dutch === true ? DUTCH_NAMES : "Living room: lounge, woonkamer") }),
      household: { devices: options.devices ?? DEVICES, ...(options.dutch === true ? { home: { HOME_LANGUAGE: "nl-NL" } } : {}) }
    })
    ha.requests.length = 0
    return { ha, kit }
  })

/** Say `text` on a device and give the last line the device spoke. */
const saying = (kit: Effect.Success<ReturnType<typeof start>>["kit"], text: string, device: string) =>
  Effect.gen(function*() {
    const before = kit.phrases.spoken.length
    const outcome = yield* kit.phrases.say(text, { device })
    return { outcome, said: kit.phrases.spoken.slice(before).map((s) => s.text).join(" ") }
  })

const taken = (o: { readonly taken: boolean }) => o.taken

describe("home-assistant: phrase commands without a room (the device's own)", () => {
  it.effect("lights on and off, in English, in the room of the device that heard it", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      for (const [text, say, service] of [
        ["Lights on.", "I've turned on the lights in Kitchen.", "light.turn_on"],
        ["Turn on the lights", "I've turned on the lights in Kitchen.", "light.turn_on"],
        ["turn the lights on", "I've turned on the lights in Kitchen.", "light.turn_on"],
        ["Lights off", "I've turned off the lights in Kitchen.", "light.turn_off"],
        ["turn off the lights", "I've turned off the lights in Kitchen.", "light.turn_off"],
        ["Turn the lights off!", "I've turned off the lights in Kitchen.", "light.turn_off"]
      ] as const) {
        ha.requests.length = 0
        const r = yield* saying(kit, text, "kitchen-display")
        assert.isTrue(taken(r.outcome), text)
        assert.strictEqual(r.said, say, text)
        // The very call the action makes: the lights by id, in the device's room.
        assert.deepStrictEqual(ha.calls(), [{ service, body: { entity_id: ["light.kitchen"] } }], text)
      }
      // Another device, another room.
      const r = yield* saying(kit, "lights off", "living-display")
      assert.strictEqual(r.said, "I've turned off the lights in Living room.")
      assert.deepStrictEqual(ha.calls().at(-1), { service: "light.turn_off", body: { entity_id: ["light.ceiling", "light.reading_lamp"] } })
    }))

  it.effect("lights on and off, in Dutch", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ dutch: true })
      for (const [text, say, service] of [
        ["Licht aan", "Ik heb de lampen in Kitchen aangezet.", "light.turn_on"],
        ["lampen aan", "Ik heb de lampen in Kitchen aangezet.", "light.turn_on"],
        ["doe het licht aan", "Ik heb de lampen in Kitchen aangezet.", "light.turn_on"],
        ["zet het licht aan", "Ik heb de lampen in Kitchen aangezet.", "light.turn_on"],
        ["licht uit", "Ik heb de lampen in Kitchen uitgezet.", "light.turn_off"],
        ["Lampen uit.", "Ik heb de lampen in Kitchen uitgezet.", "light.turn_off"],
        ["doe het licht uit", "Ik heb de lampen in Kitchen uitgezet.", "light.turn_off"],
        ["zet het licht uit", "Ik heb de lampen in Kitchen uitgezet.", "light.turn_off"]
      ] as const) {
        ha.requests.length = 0
        const r = yield* saying(kit, text, "kitchen-display")
        assert.isTrue(taken(r.outcome), text)
        assert.strictEqual(r.said, say, text)
        assert.deepStrictEqual(ha.calls(), [{ service, body: { entity_id: ["light.kitchen"] } }], text)
      }
    }))

  it.effect("the blinds open and close, in both languages; a room without blinds says so through the phrase", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      const open = yield* saying(kit, "Open the blinds", "living-display")
      assert.strictEqual(open.said, "I'm opening the blinds in Living room.")
      assert.deepStrictEqual(ha.calls(), [{ service: "cover.open_cover", body: { entity_id: ["cover.living_room_blinds"] } }])
      const close = yield* saying(kit, "close the blinds.", "living-display")
      assert.strictEqual(close.said, "I'm closing the blinds in Living room.")
      assert.strictEqual(ha.calls().at(-1)!.service, "cover.close_cover")
      // The kitchen has no blinds: the action's own sentence, nothing sent.
      ha.requests.length = 0
      assert.strictEqual((yield* saying(kit, "open the blinds", "kitchen-display")).said, "There are no blinds in Kitchen that I may use.")
      assert.deepStrictEqual(ha.calls(), [])
      const nl = yield* start({ dutch: true })
      for (const [text, service] of [["doe de rolluiken open", "cover.open_cover"], ["Doe de zonwering open", "cover.open_cover"], ["doe de rolluiken dicht", "cover.close_cover"], ["doe de zonwering dicht", "cover.close_cover"]] as const) {
        nl.ha.requests.length = 0
        const r = yield* saying(nl.kit, text, "living-display")
        assert.isTrue(taken(r.outcome), text)
        assert.deepStrictEqual(nl.ha.calls(), [{ service, body: { entity_id: ["cover.living_room_blinds"] } }], text)
      }
    }))

  it.effect("the garage is no room of blinds: a garage door is never moved by a phrase, with or without a room's name", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.strictEqual((yield* saying(kit, "open the blinds", "garage-speaker")).said, "There are no blinds in Garage that I may use.")
      // Named, the garage is not among the rooms that have blinds: the module's own sentence for a name it does not know.
      assert.strictEqual((yield* saying(kit, "close the blinds in the garage", "living-display")).said, "I don't know the garage in Home Assistant.")
      assert.strictEqual((yield* saying(kit, "open the garage blinds", "living-display")).said, "I don't know garage in Home Assistant.")
      // There is no phrase for a lock, an alarm or a gate: those words are not taken, they go on to the assistant.
      for (const text of ["unlock the front door", "open the garage door", "arm the alarm", "open the gate"]) assert.deepStrictEqual(yield* kit.phrases.say(text, { device: "hall-screen" }), { taken: false }, text)
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("the action's refusals are reached through the phrase: no room, a room that is no area, no lights, an unavailable light", () =>
    Effect.gen(function*() {
      const entities = defaultEntities()
      entities["light.bedside"] = { name: "Bedside lamp", state: "unavailable", area: "bedroom" }
      const { ha, kit } = yield* start({ entities, devices: [...DEVICES, { id: "attic-speaker", name: "Attic speaker", room: "Attic", capabilities: SPEAKER }] })
      assert.strictEqual((yield* saying(kit, "lights on", "node-roomless")).said, "Which room? I don't know which room this device is in.")
      assert.strictEqual((yield* saying(kit, "lights on", "attic-speaker")).said, "I don't know a room called Attic in Home Assistant. Which room do you mean?")
      assert.strictEqual((yield* saying(kit, "lights on", "hall-screen")).said, "There are no lights in Hall that I may use.")
      assert.strictEqual((yield* saying(kit, "lights off", "robins-phone")).said, "Bedside lamp is unavailable in Home Assistant, so I haven't changed anything.")
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("near misses are not taken: nothing fuzzy, no fillers", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      for (const text of ["lights on please", "turn on the light", "the lights on", "switch the lights on", "lights", "turn on lights", "licht aan graag", "open the blind", "close blinds"]) {
        assert.deepStrictEqual(yield* kit.phrases.say(text, { device: "kitchen-display" }), { taken: false }, text)
      }
      assert.deepStrictEqual(ha.calls(), [])
    }))
})

describe("home-assistant: phrase commands with a room's name", () => {
  it.effect("a room named in the phrase, in English: by its name, an owner's other name, an article or none", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      for (const [text, say, ids, service] of [
        ["Lights on in the living room", "I've turned on the lights in Living room.", ["light.ceiling", "light.reading_lamp"], "light.turn_on"],
        ["lights on in living room", "I've turned on the lights in Living room.", ["light.ceiling", "light.reading_lamp"], "light.turn_on"],
        ["turn on the lights in the kitchen", "I've turned on the lights in Kitchen.", ["light.kitchen"], "light.turn_on"],
        ["Turn the lights on in the lounge", "I've turned on the lights in Living room.", ["light.ceiling", "light.reading_lamp"], "light.turn_on"],
        ["turn on the kitchen lights", "I've turned on the lights in Kitchen.", ["light.kitchen"], "light.turn_on"],
        ["turn the bedroom lights on", "I've turned on the lights in Bedroom.", ["light.bedside"], "light.turn_on"],
        ["lights off in the kitchen", "I've turned off the lights in Kitchen.", ["light.kitchen"], "light.turn_off"],
        ["turn off the lights in the bedroom", "I've turned off the lights in Bedroom.", ["light.bedside"], "light.turn_off"],
        ["turn the lights off in the living room", "I've turned off the lights in Living room.", ["light.ceiling", "light.reading_lamp"], "light.turn_off"],
        ["turn off the living room lights", "I've turned off the lights in Living room.", ["light.ceiling", "light.reading_lamp"], "light.turn_off"],
        ["turn the kitchen lights off", "I've turned off the lights in Kitchen.", ["light.kitchen"], "light.turn_off"]
      ] as const) {
        ha.requests.length = 0
        // Said on a device in another room: the named room wins over the device's own.
        const r = yield* saying(kit, text, "hall-screen")
        assert.isTrue(taken(r.outcome), text)
        assert.strictEqual(r.said, say, text)
        assert.deepStrictEqual(ha.calls(), [{ service, body: { entity_id: ids } }], text)
      }
    }))

  it.effect("a room named in the phrase, in Dutch", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ dutch: true })
      for (const [text, say, ids, service] of [
        ["Licht aan in de woonkamer", "Ik heb de lampen in Living room aangezet.", ["light.ceiling", "light.reading_lamp"], "light.turn_on"],
        ["doe het licht aan in de keuken", "Ik heb de lampen in Kitchen aangezet.", ["light.kitchen"], "light.turn_on"],
        ["zet het licht aan in de slaapkamer", "Ik heb de lampen in Bedroom aangezet.", ["light.bedside"], "light.turn_on"],
        ["licht uit in de keuken", "Ik heb de lampen in Kitchen uitgezet.", ["light.kitchen"], "light.turn_off"],
        ["doe het licht uit in de woonkamer", "Ik heb de lampen in Living room uitgezet.", ["light.ceiling", "light.reading_lamp"], "light.turn_off"],
        ["zet het licht uit in de woonkamer", "Ik heb de lampen in Living room uitgezet.", ["light.ceiling", "light.reading_lamp"], "light.turn_off"]
      ] as const) {
        ha.requests.length = 0
        const r = yield* saying(kit, text, "hall-screen")
        assert.isTrue(taken(r.outcome), text)
        assert.strictEqual(r.said, say, text)
        assert.deepStrictEqual(ha.calls(), [{ service, body: { entity_id: ids } }], text)
      }
      for (const [text, service] of [["doe de rolluiken open in de woonkamer", "cover.open_cover"], ["doe de zonwering dicht in de woonkamer", "cover.close_cover"]] as const) {
        ha.requests.length = 0
        assert.isTrue(taken(yield* kit.phrases.say(text, { device: "hall-screen" })), text)
        assert.deepStrictEqual(ha.calls(), [{ service, body: { entity_id: ["cover.living_room_blinds"] } }], text)
      }
    }))

  it.effect("blinds with a room's name, in English", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      for (const [text, service, ids] of [
        ["Open the blinds in the living room", "cover.open_cover", ["cover.living_room_blinds"]],
        ["open the bedroom blinds", "cover.open_cover", ["cover.bedroom_blinds"]],
        ["close the blinds in the bedroom", "cover.close_cover", ["cover.bedroom_blinds"]],
        ["close the living room blinds", "cover.close_cover", ["cover.living_room_blinds"]]
      ] as const) {
        ha.requests.length = 0
        assert.isTrue(taken(yield* kit.phrases.say(text, { device: "hall-screen" })), text)
        assert.deepStrictEqual(ha.calls(), [{ service, body: { entity_id: ids } }], text)
      }
    }))

  it.effect("no match or more than one: the module's own sentences, and nothing is sent", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ areas: { alpha: "Shared", beta: "Shared", gamma: "Garden" }, entities: { "light.a": { name: "Alpha light", state: "off", area: "alpha" }, "light.b": { name: "Beta light", state: "off", area: "beta" }, "light.g": { name: "Garden light", state: "off", area: "gamma" } } })
      const ask = "Shared is more than one thing in Home Assistant: Shared (alpha) and Shared (beta). Which one do you mean?"
      assert.strictEqual((yield* saying(kit, "lights on in the shared", "kitchen-display")).said, ask)
      assert.strictEqual((yield* saying(kit, "turn the shared lights off", "kitchen-display")).said, ask)
      // No match: the existing sentence, without a repeat of more than the name that was said.
      assert.strictEqual((yield* saying(kit, "lights on in the attic", "kitchen-display")).said, "I don't know the attic in Home Assistant.")
      assert.deepStrictEqual(ha.calls(), [])
      // An id always works.
      assert.strictEqual((yield* saying(kit, "lights on in area beta", "kitchen-display")).said.length > 0, true)
    }))
})

/** Every example of the page (docs/modules/home-assistant.md, "Phrases"): each works exactly as written. */
const PAGE_EXAMPLES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["en", ["lights on", "lights off", "turn on the lights", "turn the lights off", "open the blinds", "close the blinds", "lights on in the kitchen", "turn off the living room lights", "close the blinds in the bedroom", "what is on in the living room", "what's on in the kitchen", "what is on here"]],
  ["nl", ["licht aan", "licht uit", "doe het licht aan", "doe de rolluiken open", "doe de zonwering dicht", "licht aan in de keuken", "doe het licht uit in de woonkamer", "doe de rolluiken open in de woonkamer", "wat staat er aan in de woonkamer", "wat staat er hier aan"]]
]

describe("home-assistant: the page's examples", () => {
  for (const [language, examples] of PAGE_EXAMPLES) {
    it.effect(`every example works as written (${language})`, () =>
      Effect.gen(function*() {
        const { kit } = yield* start({ dutch: language === "nl" })
        for (const text of examples) {
          const r = yield* kit.phrases.say(text, { device: "living-display" })
          assert.isTrue(r.taken, text)
          assert.strictEqual(r.by, "command", text)
        }
      }))
  }
})

const lightsIn = (area: string, n: number, state = "on", namer = (i: number) => `Spot ${i}`): Record<string, FakeEntity> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`light.s${String(i).padStart(2, "0")}`, { name: namer(i), state, area }]))

describe("home-assistant: what is on in a room", () => {
  it.effect("says it and shows it as a transient list on the shared, private and public devices; a device without a screen only hears it", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      // The device in the living room asks about its own room (a ceiling light is on there).
      const said = yield* saying(kit, "what is on here", "living-display")
      assert.strictEqual(said.said, "On in Living room: Ceiling.")
      yield* kit.present.settle
      const [list] = kit.present.shown("living-display")
      assert.strictEqual(list?.lifetime, "transient")
      assert.deepStrictEqual(list?.content.kind === "list" ? [list.content.title, list.content.style, list.content.items.map((i) => i.text)] : [], ["On in Living room", "bullets", ["Ceiling"]])
            // The same question about a named room from each kind of device: the household's answer is the same everywhere it is
      // spoken, and so it is shown on all of them (shared, private and public), never on a device with no screen.
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        const r = yield* saying(kit, "what is on in the living room", device)
        assert.strictEqual(r.said, "On in Living room: Ceiling.", device)
        yield* kit.present.settle
        assert.deepStrictEqual(kit.present.shown(device).map((p) => p.content.kind), ["list"], device)
        assert.isTrue(kit.present.decisions.some((d) => d.deviceId === device && d.decision.show), device)
      }
      const speaker = yield* saying(kit, "what's on in the living room", "kitchen-speaker")
      assert.strictEqual(speaker.said, "On in Living room: Ceiling.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-speaker"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "kitchen-speaker" && !d.decision.show))
    }))

  it.effect("in Dutch, with the spoken fallback as the answer", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ dutch: true })
      const said = yield* saying(kit, "wat staat er aan in de woonkamer", "living-display")
      assert.strictEqual(said.said, "Aan in Living room: Ceiling.")
      yield* kit.present.settle
      const [list] = kit.present.shown("living-display")
      assert.strictEqual(list?.content.kind === "list" ? list.content.title : "", "Aan in Living room")
    }))

  it.effect("nothing on: it says so and shows no list, and a list shown before comes down", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      yield* saying(kit, "what is on in the living room", "kitchen-display")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      ha.entities["light.ceiling"]!.state = "off"
      const none = yield* saying(kit, "what is on in the living room", "kitchen-display")
      assert.strictEqual(none.said, "Nothing is on in Living room.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("the list follows the house: an update when something is switched on or off, down when nothing is on, down after a command", () =>
    Effect.gen(function*() {
      // The house is read every ten seconds here (a minute in production, longer than a transient list lives).
      const { ha, kit } = yield* start({ refreshMs: 10_000 })
      yield* saying(kit, "what is on in the living room", "kitchen-display")
      yield* kit.present.settle
      const [first] = kit.present.shown("kitchen-display")
      // A lamp is switched on in Home Assistant: the next read shows it, in the same place.
      ha.entities["light.reading_lamp"]!.state = "on"
      yield* kit.advance(10_000)
      const [again] = kit.present.shown("kitchen-display")
      assert.strictEqual(again?.id, first!.id)
      assert.deepStrictEqual(again?.content.kind === "list" ? again.content.items.map((i) => i.text) : [], ["Ceiling", "Reading lamp"])
      // Nothing is on any more: the list comes down.
      ha.entities["light.reading_lamp"]!.state = "off"
      ha.entities["light.ceiling"]!.state = "off"
      yield* kit.advance(10_000)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // A command changed something: the list that was shown no longer applies.
      ha.entities["light.ceiling"]!.state = "on"
      yield* saying(kit, "what is on in the living room", "kitchen-display")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* saying(kit, "lights off in the kitchen", "kitchen-display")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a failed read takes the list down (what is on is no longer known); a list ends by itself and with a restart; each device has its own", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ refreshMs: 10_000 })
      yield* saying(kit, "what is on in the living room", "kitchen-display")
      yield* saying(kit, "what is on in the living room", "living-display")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      assert.strictEqual(kit.present.shown("living-display").length, 1)
      ha.down()
      yield* kit.advance(10_000)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(kit.present.shown("living-display"), [])
      ha.ok()
      yield* saying(kit, "what is on in the living room", "kitchen-display")
      yield* kit.present.settle
      // A transient list ends after its half minute...
      yield* kit.advance(31_000)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // ...and with the part that made it: after a restart nothing is left, and the next question shows a new one.
      yield* saying(kit, "what is on in the living room", "kitchen-display")
      yield* kit.present.settle
      yield* kit.stop
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("an unknown room, a device without a room and a room that is no area: the module's sentences, nothing shown", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ devices: [...DEVICES, { id: "attic-display", name: "Attic display", room: "Attic" }] })
      assert.strictEqual((yield* saying(kit, "what is on in the attic", "kitchen-display")).said, "I don't know a room called the attic in Home Assistant. Which room do you mean?")
      assert.strictEqual((yield* saying(kit, "what is on here", "node-roomless")).said, "Which room? I don't know which room this device is in.")
      assert.strictEqual((yield* saying(kit, "what is on here", "attic-display")).said, "I don't know a room called Attic in Home Assistant. Which room do you mean?")
      assert.strictEqual((yield* saying(kit, "what is on here", "hall-screen")).said, "There are no lights or switches in Hall that I may use.")
      yield* kit.present.settle
      for (const d of DEVICES) assert.deepStrictEqual(kit.present.shown(d.id), [], d.id)
      // A bare "what is on" is not taken: it is the television as often as the house.
      assert.deepStrictEqual(yield* kit.phrases.say("what is on", { device: "kitchen-display" }), { taken: false })
    }))

  it.effect("only what is known: an unavailable device is counted, never called off", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { ...defaultEntities(), "light.window": { name: "Window lamp", state: "unavailable", area: "living_room" }, "light.corner": { name: "Corner lamp", state: "unknown", area: "living_room" } }
      const { kit } = yield* start({ entities })
      const said = yield* saying(kit, "what is on in the living room", "kitchen-display")
      assert.strictEqual(said.said, "On in Living room: Ceiling. 2 devices could not be read.")
      yield* kit.present.settle
      const [list] = kit.present.shown("kitchen-display")
      assert.deepStrictEqual(list?.content.kind === "list" ? list.content.items.map((i) => i.text) : [], ["Ceiling", "2 devices could not be read."])
      // Nothing on, and some could not be read: not "nothing is on".
      entities["light.ceiling"]!.state = "off"
      const none = yield* saying(kit, "what is on in the living room", "kitchen-display")
      assert.strictEqual(none.said, "Nothing I could read is on in Living room. 2 devices could not be read.")
    }))

  it.effect("a long list is cut by whole items: twelve rows at most, and an honest 'and N more'", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ entities: lightsIn("kitchen", 15) })
      const said = yield* saying(kit, "what is on here", "kitchen-display")
      assert.strictEqual(said.said, "On in Kitchen: Spot 0, Spot 1, Spot 10 and 12 more.")
      yield* kit.present.settle
      const [list] = kit.present.shown("kitchen-display")
      const items = list?.content.kind === "list" ? list.content.items.map((i) => i.text) : []
      assert.strictEqual(items.length, 12)
      assert.strictEqual(items.at(-1), "and 4 more")
      assert.strictEqual(items[0], "Spot 0")
    }))

  it.effect("text from outside: control and bidirectional characters, an emoji at the cut, a lone surrogate: still a valid list", () =>
    Effect.gen(function*() {
      const emoji = String.fromCodePoint(0x1f600)
      const nasty = (i: number) => (i === 0 ? `Lamp${String.fromCharCode(0x0b)}one ${String.fromCodePoint(0x202e)}rtl ${String.fromCodePoint(0x2028)}x` : `${"a".repeat(78)}${emoji}${emoji}`)
      const { kit } = yield* start({ entities: lightsIn("kitchen", 2, "on", nasty) })
      const said = yield* saying(kit, "what is on here", "kitchen-display")
      yield* kit.present.settle
      const [list] = kit.present.shown("kitchen-display")
      assert.strictEqual(list?.content.kind, "list", said.said)
      const items = list?.content.kind === "list" ? list.content.items.map((i) => i.text) : []
      // Name order; Home Assistant's own cut left half an emoji at its end: dropped, never shown as a broken character.
      assert.deepStrictEqual(items, [`${"a".repeat(78)}${emoji}`, "Lamp one rtl x"])
      // The one cut function, at the boundary of the unit a person sees.
      assert.strictEqual(cutText(`${emoji}${emoji}${emoji}`, 2), `${emoji}${emoji}`)
      assert.strictEqual(cutText(`ab${String.fromCharCode(0xd83d)}cd`, 10), "abcd")
      assert.strictEqual(cutText("  a   b \n c ", 10), "a b c")
    }))

  it.effect("a house read only in part says there may be more, in the sentence and in the list", () =>
    Effect.gen(function*() {
      // 2,001 lights: the kind is incomplete (HOUSE_LIMITS.supported is 2,000).
      const entities = { ...lightsIn("kitchen", 1), ...Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`light.z${i}`, { name: `Zed ${i}`, state: "off", area: "garage" }])) } as Record<string, FakeEntity>
      const { kit } = yield* start({ entities })
      const said = yield* saying(kit, "what is on here", "kitchen-display")
      assert.strictEqual(said.said, "On in Kitchen: Spot 0. Your house has more than I can read, so there may be more.")
      yield* kit.present.settle
      const [list] = kit.present.shown("kitchen-display")
      assert.deepStrictEqual(list?.content.kind === "list" ? list.content.items.map((i) => i.text) : [], ["Spot 0", "Your house has more than I can read, so there may be more."])
    }), 60_000)

  it.effect("long names and a long room name: the sentence is whole and within its bound, the title within its own", () =>
    Effect.gen(function*() {
      const roomName = "Atelier".repeat(5)
      const entities = lightsIn("long", 6, "on", (i) => `${i} ${"long lamp name ".repeat(6)}`.slice(0, 80))
      const { kit } = yield* start({ areas: { ...defaultAreas(), long: roomName }, entities })
      const said = yield* saying(kit, `what is on in ${roomName}`, "kitchen-display")
      assert.isAtMost(said.said.length, 300)
      assert.isTrue(said.said.endsWith("."), said.said)
      yield* kit.present.settle
      const [list] = kit.present.shown("kitchen-display")
      assert.strictEqual(list?.content.kind, "list")
      assert.isAtMost(list?.content.kind === "list" ? Array.from(list.content.title).length : 99, 60)
    }))
})
