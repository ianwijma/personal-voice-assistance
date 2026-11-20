// What Open-Meteo answers, as fixtures for the offline network: epoch timestamps (`timeformat=unixtime`) and the place's
// IANA zone, as the extension asks for them. The test clock stands at Wednesday 18 November 2026, 10:00 in Amsterdam
// (09:00 UTC).

export const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
export const FORECAST = "https://api.open-meteo.com/v1/forecast"

export const utrecht = { name: "Utrecht", latitude: 52.09, longitude: 5.12, country: "Netherlands", admin1: "Utrecht" }
export const maastricht = { name: "Maastricht", latitude: 50.85, longitude: 5.69, country: "Netherlands", admin1: "Limburg" }

/** A geocoding answer that knows these places by name; any other name finds nothing. */
export const geocoding = (known: ReadonlyArray<{ readonly name: string }> = [utrecht, maastricht]) => (request: { readonly url: URL }) => {
  const name = request.url.searchParams.get("name")?.toLowerCase()
  const results = known.filter((p) => p.name.toLowerCase() === name)
  return { body: results.length === 0 ? {} : { results } }
}

const sec = (ms: number) => Math.round(ms / 1000)
/** 09:00 UTC on the 18th: 10:00 in Amsterdam. */
export const T0 = Date.UTC(2026, 10, 18, 9)

export interface ForecastOptions {
  /** Precipitation (mm) of consecutive quarter-hours from `rainFrom`; default twelve dry ones. */
  readonly rain?: ReadonlyArray<number | null> | undefined
  /** The quarter-hours' own times, epoch ms (instead of consecutive ones from `rainFrom`). */
  readonly rainTimes?: ReadonlyArray<number> | undefined
  readonly rainFrom?: number | undefined
  readonly noRain?: boolean | undefined
  /** The first daily row: 0 is the 18th, -1 the 17th. */
  readonly firstDay?: number | undefined
  /** The first hourly row, epoch ms (default local midnight of the 18th). */
  readonly hourlyFrom?: number | undefined
  readonly rainChance?: ((localHour: number, i: number) => number | null) | undefined
  readonly temperature?: ((localHour: number, i: number) => number | null) | undefined
  readonly timezone?: string | undefined
}

/**
 * A forecast for Utrecht: quarter-hours of precipitation from 10:00 on the 18th; hourly rows for three days from local
 * midnight (temperature 6 + hour/3, a 60 percent chance of rain from 14:00 to 17:00, else 10); daily rows for a week (each
 * row's time its local midnight, as Open-Meteo writes it).
 */
export const forecast = (options: ForecastOptions = {}) => {
  const rain = options.rain ?? Array.from({ length: 12 }, () => 0)
  const rainFrom = options.rainFrom ?? T0
  const minutely = options.rainTimes ?? rain.map((_, i) => rainFrom + i * 15 * 60_000)
  const hourlyFrom = options.hourlyFrom ?? Date.UTC(2026, 10, 17, 23)
  const hours = Array.from({ length: 72 }, (_, h) => hourlyFrom + h * 3_600_000)
  const localHour = (ms: number) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", hourCycle: "h23" }).format(new Date(ms)))
  const first = options.firstDay ?? 0
  const days = Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 10, 17 + first + i, 23))
  return {
    latitude: 52.1,
    utc_offset_seconds: 3600,
    timezone: options.timezone ?? "Europe/Amsterdam",
    ...(options.noRain === true ? {} : { minutely_15: { time: minutely.map(sec), precipitation: rain } }),
    hourly: {
      time: hours.map(sec),
      temperature_2m: hours.map((t, i) => (options.temperature ?? ((h: number) => 6 + h / 3))(localHour(t), i)),
      precipitation_probability: hours.map((t, i) => (options.rainChance ?? ((h: number) => (h >= 14 && h <= 17 ? 60 : 10)))(localHour(t), i)),
      weather_code: hours.map(() => 3)
    },
    daily: {
      time: days.map(sec),
      weather_code: [3, 61, 80, 3, 0, 71, 95],
      temperature_2m_max: [11.4, 12.6, 9.2, 8, 7.1, 1.4, -0.6],
      temperature_2m_min: [6.2, 8.1, 5.5, 3.2, 0.4, -2.2, -3.1],
      precipitation_probability_max: [10, 70, 90, 20, 0, 30, 60],
      wind_speed_10m_max: [20, 35, 50, 10, 5, 15, 60]
    }
  }
}

export const json = { "content-type": "application/json" }
