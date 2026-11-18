// What Open-Meteo and MeteoAlarm answer, as fixtures for the offline network. The test clock stands at Wednesday 18 November
// 2026, 10:00 in Amsterdam (09:00 UTC).

export const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
export const FORECAST = "https://api.open-meteo.com/v1/forecast"
export const FEED = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-netherlands"

export const utrecht = { name: "Utrecht", latitude: 52.09, longitude: 5.12, country: "Netherlands", admin1: "Utrecht" }
export const maastricht = { name: "Maastricht", latitude: 50.85, longitude: 5.69, country: "Netherlands", admin1: "Limburg" }

/** A geocoding answer that knows these places by name; any other name finds nothing. */
export const geocoding = (known: ReadonlyArray<typeof utrecht> = [utrecht, maastricht]) => (request: { readonly url: URL }) => {
  const name = request.url.searchParams.get("name")?.toLowerCase()
  const results = known.filter((p) => p.name.toLowerCase() === name)
  return { body: results.length === 0 ? {} : { results } }
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * A forecast for Utrecht from 10:00 on the 18th: `rain` is the eight quarter-hours of precipitation (mm) from 10:00, the daily
 * rows are a week from the 18th, and the hourly rows are three days of `temperature(hour)`.
 */
export const forecast = (options: { readonly rain?: ReadonlyArray<number | null> | undefined; readonly noRain?: boolean | undefined } = {}) => {
  const rain = options.rain ?? [0, 0, 0, 0, 0, 0, 0, 0]
  const minutely = rain.map((_, i) => `2026-11-18T${pad(10 + Math.floor(i / 4))}:${pad((i % 4) * 15)}`)
  const hours = Array.from({ length: 72 }, (_, h) => `2026-11-${pad(18 + Math.floor(h / 24))}T${pad(h % 24)}:00`)
  return {
    latitude: 52.1,
    utc_offset_seconds: 3600,
    ...(options.noRain === true ? {} : { minutely_15: { time: minutely, precipitation: rain } }),
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, h) => 6 + (h % 24) / 3),
      precipitation_probability: hours.map((_, h) => (h % 24 >= 14 && h % 24 <= 17 ? 60 : 10)),
      weather_code: hours.map(() => 3)
    },
    daily: {
      time: ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"],
      weather_code: [3, 61, 80, 3, 0, 71, 95],
      temperature_2m_max: [11.4, 12.6, 9.2, 8, 7.1, 1.4, -0.6],
      temperature_2m_min: [6.2, 8.1, 5.5, 3.2, 0.4, -2.2, -3.1],
      precipitation_probability_max: [10, 70, 90, 20, 0, 30, 60],
      wind_speed_10m_max: [20, 35, 50, 10, 5, 15, 60]
    }
  }
}

const warning = (area: ReadonlyArray<string>, level: string, type: string, onset: string, expires: string, extra: Record<string, unknown> = {}) => ({
  alert: {
    identifier: `id-${area.join("-")}-${type}`,
    info: [
      {
        language: "en-GB",
        event: "Weather warning",
        onset,
        expires,
        parameter: [{ valueName: "awareness_level", value: level }, { valueName: "awareness_type", value: type }],
        area: area.map((areaDesc) => ({ areaDesc })),
        ...extra
      }
    ]
  }
})

/** The Dutch feed: yellow wind for Utrecht and Flevoland until 18:00 local, orange snow for Limburg, and others that do not count. */
export const feed = (extra: ReadonlyArray<unknown> = []) => ({
  warnings: [
    warning(["Utrecht", "Flevoland"], "2; yellow; Moderate", "1; Wind", "2026-11-18T08:00:00+00:00", "2026-11-18T17:00:00+00:00"),
    warning(["Limburg"], "3; orange; Severe", "2; snow/ice", "2026-11-18T12:00:00+00:00", "2026-11-19T12:00:00+00:00"),
    // Over already, and far in the future, and green: none of them is a warning now.
    warning(["Utrecht"], "2; yellow; Moderate", "3; Thunderstorms", "2026-11-17T08:00:00+00:00", "2026-11-18T07:00:00+00:00"),
    warning(["Utrecht"], "3; orange; Severe", "10; Rain", "2026-11-25T08:00:00+00:00", "2026-11-25T17:00:00+00:00"),
    warning(["Utrecht"], "1; green; Minor", "1; Wind", "2026-11-18T08:00:00+00:00", "2026-11-18T17:00:00+00:00"),
    ...extra
  ]
})

export const json = { "content-type": "application/json" }
