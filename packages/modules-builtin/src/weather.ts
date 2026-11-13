import { type AssistantModule, makeTool, ToolError } from "@pva/core"
import { Effect, Schema } from "effect"

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

/** WMO weather interpretation codes, as documented by Open-Meteo. */
const conditions: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail"
}
export const describeCode = (code: number | undefined): string =>
  code === undefined ? "unknown conditions" : conditions[code] ?? "unknown conditions"

/** "Amsterdam, North Holland, Netherlands" (parts that repeat or are missing are left out). */
const placeName = (p: Place) =>
  [...new Set([p.name, p.admin1, p.country].filter((s): s is string => s !== undefined && s.length > 0))].join(", ")

/**
 * Example of "a new way to fetch information": current weather and today's
 * forecast from Open-Meteo (no API key). Read-only, so it may run during a
 * speculative turn. Geocoding results are cached for the life of the process,
 * so a repeated place costs one HTTP request instead of two.
 */
export const weatherModule = (options: WeatherOptions = {}): AssistantModule => {
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
        const query = place?.trim() || options.defaultPlace
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

  return { name: "weather", tools: [weather] }
}
