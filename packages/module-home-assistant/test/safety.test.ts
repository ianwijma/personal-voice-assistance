// Nothing of the security kind, by construction (decision 1 of the review round): only covers of a blind class are
// moved, scripts are not run at all, and a scene runs only when Home Assistant lists what it sets and every one of
// those is a light, a blind, a thermostat or a media player. Each through the action, its generated tool and the
// HomeAssistant service; nothing of it reaches Home Assistant.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HomeAssistant } from "@pva/module-contracts"
import { Effect } from "effect"
import { homeAssistantModule } from "../src/index.ts"
import { configured, defaultEntities, type FakeEntity, makeFakeHa } from "./fakeHa.ts"

/** Covers of every kind that must never move: no class, a class the module does not know, and the security ones. */
const UNMOVED: Record<string, FakeEntity> = {
  "cover.no_class": { name: "Shed actuator", state: "closed", area: "garage", features: 15 },
  "cover.odd_class": { name: "Odd actuator", state: "closed", area: "garage", class: "garage_door", features: 15 },
  "cover.window": { name: "Skylight", state: "closed", area: "garage", class: "window", features: 15 },
  "cover.damper": { name: "Vent damper", state: "closed", area: "garage", class: "damper", features: 15 },
  "cover.gate": { name: "Drive gate", state: "closed", area: "garage", class: "gate", features: 15 },
  "cover.door": { name: "Side door", state: "closed", area: "garage", class: "door", features: 15 }
}

const start = (entities: Record<string, FakeEntity>, aliases = "") =>
  Effect.gen(function*() {
    const ha = makeFakeHa({ entities })
    const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), {
      ...configured({ aliases }),
      household: { devices: [{ id: "garage-speaker", name: "Garage speaker", room: "Garage" }, { id: "kitchen-display", name: "Kitchen display", room: "Kitchen" }] }
    })
    ha.requests.length = 0
    return { ha, kit, service: kit.service(HomeAssistant)! }
  })

describe("home-assistant: covers that are not blinds are never moved", () => {
  it.effect("by name or id, through the room they are in, here, all blinds, the generated tools and the service: none of them", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start({ ...defaultEntities(), ...UNMOVED })
      for (const id of Object.keys(UNMOVED)) {
        const name = UNMOVED[id]!.name!
        for (const action of ["covers_open", "covers_close", "covers_stop"]) {
          for (const target of [id, name]) {
            const r = yield* kit.action(action, { target })
            assert.isFalse(r.ok, `${action} ${target}`)
            const tool = yield* kit.tool(`home-assistant_${action}`, { target })
            assert.isFalse(tool.ok, `${action} ${target}`)
          }
        }
        assert.isFalse((yield* kit.action("cover_position", { target: id, position: 40 })).ok, id)
        // The service refuses it by id, as it refuses a garage door.
        for (const call of ["open_cover", "close_cover", "stop_cover", "set_cover_position"]) {
          const e = yield* Effect.flip(service.callService({ domain: "cover", service: call, target: { entityIds: [id] } }))
          assert.strictEqual(e.reason, "refused", `${call} ${id}`)
        }
        // Read, like a garage door: the state is there for presence and the locks question.
        assert.strictEqual(service.entity(id)?.state, "closed")
      }
      // The room that holds them has no blinds, here in it has none, and "all blinds" are the two real ones.
      assert.deepStrictEqual(yield* kit.action("covers_open", {}, { device: "garage-speaker" }), { ok: true, say: "There are no blinds in Garage that I may use." })
      assert.deepStrictEqual((yield* kit.tool("home-assistant_covers_open", {}, { device: "garage-speaker" })).value, "There are no blinds in Garage that I may use.")
      assert.isFalse((yield* kit.action("covers_open", { target: "garage" })).ok)
      assert.deepStrictEqual(yield* kit.action("covers_close", { target: "all blinds" }), { ok: true, say: "I'm closing all the blinds." })
      assert.deepStrictEqual(ha.calls(), [{ service: "cover.close_cover", body: { entity_id: ["cover.bedroom_blinds", "cover.living_room_blinds"] } }])
      // A blind among them in one service call: the whole call is refused.
      const mixed = yield* Effect.flip(service.callService({ domain: "cover", service: "close_cover", target: { entityIds: ["cover.living_room_blinds", "cover.no_class"] } }))
      assert.strictEqual(mixed.reason, "refused")
      assert.strictEqual(ha.calls().length, 1)
      // The page says how many were left out for want of a class, and how to give a blind its class.
      const lists = String(kit.info()?.settings.values.lists)
      assert.include(lists, "1 cover has no class and is only read (give a blind its class in Home Assistant: the entity's settings, Show as)")
      assert.include(lists, "6 other covers (garage doors, gates, doors and the like) only read")
    }))

  it.effect("every cover action declares change only: there is no security path left to take", () =>
    Effect.gen(function*() {
      const { kit } = yield* start(defaultEntities())
      for (const action of ["covers_open", "covers_close", "covers_stop", "cover_position"]) assert.include(kit.toolNames(), `home-assistant_${action}`)
      // A house whose only cover is a garage door offers no cover action at all, and still reads it.
      const garage = yield* start({ "cover.garage_door": { name: "Garage door", state: "open", area: "garage", class: "garage" }, "light.hall": { name: "Hall", state: "off" } })
      assert.isFalse(garage.kit.toolNames().some((n) => /covers_|cover_position/.test(n)))
      assert.deepStrictEqual(yield* garage.kit.action("locks_status"), { ok: true, say: "Garage door is open." })
    }))
})

describe("home-assistant: scenes run only when everything they set is something the module changes itself", () => {
  const scenes: Record<string, FakeEntity> = {
    "scene.unlock_house": { name: "Unlock house", state: "x", members: ["light.ceiling", "lock.front_door"] },
    "scene.disarm": { name: "Disarm", state: "x", members: ["alarm_control_panel.home"] },
    "scene.open_garage": { name: "Open garage", state: "x", members: ["cover.garage_door", "light.kitchen"] },
    "scene.open_gate": { name: "Open gate", state: "x", members: ["cover.gate"] },
    "scene.coffee": { name: "Coffee", state: "x", members: ["switch.coffee"] },
    "scene.mystery": { name: "Mystery", state: "x" },
    "scene.evening": { name: "Evening", state: "x", members: ["light.ceiling", "cover.living_room_blinds", "climate.living_room", "media_player.kitchen"] }
  }
  const aliases = Object.keys(scenes).map((id) => `${id}: ${scenes[id]!.name!.toLowerCase()}`).join("\n")
  const entities = () => ({ ...defaultEntities(), "cover.gate": { name: "Gate", state: "closed", class: "gate" }, ...scenes })

  it.effect("a lock, an alarm, a garage door or a gate through a scene, a scene of something else, a scene that lists nothing: refused with why, by action and tool", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start(entities(), aliases)
      const unsafe = "it sets something I don't change by voice, such as a lock, an alarm or a garage door."
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        ["unlock house", "scene.unlock_house", `I don't start Unlock house: ${unsafe}`],
        ["disarm", "scene.disarm", `I don't start Disarm: ${unsafe}`],
        ["open garage", "scene.open_garage", `I don't start Open garage: ${unsafe}`],
        ["open gate", "scene.open_gate", `I don't start Open gate: ${unsafe}`],
        ["coffee", "scene.coffee", `I don't start Coffee: ${unsafe}`],
        ["mystery", "scene.mystery", "I don't start Mystery: Home Assistant doesn't say what it sets."]
      ]
      for (const [name, id, said] of cases) {
        assert.deepStrictEqual(yield* kit.action("scene_activate", { scene: name }), { ok: true, say: said }, name)
        assert.deepStrictEqual(yield* kit.action("scene_activate", { scene: id }), { ok: true, say: said }, id)
        assert.strictEqual((yield* kit.tool("home-assistant_scene_activate", { scene: id })).value, said, id)
      }
      assert.deepStrictEqual(ha.calls(), [])
      // The one scene of lights, blinds, a thermostat and a media player runs.
      assert.deepStrictEqual(yield* kit.action("scene_activate", { scene: "evening" }), { ok: true, say: "I've started Evening." })
      assert.deepStrictEqual(ha.calls(), [{ service: "scene.turn_on", body: { entity_id: ["scene.evening"] } }])
      assert.include(String(kit.info()?.settings.values.lists), "scenes that can be started: Evening")
    }))

  it.effect("a consumer of the service reaches no scene; a house with only unsafe scenes offers no scene action", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start(entities(), aliases)
      for (const id of [...Object.keys(scenes), "scene.movie_time"]) {
        const e = yield* Effect.flip(service.callService({ domain: "scene", service: "turn_on", target: { entityIds: [id] } }))
        assert.include(["refused", "unknown_entity"], e.reason, id)
      }
      assert.deepStrictEqual(ha.calls(), [])
      const only = yield* start({ ...defaultEntities(), "scene.unlock_house": scenes["scene.unlock_house"]! }, "scene.unlock_house: unlock house")
      assert.notInclude(only.kit.toolNames(), "home-assistant_scene_activate")
    }))

  it.effect("a scene whose entities change in Home Assistant to include a lock is refused at once, by the module's own checked path too", () =>
    Effect.gen(function*() {
      const { ha, kit } = yield* start(entities(), aliases)
      ha.entities["scene.evening"]!.members = ["light.ceiling", "lock.front_door"]
      yield* kit.advance(60_000)
      assert.deepStrictEqual(yield* kit.action("scene_activate", { scene: "evening" }), { ok: true, say: "I don't start Evening: it sets something I don't change by voice, such as a lock, an alarm or a garage door." })
      assert.deepStrictEqual(ha.calls(), [])
    }))
})
