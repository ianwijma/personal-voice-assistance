import { type Connector, makeCachedJson, type Resolver, userAgent } from "@pva/net"
import { Data, Effect, Schema } from "effect"

/** What the weather extension takes from its tests: the resolver and connector of `@pva/net` (absent: the real ones). */
export interface WeatherNet {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
export const FORECAST_API = "https://api.open-meteo.com/v1/forecast"

export class WeatherError extends Data.TaggedError("WeatherError")<{ readonly reason: "unreachable" | "unreadable" | "no-place" | "unknown-place" }> {}

/** The longest place name, region or country kept from the geocoder: one line of at most this many characters. */
export const PLACE_CHARS = 80

/** Outside text as one line of at most `max` characters: no control or bidirectional characters, no lone surrogates. */
export const oneLine = (text: string, max = PLACE_CHARS): string => {
  const one = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩‎‏؜]+/gu, " ")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return one.length <= max ? one : one.slice(0, max).replace(/[\ud800-\udbff]$/, "").trimEnd()
}

const RawPlace = Schema.Struct({
  name: Schema.String,
  latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  country: Schema.optionalKey(Schema.String),
  admin1: Schema.optionalKey(Schema.String)
})
/** A place as the extension keeps it: every name cut to one line of `PLACE_CHARS`; outside text all the same. */
export interface Place {
  readonly name: string
  readonly latitude: number
  readonly longitude: number
  readonly country?: string
  readonly admin1?: string
}
const Geocoding = Schema.Struct({ results: Schema.optionalKey(Schema.Array(RawPlace).check(Schema.isMaxLength(100))) })

const SERIES = 400
const Times = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000_000 }))).check(Schema.isMaxLength(SERIES))
const Numbers = Schema.Array(Schema.NullOr(Schema.Finite)).check(Schema.isMaxLength(SERIES))
/** Only what is read, with epoch timestamps (`timeformat=unixtime`); anything else in the answer is ignored. */
const RawForecast = Schema.Struct({
  timezone: Schema.String.check(Schema.isMaxLength(64)),
  minutely_15: Schema.optionalKey(Schema.Struct({ time: Times, precipitation: Numbers })),
  hourly: Schema.Struct({ time: Times, temperature_2m: Numbers, precipitation_probability: Numbers, weather_code: Numbers }),
  daily: Schema.Struct({
    time: Times,
    weather_code: Numbers,
    temperature_2m_max: Numbers,
    temperature_2m_min: Numbers,
    precipitation_probability_max: Numbers,
    wind_speed_10m_max: Numbers
  })
})
export type Forecast = typeof RawForecast.Type

const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The forecast's own checks: its zone is an IANA zone this machine knows, and each series is as long as its times. */
const checkForecast = (f: Forecast): boolean => {
  const same = (times: ReadonlyArray<number>, ...series: ReadonlyArray<ReadonlyArray<unknown>>) => series.every((s) => s.length === times.length)
  return isZone(f.timezone) &&
    (f.minutely_15 === undefined || same(f.minutely_15.time, f.minutely_15.precipitation)) &&
    same(f.hourly.time, f.hourly.temperature_2m, f.hourly.precipitation_probability, f.hourly.weather_code) &&
    same(f.daily.time, f.daily.weather_code, f.daily.temperature_2m_max, f.daily.temperature_2m_min, f.daily.precipitation_probability_max, f.daily.wind_speed_10m_max)
}

/** The most any one answer may be: 256 KiB (a week of hourly data is about 20 KiB). */
const MAX_BYTES = 256 * 1024
export const FORECAST_TTL_MS = 10 * 60_000

/** "Paris, France" is searched as "Paris", preferring a result whose region or country matches the rest. */
const pickPlace = (results: ReadonlyArray<Place>, query: string): Place | undefined => {
  const qualifier = query.split(",").slice(1).join(" ").trim().toLowerCase()
  return (qualifier.length > 0 ? results.find((r) => [r.country, r.admin1].some((s) => s !== undefined && s.toLowerCase().includes(qualifier))) : undefined) ?? results[0]
}

const placeOf = (raw: typeof RawPlace.Type): Place | undefined => {
  const name = oneLine(raw.name)
  if (name === "") return undefined
  const country = raw.country === undefined ? "" : oneLine(raw.country)
  const admin1 = raw.admin1 === undefined ? "" : oneLine(raw.admin1)
  return { name, latitude: raw.latitude, longitude: raw.longitude, ...(country !== "" ? { country } : {}), ...(admin1 !== "" ? { admin1 } : {}) }
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
      fetch: { timeoutMs: Math.max(1, Math.round(options.timeoutMs)), maxBytes: MAX_BYTES, ...net }
    }).pipe(
      Effect.mapError(() => new WeatherError({ reason: "unreachable" })),
      Effect.flatMap((r) => Schema.decodeUnknownEffect(schema)(r.value).pipe(Effect.map((value) => ({ value, ageMs: r.ageMs, source: r.source })), Effect.mapError(() => new WeatherError({ reason: "unreadable" }))))
    )

  return {
    /** A place by name (home, or what the person said); results are kept a day. Its names are outside text, cut to one line. */
    place: (query: string, timeoutMs: number, contact: string | undefined) =>
      Effect.gen(function*() {
        const name = query.split(",")[0]!.trim()
        if (name === "") return yield* new WeatherError({ reason: "unknown-place" })
        const url = `${GEOCODE_URL}?${new URLSearchParams({ name, count: "10", language: "en", format: "json" })}`
        const { value } = yield* get(url, Geocoding as Schema.Codec<typeof Geocoding.Type, unknown>, { ttlMs: 86_400_000, staleIfErrorMs: 7 * 86_400_000, timeoutMs, contact })
        const found = pickPlace((value.results ?? []).flatMap((r) => placeOf(r) ?? []), query)
        return found === undefined ? yield* new WeatherError({ reason: "unknown-place" }) : found
      }),
    /**
     * Rain, hourly and daily data for a place, with epoch timestamps and the place's IANA zone; coordinates are rounded to
     * two decimals (about a kilometre) before they leave the house.
     */
    forecast: (place: Place, fahrenheit: boolean, timeoutMs: number, contact: string | undefined) => {
      const params = new URLSearchParams({
        latitude: roundCoord(place.latitude),
        longitude: roundCoord(place.longitude),
        timezone: "auto",
        timeformat: "unixtime",
        forecast_days: "7",
        minutely_15: "precipitation",
        past_minutely_15: "2",
        forecast_minutely_15: "12",
        hourly: "temperature_2m,precipitation_probability,weather_code",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
        ...(fahrenheit ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph" } : {})
      })
      return get(`${FORECAST_API}?${params}`, RawForecast as Schema.Codec<Forecast, unknown>, { ttlMs: FORECAST_TTL_MS, staleIfErrorMs: 3 * 3_600_000, timeoutMs, contact }).pipe(
        Effect.flatMap((r) => (checkForecast(r.value) ? Effect.succeed(r) : Effect.fail(new WeatherError({ reason: "unreadable" }))))
      )
    }
  }
}
export type WeatherClient = ReturnType<typeof makeWeatherClient>
