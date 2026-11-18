// What a target names, and saying exactly what happened: a name that is more than one area is a question; the saved
// whole-house names still work; a known id or name resolves beyond any choice list's length; the whole target is
// checked before anything is sent; unread lights are never "off"; a named room stays that room; temperatures in the
// household's unit, converted for an installation in the other one; numbers as @pva/language says them.
import { assert, describe, it } from "@effect/vitest"
import { MAX_CHOICE_OPTIONS } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { homeAssistantModule } from "../src/index.ts"
import { configured, type FakeEntity, type FakeHaOptions, makeFakeHa } from "./fakeHa.ts"

const start = (options: FakeHaOptions & { readonly aliases?: string; readonly home?: Record<string, string>; readonly devices?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly room?: string }> } = {}) =>
  Effect.gen(function*() {
    const ha = makeFakeHa(options)
    const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), {
      ...configured({ aliases: options.aliases ?? "" }),
      household: { ...(options.home !== undefined ? { home: options.home } : {}), ...(options.devices !== undefined ? { devices: options.devices } : {}) }
    })
    ha.requests.length = 0
    return { ha, kit }
  })

describe("home-assistant: names that are more than one thing", () => {
  const shared = {
    areas: { alpha: "Shared", beta: "Shared", gamma: "Garden" },
    entities: { "light.alpha": { name: "Alpha lamp", state: "off", area: "alpha" }, "light.beta": { name: "Beta lamp", state: "off", area: "beta" }, "light.garden": { name: "Garden lamp", state: "off", area: "gamma" }, "sensor.alpha": { name: "Alpha temperature", state: "19", area: "alpha", class: "temperature", unit: "°C" } },
    devices: [{ id: "shared-speaker", name: "Shared speaker", room: "Shared" }, { id: "alpha-speaker", name: "Alpha speaker", room: "alpha" }]
  }

  it.effect("a room name two areas share asks which, by action, tool and here; each area's id still works", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start(shared)
      const ask = "Shared is more than one thing in Home Assistant: Shared (alpha) and Shared (beta). Which one do you mean?"
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "Shared" }), { ok: true, say: ask })
      assert.strictEqual((yield* kit.tool("home-assistant_lights_on", { target: "shared" })).value, ask)
      assert.deepStrictEqual(yield* kit.action("lights_on", {}, { device: "shared-speaker" }), { ok: true, say: ask })
      assert.deepStrictEqual(ha.calls(), [])
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "area:beta" }), { ok: true, say: "I've turned on the lights in Shared." })
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "beta" }), { ok: true, say: "I've turned on the lights in Shared." })
      assert.deepStrictEqual(yield* kit.action("lights_off", {}, { device: "alpha-speaker" }), { ok: true, say: "I've turned off the lights in Shared." })
      assert.deepStrictEqual(ha.calls().map((c) => c.body), [{ entity_id: ["light.beta"] }, { entity_id: ["light.beta"] }, { entity_id: ["light.alpha"] }])
      // The same for the room of a question and of home_state.
      assert.deepStrictEqual(yield* kit.action("climate_status", { room: "Shared" }), { ok: true, say: ask })
      assert.deepStrictEqual((yield* kit.tool("home_state", { area: "Shared" })).value, { spoken: ask })
    }))

  it.effect("an owner's other name that two rooms share is a question too; two lights of one name in different rooms as well", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({
        areas: { kitchen: "Kitchen", den: "Den" },
        entities: { "light.k": { name: "Lamp", state: "off", area: "kitchen" }, "light.d": { name: "Lamp", state: "off", area: "den" } },
        aliases: "Kitchen: downstairs\nDen: downstairs"
      })
      const r = yield* kit.action("lights_on", { target: "downstairs" })
      assert.deepStrictEqual(r, { ok: true, say: "downstairs is more than one thing in Home Assistant: Den and Kitchen. Which one do you mean?" })
      const lamp = yield* kit.action("lights_on", { target: "lamp" })
      assert.deepStrictEqual(lamp, { ok: true, say: "Lamp is more than one thing in Home Assistant: Lamp (light.d) and Lamp (light.k). Which one do you mean?" })
      assert.deepStrictEqual(ha.calls(), [])
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "light.d" }), { ok: true, say: "I've turned on Lamp." })
    }))
})

describe("home-assistant: saved settings keep working", () => {
  it.effect("a saved whole-house name (all: …, all lights: …) still switches every light", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ aliases: "all: downstairs\nall lights: alles\nLiving room: lounge" })
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "downstairs" }), { ok: true, say: "I've turned off all the lights." })
      assert.deepStrictEqual((yield* kit.tool("home-assistant_lights_on", { target: "alles" })).value, "I've turned on all the lights.")
      assert.deepStrictEqual(ha.calls().map((c) => c.body), [
        { entity_id: ["light.bedside", "light.ceiling", "light.kitchen", "light.reading_lamp"] },
        { entity_id: ["light.bedside", "light.ceiling", "light.kitchen", "light.reading_lamp"] }
      ])
    }))
})

describe("home-assistant: every known name resolves, however long the list", () => {
  /** More lights than one choice list carries, over more areas than one choice list carries. */
  const big = () => {
    const areas: Record<string, string> = {}
    const entities: Record<string, FakeEntity> = {}
    for (let a = 0; a < 300; a++) areas[`r${String(a).padStart(3, "0")}`] = `Room ${a}`
    for (let i = 0; i < 1_200; i++) entities[`light.l${String(i).padStart(4, "0")}`] = { name: `Lamp ${i}`, state: "off", area: `r${String(i % 300).padStart(3, "0")}` }
    return { areas, entities, devices: [{ id: "room-speaker", name: "Room speaker", room: "Room 299" }] }
  }

  it.effect("a light beyond option 255 by id and by name, a room beyond it, here and all: by action and by tool", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start(big())
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "light.l1199" }), { ok: true, say: "I've turned off Lamp 1199." })
      assert.strictEqual((yield* kit.tool("home-assistant_lights_on", { target: "Lamp 1150" })).value, "I've turned on Lamp 1150.")
      assert.strictEqual((yield* kit.tool("home-assistant_lights_on", { target: "Room 298" })).value, "I've turned on the lights in Room 298.")
      assert.deepStrictEqual(yield* kit.action("lights_on", {}, { device: "room-speaker" }), { ok: true, say: "I've turned on the lights in Room 299." })
      assert.strictEqual((yield* kit.tool("home-assistant_lights_off", { target: "all lights" })).value, "I've turned off all the lights.")
      assert.deepStrictEqual(ha.calls().map((c) => (c.body as { entity_id: Array<string> }).entity_id.length), [1, 1, 4, 4, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50])
      // A request read as text (as the intent agent passes it in a house this large) finds the name in it, or means here.
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "turn off the lamp 7 please" }), { ok: true, say: "I've turned off Lamp 7." })
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "lights off" }, { device: "room-speaker" }), { ok: true, say: "I've turned off the lights in Room 299." })
      // A name that is not there is not guessed.
      assert.isFalse((yield* kit.action("lights_off", { target: "the attic lamp" })).ok)
    }), 60_000)

  it.effect(`a list that fits one choice list (at most ${MAX_CHOICE_OPTIONS - 1}) is offered as one; a longer one is free text resolved over the whole house`, () =>
    Effect.gen(function*() {
      const small = yield* start()
      const smallTool = (yield* small.kit.tool("home-assistant_lights_on", { target: "the attic" }))
      assert.include(smallTool.content, "Unknown room or light")
      const large = yield* start(big())
      const largeTool = yield* large.kit.tool("home-assistant_lights_on", { target: "the attic" })
      assert.include(largeTool.content, "I don't know the attic in Home Assistant.")
    }), 60_000)
})

describe("home-assistant: the whole target is checked before anything is sent", () => {
  it.effect("thermostats that cannot all take the mode, blinds that cannot all take a position, a light that is unavailable: nothing sent, what cannot is named", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {
        "climate.heat": { name: "Heat only", state: "heat", area: "kitchen", modes: ["off", "heat"] },
        "climate.cool": { name: "Cool only", state: "cool", area: "kitchen", modes: ["off", "cool"] },
        "cover.full": { name: "Full blind", state: "open", area: "kitchen", class: "blind", features: 15 },
        "cover.simple": { name: "Simple blind", state: "open", area: "kitchen", class: "shade", features: 3 },
        "light.ok": { name: "Ok lamp", state: "off", area: "kitchen" },
        "light.away": { name: "Away lamp", state: "unavailable", area: "kitchen" }
      }
      const { ha, kit } = yield* start({ entities, areas: { kitchen: "Kitchen" } })
      assert.deepStrictEqual(yield* kit.action("climate_mode", { target: "kitchen", mode: "heat" }), { ok: true, say: "Cool only can't be set to heating, so I haven't changed anything." })
      assert.deepStrictEqual(yield* kit.action("cover_position", { target: "kitchen", position: 30 }), { ok: true, say: "Simple blind can't be set to a position, so I haven't changed anything; say open or close." })
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: true, say: "Away lamp is unavailable in Home Assistant, so I haven't changed anything." })
      assert.deepStrictEqual(ha.calls(), [])
      // What all of them can do, is done for all of them.
      assert.deepStrictEqual(yield* kit.action("climate_mode", { target: "kitchen", mode: "off" }), { ok: true, say: "I've set the heating in Kitchen to off." })
      assert.deepStrictEqual(yield* kit.action("covers_close", { target: "kitchen" }), { ok: true, say: "I'm closing the blinds in Kitchen." })
      assert.deepStrictEqual(ha.calls().map((c) => c.body), [{ hvac_mode: "off", entity_id: ["climate.cool", "climate.heat"] }, { entity_id: ["cover.full", "cover.simple"] }])
      // In Dutch, more than one.
      const nl = yield* start({ entities: { ...entities, "cover.simple2": { name: "Tweede", state: "open", area: "kitchen", class: "shade", features: 3 } }, areas: { kitchen: "Keuken" }, home: { HOME_LANGUAGE: "nl-NL" } })
      assert.deepStrictEqual(yield* nl.kit.action("cover_position", { target: "keuken", position: 30 }), { ok: true, say: "Simple blind en Tweede kunnen niet op een stand worden gezet, dus ik heb niets veranderd; zeg open of dicht." })
    }))
})

describe("home-assistant: lights that could not be read are never off", () => {
  it.effect("unknown and unavailable lights: how many could not be read, never \"all off\"", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {
        "light.a": { name: "A", state: "off" },
        "light.b": { name: "B", state: "unavailable" },
        "light.c": { name: "C", state: "unknown" }
      }
      const { ha, kit } = yield* start({ entities })
      assert.deepStrictEqual(yield* kit.action("lights_status", {}, { device: "kitchen-display" }), { ok: true, say: "None of the lights I could read is on. 2 lights could not be read." })
      ha.entities["light.a"]!.state = "on"
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "A is on. 2 lights could not be read." })
      ha.entities["light.c"]!.state = "off"
      ha.entities["light.a"]!.state = "off"
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "None of the lights I could read is on. One light could not be read." })
      ha.entities["light.b"]!.state = "off"
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "All the lights are off." })
    }))
})

describe("home-assistant: a named room stays that room", () => {
  it.effect("a room with no temperature says so, for the room named and for here; only a device without a room hears the whole house", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ devices: [{ id: "hall-screen", name: "Hall screen", room: "Hall" }, { id: "node", name: "Node" }] })
      assert.deepStrictEqual(yield* kit.action("climate_status", { room: "Hall" }, { device: "hall-screen" }), { ok: true, say: "There's no temperature reading in Hall." })
      assert.deepStrictEqual(yield* kit.action("climate_status", {}, { device: "hall-screen" }), { ok: true, say: "There's no temperature reading in Hall." })
      assert.deepStrictEqual(yield* kit.action("climate_status", {}, { device: "node" }), { ok: true, say: "Living room thermostat is 18.5 degrees, set to 20 and Kitchen temperature is 21.3 degrees." })
      const state = yield* kit.tool("home_state", { area: "Hall", kind: "climate" })
      assert.deepStrictEqual(state.value, { note: (state.value as { note: string }).note, rooms: [], empty: "Hall" })
    }))
})

describe("home-assistant: temperatures in the household's unit", () => {
  it.effect("a Celsius household and a Fahrenheit installation: the request is converted, and so is every readback", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {
        "climate.living_room": { name: "Living room thermostat", state: "heat", area: "living_room", current: 71.6, target: 68 },
        "sensor.porch": { name: "Porch", state: "50", area: "living_room", class: "temperature", unit: "°F" }
      }
      const { ha, kit } = yield* start({ entities, unit: "°F" })
      assert.deepStrictEqual(yield* kit.action("climate_set", { target: "living room", temperature: 21 }), { ok: true, say: "I've set the heating in Living room to 21 degrees; it's 22 degrees now." })
      assert.deepStrictEqual(ha.calls(), [{ service: "climate.set_temperature", body: { temperature: 69.8, entity_id: ["climate.living_room"] } }])
      // As the kit's offline network recorded what was sent: a POST, its body exactly this.
      const sent = ha.sent.at(-1)!
      assert.deepStrictEqual([sent.method, sent.url, sent.body], ["POST", "http://ha.test:8123/api/services/climate/set_temperature", "{\"temperature\":69.8,\"entity_id\":[\"climate.living_room\"]}"])
      assert.deepStrictEqual(yield* kit.action("climate_status", { room: "living room" }), { ok: true, say: "Living room thermostat is 22 degrees, set to 21 and Porch is 10 degrees." })
      const state = yield* kit.tool("home_state", { kind: "climate" })
      assert.include(state.content, "Living room thermostat: heat, 22° now, set to 21°")
    }))

  it.effect("an imperial household and a Celsius installation: the other way round, with the bounds in Fahrenheit", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ home: { HOME_UNITS: "imperial" } })
      assert.deepStrictEqual(yield* kit.action("climate_set", { target: "living room", temperature: 70 }), { ok: true, say: "I've set the heating in Living room to 70 degrees; it's 65.3 degrees now." })
      assert.deepStrictEqual(ha.calls(), [{ service: "climate.set_temperature", body: { temperature: 21.11, entity_id: ["climate.living_room"] } }])
      assert.isFalse((yield* kit.action("climate_set", { target: "living room", temperature: 20 })).ok)
    }))

  it.effect("an installation whose unit was not read: nothing is sent", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ unit: "K" })
      assert.deepStrictEqual(yield* kit.action("climate_set", { target: "living room", temperature: 21 }), { ok: true, say: "I couldn't read which temperature unit Home Assistant uses, so I haven't changed anything." })
      assert.deepStrictEqual(ha.calls(), [])
    }))
})

describe("home-assistant: numbers as they were sent and read", () => {
  it.effect("fractions, a reading near zero and a reading too large to say, in English and Dutch", () =>
    Effect.gen(function*() {
      const entities = (): Record<string, FakeEntity> => ({
        "climate.living_room": { name: "Living room thermostat", state: "heat", area: "living_room", current: 0.004, target: 20 },
        "sensor.near": { name: "Near", state: "0.04", area: "kitchen", class: "temperature", unit: "°C" },
        "light.ceiling": { name: "Ceiling", state: "on", area: "living_room" },
        "light.reading_lamp": { name: "Reading lamp", state: "off", area: "living_room" },
        "sensor.huge": { name: "Huge", state: "1e300", area: "kitchen", class: "temperature", unit: "°C" }
      })
      const en = yield* start({ entities: entities() })
      assert.deepStrictEqual(yield* en.kit.action("climate_set", { target: "living room", temperature: 21.25 }), { ok: true, say: "I've set the heating in Living room to 21.25 degrees; it's almost zero degrees now." })
      assert.deepStrictEqual(en.ha.calls().map((c) => c.body), [{ temperature: 21.25, entity_id: ["climate.living_room"] }])
      assert.deepStrictEqual(yield* en.kit.action("climate_status", { room: "kitchen" }), { ok: true, say: "Huge has no temperature I can read and Near is 0.04 degrees." })
      const nl = yield* start({ entities: entities(), home: { HOME_LANGUAGE: "nl-NL" } })
      assert.deepStrictEqual(yield* nl.kit.action("climate_set", { target: "living room", temperature: 21.25 }), { ok: true, say: "Ik heb de verwarming in Living room op 21,25 graden gezet; het is nu bijna nul graden." })
      assert.deepStrictEqual(yield* nl.kit.action("climate_status", { room: "kitchen" }), { ok: true, say: "Huge heeft geen temperatuur die ik kan lezen en Near is 0,04 graden." })
      assert.deepStrictEqual(yield* nl.kit.action("set_brightness", { target: "living room", level: 33.4 }), { ok: true, say: "Ik heb de lampen in Living room op 33 procent gezet." })
      assert.deepStrictEqual(nl.ha.calls().at(-1)?.body, { brightness_pct: 33, entity_id: ["light.ceiling", "light.reading_lamp"] })
    }))
})


