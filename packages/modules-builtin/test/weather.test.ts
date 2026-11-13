import { assert, describe, it } from "@effect/vitest"
import { makeToolRegistry, resolveSettings, type ToolResult } from "@pva/core"
import { Effect } from "effect"
import { makeWeather, weatherModule, type WeatherOptions } from "../src/weather.ts"

const geocoding = {
  results: [
    { name: "Paris", latitude: 33.66, longitude: -95.56, country: "United States", admin1: "Texas" },
    { name: "Paris", latitude: 48.85, longitude: 2.35, country: "France", admin1: "Île-de-France" }
  ]
}
const forecast = {
  latitude: 48.86,
  current_units: { temperature_2m: "°C" },
  current: { time: "2026-11-13T11:45", temperature_2m: 11.6, apparent_temperature: 9.2, weather_code: 61, wind_speed_10m: 14.4 },
  daily: {
    time: ["2026-11-13"],
    weather_code: [80],
    temperature_2m_max: [13.1],
    temperature_2m_min: [7.8],
    precipitation_probability_max: [70]
  }
}

/** A `fetch` stand-in that answers from `routes` (by host) and records every URL. No network. */
const fakeFetch = (routes: Record<string, () => Response | Promise<Response>>) => {
  const urls: Array<URL> = []
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    urls.push(url)
    const route = routes[url.host]
    if (route === undefined) throw new TypeError(`fetch failed: no route for ${url.host}`)
    return route()
  }) as typeof globalThis.fetch
  return { fetch, urls }
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })

const ok = { "geocoding-api.open-meteo.com": json(geocoding), "api.open-meteo.com": json(forecast) }

const run = (options: WeatherOptions, input: unknown): Effect.Effect<ToolResult> =>
  makeToolRegistry([makeWeather(options)]).run({ id: "1", name: "weather", input })

describe("weather module", () => {
  it.effect("geocodes the place, prefers the named country, returns a compact summary", () =>
    Effect.gen(function*() {
      const { fetch, urls } = fakeFetch(ok)
      const result = yield* run({ fetch }, { place: "Paris, France" })
      assert.isFalse(result.isError, result.content)
      assert.deepStrictEqual(JSON.parse(result.content), {
        place: "Paris, Île-de-France, France",
        localTime: "2026-11-13T11:45",
        now: "light rain, 12°C (feels like 9°C), wind 14 km/h",
        today: "light rain showers, 8 to 13°C, 70% chance of precipitation"
      })
      assert.strictEqual(urls[0]!.searchParams.get("name"), "Paris")
      assert.strictEqual(urls[1]!.searchParams.get("latitude"), "48.85")
      assert.strictEqual(urls[1]!.searchParams.get("timezone"), "auto")
      assert.isNull(urls[1]!.searchParams.get("temperature_unit"))
    }))

  it.effect("uses the home location and units, and caches geocoding", () =>
    Effect.gen(function*() {
      const { fetch, urls } = fakeFetch(ok)
      const registry = makeToolRegistry([makeWeather({ fetch, defaultPlace: "Paris", units: "fahrenheit" })])
      const first = yield* registry.run({ id: "1", name: "weather", input: {} })
      assert.match(JSON.parse(first.content).place, /^Paris, Texas/)
      assert.match(JSON.parse(first.content).now, /°F .* mph$/)
      yield* registry.run({ id: "2", name: "weather", input: { place: "paris" } })
      assert.deepStrictEqual(urls.map((u) => u.host), ["geocoding-api.open-meteo.com", "api.open-meteo.com", "api.open-meteo.com"])
      assert.strictEqual(urls[1]!.searchParams.get("temperature_unit"), "fahrenheit")
      assert.isTrue(registry.isSpeculative("weather"))
    }))

  it.effect("failures become ToolErrors for the model", () =>
    Effect.gen(function*() {
      const noPlace = yield* run({ fetch: fakeFetch(ok).fetch }, {})
      assert.deepStrictEqual([noPlace.isError, noPlace.content], [true, "No place given and no home location configured; ask the user where"])

      const unknown = yield* run({ fetch: fakeFetch({ "geocoding-api.open-meteo.com": json({}) }).fetch }, { place: "Atlantis" })
      assert.deepStrictEqual([unknown.isError, unknown.content], [true, "No place called \"Atlantis\" found"])

      const http = yield* run({ fetch: fakeFetch({ ...ok, "api.open-meteo.com": json({ error: true }, 500) }).fetch }, { place: "Paris" })
      assert.deepStrictEqual([http.isError, http.content], [true, "Weather service request failed: HTTP 500"])

      const garbage = yield* run({ fetch: fakeFetch({ ...ok, "api.open-meteo.com": json({ current: {} }) }).fetch }, { place: "Paris" })
      assert.deepStrictEqual([garbage.isError, garbage.content], [true, "Weather service sent an unexpected response"])

      const offline = yield* run({ fetch: fakeFetch({}).fetch }, { place: "Paris" })
      assert.deepStrictEqual([offline.isError, offline.content], [true, "Weather service request failed: fetch failed: no route for geocoding-api.open-meteo.com"])
    }))

  it.live("gives up after the timeout and aborts the request", () =>
    Effect.gen(function*() {
      let aborted = false
      const fetch = ((_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        })) as typeof globalThis.fetch
      const result = yield* run({ fetch, timeoutMs: 50 }, { place: "Paris" })
      assert.deepStrictEqual([result.isError, result.content], [true, "Weather service did not answer within 50 ms"])
      assert.isTrue(aborted)
    }))

  it("exposes an optional place parameter", () => {
    const [spec] = makeToolRegistry([makeWeather()]).specs
    assert.strictEqual(spec!.name, "weather")
    assert.isUndefined(spec!.inputSchema.required)
    assert.property(spec!.inputSchema.properties as object, "place")
  })
})

describe("weather module definition", () => {
  it.effect("environment values lock fields; start publishes the home location and uses the injected fetch", () =>
    Effect.gen(function*() {
      const { fetch, urls } = fakeFetch(ok)
      const module = weatherModule({ fetch })
      const resolved = resolveSettings(module.settings, {
        stored: { defaultPlace: "Paris, France" },
        secrets: {},
        env: { WEATHER_UNITS: "fahrenheit" }
      })
      assert.deepStrictEqual(resolved.value, { defaultPlace: "Paris, France", units: "fahrenheit", timeoutMs: 3000 })
      assert.deepStrictEqual(resolved.form.fields.find((f) => f.key === "units")?.locked, { reason: "Set by WEATHER_UNITS in the environment" })
      const statuses: Array<unknown> = []
      const instance = yield* Effect.scoped(module.start({ settings: resolved.value!, setStatus: (s) => statuses.push(s) }))
      assert.deepStrictEqual(statuses, [{ text: "Home: Paris, France", tone: "neutral" }])
      const result = yield* makeToolRegistry([{ name: "weather", ...instance }]).run({ id: "1", name: "weather", input: {} })
      assert.match(JSON.parse(result.content).now, /°F/)
      assert.strictEqual(urls.length, 2)
    }))

  it("an invalid environment value is reported on the field", () => {
    const resolved = resolveSettings(weatherModule().settings, { stored: {}, secrets: {}, env: { WEATHER_UNITS: "kelvin" } })
    assert.deepStrictEqual(resolved.form.errors, [{ key: "units", message: "WEATHER_UNITS=kelvin is not valid: Must be one of: celsius, fahrenheit" }])
  })
})
