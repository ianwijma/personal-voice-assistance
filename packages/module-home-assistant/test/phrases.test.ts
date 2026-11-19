// Phrase commands and the "what is on" list, through the real host (the test kit): each phrase in both languages (matched,
// not matched for a near miss, the action's own refusals reached through the phrase), and the transient list on the
// shared, private and public devices of a household, on a device without a screen, its update and its withdrawal.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule, type TestDevice } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { homeAssistantModule } from "../src/index.ts"
import { cutText, listing, roomNow } from "../src/whatsOn.ts"
import { configured, defaultEntities, type FakeEntity, makeFakeHa, TOKEN } from "./fakeHa.ts"

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


describe("home-assistant: phrase commands, said without a room (the asking device's own)", () => {
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
        assert.deepStrictEqual(ha.calls(), [{ service, body: { entity_id: ["light.kitchen"] } }], text)
      }
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
      assert.strictEqual((yield* saying(kit, "Open the blinds", "living-display")).said, "I'm opening the blinds in Living room.")
      assert.deepStrictEqual(ha.calls(), [{ service: "cover.open_cover", body: { entity_id: ["cover.living_room_blinds"] } }])
      assert.strictEqual((yield* saying(kit, "close the blinds.", "living-display")).said, "I'm closing the blinds in Living room.")
      ha.requests.length = 0
      assert.strictEqual((yield* saying(kit, "open the blinds", "kitchen-display")).said, "There are no blinds in Kitchen that I may use.")
      assert.deepStrictEqual(ha.calls(), [])
      const nl = yield* start({ dutch: true })
      for (const [text, service] of [["doe de rolluiken open", "cover.open_cover"], ["Doe de zonwering open", "cover.open_cover"], ["doe de rolluiken dicht", "cover.close_cover"], ["doe de zonwering dicht", "cover.close_cover"]] as const) {
        nl.ha.requests.length = 0
        assert.isTrue(taken((yield* saying(nl.kit, text, "living-display")).outcome), text)
        assert.deepStrictEqual(nl.ha.calls(), [{ service, body: { entity_id: ["cover.living_room_blinds"] } }], text)
      }
    }))

  it.effect("the garage is no room of blinds, and nothing of the security kind has a phrase", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.strictEqual((yield* saying(kit, "open the blinds", "garage-speaker")).said, "There are no blinds in Garage that I may use.")
      for (const text of ["unlock the front door", "open the garage door", "arm the alarm", "open the gate"]) assert.deepStrictEqual(yield* kit.phrases.say(text, { device: "hall-screen" }), { taken: false }, text)
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("the action's refusals are reached through the phrase: no room, a room that is no area, no lights, an unavailable light", () =>
    Effect.gen(function*() {
      const entities = defaultEntities()
      entities["light.bedside"] = { name: "Bedside lamp", state: "unavailable", area: "bedroom" }
      const { ha, kit } = yield* start({ entities, devices: [...DEVICES, { id: "attic-speaker", name: "Attic speaker", room: "Attic", capabilities: SPEAKER }] })
      assert.strictEqual((yield* saying(kit, "lights on", "node-roomless")).said, "Which room? I don't know which room this device is in.")
      // A room the module does not know: it says "that room", never the words it did not recognise.
      assert.strictEqual((yield* saying(kit, "lights on", "attic-speaker")).said, "I don't know that room in Home Assistant. Which room do you mean?")
      assert.strictEqual((yield* saying(kit, "lights on", "hall-screen")).said, "There are no lights in Hall that I may use.")
      assert.strictEqual((yield* saying(kit, "lights off", "robins-phone")).said, "Bedside lamp is unavailable in Home Assistant, so I haven't changed anything.")
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("a refusal never repeats text from outside: a room named like the token, two rooms of one name", () =>
    Effect.gen(function*() {
      const secretRoom = `Room ${TOKEN}`
      const { ha, kit } = yield* start({
        areas: { alpha: "Shared", beta: "Shared" },
        entities: { "light.a": { name: "Alpha light", state: "off", area: "alpha" }, "light.b": { name: "Beta light", state: "off", area: "beta" } },
        devices: [...DEVICES, { id: "secret-speaker", name: "Secret speaker", room: secretRoom, capabilities: SPEAKER }, { id: "shared-speaker", name: "Shared speaker", room: "Shared", capabilities: SPEAKER }]
      })
      for (const [device, said] of [
        ["secret-speaker", "I don't know that room in Home Assistant. Which room do you mean?"],
        ["shared-speaker", "That room is more than one thing in Home Assistant. Which one do you mean?"]
      ] as const) {
        for (const text of ["lights on", "lights off", "open the blinds", "what is on here"]) {
          const r = yield* saying(kit, text, device)
          assert.notInclude(r.said, TOKEN)
          assert.notInclude(r.said, "Shared")
          if (text !== "open the blinds") assert.strictEqual(r.said, said, `${device} ${text}`)
        }
      }
      assert.deepStrictEqual(ha.calls(), [])
      // Said in Dutch: the same.
      const nl = yield* start({ dutch: true, devices: [...DEVICES, { id: "attic-speaker", name: "Attic speaker", room: "Zolder", capabilities: SPEAKER }] })
      assert.strictEqual((yield* saying(nl.kit, "licht aan", "attic-speaker")).said, "Ik ken die kamer niet in Home Assistant. Welke kamer bedoel je?")
    }))

  it.effect("near misses are not taken: nothing fuzzy, no fillers; and a room's name is not part of any phrase", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      for (const text of ["lights on please", "turn on the light", "the lights on", "switch the lights on", "lights", "turn on lights", "licht aan graag", "open the blind", "close blinds",
        "lights on in the kitchen", "turn on the kitchen lights", "open the blinds in the living room", "close the living room blinds", "licht aan in de keuken", "doe de rolluiken open in de woonkamer",
        "what is on in the kitchen", "what's on in the kitchen", "wat staat er aan in de keuken", "what is on"]) {
        assert.deepStrictEqual(yield* kit.phrases.say(text, { device: "kitchen-display" }), { taken: false }, text)
      }
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("the module offers exactly its actions: no companion with a room slot", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      const phrased = [...new Set((yield* kit.phrases.commandsFor()).phrases.flatMap((c) => (c.owner.kind === "action" ? [c.owner.action.id] : [])))].sort()
      assert.deepStrictEqual(phrased, ["covers_close", "covers_open", "lights_off", "lights_on", "whats_on"].map((a) => `home-assistant.${a}`))
    }))
})

describe("home-assistant: a phrase heard once acts once", () => {
  const phrase = (turnId: number) => ({ source: "phrase" as const, turnId, device: "kitchen-display" })
  it.effect("the same phrase invocation twice, in a row or at once, sends one call and answers the same twice", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      const a = yield* kit.action("lights_on", { target: "kitchen" }, phrase(910))
      const b = yield* kit.action("lights_on", { target: "kitchen" }, phrase(910))
      assert.deepStrictEqual(a, b)
      assert.strictEqual(ha.calls().length, 1)
      // At once: the second waits for the first and shares its outcome.
      ha.requests.length = 0
      const both = yield* Effect.all([kit.action("covers_open", { target: "living room" }, phrase(911)), kit.action("covers_open", { target: "living room" }, phrase(911))], { concurrency: "unbounded" })
      assert.deepStrictEqual(both[0], both[1])
      assert.strictEqual(ha.calls().length, 1)
      // Another turn, another device, another action or another input acts again.
      yield* kit.action("lights_on", { target: "kitchen" }, phrase(912))
      yield* kit.action("lights_on", { target: "kitchen" }, { ...phrase(912), device: "living-display" })
      yield* kit.action("lights_off", { target: "kitchen" }, phrase(912))
      yield* kit.action("lights_on", { target: "bedroom" }, phrase(912))
      yield* kit.action("lights_on", { target: "kitchen" }, { ...phrase(912), conversationId: "conversation-2" })
      assert.strictEqual(ha.calls().length, 5)
    }))

  it.effect("a refusal is replayed too, and acts on nothing; a failure is shared", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      const a = yield* kit.action("lights_on", {}, { ...phrase(920), device: "hall-screen" })
      const b = yield* kit.action("lights_on", {}, { ...phrase(920), device: "hall-screen" })
      assert.deepStrictEqual(a, b)
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("every other kind of turn runs every time: the model calling the generated tool twice in one turn sends both", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      const voice = { source: "voice" as const, turnId: 930, device: "kitchen-display" }
      yield* kit.tool("home-assistant_lights_on", { target: "kitchen" }, voice)
      yield* kit.tool("home-assistant_lights_on", { target: "kitchen" }, voice)
      assert.strictEqual(ha.calls().length, 2)
      yield* kit.action("lights_off", { target: "kitchen" }, voice)
      yield* kit.action("lights_off", { target: "kitchen" }, voice)
      yield* kit.action("lights_off", { target: "kitchen" }, { ...voice, source: "text" })
      yield* kit.action("lights_off", { target: "kitchen" }, { ...voice, source: "text" })
      assert.strictEqual(ha.calls().length, 6)
    }))

  it.effect("heard through the real phrase path twice (two utterances) acts twice: the record is per invocation", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      yield* saying(kit, "lights on", "kitchen-display")
      yield* saying(kit, "lights on", "kitchen-display")
      assert.strictEqual(ha.calls().length, 2)
    }))
})

const PAGE_EXAMPLES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["en", ["lights on", "lights off", "turn on the lights", "turn the lights off", "open the blinds", "close the blinds", "what is on here"]],
  ["nl", ["licht aan", "licht uit", "doe het licht aan", "doe de rolluiken open", "doe de zonwering dicht", "wat staat er hier aan"]]
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
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`light.s${String(i).padStart(4, "0")}`, { name: namer(i), state, area }]))

const listOfScreen = (kit: Effect.Success<ReturnType<typeof start>>["kit"], device: string): { readonly title: string; readonly rows: ReadonlyArray<string> } | undefined => {
  const [p] = kit.present.shown(device)
  return p?.content.kind === "list" ? { title: p.content.title, rows: p.content.items.map((i) => i.text) } : undefined
}

describe("home-assistant: what is on here", () => {
  it.effect("says it and returns a transient plain list of the devices it named, on shared, private and public screens; a device without a screen only hears it", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ entities: { ...defaultEntities(), "light.bedside": { name: "Bedside lamp", state: "on", area: "bedroom" }, "light.lobby": { name: "Lobby lamp", state: "on", area: "hall" } } })
      const said = yield* saying(kit, "what is on here", "living-display")
      assert.strictEqual(said.said, "On in Living room: Ceiling.")
      yield* kit.present.settle
      const [list] = kit.present.shown("living-display")
      assert.strictEqual(list?.lifetime, "transient")
      assert.deepStrictEqual(listOfScreen(kit, "living-display"), { title: "On in Living room", rows: ["Ceiling"] })
      assert.isTrue(kit.phrases.traces.at(-1)?.presented)
      for (const [device, row] of [["robins-phone", "Bedside lamp"], ["hall-screen", "Lobby lamp"]] as const) {
        assert.strictEqual((yield* saying(kit, "what is on here", device)).said.includes(row), true, device)
        yield* kit.present.settle
        assert.deepStrictEqual(listOfScreen(kit, device)?.rows, [row], device)
        assert.isTrue(kit.present.decisions.some((d) => d.deviceId === device && d.decision.show), device)
      }
      yield* saying(kit, "what is on here", "kitchen-speaker")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-speaker"), [])
    }))

  it.effect("in Dutch", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ dutch: true })
      assert.strictEqual((yield* saying(kit, "wat staat er hier aan", "living-display")).said, "Aan in Living room: Ceiling.")
      yield* kit.present.settle
      assert.strictEqual(listOfScreen(kit, "living-display")?.title, "Aan in Living room")
    }))

  it.effect("nothing on: it says so and returns no list; the list is a snapshot: it is not updated when the house changes, it ends by its lifetime, and the next list replaces it", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ refreshMs: 10_000 })
      yield* saying(kit, "what is on here", "living-display")
      yield* kit.present.settle
      const [first] = kit.present.shown("living-display")
      ha.entities["light.reading_lamp"]!.state = "on"
      yield* kit.advance(10_000)
      // Read again by the module's poll: the screen still shows what the answer said.
      assert.deepStrictEqual(kit.present.shown("living-display").map((p) => p.id), [first!.id])
      assert.deepStrictEqual(listOfScreen(kit, "living-display")?.rows, ["Ceiling"])
      // It ends by its lifetime (half a minute).
      yield* kit.advance(30_000)
      assert.deepStrictEqual(kit.present.shown("living-display"), [])
      // The next answer is a new list; an answer with nothing on says so and shows none.
      yield* saying(kit, "what is on here", "living-display")
      yield* kit.present.settle
      assert.deepStrictEqual(listOfScreen(kit, "living-display")?.rows, ["Ceiling", "Reading lamp"])
      ha.entities["light.ceiling"]!.state = "off"
      ha.entities["light.reading_lamp"]!.state = "off"
      yield* kit.advance(30_000)
      const none = yield* saying(kit, "what is on here", "living-display")
      assert.strictEqual(none.said, "Nothing is on in Living room.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("living-display"), [])
    }))

  it.effect("the four status readers, run speculatively or not, never touch a screen", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      yield* saying(kit, "what is on here", "living-display")
      yield* kit.present.settle
      const before = kit.present.shown("living-display").map((p) => p.id)
      const messages = kit.present.messages.length
      ha.entities["light.ceiling"]!.state = "off"
      yield* kit.action("lights_status", {}, { device: "kitchen-display" })
      yield* kit.action("climate_status", {}, { device: "kitchen-display" })
      yield* kit.action("locks_status", {}, { device: "kitchen-display" })
      yield* kit.tool("home_state", {}, { device: "kitchen-display" })
      yield* kit.tool("home-assistant_lights_status", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("living-display").map((p) => p.id), before)
      assert.strictEqual(kit.present.messages.length, messages)
      assert.deepStrictEqual(listOfScreen(kit, "living-display")?.rows, ["Ceiling"])
    }))

  it.effect("a room that is no area, a device without a room and two areas of one name: the module's sentences, no list", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ devices: [...DEVICES, { id: "attic-display", name: "Attic display", room: "Attic" }] })
      assert.strictEqual((yield* saying(kit, "what is on here", "node-roomless")).said, "Which room? I don't know which room this device is in.")
      assert.strictEqual((yield* saying(kit, "what is on here", "attic-display")).said, "I don't know that room in Home Assistant. Which room do you mean?")
      assert.strictEqual((yield* saying(kit, "what is on here", "hall-screen")).said, "There are no lights or switches in Hall that I may use.")
      yield* kit.present.settle
      for (const d of DEVICES) assert.deepStrictEqual(kit.present.shown(d.id), [], d.id)
    }))

  it.effect("only what is known: an unavailable device is counted, never called off; a list names what the sentence names", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { ...defaultEntities(), "light.window": { name: "Window lamp", state: "unavailable", area: "living_room" }, "light.corner": { name: "Corner lamp", state: "unknown", area: "living_room" } }
      const { kit } = yield* start({ entities })
      assert.strictEqual((yield* saying(kit, "what is on here", "living-display")).said, "On in Living room: Ceiling. 2 devices could not be read.")
      yield* kit.present.settle
      assert.deepStrictEqual(listOfScreen(kit, "living-display")?.rows, ["Ceiling", "2 devices could not be read."])
      entities["light.ceiling"]!.state = "off"
      assert.strictEqual((yield* saying(kit, "what is on here", "living-display")).said, "Nothing I could read is on in Living room. 2 devices could not be read.")
    }))

  it.effect("speech and screen are one selection: the same names, the same shortened names, the same 'more'", () =>
    Effect.gen(function*() {
      const long = (i: number) => `Lamp ${i} ${"over the garden ".repeat(5)}`.slice(0, 70)
      const { kit } = yield* start({ entities: lightsIn("kitchen", 15, "on", long) })
      const said = yield* saying(kit, "what is on here", "kitchen-display")
      yield* kit.present.settle
      const screen = listOfScreen(kit, "kitchen-display")!
      const more = / and (\d+) more\.$/.exec(said.said)
      // The sentence names some; the screen names exactly those, shortened the same, and says the same count.
      const named = screen.rows.slice(0, -1)
      assert.isAtLeast(named.length, 1)
      assert.isAtMost(named.length, 4)
      for (const n of named) assert.include(said.said, n)
      assert.strictEqual(screen.rows.at(-1), `and ${more![1]} more`)
      assert.strictEqual(named.length + Number(more![1]), 15)
      assert.isAtMost(said.said.length, 300)
      for (const row of screen.rows) assert.isAtMost(row.length, 40 + 10)
    }))

  it.effect("fifteen short names: three named and 'and 12 more', on both", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ entities: lightsIn("kitchen", 15) })
      const said = yield* saying(kit, "what is on here", "kitchen-display")
      assert.strictEqual(said.said, "On in Kitchen: Spot 0, Spot 1, Spot 2 and 12 more.")
      yield* kit.present.settle
      assert.deepStrictEqual(listOfScreen(kit, "kitchen-display")?.rows, ["Spot 0", "Spot 1", "Spot 2", "and 12 more"])
    }))

  it.effect("outside text: controls and bidirectional characters become spaces, an emoji at the cut stays whole, a room of 40 emoji still shows its list", () =>
    Effect.gen(function*() {
      const emoji = String.fromCodePoint(0x1f600)
      const nasty = (i: number) => (i === 0 ? `Lamp${String.fromCharCode(0x0b)}one ${String.fromCodePoint(0x202e)}rtl ${String.fromCodePoint(0x2028)}x` : `${"a".repeat(38)}${emoji}${emoji}${emoji}`)
      const room = `Fun ${emoji.repeat(40)}`
      const { kit } = yield* start({ areas: { fun: room }, entities: lightsIn("fun", 2, "on", nasty), devices: [{ id: "fun-display", name: "Fun display", room }] })
      const said = yield* saying(kit, "what is on here", "fun-display")
      yield* kit.present.settle
      const screen = listOfScreen(kit, "fun-display")
      // The real Presenter checks the protocol's bounds (UTF-16 units): the list is there.
      assert.isDefined(screen, said.said)
      assert.isAtMost(screen!.title.length, 60)
      assert.deepStrictEqual(screen!.rows, ["Lamp one rtl x", `${"a".repeat(38)}${emoji}`])
      assert.isAtMost(said.said.length, 300)
      // The one cut function: code point boundary, inside the UTF-16 bound.
      assert.strictEqual(cutText(emoji.repeat(3), 5), emoji.repeat(2))
      assert.strictEqual(cutText(emoji.repeat(3), 1), "")
      assert.strictEqual(cutText(`ab${String.fromCharCode(0xd83d)}cd`, 10), "abcd")
      assert.strictEqual(cutText("  a   b \n c ", 10), "a b c")
    }))

  it.effect("every bounded line is within the protocol's limits in both languages, even at the largest counts", () =>
    Effect.gen(function*() {
      const area = { id: "x", name: "Room".repeat(30), aliases: [] }
      for (const lang of ["en", "nl"] as const) {
        const out = listing(lang, area as never, { onCount: 2000, firstOn: ["N".repeat(80), "M".repeat(80), "L".repeat(80), "K".repeat(80)], total: 2000, unread: 1500, partial: true })
        assert.isAtMost(out.say.length, 300)
        if (out.present?.kind === "list") {
          assert.isAtMost(out.present.title.length, 60)
          for (const i of out.present.items) assert.isAtMost(i.text.length, 80)
          // A note is a whole sentence, never cut to fit.
          assert.isTrue(out.present.items.some((i) => i.text.endsWith(".")))
        }
        const notes = listing(lang, area as never, { onCount: 1, firstOn: ["A"], total: 2000, unread: 2000, partial: true }).present
        if (notes?.kind === "list") for (const i of notes.items.slice(1)) assert.isTrue(i.text.endsWith("."), i.text)
      }
    }))

  it.effect("a house read only in part says there may be more, in the sentence and in the list", () =>
    Effect.gen(function*() {
      const entities = { ...lightsIn("kitchen", 1), ...Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`light.z${i}`, { name: `Zed ${i}`, state: "off", area: "garage" }])) } as Record<string, FakeEntity>
      const { kit } = yield* start({ entities })
      const said = yield* saying(kit, "what is on here", "kitchen-display")
      assert.strictEqual(said.said, "On in Kitchen: Spot 0. Your house has more than I can read, so there may be more.")
      yield* kit.present.settle
      assert.deepStrictEqual(listOfScreen(kit, "kitchen-display")?.rows, ["Spot 0", "Your house has more than I can read, so there may be more."])
    }), 60_000)

  it.effect("counts everything, names only a prefix: the selection is the first on in house order", () =>
    Effect.gen(function*() {
      const house = { entities: Array.from({ length: 10 }, (_, i) => ({ areaId: "x", kind: "light", name: `L${i}`, state: i % 2 === 0 ? "on" : "unavailable" })), incomplete: new Set() } as never
      const now = roomNow(house, { id: "x", name: "X", aliases: [] } as never, new Set(["light"]))
      assert.deepStrictEqual([now.onCount, now.total, now.unread, now.firstOn], [5, 10, 5, ["L0", "L2", "L4", "L6"]])
    }))
})
