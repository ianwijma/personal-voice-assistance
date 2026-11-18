// Every action and the tool, on their ordinary path and on their refusals, through the real gateway as turns of the
// default test household (a shared kitchen display in the Kitchen, Robin's phone in the Bedroom, a public hall screen
// in the Hall), in English and in Dutch.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { HOME_STATE_ITEMS, homeAssistantModule, OUTSIDE_NOTE } from "../src/index.ts"
import { configured, makeFakeHa } from "./fakeHa.ts"

const start = (options: { readonly aliases?: string; readonly dutch?: boolean; readonly devices?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly room?: string }> } = {}) =>
  Effect.gen(function*() {
    const ha = makeFakeHa()
    const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), {
      ...configured({ aliases: options.aliases ?? "scene.movie_time: movie time, filmavond\nLiving room: lounge, woonkamer" }),
      ...(options.dutch === true || options.devices !== undefined
        ? { household: { ...(options.dutch === true ? { home: { HOME_LANGUAGE: "nl-NL" } } : {}), ...(options.devices !== undefined ? { devices: options.devices } : {}) } }
        : {})
    })
    ha.requests.length = 0
    return { ha, kit }
  })

const kitchen = { device: "kitchen-display" }
const kitchen_ = kitchen
const hall = { device: "hall-screen" }

describe("home-assistant: lights", () => {
  it.effect("on and off in a room, here (the device's room), one light and every light; each call names the lights by id", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "living room" }), { ok: true, say: "I've turned on the lights in Living room." })
      assert.deepStrictEqual(ha.calls(), [{ service: "light.turn_on", body: { entity_id: ["light.ceiling", "light.reading_lamp"] } }])
      // No room named: here, the kitchen display's room.
      assert.deepStrictEqual(yield* kit.action("lights_off", {}, kitchen), { ok: true, say: "I've turned off the lights in Kitchen." })
      assert.deepStrictEqual(ha.calls()[1], { service: "light.turn_off", body: { entity_id: ["light.kitchen"] } })
      // An owner's other name for a room, and one light by its name.
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "lounge" }), { ok: true, say: "I've turned on the lights in Living room." })
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "bedside lamp" }), { ok: true, say: "I've turned off Bedside lamp." })
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "all lights" }), { ok: true, say: "I've turned off all the lights." })
      assert.deepStrictEqual(ha.calls().at(-1), { service: "light.turn_off", body: { entity_id: ["light.bedside", "light.ceiling", "light.kitchen", "light.reading_lamp"] } })
    }))

  it.effect("brightness, and which lights are on (read live)", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("set_brightness", { target: "kitchen", level: 40 }), { ok: true, say: "I've set the lights in Kitchen to 40 percent." })
      assert.deepStrictEqual(ha.calls(), [{ service: "light.turn_on", body: { brightness_pct: 40, entity_id: ["light.kitchen"] } }])
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "Ceiling and Kitchen light are on." })
      ha.entities["light.ceiling"]!.state = "off"
      ha.entities["light.kitchen"]!.state = "off"
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "All the lights are off." })
      ha.entities["light.bedside"]!.state = "on"
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "Bedside lamp is on." })
    }))

  it.effect("the same through the generated tools, as the model calls them", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      const r = yield* kit.tool("home-assistant_lights_on", { target: "Kitchen" })
      assert.isTrue(r.ok)
      assert.strictEqual(r.value, "I've turned on the lights in Kitchen.")
      const unknown = yield* kit.tool("home-assistant_lights_on", { target: "the attic" })
      assert.isFalse(unknown.ok)
      assert.include(unknown.content, "Unknown room or light")
    }))

  it.effect("here on a device without a room asks which room; a room that is no area asks too; nothing is switched", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ devices: [{ id: "node-roomless", name: "Node" }, { id: "attic-speaker", name: "Attic speaker", room: "Attic" }] })
      assert.deepStrictEqual(yield* kit.action("lights_on", {}, { device: "node-roomless" }), { ok: true, say: "Which room? I don't know which room this device is in." })
      assert.deepStrictEqual(yield* kit.action("lights_on", {}, { device: "attic-speaker" }), { ok: true, say: "I don't know a room called Attic in Home Assistant. Which room do you mean?" })
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("a room without lights says so", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("lights_on", {}, hall), { ok: true, say: "There are no lights in Hall that I may use." })
      assert.deepStrictEqual(ha.calls(), [])
    }))
})

describe("home-assistant: switches, heating, scenes", () => {
  it.effect("switches and fans, by name and here", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("switches_on", { target: "coffee machine" }), { ok: true, say: "I've turned on Coffee machine." })
      assert.deepStrictEqual(yield* kit.action("switches_off", {}, { device: "robins-phone" }), { ok: true, say: "I've turned off the switches in Bedroom." })
      assert.deepStrictEqual(ha.calls(), [{ service: "switch.turn_on", body: { entity_id: ["switch.coffee"] } }, { service: "fan.turn_off", body: { entity_id: ["fan.bedroom"] } }])
    }))

  it.effect("the temperature, with what it is now; the mode, and a mode the thermostat does not have", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("climate_set", { target: "living room", temperature: 21 }), { ok: true, say: "I've set the heating in Living room to 21 degrees; it's 18.5 degrees now." })
      assert.deepStrictEqual(ha.calls(), [{ service: "climate.set_temperature", body: { temperature: 21, entity_id: ["climate.living_room"] } }])
      assert.deepStrictEqual(yield* kit.action("climate_mode", { target: "living room", mode: "off" }), { ok: true, say: "I've set the heating in Living room to off." })
      assert.deepStrictEqual(yield* kit.action("climate_mode", { target: "living room", mode: "cool" }), { ok: true, say: "Living room thermostat can't be set to cooling, so I haven't changed anything." })
      assert.strictEqual(ha.calls().length, 2)
      const outOfRange = yield* kit.action("climate_set", { target: "living room", temperature: 80 })
      assert.isFalse(outOfRange.ok)
      assert.strictEqual(ha.calls().length, 2)
    }))

  it.effect("how warm it is: here from a sensor, in a room from the thermostat, the whole house from a device without a room", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ devices: [{ id: "kitchen-display", name: "Kitchen display", room: "Kitchen" }, { id: "node-roomless", name: "Node" }] })
      assert.deepStrictEqual(yield* kit.action("climate_status", {}, kitchen), { ok: true, say: "Kitchen temperature is 21.3 degrees." })
      assert.deepStrictEqual(yield* kit.action("climate_status", { room: "lounge" }, kitchen), { ok: true, say: "Living room thermostat is 18.5 degrees, set to 20." })
      assert.deepStrictEqual(yield* kit.action("climate_status", {}, { device: "node-roomless" }), { ok: true, say: "Living room thermostat is 18.5 degrees, set to 20 and Kitchen temperature is 21.3 degrees." })
    }))

  it.effect("a scene the owner named starts; one not named is not offered and cannot be reached", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("scene_activate", { scene: "movie time" }), { ok: true, say: "I've started Movie time." })
      assert.deepStrictEqual(ha.calls(), [{ service: "scene.turn_on", body: { entity_id: ["scene.movie_time"] } }])
      const script = yield* kit.action("scene_activate", { scene: "goodnight" })
      assert.isFalse(script.ok)
      assert.strictEqual(ha.calls().length, 1)
    }))
})

describe("home-assistant: blinds, garage doors, locks", () => {
  it.effect("blinds open, close, stop and go to a position; one without positions says so", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("covers_close", { target: "living room" }), { ok: true, say: "I'm closing the blinds in Living room." })
      assert.deepStrictEqual(yield* kit.action("covers_open", {}, { device: "robins-phone" }), { ok: true, say: "I'm opening the blinds in Bedroom." })
      assert.deepStrictEqual(yield* kit.action("covers_stop", { target: "bedroom blinds" }), { ok: true, say: "I've stopped Bedroom blinds." })
      assert.deepStrictEqual(yield* kit.action("cover_position", { target: "living room blinds", position: 30 }), { ok: true, say: "I'm setting Living room blinds to 30 percent open." })
      assert.deepStrictEqual(yield* kit.action("cover_position", { target: "bedroom blinds", position: 30 }), { ok: true, say: "Bedroom blinds can't be set to a position, so I haven't changed anything; say open or close." })
      assert.deepStrictEqual(ha.calls().map((c) => c.service), ["cover.close_cover", "cover.open_cover", "cover.stop_cover", "cover.set_cover_position"])
      // "All blinds" are the blinds and shades only: never the garage door.
      assert.deepStrictEqual(yield* kit.action("covers_close", { target: "all blinds" }), { ok: true, say: "I'm closing all the blinds." })
      assert.deepStrictEqual(ha.calls().at(-1)?.body, { entity_id: ["cover.bedroom_blinds", "cover.living_room_blinds"] })
    }))

  it.effect("a garage door is no name a cover action takes, the garage is no room of blinds, and here in the garage has no blinds; nothing reaches Home Assistant", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start({ devices: [{ id: "garage-speaker", name: "Garage speaker", room: "Garage" }] })
      for (const [id, params] of [["covers_open", { target: "garage door" }], ["covers_close", { target: "garage" }], ["cover_position", { target: "cover.garage_door", position: 50 }], ["covers_stop", { target: "garage door" }]] as const) {
        const r = yield* kit.action(id, params)
        assert.isFalse(r.ok, id)
        if (!r.ok) assert.strictEqual(r.code, "invalid_params", id)
        const tool = yield* kit.tool(`home-assistant_${id}`, params)
        assert.isFalse(tool.ok, id)
        assert.include(tool.content, "Unknown room or blind", id)
      }
      for (const id of ["covers_open", "covers_close", "covers_stop"]) {
        assert.deepStrictEqual(yield* kit.action(id, {}, { device: "garage-speaker" }), { ok: true, say: "There are no blinds in Garage that I may use." }, id)
        assert.deepStrictEqual((yield* kit.tool(`home-assistant_${id}`, {}, { device: "garage-speaker" })).value, "There are no blinds in Garage that I may use.", id)
      }
      assert.deepStrictEqual(yield* kit.action("cover_position", { position: 50 }, { device: "garage-speaker" }), { ok: true, say: "There are no blinds in Garage that I may use." })
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("locks and alarm panels are read (a lock's state is read), never changed: no action takes a lock", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start()
      assert.deepStrictEqual(yield* kit.action("locks_status"), { ok: true, say: "Alarm is disarmed, Garage door is closed and Front door is locked." })
      ha.entities["lock.front_door"]!.state = "unlocked"
      assert.deepStrictEqual(yield* kit.action("locks_status", {}, hall), { ok: true, say: "Alarm is disarmed, Garage door is closed and Front door is unlocked." })
      // No change action can name a lock or an alarm panel.
      for (const id of ["lights_off", "switches_off", "covers_close"]) {
        const r = yield* kit.action(id, { target: "front door" })
        assert.isFalse(r.ok, id)
      }
      assert.deepStrictEqual(ha.calls(), [])
      // A tool or action that could only ever be security would not be offered at all; these never are security for a lock.
      assert.isFalse(kit.toolNames().some((n) => /lock_|unlock|alarm_|disarm/.test(n.replace("locks_status", ""))))
    }))
})

describe("home-assistant: home_state", () => {
  it.effect("a few devices with their state now, marked as outside content, narrowed by room and kind; no person and no classless sensor", () =>
    Effect.gen(function*() {
      const { kit } = yield* start()
      const all = yield* kit.tool("home_state", {})
      assert.isTrue(all.ok)
      const value = all.value as { readonly note: string; readonly rooms: ReadonlyArray<{ readonly room: string; readonly things: ReadonlyArray<string> }>; readonly more: number }
      assert.strictEqual(value.note, OUTSIDE_NOTE)
      // A handful of items and how many more (docs/MODULES.md §16), never the whole house.
      assert.strictEqual(value.rooms.flatMap((r) => r.things).length, HOME_STATE_ITEMS)
      assert.strictEqual(value.more, 16 - HOME_STATE_ITEMS)
      assert.notInclude(all.content, "Robin")
      assert.notInclude(all.content, "Dorpsstraat")
      const living = yield* kit.tool("home_state", { area: "lounge" })
      assert.deepStrictEqual((living.value as typeof value).rooms, [{
        room: "Living room",
        things: ["Living room thermostat: heat, 18.5° now, set to 20°", "Living room blinds: open, 100% open", "Ceiling: on, 50%", "Reading lamp: off", "Movie time: scene"]
      }])
      const garage = yield* kit.tool("home_state", { area: "garage" })
      assert.include(garage.content, "Garage door: closed (only read)")
      const kitchen = yield* kit.tool("home_state", { area: "kitchen", kind: "media_player" })
      assert.include(kitchen.content, "Kitchen speaker: playing, Miles Davis – So What")
      const here = yield* kit.tool("home_state", { area: "here", kind: "light" }, kitchen_)
      assert.deepStrictEqual(here.value, { note: OUTSIDE_NOTE, rooms: [{ room: "Kitchen", things: ["Kitchen light: off"] }] })
      const lounge = yield* kit.tool("home_state", { area: "lounge", kind: "climate" })
      assert.deepStrictEqual(lounge.value, { note: OUTSIDE_NOTE, rooms: [{ room: "Living room", things: ["Living room thermostat: heat, 18.5° now, set to 20°"] }] })
      const nowhere = yield* kit.tool("home_state", { area: "the attic" })
      assert.deepStrictEqual(nowhere.value, { spoken: "I don't know a room called the attic in Home Assistant. Which room do you mean?" })
    }))

  it.effect("a long house: a handful of items and how many more, also in one room", () =>
    Effect.gen(function*() {
      const entities: Record<string, { name: string; state: string; area: string }> = {}
      for (let i = 0; i < 75; i++) entities[`light.lamp_${String(i).padStart(2, "0")}`] = { name: `Lamp ${i}`, state: "off", area: "kitchen" }
      const ha = makeFakeHa({ entities })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      for (const input of [{}, { area: "kitchen" }, { kind: "light" as const }]) {
        const r = yield* kit.tool("home_state", input)
        const value = r.value as { readonly rooms: ReadonlyArray<{ readonly things: ReadonlyArray<string> }>; readonly more: number }
        assert.strictEqual(value.rooms.flatMap((x) => x.things).length, HOME_STATE_ITEMS)
        assert.strictEqual(value.more, 75 - HOME_STATE_ITEMS)
        assert.isBelow(r.content.length, 1_000)
      }
    }))
})

describe("home-assistant: in Dutch", () => {
  it.effect("every sentence in the household's language", () =>
    Effect.gen(function*() {
      const { kit } = yield* start({ dutch: true })
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "woonkamer" }), { ok: true, say: "Ik heb de lampen in Living room aangezet." })
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "alle lampen" }), { ok: true, say: "Ik heb alle lampen uitgezet." })
      assert.deepStrictEqual(yield* kit.action("climate_set", { target: "woonkamer", temperature: 20.5 }), { ok: true, say: "Ik heb de verwarming in Living room op 20,5 graden gezet; het is nu 18,5 graden." })
      assert.deepStrictEqual(yield* kit.action("covers_close", { target: "alle rolluiken" }), { ok: true, say: "Ik doe alle zonwering dicht." })
      assert.deepStrictEqual(yield* kit.action("locks_status"), { ok: true, say: "Alarm is uitgeschakeld, Garage door is dicht en Front door is op slot." })
      assert.deepStrictEqual(yield* kit.action("scene_activate", { scene: "filmavond" }), { ok: true, say: "Ik heb Movie time gestart." })
      assert.deepStrictEqual(yield* kit.action("lights_on", {}, hall), { ok: true, say: "Er zijn geen lampen in Hall die ik mag gebruiken." })
    }))
})
