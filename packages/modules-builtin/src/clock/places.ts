// The cities the extended `current_time` knows by name (its `place` parameter, and the home place of the sun times): a
// time zone and coordinates for each. Offline on purpose (no geocoder on the turn path); a place that is not here is
// answered with a question for a time zone. Names in English and Dutch.
export interface Place {
  readonly name: string
  readonly zone: string
  readonly lat: number
  readonly lon: number
  readonly aliases?: ReadonlyArray<string>
}

export const PLACES: ReadonlyArray<Place> = [
  { name: "Amsterdam", zone: "Europe/Amsterdam", lat: 52.37, lon: 4.9 },
  { name: "Rotterdam", zone: "Europe/Amsterdam", lat: 51.92, lon: 4.48 },
  { name: "The Hague", zone: "Europe/Amsterdam", lat: 52.08, lon: 4.31, aliases: ["Den Haag", "'s-Gravenhage"] },
  { name: "Utrecht", zone: "Europe/Amsterdam", lat: 52.09, lon: 5.12 },
  { name: "Eindhoven", zone: "Europe/Amsterdam", lat: 51.44, lon: 5.48 },
  { name: "Groningen", zone: "Europe/Amsterdam", lat: 53.22, lon: 6.57 },
  { name: "Maastricht", zone: "Europe/Amsterdam", lat: 50.85, lon: 5.69 },
  { name: "Brussels", zone: "Europe/Brussels", lat: 50.85, lon: 4.35, aliases: ["Brussel", "Bruxelles"] },
  { name: "Antwerp", zone: "Europe/Brussels", lat: 51.22, lon: 4.4, aliases: ["Antwerpen"] },
  { name: "London", zone: "Europe/London", lat: 51.51, lon: -0.13, aliases: ["Londen"] },
  { name: "Dublin", zone: "Europe/Dublin", lat: 53.35, lon: -6.26 },
  { name: "Paris", zone: "Europe/Paris", lat: 48.86, lon: 2.35, aliases: ["Parijs"] },
  { name: "Berlin", zone: "Europe/Berlin", lat: 52.52, lon: 13.4 },
  { name: "Frankfurt", zone: "Europe/Berlin", lat: 50.11, lon: 8.68 },
  { name: "Munich", zone: "Europe/Berlin", lat: 48.14, lon: 11.58, aliases: ["München"] },
  { name: "Madrid", zone: "Europe/Madrid", lat: 40.42, lon: -3.7 },
  { name: "Barcelona", zone: "Europe/Madrid", lat: 41.39, lon: 2.17 },
  { name: "Lisbon", zone: "Europe/Lisbon", lat: 38.72, lon: -9.14, aliases: ["Lissabon"] },
  { name: "Rome", zone: "Europe/Rome", lat: 41.9, lon: 12.5, aliases: ["Rome", "Roma"] },
  { name: "Vienna", zone: "Europe/Vienna", lat: 48.21, lon: 16.37, aliases: ["Wenen"] },
  { name: "Zurich", zone: "Europe/Zurich", lat: 47.38, lon: 8.54 },
  { name: "Copenhagen", zone: "Europe/Copenhagen", lat: 55.68, lon: 12.57, aliases: ["Kopenhagen"] },
  { name: "Stockholm", zone: "Europe/Stockholm", lat: 59.33, lon: 18.07 },
  { name: "Oslo", zone: "Europe/Oslo", lat: 59.91, lon: 10.75 },
  { name: "Helsinki", zone: "Europe/Helsinki", lat: 60.17, lon: 24.94 },
  { name: "Warsaw", zone: "Europe/Warsaw", lat: 52.23, lon: 21.01, aliases: ["Warschau"] },
  { name: "Prague", zone: "Europe/Prague", lat: 50.08, lon: 14.44, aliases: ["Praag"] },
  { name: "Athens", zone: "Europe/Athens", lat: 37.98, lon: 23.73, aliases: ["Athene"] },
  { name: "Istanbul", zone: "Europe/Istanbul", lat: 41.01, lon: 28.98 },
  { name: "Moscow", zone: "Europe/Moscow", lat: 55.76, lon: 37.62, aliases: ["Moskou"] },
  { name: "Cairo", zone: "Africa/Cairo", lat: 30.04, lon: 31.24, aliases: ["Caïro"] },
  { name: "Johannesburg", zone: "Africa/Johannesburg", lat: -26.2, lon: 28.05 },
  { name: "Nairobi", zone: "Africa/Nairobi", lat: -1.29, lon: 36.82 },
  { name: "Dubai", zone: "Asia/Dubai", lat: 25.2, lon: 55.27 },
  { name: "Mumbai", zone: "Asia/Kolkata", lat: 19.08, lon: 72.88, aliases: ["Bombay"] },
  { name: "Delhi", zone: "Asia/Kolkata", lat: 28.61, lon: 77.21, aliases: ["New Delhi"] },
  { name: "Bangkok", zone: "Asia/Bangkok", lat: 13.76, lon: 100.5 },
  { name: "Singapore", zone: "Asia/Singapore", lat: 1.35, lon: 103.82, aliases: ["Singapoer"] },
  { name: "Hong Kong", zone: "Asia/Hong_Kong", lat: 22.32, lon: 114.17 },
  { name: "Beijing", zone: "Asia/Shanghai", lat: 39.9, lon: 116.4, aliases: ["Peking"] },
  { name: "Shanghai", zone: "Asia/Shanghai", lat: 31.23, lon: 121.47 },
  { name: "Seoul", zone: "Asia/Seoul", lat: 37.57, lon: 126.98 },
  { name: "Tokyo", zone: "Asia/Tokyo", lat: 35.68, lon: 139.69 },
  { name: "Sydney", zone: "Australia/Sydney", lat: -33.87, lon: 151.21 },
  { name: "Melbourne", zone: "Australia/Melbourne", lat: -37.81, lon: 144.96 },
  { name: "Auckland", zone: "Pacific/Auckland", lat: -36.85, lon: 174.76 },
  { name: "New York", zone: "America/New_York", lat: 40.71, lon: -74.01, aliases: ["NYC"] },
  { name: "Washington", zone: "America/New_York", lat: 38.91, lon: -77.04 },
  { name: "Toronto", zone: "America/Toronto", lat: 43.65, lon: -79.38 },
  { name: "Chicago", zone: "America/Chicago", lat: 41.88, lon: -87.63 },
  { name: "Denver", zone: "America/Denver", lat: 39.74, lon: -104.99 },
  { name: "Los Angeles", zone: "America/Los_Angeles", lat: 34.05, lon: -118.24 },
  { name: "San Francisco", zone: "America/Los_Angeles", lat: 37.77, lon: -122.42 },
  { name: "Vancouver", zone: "America/Vancouver", lat: 49.28, lon: -123.12 },
  { name: "Mexico City", zone: "America/Mexico_City", lat: 19.43, lon: -99.13 },
  { name: "Sao Paulo", zone: "America/Sao_Paulo", lat: -23.55, lon: -46.63, aliases: ["São Paulo"] },
  { name: "Buenos Aires", zone: "America/Argentina/Buenos_Aires", lat: -34.6, lon: -58.38 },
  { name: "Paramaribo", zone: "America/Paramaribo", lat: 5.85, lon: -55.2 },
  { name: "Willemstad", zone: "America/Curacao", lat: 12.11, lon: -68.93, aliases: ["Curaçao"] }
]

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/** A place by its name or an alias (case, accents and punctuation ignored); `home` is a free text such as "Utrecht" or "Utrecht, Netherlands". */
export const findPlace = (text: string): Place | undefined => {
  const wanted = fold(text)
  if (wanted === "") return undefined
  const exact = PLACES.find((p) => [p.name, ...(p.aliases ?? [])].some((n) => fold(n) === wanted))
  if (exact !== undefined) return exact
  // "Utrecht, Netherlands": the first part before a comma.
  const head = fold(text.split(",")[0] ?? "")
  return head === wanted ? undefined : PLACES.find((p) => [p.name, ...(p.aliases ?? [])].some((n) => fold(n) === head))
}
