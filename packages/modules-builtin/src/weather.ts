import { ActionError, type AssistantModule, defineAction, defineModule, makeTool, Param, Setting, ToolError } from "@pva/core"
import { BriefingSections } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { makeWeatherClient, type WeatherClient, type WeatherNet } from "./weather/client.ts"
import { makeWeatherExtras, type WeatherSettingsView } from "./weather/extras.ts"
import { conditionsEn } from "./weather/words.ts"

export { type WeatherNet } from "./weather/client.ts"

export interface WeatherOptions {
  /** Place used when the user does not name one, e.g. "Amsterdam". */
  readonly defaultPlace?: string | undefined
  /** Default "celsius" (with km/h); "fahrenheit" uses mph. */
  readonly units?: "celsius" | "fahrenheit" | undefined
  /** Budget for the whole lookup (geocoding + forecast). Default 3000 ms: a voice reply cannot wait longer. */
  readonly timeoutMs?: number | undefined
  /** Injected in tests. Default: the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
}

export const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

// Only the fields we read; anything else in the responses is ignored.
const GeocodingResponse = Schema.Struct({
  results: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String,
    latitude: Schema.Finite,
    longitude: Schema.Finite,
    country: Schema.optional(Schema.String),
    admin1: Schema.optional(Schema.String)
  })))
})
type Place = NonNullable<typeof GeocodingResponse.Type["results"]>[number]

const ForecastResponse = Schema.Struct({
  current: Schema.Struct({
    time: Schema.String,
    temperature_2m: Schema.Finite,
    apparent_temperature: Schema.Finite,
    weather_code: Schema.Finite,
    wind_speed_10m: Schema.Finite
  }),
  daily: Schema.Struct({
    weather_code: Schema.Array(Schema.Finite),
    temperature_2m_max: Schema.Array(Schema.Finite),
    temperature_2m_min: Schema.Array(Schema.Finite),
    precipitation_probability_max: Schema.Array(Schema.NullOr(Schema.Finite))
  })
})

/** WMO weather interpretation codes, as documented by Open-Meteo: the English names are in `weather/words.ts`. */
export const describeCode = (code: number | undefined): string =>
  code === undefined ? "unknown conditions" : conditionsEn[code] ?? "unknown conditions"

/** "Amsterdam, North Holland, Netherlands" (parts that repeat or are missing are left out). */
const placeName = (p: Place) =>
  [...new Set([p.name, p.admin1, p.country].filter((s): s is string => s !== undefined && s.length > 0))].join(", ")

/**
 * Example of "a new way to fetch information": current weather and today's
 * forecast from Open-Meteo (no API key). Read-only, so it may run during a
 * speculative turn. Geocoding results are cached for the life of the process,
 * so a repeated place costs one HTTP request instead of two.
 */
export const makeWeather = (options: WeatherOptions = {}): AssistantModule => {
  const { tool } = makeWeatherParts(options)
  return { name: "weather", tools: [tool] }
}

/** Words that may trail a spoken place but are not part of it ("in Paris today"). */
const TRAILING = /\s+(today|now|right now|tomorrow|please|vandaag|nu|morgen|alsjeblieft)$/i

/** The `weather` tool and the `today` action of one instance, sharing the geocode cache. */
export const makeWeatherParts = (options: WeatherOptions = {}) => {
  const fetchFn = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 3000
  const fahrenheit = options.units === "fahrenheit"
  const deg = fahrenheit ? "°F" : "°C"
  const speed = fahrenheit ? "mph" : "km/h"
  const geocache = new Map<string, Place>()

  const getJson = <S extends Schema.Codec<any, unknown>>(url: URL, schema: S) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchFn(url, { signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<unknown>
      },
      catch: (cause) =>
        new ToolError({ message: `Weather service request failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((e) => e instanceof ToolError ? e : new ToolError({ message: "Weather service sent an unexpected response", cause: e }))
    )

  /** "Paris, France": search "Paris" and prefer a result whose region or country matches the rest. */
  const geocode = (query: string) =>
    Effect.gen(function*() {
      const key = query.trim().toLowerCase()
      const cached = geocache.get(key)
      if (cached !== undefined) return cached
      const [name = "", ...rest] = query.split(",").map((s) => s.trim())
      const url = new URL(GEOCODING_URL)
      url.search = new URLSearchParams({ name, count: "10", language: "en", format: "json" }).toString()
      const { results = [] } = yield* getJson(url, GeocodingResponse)
      const qualifier = rest.join(" ").toLowerCase()
      const place = (qualifier.length > 0
        ? results.find((r) => [r.country, r.admin1].some((s) => s !== undefined && s.toLowerCase().includes(qualifier)))
        : undefined) ?? results[0]
      if (place === undefined) return yield* new ToolError({ message: `No place called "${query}" found` })
      geocache.set(key, place)
      return place
    })

  const forecast = (place: Place) => {
    const url = new URL(FORECAST_URL)
    url.search = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "auto",
      forecast_days: "1",
      ...(fahrenheit ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph" } : {})
    }).toString()
    return getJson(url, ForecastResponse)
  }

  const round = (n: number) => Math.round(n)

  const weather = makeTool({
    name: "weather",
    description: "Current weather and today's forecast for a place (city name, optionally with region or country, " +
      "e.g. \"Paris, France\"). Omit the place for the user's home location.",
    parameters: Schema.Struct({
      place: Schema.optional(Schema.String.annotate({ description: "City name, optionally followed by a comma and region or country" }))
    }),
    speculative: true,
    execute: ({ place }) =>
      Effect.gen(function*() {
        const query = place?.trim() || options.defaultPlace?.trim()
        if (query === undefined || query.length === 0) {
          return yield* new ToolError({ message: "No place given and no home location configured; ask the user where" })
        }
        const location = yield* geocode(query)
        const { current: now, daily } = yield* forecast(location)
        const rain = daily.precipitation_probability_max[0]
        const min = daily.temperature_2m_min[0]
        const max = daily.temperature_2m_max[0]
        return {
          place: placeName(location),
          localTime: now.time,
          now: `${describeCode(now.weather_code)}, ${round(now.temperature_2m)}${deg} (feels like ${
            round(now.apparent_temperature)
          }${deg}), wind ${round(now.wind_speed_10m)} ${speed}`,
          today: describeCode(daily.weather_code[0]) +
            (min === undefined || max === undefined ? "" : `, ${round(min)} to ${round(max)}${deg}`) +
            (rain === undefined || rain === null ? "" : `, ${rain}% chance of precipitation`)
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new ToolError({ message: `Weather service did not answer within ${timeoutMs} ms` }))
        })
      )
  })

  /**
   * The `today` action (docs/AGENTS-AND-INTENTS.md §3.9): read-only, so it may
   * run during a speculative turn; not offered as a tool (the `weather` tool
   * exists). "Amsterdam: light rain, 12 degrees; 9 to 14 today."
   */
  const today = defineAction({
    id: "today",
    label: "Tell the weather",
    description: "Say the current weather and today's forecast, at home or in a named city.",
    examples: ["what's the weather like", "what is the weather in Paris", "hoe is het weer", "wat voor weer is het in Utrecht"],
    params: {
      // "wat voor weer is het in Utrecht": "voor" after "wat" is "what kind of", not "for <place>".
      place: Param.text({ label: "Place", after: ["in", "for", "at", "voor", "te"], notAfter: ["wat"], maxWords: 4, optional: true })
    },
    speculative: true,
    offerAsTool: false,
    run: ({ place }) =>
      Effect.gen(function*() {
        const named = place?.replace(/[.!?,]+$/, "").replace(TRAILING, "").trim()
        const query = named || options.defaultPlace?.trim()
        if (query === undefined || query.length === 0) {
          return yield* new ActionError({ message: "I don't know where home is: set a home location in the weather options." })
        }
        const location = yield* geocode(query)
        const { current: now, daily } = yield* forecast(location)
        const min = daily.temperature_2m_min[0]
        const max = daily.temperature_2m_max[0]
        const unit = fahrenheit ? "degrees Fahrenheit" : "degrees"
        return {
          say: `${location.name}: ${describeCode(now.weather_code)}, ${round(now.temperature_2m)} ${unit}` +
            (min === undefined || max === undefined ? "." : `; ${round(min)} to ${round(max)} today.`)
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new ActionError({ message: "The weather service did not answer in time." }))
        }),
        Effect.mapError((e) => e instanceof ActionError ? e : new ActionError({ message: "The weather service did not answer.", cause: e }))
      )
  })

  return { tool: weather, today }
}

/**
 * The weather module: the `weather` tool and `today` action below (Open-Meteo, one request each), and the extension of the
 * local-info pull request in `weather/` (rain in the next hours, a forecast of a day this week, and a briefing section),
 * which fetch through `@pva/net`. The geocode cache of the first two lives in the instance, so
 * changed settings start with a fresh cache; the extension's cache lives in the module's shared part. `fetch` is injected in
 * tests of the first two, `resolver` and `connector` in tests of the extension.
 */
export const weatherModule = (deps: { readonly fetch?: typeof globalThis.fetch } & WeatherNet = {}) =>
  defineModule({
    apiVersion: 2,
    id: "weather",
    name: "Weather",
    description: "Current weather, rain in the next hours and forecasts from Open-Meteo (no account needed).",
    settings: {
      defaultPlace: Setting.text({
        label: "Home location",
        description: "Used when you don't name a place. Follows Home's location unless set here.",
        placeholder: "Amsterdam, Netherlands",
        env: "WEATHER_DEFAULT_PLACE",
        maxLength: 200,
        overridable: true
      }),
      units: Setting.choice({
        label: "Units",
        env: "WEATHER_UNITS",
        default: "celsius",
        options: [{ value: "celsius", label: "Celsius, km/h" }, { value: "fahrenheit", label: "Fahrenheit, mph" }],
        overridable: true
      }),
      timeoutMs: Setting.number({
        label: "Timeout",
        description: "Longest a lookup may take; a spoken reply cannot wait much longer.",
        default: 3000,
        integer: true,
        min: 500,
        max: 10_000,
        step: 100,
        unit: "ms",
        advanced: true
      })
    },
    requires: [{ network: "internet", why: "Fetches forecasts from Open-Meteo." }],
    // Nothing to check without the network, and no setting is required: the place can be said in each question.
    health: () => Effect.succeed([]),
    shared: (ctx) =>
      Effect.sync(() => {
        const client = makeWeatherClient({ ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}), ...(deps.connector !== undefined ? { connector: deps.connector } : {}) })
        const extras = makeWeatherExtras({ client: () => client, view: () => ctx.host.view(), settings: (turn) => ctx.settingsFor(turn?.assistantId) as WeatherSettingsView | undefined })
        return { value: { client }, contributions: extras.sections.map((s) => BriefingSections.of(s)) }
      }),
    start: ({ setStatus, settings, shared, host }) =>
      Effect.sync(() => {
        const home = settings.defaultPlace.trim()
        setStatus(home === "" ? undefined : { text: `Home: ${home}`.slice(0, 120), tone: "neutral" })
        const { today, tool } = makeWeatherParts({ ...settings, ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}) })
        // Looked up when a call runs, never at start: what the host gave this instance is used only while it runs.
        const extras = makeWeatherExtras({
          client: () => (shared as { readonly client: WeatherClient }).client,
          view: () => host.view(),
          settings: () => settings
        })
        return { tools: [tool, ...extras.tools], actions: [today, ...extras.actions] }
      })
  })
