// Piece D: the demo home and the clock and weather actions (docs/AGENTS-AND-INTENTS.md §3.9).
import { assert, describe, it } from "@effect/vitest"
import { makeModuleHost, readOnlyPersistence, type RegisteredAction } from "@pva/core"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { clockActions, clockModule } from "../src/clock.ts"
import { demoHomeContributions, demoHomeModule, houseFrom, houseProblem, makeDemoHouse } from "../src/demoHome.ts"
import { makeWeatherParts, weatherModule } from "../src/weather.ts"

const byId = (actions: ReadonlyArray<{ readonly id: string }>, id: string) => actions.find((a) => a.id === id)! as RegisteredAction["definition"]

describe("demo home", () => {
  it.effect("switches rooms, lamps and everything; says which lights are on", () =>
    Effect.gen(function*() {
      const house = makeDemoHouse()
      let changes = 0
      const { actions, tools } = demoHomeContributions(house, () => changes++)
      const on = byId(actions, "lights_on")
      const off = byId(actions, "lights_off")
      const status = byId(actions, "lights_status")
      assert.strictEqual(on.announce!({ target: "area:living_room" }), "Living room lights on.")
      assert.deepStrictEqual(yield* status.run({}), { say: "All lights are off." })
      yield* on.run({ target: "area:kitchen" })
      yield* on.run({ target: "light:desk_lamp" })
      assert.deepStrictEqual(yield* status.run({}), { say: "The kitchen and the desk lamp are on." })
      yield* on.run({ target: "all" })
      assert.deepStrictEqual(yield* status.run({}), { say: "All lights are on." })
      yield* off.run({ target: "all" })
      assert.strictEqual(house.onCount(), 0)
      assert.strictEqual(changes, 4)
      assert.strictEqual(tools[0]!.name, "demo_home_state")
      assert.isTrue(status.speculative)
      assert.isTrue(byId(actions, "all_off").confirm === true)
    }))

  it.effect("set_brightness dims a room and turns it on; 0 turns it off", () =>
    Effect.gen(function*() {
      const house = makeDemoHouse()
      const dim = byId(demoHomeContributions(house).actions, "set_brightness")
      assert.strictEqual(dim.announce!({ target: "area:living_room", level: 40 }), "Living room lights at 40 percent.")
      yield* dim.run({ target: "area:living_room", level: 40 })
      assert.deepStrictEqual(house.lightsOf("area:living_room").map((l) => [l.on, l.brightness]), [[true, 40], [true, 40]])
      yield* dim.run({ target: "area:living_room", level: 0 })
      assert.strictEqual(house.onCount(), 0)
    }))

  it("offers one target per room, per named lamp, and all lights", () => {
    const house = makeDemoHouse()
    assert.deepStrictEqual(house.targets.map((t) => t.value), [
      "area:living_room",
      "area:kitchen",
      "area:bedroom",
      "area:office",
      "light:desk_lamp",
      "light:reading_lamp",
      "all"
    ])
  })

  it.effect("as a module: enabled by default, actions in the snapshot, generated tools, status line", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [demoHomeModule], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      const snapshot = host.snapshot()
      assert.deepStrictEqual(snapshot.actions.map((a) => a.id), [
        "demo-home.lights_on",
        "demo-home.lights_off",
        "demo-home.set_brightness",
        "demo-home.lights_status",
        "demo-home.all_off"
      ])
      assert.deepStrictEqual(snapshot.registry.specs.map((s) => s.name), [
        "demo_home_state",
        "demo-home_lights_on",
        "demo-home_lights_off",
        "demo-home_set_brightness",
        "demo-home_lights_status",
        "demo-home_all_off"
      ])
      const result = yield* snapshot.registry.run({ id: "1", name: "demo-home_lights_on", input: { target: "the lounge" } })
      assert.deepStrictEqual([result.isError, result.content], [false, "Living room lights on."])
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 0)))
      assert.strictEqual(host.modules()[0]!.status?.text, "4 rooms · 2 lights on")
    })))
})

describe("demo home ids (review round 1)", () => {
  const room = (name: string) => ({ name, aliases: [] as Array<string> })
  const lamp = (name: string, inRoom: string) => ({ name, room: inRoom, aliases: [] as Array<string> })

  it("refuses names that would share an id: punctuation, non-Latin names, a lamp named like a main light", () => {
    assert.match(houseProblem([room("Living room"), room("Living-room")], []) ?? "", /"Living room" and "Living-room" are too alike/)
    assert.match(houseProblem([room("Living room"), room("living  room!")], []) ?? "", /too alike/)
    assert.match(houseProblem([room("Kitchen")], [lamp("Kitchen main", "Kitchen")]) ?? "", /"Kitchen main" is too alike to "Kitchen light"/)
    assert.match(houseProblem([room("Hall")], [lamp("Desk lamp", "Hall"), lamp("Desk-lamp", "Hall")]) ?? "", /too alike/)
    // Names without an ASCII form get ids by place, so they do not clash.
    assert.strictEqual(houseProblem([room("寝室"), room("台所")], [lamp("ランプ", "寝室")]), undefined)
    assert.strictEqual(houseProblem([room("Café"), room("Cafe bar")], []), undefined)
  })

  it("switches one room only when two rooms differ in letters a slug would lose", () =>
    Effect.runSync(Effect.gen(function*() {
      const house = houseFrom({ rooms: [room("寝室"), room("台所")], lights: [lamp("ランプ", "台所")] })
      assert.deepStrictEqual(house.rooms.map((r) => r.id), ["room_1", "room_2"])
      assert.deepStrictEqual(house.lamps.map((l) => [l.id, l.room]), [["lamp_1", "room_2"]])
      const { actions } = demoHomeContributions(house)
      yield* byId(actions, "lights_on").run({ target: "area:room_1" })
      assert.deepStrictEqual(house.lights.filter((l) => l.on).map((l) => l.name), ["寝室 light"])
    })))

  it.effect("the module refuses such a house at start, and the records refuse the lamps when saved", () =>
    Effect.gen(function*() {
      const host = yield* makeModuleHost({
        catalog: [demoHomeModule],
        persistence: readOnlyPersistence({ modules: { "demo-home": { enabled: true, settings: { rooms: [room("Kitchen")], lights: [lamp("Kitchen main", "Kitchen")] } } }, secrets: {} }),
        env: {}
      })
      yield* host.startEnabled
      assert.match(host.modules()[0]!.error ?? "", /too alike/)
      const saved = yield* host.configure("demo-home", { values: { lights: [lamp("Desk lamp", "Kitchen"), lamp("Desk_lamp", "Kitchen")] }, secrets: {} })
      assert.isFalse(saved.ok)
    }))
})

describe("clock.time_now", () => {
  const at = Date.UTC(2026, 10, 13, 13, 32) // 14:32 in Amsterdam

  it.effect("says the local time, or the time in a named place; read-only", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(at)
      const [timeNow] = clockActions({ timeZone: "Europe/Amsterdam", locale: "en-GB" })
      assert.isTrue(timeNow!.speculative)
      assert.deepStrictEqual(yield* timeNow!.run({ zone: undefined }), { say: "It's 14:32." })
      assert.deepStrictEqual(yield* timeNow!.run({ zone: "Asia/Tokyo" }), { say: "In Tokyo it's 22:32." })
    }))

  it.effect("the module contributes the action and keeps the current_time tool; the action becomes clock_time_now", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [clockModule], persistence: readOnlyPersistence(), env: { CLOCK_TIME_ZONE: "Europe/Amsterdam" } })
      yield* host.startEnabled
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), ["current_time", "clock_time_now"])
      assert.deepStrictEqual(host.snapshot().actions.map((a) => a.id), ["clock.time_now"])
    })))
})

describe("weather.today", () => {
  const geocoding = { results: [{ name: "Amsterdam", latitude: 52.37, longitude: 4.89, country: "Netherlands", admin1: "North Holland" }] }
  const forecast = {
    current: { time: "2026-11-13T11:45", temperature_2m: 11.6, apparent_temperature: 9.2, weather_code: 61, wind_speed_10m: 14.4 },
    daily: { weather_code: [80], temperature_2m_max: [14.2], temperature_2m_min: [8.9], precipitation_probability_max: [70] }
  }
  const urls: Array<URL> = []
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    urls.push(url)
    return new Response(JSON.stringify(url.host.startsWith("geocoding") ? geocoding : forecast))
  }) as typeof globalThis.fetch

  it.effect("says the weather for the named place or home; trailing words are dropped", () =>
    Effect.gen(function*() {
      const { today } = makeWeatherParts({ fetch, defaultPlace: "Amsterdam" })
      assert.deepStrictEqual(yield* today.run({ place: undefined }), { say: "Amsterdam: light rain, 12 degrees; 9 to 14 today." })
      urls.length = 0
      yield* today.run({ place: "Amsterdam today?" })
      assert.deepStrictEqual(urls.map((u) => u.host), ["api.open-meteo.com"], "the geocode was cached under the cleaned name")
      assert.isTrue(today.speculative)
      assert.isFalse(today.offerAsTool)
    }))

  it.effect("without a place or a home location it fails with a spoken reason", () =>
    Effect.gen(function*() {
      const { today } = makeWeatherParts({ fetch })
      const error = yield* Effect.flip(today.run({ place: undefined }))
      assert.match(error.message, /set a home location/)
    }))

  it.effect("the module offers its actions but no generated tool (each has a tool of its own, or is for the typed path only)", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [weatherModule({ fetch })], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      // `weather` and the three tools of the local-info extension; the four actions are not also tools.
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), ["weather", "weather_rain_soon", "weather_forecast", "weather_warnings"])
      assert.deepStrictEqual(host.snapshot().actions.map((a) => a.id), ["weather.today", "weather.rain_soon", "weather.tomorrow", "weather.warnings"])
    })))
})
