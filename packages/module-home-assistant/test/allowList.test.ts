// The services a call may name are an allow-list (`src/services.ts`): every one of them passes with its own target
// domain and fields, and everything else is refused before anything is sent, the Z-Wave call that unlocks a door
// through its contact sensor first.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HomeAssistant, type HaServiceCall } from "@pva/module-contracts"
import { Effect } from "effect"
import { homeAssistantModule } from "../src/index.ts"
import { type Field, SERVICES } from "../src/services.ts"
import { configured, defaultEntities, type FakeEntity, makeFakeHa } from "./fakeHa.ts"

/** An exposed entity of each domain a rule acts on. */
const TARGET: Readonly<Record<string, string>> = {
  light: "light.ceiling",
  switch: "switch.coffee",
  fan: "fan.bedroom",
  input_boolean: "input_boolean.guests",
  cover: "cover.living_room_blinds",
  climate: "climate.living_room",
  media_player: "media_player.kitchen",
  scene: "scene.movie_time"
}

/** A valid value of a field. */
const sample = (f: Field): unknown => (f.kind === "number" ? f.min : f.kind === "boolean" ? true : f.kind === "text" ? "music" : f.values[0])

const start = Effect.gen(function*() {
  const entities: Record<string, FakeEntity> = { ...defaultEntities(), "input_boolean.guests": { name: "Guests", state: "off" }, "light.relay": { name: "Relay", state: "off", colorModes: ["onoff"] } }
  const ha = makeFakeHa({ entities })
  const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ aliases: "scene.movie_time: movie time" }))
  ha.requests.length = 0
  return { ha, kit, service: kit.service(HomeAssistant)! }
})

describe("HomeAssistant: the services a call may name", () => {
  it.effect("every service of the table passes, on an entity of its own domain, with its required fields", () =>
    Effect.gen(function*() {
      const { ha, service } = yield* start
      const names = Object.keys(SERVICES)
      assert.isAtLeast(names.length, 30)
      for (const name of names) {
        const rule = SERVICES[name]!
        const [domain, svc] = name.split(".") as [string, string]
        const data = Object.fromEntries(Object.entries(rule.fields).filter(([, f]) => f.required === true).map(([k, f]) => [k, sample(f)]))
        const call = { domain, service: svc, target: { entityIds: [TARGET[rule.domain]!] }, ...(Object.keys(data).length > 0 ? { data } : {}), ...(rule.response === true ? { returnResponse: true } : {}) } as HaServiceCall
        const done = yield* Effect.result(service.callService(call))
        assert.strictEqual(done._tag, "Success", name)
      }
      assert.strictEqual(ha.calls().length, names.length)
    }))

  it.effect("everything else is refused before anything is sent: integrations' own services, other fields, nested values, another domain's entity", () =>
    Effect.gen(function*() {
      const { ha, service } = yield* start
      const call = (domain: string, svc: string, id: string, data?: Record<string, unknown>): HaServiceCall => ({ domain, service: svc, target: { entityIds: [id] }, ...(data !== undefined ? { data } : {}) }) as HaServiceCall
      const refused: ReadonlyArray<readonly [string, HaServiceCall]> = [
        // Z-Wave's command class API through the door's contact sensor: Door Lock (98), set, unsecured (0).
        ["zwave_js.invoke_cc_api", call("zwave_js", "invoke_cc_api", "binary_sensor.back_door", { command_class: 98, endpoint: 0, method_name: "set", parameters: [0] })],
        ["zwave_js.set_value", call("zwave_js", "set_value", "binary_sensor.back_door", { command_class: 98, property: "targetMode", value: 0 })],
        ["zwave_js.multicast_set_value", call("zwave_js", "multicast_set_value", "light.ceiling", { command_class: 98, property: "targetMode", value: 0 })],
        ["zwave_js.set_config_parameter", call("zwave_js", "set_config_parameter", "light.ceiling", { parameter: 1, value: 1 })],
        ["zha.issue_zigbee_cluster_command", call("zha", "issue_zigbee_cluster_command", "light.ceiling", { cluster_id: 257, command: 1 })],
        ["mqtt.publish", call("mqtt", "publish", "light.ceiling", { topic: "lock/front/set", payload: "UNLOCK" })],
        ["homeassistant.turn_on", call("homeassistant", "turn_on", "light.ceiling")],
        ["homeassistant.reload_all", call("homeassistant", "reload_all", "light.ceiling")],
        ["script.turn_on", call("script", "turn_on", "script.goodnight")],
        ["automation.trigger", call("automation", "trigger", "light.ceiling")],
        ["shell_command.open", call("shell_command", "open", "light.ceiling")],
        ["rest_command.unlock", call("rest_command", "unlock", "light.ceiling")],
        ["notify.notify", call("notify", "notify", "light.ceiling", { message: "x" })],
        ["persistent_notification.create", call("persistent_notification", "create", "light.ceiling", { message: "x" })],
        ["tts.speak", call("tts", "speak", "media_player.kitchen", { message: "x" })],
        ["lock.unlock", call("lock", "unlock", "lock.front_door")],
        ["alarm_control_panel.alarm_disarm", call("alarm_control_panel", "alarm_disarm", "alarm_control_panel.home")],
        ["button.press", call("button", "press", "light.ceiling")],
        ["number.set_value", call("number", "set_value", "light.ceiling", { value: 1 })],
        ["select.select_option", call("select", "select_option", "light.ceiling", { option: "x" })],
        ["vacuum.start", call("vacuum", "start", "light.ceiling")],
        ["siren.turn_on", call("siren", "turn_on", "light.ceiling")],
        ["valve.open_valve", call("valve", "open_valve", "light.ceiling")],
        ["water_heater.set_temperature", call("water_heater", "set_temperature", "climate.living_room", { temperature: 50 })],
        ["scene.apply", call("scene", "apply", "scene.movie_time", { entities: { "lock.front_door": "unlocked" } })],
        ["scene.create", call("scene", "create", "scene.movie_time", { scene_id: "x" })],
        ["input_boolean.reload", call("input_boolean", "reload", "input_boolean.guests")],
        ["fan.set_percentage", call("fan", "set_percentage", "fan.bedroom", { percentage: 50 })],
        ["climate.set_preset_mode", call("climate", "set_preset_mode", "climate.living_room", { preset_mode: "away" })],
        ["media_player.join", call("media_player", "join", "media_player.kitchen", { group_members: ["media_player.kitchen"] })],
        ["cover.open_cover on a garage door", call("cover", "open_cover", "cover.garage_door")],
        ["light.turn_on on a switch", call("light", "turn_on", "switch.coffee")],
        ["switch.turn_on on a lock", call("switch", "turn_on", "lock.front_door")],
        ["media_player.volume_set on a light", call("media_player", "volume_set", "light.ceiling", { volume_level: 0.5 })],
        ["light.turn_on with an entity id in data", call("light", "turn_on", "light.ceiling", { entity_id: "lock.front_door" })],
        ["light.turn_on with a data field named like something every object has (constructor)", call("light", "turn_on", "light.ceiling", { constructor: 1 })],
        ["light.turn_on with a data field named toString", call("light", "turn_on", "light.ceiling", { toString: "x" })],
        ["light.turn_on with an own __proto__ data field", call("light", "turn_on", "light.ceiling", JSON.parse('{"__proto__":1}'))],
        ["light.turn_on with a field not listed", call("light", "turn_on", "light.ceiling", { flash: "long" })],
        ["light.turn_on with a nested value", call("light", "turn_on", "light.ceiling", { brightness_pct: { value: 10 } })],
        ["media_player.play_media with an area in data", call("media_player", "play_media", "media_player.kitchen", { media_content_id: "x", media_content_type: "music", area_id: "garage" })],
        ["media_player.play_media with a selector", call("media_player", "play_media", "media_player.kitchen", { media_content_id: "x", media_content_type: "music", extra: { target: { device_id: "abc" } } })],
        ["light.turn_on with a brightness for a relay", call("light", "turn_on", "light.relay", { brightness_pct: 40 })]
      ]
      assert.isAtLeast(refused.length, 30)
      for (const [what, c] of refused) {
        const e = yield* Effect.flip(service.callService(c))
        assert.strictEqual(e.reason, "refused", what)
      }
      // Out of a field's range is a call outside the bounds.
      assert.strictEqual((yield* Effect.flip(service.callService(call("media_player", "volume_set", "media_player.kitchen", { volume_level: 5 })))).reason, "invalid")
      assert.strictEqual((yield* Effect.flip(service.callService(call("cover", "set_cover_position", "cover.living_room_blinds")))).reason, "invalid")
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("the module's own actions take the same table: what its actions send is in it", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start
      yield* kit.action("lights_on", { target: "kitchen" })
      yield* kit.action("set_brightness", { target: "ceiling", level: 30 })
      yield* kit.action("switches_off", { target: "coffee machine" })
      yield* kit.action("climate_set", { target: "living room", temperature: 21 })
      yield* kit.action("climate_mode", { target: "living room", mode: "off" })
      yield* kit.action("covers_close", { target: "living room" })
      yield* kit.action("cover_position", { target: "living room blinds", position: 30 })
      yield* kit.action("scene_activate", { scene: "movie time" })
      const sent = ha.calls().map((c) => c.service)
      assert.deepStrictEqual(sent, ["light.turn_on", "light.turn_on", "switch.turn_off", "climate.set_temperature", "climate.set_hvac_mode", "cover.close_cover", "cover.set_cover_position", "scene.turn_on"])
      assert.isTrue(sent.every((s) => s in SERVICES))
    }))
})
