import { type Connector, makeCachedJson, type Resolver, userAgent } from "@pva/net"
import { Data, Effect, Schema } from "effect"

/** What the weather extension takes from its tests: the resolver and connector of `@pva/net` (absent: the real ones). */
export interface WeatherNet {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
export const FORECAST_API = "https://api.open-meteo.com/v1/forecast"
export const WARNINGS_FEED = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-"

export class WeatherError extends Data.TaggedError("WeatherError")<{ readonly reason: "unreachable" | "unreadable" | "no-place" | "unknown-place" }> {}

const Place = Schema.Struct({
  name: Schema.String,
  latitude: Schema.Finite,
  longitude: Schema.Finite,
  country: Schema.optionalKey(Schema.String),
  admin1: Schema.optionalKey(Schema.String)
})
export type Place = typeof Place.Type
const Geocoding = Schema.Struct({ results: Schema.optionalKey(Schema.Array(Place)) })

const Numbers = Schema.Array(Schema.NullOr(Schema.Finite))
const Strings = Schema.Array(Schema.String)
/** Only what is read; anything else in the answer is ignored. */
export const Forecast = Schema.Struct({
  utc_offset_seconds: Schema.Finite,
  minutely_15: Schema.optionalKey(Schema.Struct({ time: Strings, precipitation: Numbers })),
  hourly: Schema.Struct({ time: Strings, temperature_2m: Numbers, precipitation_probability: Numbers, weather_code: Numbers }),
  daily: Schema.Struct({
    time: Strings,
    weather_code: Numbers,
    temperature_2m_max: Numbers,
    temperature_2m_min: Numbers,
    precipitation_probability_max: Numbers,
    wind_speed_10m_max: Numbers
  })
})
export type Forecast = typeof Forecast.Type

/** The most any one answer may be: 256 KiB (a week of hourly data is about 20 KiB). */
const MAX_BYTES = 256 * 1024
export const FORECAST_TTL_MS = 10 * 60_000
export const WARNINGS_TTL_MS = 15 * 60_000

/** "Paris, France" is searched as "Paris", preferring a result whose region or country matches the rest. */
const pickPlace = (results: ReadonlyArray<Place>, query: string): Place | undefined => {
  const qualifier = query.split(",").slice(1).join(" ").trim().toLowerCase()
  return (qualifier.length > 0 ? results.find((r) => [r.country, r.admin1].some((s) => s !== undefined && s.toLowerCase().includes(qualifier))) : undefined) ?? results[0]
}

const roundCoord = (n: number) => n.toFixed(2)

/** The extension's outside calls: every request `safeFetch` (through `makeCachedJson`), with a time limit and a size limit, cached in this part. */
export const makeWeatherClient = (net: WeatherNet) => {
  const cached = makeCachedJson()
  const get = <A, I>(url: string, schema: Schema.Codec<A, I>, options: { readonly ttlMs: number; readonly staleIfErrorMs: number; readonly timeoutMs: number; readonly contact: string | undefined }) =>
    cached.getJson(url, {
      ttlMs: options.ttlMs,
      staleIfErrorMs: options.staleIfErrorMs,
      headers: { "user-agent": userAgent(options.contact) },
      fetch: { timeoutMs: options.timeoutMs, maxBytes: MAX_BYTES, ...net }
    }).pipe(
      Effect.mapError(() => new WeatherError({ reason: "unreachable" })),
      Effect.flatMap((r) => Schema.decodeUnknownEffect(schema)(r.value).pipe(Effect.map((value) => ({ value, ageMs: r.ageMs, source: r.source })), Effect.mapError(() => new WeatherError({ reason: "unreadable" }))))
    )

  return {
    /** A place by name (home, or what the person said); results are kept a day. */
    place: (query: string, timeoutMs: number, contact: string | undefined) =>
      Effect.gen(function*() {
        const name = query.split(",")[0]!.trim()
        if (name === "") return yield* new WeatherError({ reason: "unknown-place" })
        const url = `${GEOCODE_URL}?${new URLSearchParams({ name, count: "10", language: "en", format: "json" })}`
        const { value } = yield* get(url, Geocoding as Schema.Codec<typeof Geocoding.Type, unknown>, { ttlMs: 86_400_000, staleIfErrorMs: 7 * 86_400_000, timeoutMs, contact })
        const found = pickPlace(value.results ?? [], query)
        return found === undefined ? yield* new WeatherError({ reason: "unknown-place" }) : found
      }),
    /** Rain, hourly and daily data for a place; coordinates are rounded to two decimals (about a kilometre) before they leave the house. */
    forecast: (place: Place, fahrenheit: boolean, timeoutMs: number, contact: string | undefined) => {
      const params = new URLSearchParams({
        latitude: roundCoord(place.latitude),
        longitude: roundCoord(place.longitude),
        timezone: "auto",
        forecast_days: "7",
        minutely_15: "precipitation",
        forecast_minutely_15: "8",
        hourly: "temperature_2m,precipitation_probability,weather_code",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
        ...(fahrenheit ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph" } : {})
      })
      return get(`${FORECAST_API}?${params}`, Forecast as Schema.Codec<Forecast, unknown>, { ttlMs: FORECAST_TTL_MS, staleIfErrorMs: 3 * 3_600_000, timeoutMs, contact })
    },
    /** The warnings feed of a country, as the service's own JSON; `parseWarnings` reads it. */
    warnings: (country: string, timeoutMs: number, contact: string | undefined) => {
      const slug = country.toLowerCase().normalize("NFKD").replace(/[^a-z\s-]/g, "").trim().replace(/\s+/g, "-")
      if (slug === "") return Effect.fail(new WeatherError({ reason: "unknown-place" }))
      return get(`${WARNINGS_FEED}${slug}`, Schema.Unknown as Schema.Codec<unknown, unknown>, { ttlMs: WARNINGS_TTL_MS, staleIfErrorMs: 3_600_000, timeoutMs, contact })
    }
  }
}
export type WeatherClient = ReturnType<typeof makeWeatherClient>
