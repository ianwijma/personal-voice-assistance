/**
 * Weather warnings from MeteoAlarm's CAP feed for a country (`feeds.meteoalarm.org/api/v1/warnings/feeds-<country>`), read by
 * hand and strictly: the feed is the fragile part of this module (docs/research/modules/local-info.md §5), so a document that is
 * not what was expected is `unreadable`, never "no warnings". The shape read here is the one the service documents; it has not
 * been checked against the live service by the author (no network), which the module's page says.
 */
export type Level = "yellow" | "orange" | "red"

export interface Warning {
  readonly level: Level
  /** MeteoAlarm's awareness type number (1 wind … 12 rain and flooding), when the feed gave one. */
  readonly type: number | undefined
  /** The feed's own name for the phenomenon, used when the type is not one of the module's. */
  readonly event: string
  readonly area: string
  readonly fromMs: number | undefined
  readonly untilMs: number | undefined
}

export type WarningsResult = { readonly _tag: "ok"; readonly warnings: ReadonlyArray<Warning> } | { readonly _tag: "unreadable" }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, max) : "")
const time = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/** At most this many alerts of one feed are read, and this many areas of one alert: the feed is outside data. */
export const MAX_ALERTS = 500
const MAX_AREAS = 200

const levelOf = (value: unknown): Level | undefined => {
  const word = text(value).split(";")[1]?.trim().toLowerCase()
  return word === "yellow" || word === "orange" || word === "red" ? word : undefined
}

/** The warnings of a feed document that are in force or begin within `horizonMs` of `nowMs`. */
export const parseWarnings = (json: unknown, nowMs: number, horizonMs: number): WarningsResult => {
  if (!isRecord(json) || !Array.isArray(json.warnings)) return { _tag: "unreadable" }
  const found: Array<Warning> = []
  let readable = 0
  const alerts = json.warnings.slice(0, MAX_ALERTS)
  for (const entry of alerts) {
    const alert = isRecord(entry) && isRecord(entry.alert) ? entry.alert : undefined
    if (alert === undefined || !Array.isArray(alert.info)) continue
    readable++
    const infos = alert.info.filter(isRecord)
    // One language is enough (the phenomenon and level come from the parameters, which every language repeats).
    const info = infos.find((i) => text(i.language).toLowerCase().startsWith("en")) ?? infos[0]
    if (info === undefined) continue
    const params = Array.isArray(info.parameter) ? info.parameter.filter(isRecord) : []
    const param = (name: string) => params.find((p) => text(p.valueName).toLowerCase() === name)?.value
    const level = levelOf(param("awareness_level"))
    if (level === undefined) continue
    const typeNumber = Number(text(param("awareness_type")).split(";")[0]?.trim())
    const fromMs = time(info.onset) ?? time(info.effective)
    const untilMs = time(info.expires)
    if (untilMs !== undefined && untilMs <= nowMs) continue
    if (fromMs !== undefined && fromMs > nowMs + horizonMs) continue
    const areas = Array.isArray(info.area) ? info.area.filter(isRecord).slice(0, MAX_AREAS) : []
    for (const area of areas) {
      const name = text(area.areaDesc, 100)
      if (name !== "") found.push({ level, type: Number.isInteger(typeNumber) ? typeNumber : undefined, event: text(info.event, 100), area: name, fromMs, untilMs })
    }
  }
  // A feed with alerts of which none could be read is a feed that changed, not a quiet day.
  if (alerts.length > 0 && readable === 0) return { _tag: "unreadable" }
  return { _tag: "ok", warnings: found }
}

const rank: Record<Level, number> = { yellow: 1, orange: 2, red: 3 }

/** The warnings that name the place (its region or its own name), most severe first, the same warning once. */
export const forPlace = (warnings: ReadonlyArray<Warning>, place: { readonly name: string; readonly admin1?: string | undefined }): ReadonlyArray<Warning> => {
  const names = [place.admin1, place.name].filter((n): n is string => n !== undefined && n.length > 0).map((n) => n.toLowerCase())
  const seen = new Set<string>()
  return warnings
    .filter((w) => names.some((n) => w.area.toLowerCase().includes(n) || n.includes(w.area.toLowerCase())))
    .filter((w) => {
      const key = `${w.type}:${w.level}:${w.area}:${w.untilMs}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => rank[b.level] - rank[a.level] || (a.untilMs ?? 0) - (b.untilMs ?? 0))
}
