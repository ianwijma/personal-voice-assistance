// The built-in modules as per-assistant instances (docs/ASSISTANTS.md §2.6, WP-12a/12b): the clock with an
// assistant's own date format answers that assistant in it; the weather's place and units follow the linked
// defaults (Home) unless set.
import { assert, describe, it } from "@effect/vitest"
import { type ModuleDemand, type ModuleHost, makeModuleHost, readOnlyPersistence, type Tool } from "@pva/core"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { clockModule } from "../src/clock.ts"
import { weatherModule } from "../src/weather.ts"

const tool = (host: ModuleHost, assistant: string, name: string): Tool | undefined =>
  (host.snapshot().assistantParts.get(assistant) ?? []).flatMap((p) => p.module.tools ?? []).find((t) => t.name === name)

describe("built-in modules per assistant", () => {
  it.effect("clock: an own date format runs a second instance and each assistant gets its own answer; the fields are overridable", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.UTC(2026, 10, 13, 10, 45))
      const demand: Array<ModuleDemand> = [{ assistantId: "jeff" }, { assistantId: "t3", own: { locale: "nl-NL" } }, { assistantId: "x", own: { locale: "en-GB" } }]
      const host = yield* makeModuleHost({
        catalog: [clockModule],
        persistence: readOnlyPersistence(),
        env: {},
        demand: () => new Map([["clock", demand]]),
        defaults: () => ({ timeZone: "Europe/Amsterdam", locale: "en-GB" })
      })
      yield* host.startEnabled
      const clock = host.modules()[0]!
      assert.deepStrictEqual(clock.settings.fields.map((f) => [f.key, f.overridable === true]), [["timeZone", true], ["locale", true]])
      assert.deepStrictEqual(clock.instances?.map((i) => i.assistants), [["jeff", "x"], ["t3"]])
      const jeff = (yield* tool(host, "jeff", "current_time")!.execute({ timeZone: "Europe/Amsterdam" })) as { date: string }
      const t3 = (yield* tool(host, "t3", "current_time")!.execute({ timeZone: "Europe/Amsterdam" })) as { date: string }
      assert.strictEqual(jeff.date, "Friday, 13 November 2026")
      assert.strictEqual(t3.date, "vrijdag 13 november 2026")
      // The context of each assistant (sent with every turn) is its own instance's.
      const context = (assistant: string) =>
        Effect.forEach(host.snapshot().assistantParts.get(assistant)!.flatMap((p) => p.module.context ?? []), (c) => c.get)
      assert.match((yield* context("jeff"))[0]!, /^It is Friday, 13 November 2026, 11:45 local time \(Europe\/Amsterdam\)\.$/)
      assert.match((yield* context("t3"))[0]!, /^It is vrijdag 13 november 2026, 11:45 local time \(Europe\/Amsterdam\)\.$/)
    }).pipe(Effect.scoped))

  it.effect("weather: the place and units follow the linked defaults (Home) unless set; an assistant's own units win", () =>
    Effect.gen(function*() {
      const urls: Array<URL> = []
      const fetch = (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input)
        urls.push(url)
        const body = url.host.startsWith("geocoding")
          ? { results: [{ name: "Utrecht", latitude: 52.09, longitude: 5.12, country: "Netherlands" }] }
          : {
            current: { time: "2026-11-13T11:45", temperature_2m: 50, apparent_temperature: 48, weather_code: 3, wind_speed_10m: 9 },
            daily: { weather_code: [3], temperature_2m_max: [52], temperature_2m_min: [44], precipitation_probability_max: [10] }
          }
        return new Response(JSON.stringify(body))
      }) as typeof globalThis.fetch
      let home = { defaultPlace: "Utrecht, Netherlands", units: "fahrenheit" }
      const host = yield* makeModuleHost({
        catalog: [weatherModule({ fetch })],
        persistence: readOnlyPersistence(),
        env: {},
        demand: () => new Map([["weather", [{ assistantId: "jeff" }, { assistantId: "t3", own: { units: "celsius" } }]]]),
        defaults: () => home
      })
      yield* host.startEnabled
      const weather = host.modules()[0]!
      assert.deepStrictEqual([weather.settings.values.defaultPlace, weather.settings.values.units], ["Utrecht, Netherlands", "fahrenheit"])
      assert.deepStrictEqual(weather.settings.fields.map((f) => [f.key, f.overridable === true]), [["defaultPlace", true], ["units", true], ["timeoutMs", false]])
      assert.deepStrictEqual(weather.status, { text: "Home: Utrecht, Netherlands", tone: "neutral" })
      const jeff = (yield* tool(host, "jeff", "weather")!.execute({})) as { now: string }
      assert.strictEqual(urls[0]!.searchParams.get("name"), "Utrecht")
      assert.strictEqual(urls[1]!.searchParams.get("temperature_unit"), "fahrenheit")
      assert.match(jeff.now, /50°F/)
      yield* tool(host, "t3", "weather")!.execute({})
      assert.isNull(urls.at(-1)!.searchParams.get("temperature_unit"), "T3's own units: Celsius")
      // Home moves: the instance with the shared settings follows at the next refresh; a saved value wins over Home.
      home = { defaultPlace: "Paris, France", units: "fahrenheit" }
      yield* host.refresh
      assert.strictEqual(host.modules()[0]!.settings.values.defaultPlace, "Paris, France")
      yield* host.configure("weather", { values: { defaultPlace: "Delft" }, secrets: {} })
      home = { defaultPlace: "Rome", units: "fahrenheit" }
      yield* host.refresh
      assert.strictEqual(host.modules()[0]!.settings.values.defaultPlace, "Delft")
      assert.deepStrictEqual(host.modules()[0]!.status, { text: "Home: Delft", tone: "neutral" })
    }).pipe(Effect.scoped))
})
