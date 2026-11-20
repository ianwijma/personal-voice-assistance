/**
 * What a collection is, as plain data, and the calendar arithmetic around it. No library here: this file is loaded on the
 * main thread and in the calendar reader's worker (`readCalendar.task.ts`), which is the only place `ical.js` is imported.
 */

/** The most bytes of calendar text read: `safeFetch`'s `maxBytes`. */
export const ICS_MAX_BYTES = 256 * 1024
/** The most collections kept: the next ones from today, in order. */
export const MAX_COLLECTIONS = 60
/** The most events (VEVENTs) a calendar may have; more is a calendar this module does not read. */
export const MAX_EVENTS = 2_000
/** The most steps of recurrence expansion over the whole calendar; more is a calendar this module does not read. */
export const MAX_WORK = 20_000
/** How far ahead the reader looks for them. */
export const HORIZON_DAYS = 400

/** The kinds of bin the module knows by name; anything else is `other`, with the calendar's own words as its label. */
export const BIN_KINDS = ["gft", "paper", "plastic", "rest", "glass", "other"] as const
export type BinKind = (typeof BIN_KINDS)[number]

/**
 * One collection: an all-day entry has its calendar date `d` (20261119); a timed one its instant `t` (epoch ms), whose
 * date is found in the household's zone when it is answered, so a change of zone changes the answer without a refresh.
 * Exactly one of the two is set.
 */
export interface Entry {
  readonly d?: number
  readonly t?: number
  readonly k: BinKind
  /** The calendar's own words or the owner's name for the bin (one line, at most 60 characters): outside text. */
  readonly l?: string
}

export interface OwnerRule {
  /** Words that must appear in the calendar's title (any case). */
  readonly match: string
  /** What the bin is called. */
  readonly label: string
}

/** Words (their beginnings) that name a kind, Dutch and English. Checked in this order. */
const KEYWORDS: ReadonlyArray<readonly [Exclude<BinKind, "other">, ReadonlyArray<string>]> = [
  ["gft", ["gft", "groen", "groente", "organic", "green", "compost", "bioafval", "biobak"]],
  ["paper", ["papier", "paper", "karton", "cardboard", "oud-papier"]],
  ["plastic", ["pmd", "plastic", "verpakking", "packag", "drankkarton", "blik"]],
  ["glass", ["glas", "glass"]],
  ["rest", ["rest", "grij", "grey", "gray", "general", "residual", "zwart", "black"]]
]

const tokens = (text: string): ReadonlyArray<string> => text.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((t) => t.length > 0)

/** The kind a title names, or `undefined`. */
export const classify = (text: string): Exclude<BinKind, "other"> | undefined => {
  const words = tokens(text)
  for (const [kind, starts] of KEYWORDS) {
    if (words.some((w) => starts.some((s) => w.startsWith(s)))) return kind
  }
  return undefined
}

/** The kind a word the person said names ("pmd", "groen", "papier", "glass"): the same table. */
export const kindOfSpoken = (text: string): BinKind | undefined => classify(text)

const clean = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]+/gu, " ").replace(/\s+/g, " ").trim()

/** A calendar's title as a one-line label of at most 60 characters, without lone surrogates; "" when nothing is left. */
export const labelOf = (text: string): string => {
  const one = clean(text).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
  return one.length <= 60 ? one : one.slice(0, 60).replace(/[\ud800-\udbff]$/, "").trimEnd()
}

/** What bin a calendar title is: the owner's mapping first, then the built-in words, else `other` with its own words. */
export const binOf = (summary: string, rules: ReadonlyArray<OwnerRule>): { readonly k: BinKind; readonly l?: string } | undefined => {
  const lower = summary.toLowerCase()
  const rule = rules.find((r) => r.match.trim() !== "" && lower.includes(r.match.trim().toLowerCase()))
  if (rule !== undefined) {
    const label = labelOf(rule.label)
    const k = classify(label) ?? classify(summary) ?? "other"
    return { k, ...(label === "" ? {} : { l: label }) }
  }
  const k = classify(summary)
  if (k !== undefined) return { k }
  const label = labelOf(summary)
  return label === "" ? undefined : { k: "other", l: label }
}

export const dayNumber = (y: number, m: number, d: number): number => y * 10_000 + m * 100 + d

/** The date a moment falls on in `zone`, as `20261119`. */
export const dayIn = (epochMs: number, zone: string): number => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return dayNumber(get("year"), get("month"), get("day"))
}

/** `20261119` as `{ year, month, day }`. */
export const localDate = (day: number) => ({ year: Math.floor(day / 10_000), month: Math.floor(day / 100) % 100, day: day % 100 })

/** The day `n` days after `day`, in the calendar (no zone needed). */
export const addDays = (day: number, n: number): number => {
  const d = localDate(day)
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n))
  return dayNumber(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** Days since 1970-01-01 of a day number. */
export const epochDay = (day: number): number => {
  const d = localDate(day)
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000)
}

/** The date of an entry in `zone`. */
export const dayOfEntry = (e: Entry, zone: string): number => (e.d !== undefined ? e.d : dayIn(e.t!, zone))

/** The owner's names as the task's input carries them. */
export const rulesJsonOf = (rules: ReadonlyArray<OwnerRule>): string => JSON.stringify(rules.map((r) => ({ match: r.match, label: r.label })))

/** The owner's names from the input's JSON text, or `undefined` when it is not of the allowed shape. */
export const rulesFromJson = (json: string): ReadonlyArray<OwnerRule> | undefined => {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Array.isArray(value) || value.length > 12) return undefined
  const rules: Array<OwnerRule> = []
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined
    const { match, label } = item as Record<string, unknown>
    if (typeof match !== "string" || typeof label !== "string" || match.length > 40 || label.length > 40 || Object.keys(item).length !== 2) return undefined
    rules.push({ match, label })
  }
  return rules
}
