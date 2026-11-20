// The cities the extended `current_time` knows by name (its `place` and `from` parameters): a time zone for each.
// Offline on purpose (no geocoder on the turn path); a place that is not here is
// answered with a question for a time zone. Names in English and Dutch.
export interface Place {
  readonly name: string
  readonly zone: string
  readonly aliases?: ReadonlyArray<string>
}

export const PLACES: ReadonlyArray<Place> = [
  { name: "Amsterdam", zone: "Europe/Amsterdam" },
  { name: "Rotterdam", zone: "Europe/Amsterdam" },
  { name: "The Hague", zone: "Europe/Amsterdam", aliases: ["Den Haag", "'s-Gravenhage"] },
  { name: "Utrecht", zone: "Europe/Amsterdam" },
  { name: "Eindhoven", zone: "Europe/Amsterdam" },
  { name: "Groningen", zone: "Europe/Amsterdam" },
  { name: "Maastricht", zone: "Europe/Amsterdam" },
  { name: "Brussels", zone: "Europe/Brussels", aliases: ["Brussel", "Bruxelles"] },
  { name: "Antwerp", zone: "Europe/Brussels", aliases: ["Antwerpen"] },
  { name: "London", zone: "Europe/London", aliases: ["Londen"] },
  { name: "Dublin", zone: "Europe/Dublin" },
  { name: "Paris", zone: "Europe/Paris", aliases: ["Parijs"] },
  { name: "Berlin", zone: "Europe/Berlin" },
  { name: "Frankfurt", zone: "Europe/Berlin" },
  { name: "Munich", zone: "Europe/Berlin", aliases: ["München"] },
  { name: "Madrid", zone: "Europe/Madrid" },
  { name: "Barcelona", zone: "Europe/Madrid" },
  { name: "Lisbon", zone: "Europe/Lisbon", aliases: ["Lissabon"] },
  { name: "Rome", zone: "Europe/Rome", aliases: ["Rome", "Roma"] },
  { name: "Vienna", zone: "Europe/Vienna", aliases: ["Wenen"] },
  { name: "Zurich", zone: "Europe/Zurich" },
  { name: "Copenhagen", zone: "Europe/Copenhagen", aliases: ["Kopenhagen"] },
  { name: "Stockholm", zone: "Europe/Stockholm" },
  { name: "Oslo", zone: "Europe/Oslo" },
  { name: "Helsinki", zone: "Europe/Helsinki" },
  { name: "Warsaw", zone: "Europe/Warsaw", aliases: ["Warschau"] },
  { name: "Prague", zone: "Europe/Prague", aliases: ["Praag"] },
  { name: "Athens", zone: "Europe/Athens", aliases: ["Athene"] },
  { name: "Istanbul", zone: "Europe/Istanbul" },
  { name: "Moscow", zone: "Europe/Moscow", aliases: ["Moskou"] },
  { name: "Cairo", zone: "Africa/Cairo", aliases: ["Caïro"] },
  { name: "Johannesburg", zone: "Africa/Johannesburg" },
  { name: "Nairobi", zone: "Africa/Nairobi" },
  { name: "Dubai", zone: "Asia/Dubai" },
  { name: "Mumbai", zone: "Asia/Kolkata", aliases: ["Bombay"] },
  { name: "Delhi", zone: "Asia/Kolkata", aliases: ["New Delhi"] },
  { name: "Bangkok", zone: "Asia/Bangkok" },
  { name: "Singapore", zone: "Asia/Singapore", aliases: ["Singapoer"] },
  { name: "Hong Kong", zone: "Asia/Hong_Kong" },
  { name: "Beijing", zone: "Asia/Shanghai", aliases: ["Peking"] },
  { name: "Shanghai", zone: "Asia/Shanghai" },
  { name: "Seoul", zone: "Asia/Seoul" },
  { name: "Tokyo", zone: "Asia/Tokyo" },
  { name: "Sydney", zone: "Australia/Sydney" },
  { name: "Melbourne", zone: "Australia/Melbourne" },
  { name: "Auckland", zone: "Pacific/Auckland" },
  { name: "New York", zone: "America/New_York", aliases: ["NYC"] },
  { name: "Washington", zone: "America/New_York" },
  { name: "Toronto", zone: "America/Toronto" },
  { name: "Chicago", zone: "America/Chicago" },
  { name: "Denver", zone: "America/Denver" },
  { name: "Los Angeles", zone: "America/Los_Angeles" },
  { name: "San Francisco", zone: "America/Los_Angeles" },
  { name: "Vancouver", zone: "America/Vancouver" },
  { name: "Mexico City", zone: "America/Mexico_City" },
  { name: "Sao Paulo", zone: "America/Sao_Paulo", aliases: ["São Paulo"] },
  { name: "Buenos Aires", zone: "America/Argentina/Buenos_Aires" },
  { name: "Paramaribo", zone: "America/Paramaribo" },
  { name: "Willemstad", zone: "America/Curacao", aliases: ["Curaçao"] }
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
