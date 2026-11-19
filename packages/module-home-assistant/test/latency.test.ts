// Latency tests (docs/MODULES.md §15 "Latency tests": this file imports latencyBound.ts, so it runs in the latency
// project, alone): how long the main thread stops while the largest supported house is polled, and while a request
// is resolved in it, through the action and the tool. The bound is the shared one (three times it on CI).
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HomeAssistant } from "@pva/module-contracts"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { HOUSE_LIMITS, homeAssistantModule, resolveInSentence, targetIndex } from "../src/index.ts"
import { configured, type FakeEntity, makeFakeHa } from "./fakeHa.ts"

const POLL = 60_000
const settle = Effect.repeat(Effect.yieldNow, { times: 400 })

/** `n` lights over 40 areas, with names like a real house's. */
const lights = (n: number, state = "off"): Record<string, FakeEntity> => {
  const out: Record<string, FakeEntity> = {}
  for (let i = 0; i < n; i++) out[`light.l${String(i).padStart(4, "0")}`] = { name: `Lamp ${i} by the window`, state, area: `area_${i % 40}`, brightness: 128 }
  return out
}
const areas40 = () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`area_${i}`, i === 0 ? "Kitchen" : `Room ${i}`]))

/** The longest gap between ticks of a 1 ms timer while `effect` runs: the longest the main thread was held. */
const longestStop = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    try {
      const value = yield* effect
      return { value, worst: Math.max(worst, performance.now() - last) }
    } finally {
      clearInterval(timer)
    }
  })

describe("home-assistant: the main thread, in the largest supported house", () => {
  it.effect(`a poll of the largest supported house holds the main thread less than 10 ms at a time`, () =>
    Effect.gen(function*() {
      const entities = lights(HOUSE_LIMITS.supported - 1)
      entities["person.sam"] = { name: "Sam", state: "home" }
      const ha = makeFakeHa({ areas: areas40(), entities })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      const service = kit.service(HomeAssistant)!
      for (const e of Object.values(entities)) e.state = e.state === "off" ? "on" : "not_home"
      // A 1 ms timer: the longest gap between its ticks is the longest the main thread was held.
      let last = performance.now()
      let worst = 0
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
      }, 1)
      try {
        // Two polls, so the second compares every entity with the first and publishes 2,000 changes.
        for (let poll = 0; poll < 2; poll++) {
          yield* kit.advance(POLL)
          yield* settle
          for (const e of Object.values(entities)) e.state = e.state === "on" ? "off" : e.state
        }
      } finally {
        clearInterval(timer)
      }
      worst = Math.max(worst, performance.now() - last)
      assert.strictEqual(service.entities().length, HOUSE_LIMITS.supported)
      // Both polls were taken in: the last one switched every light back off.
      assert.strictEqual(service.entity("light.l0000")?.state, "off")
      assert.strictEqual(service.entity("person.sam")?.state, "not_home")
      console.log(`longest stop during two polls of ${HOUSE_LIMITS.supported} entities: ${worst.toFixed(1)} ms`)
      assert.isBelow(worst, bound(10))
    }), 60_000)

  it.effect("resolving a five-word request holds the main thread less than 10 ms, through the action and the tool", () =>
    Effect.gen(function*() {
      // 2,000 lights with names of 80 characters (the longest a name is kept), so every target is free text.
      const entities: Record<string, FakeEntity> = {}
      for (let i = 0; i < HOUSE_LIMITS.supported; i++) {
        entities[`light.l${String(i).padStart(4, "0")}`] = { name: `Lamp ${i} ${"by the long window over the garden ".repeat(3)}`.slice(0, HOUSE_LIMITS.nameChars), state: "off", area: `area_${i % 40}` }
      }
      const ha = makeFakeHa({ areas: areas40(), entities })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      const request = "turn on the kitchen lights"
      // Warm: the first call compiles what every later one runs.
      for (let k = 0; k < 2; k++) yield* kit.action("lights_off", { target: request })
      const action = yield* longestStop(kit.action("lights_on", { target: request }))
      assert.deepStrictEqual(action.value, { ok: true, say: "I've turned on the lights in Kitchen." })
      const tool = yield* longestStop(kit.tool("home-assistant_lights_off", { target: request }))
      assert.strictEqual(tool.value.value, "I've turned off the lights in Kitchen.")
      console.log(`resolving "${request}" among ${HOUSE_LIMITS.supported} lights: longest stop ${action.worst.toFixed(1)} ms (action), ${tool.worst.toFixed(1)} ms (tool)`)
      assert.isBelow(action.worst, bound(10))
      assert.isBelow(tool.worst, bound(10))
    }), 60_000)

  it.effect("a phrase's answer with its list, in the largest supported house: what is on in a room holds the main thread less than 10 ms at a time", () =>
    Effect.gen(function*() {
      // 2,000 lights, all on, 50 to a room: the answer reads the house again, builds the list (twelve rows) and shows it.
      const ha = makeFakeHa({ areas: areas40(), entities: lights(HOUSE_LIMITS.supported, "on") })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      // Warm: the first call compiles what every later one runs.
      yield* kit.phrases.say("what is on in the kitchen", { device: "kitchen-display" })
      const first = yield* longestStop(kit.phrases.say("what is on in the kitchen", { device: "kitchen-display" }))
      assert.isTrue(first.value.taken)
      yield* kit.present.settle
      const shown = kit.present.shown("kitchen-display")
      assert.strictEqual(shown.length, 1)
      assert.strictEqual(shown[0]!.content.kind === "list" ? shown[0]!.content.items.length : 0, 12)
      // And the plain commands by phrase, as the device's own room.
      const off = yield* longestStop(kit.phrases.say("lights off", { device: "kitchen-display" }))
      assert.isTrue(off.value.taken)
      console.log(`"what is on in the kitchen" with its list among ${HOUSE_LIMITS.supported} lights: longest stop ${first.worst.toFixed(1)} ms; "lights off": ${off.worst.toFixed(1)} ms`)
      assert.isBelow(first.worst, bound(10))
      assert.isBelow(off.worst, bound(10))
    }), 60_000)

  it.effect("the lookup itself is a few map reads: a five-word request in the largest supported house", () =>
    Effect.gen(function*() {
      const areas = areas40()
      const entities = Array.from({ length: HOUSE_LIMITS.supported }, (_, i) => ({ i, name: `Lamp ${i} ${"by the long window over the garden ".repeat(3)}`.slice(0, HOUSE_LIMITS.nameChars) }))
      const house = {
        areas: Object.entries(areas).map(([id, name]) => ({ id, name, aliases: [] })),
        entities: entities.map(({ i, name }) => ({
          entityId: `light.l${String(i).padStart(4, "0")}`, domain: "light", kind: "light", name, aliases: [], state: "off", areaId: `area_${i % 40}`, deviceClass: undefined, brightnessPct: undefined, dimmable: true,
          currentTemperature: undefined, targetTemperature: undefined, hvacModes: [], position: undefined, supportedFeatures: undefined, unit: undefined, mediaTitle: undefined, mediaArtist: undefined,
          volumeLevel: undefined, lastChanged: 0, blind: false, members: undefined, runnable: false, notRunnable: undefined
        }))
      } as never as Parameters<typeof targetIndex>[0]
      const named = { ...house, byId: new Map(), incomplete: new Set(), leftOut: 0, secretDropped: 0, temperatureUnit: "C", fetchedAt: 0 } as never as Parameters<typeof targetIndex>[0]
      const index = targetIndex(named, "light")
      const times: Array<number> = []
      for (let k = 0; k < 20; k++) {
        const t0 = performance.now()
        const value = resolveInSentence(index, "turn on the kitchen lights", new Set(["turn", "on", "the", "lights"]))
        times.push(performance.now() - t0)
        assert.strictEqual(value, "area:area_0")
      }
      times.sort((a, b) => a - b)
      console.log(`resolveInSentence over ${index.options.length} options: median ${times[10]!.toFixed(3)} ms, worst ${times[19]!.toFixed(3)} ms`)
      assert.isBelow(times[19]!, bound(10))
    }))
})
