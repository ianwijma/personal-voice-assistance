import { type HostView, type Row, StoreError, type StoreFailure } from "@pva/core"
import { type LocalDate, normalizeTimeZone, speakDuration, speakList } from "@pva/language"
import { isLine, type Language } from "@pva/module-contracts"
import { Effect } from "effect"

/**
 * What the two modules of this package share: the household's zone, local dates of instants, names as people say them,
 * the bounded scan of a collection, and how a store failure is worded. Pure helpers; nothing here keeps state.
 */

/**
 * The household's zone, canonical: `HOME_TIME_ZONE` trimmed and read by `@pva/language`'s `normalizeTimeZone` (the Home
 * section accepts it with spaces around it), and when it is empty or not a zone this machine knows, this machine's
 * (docs/MODULES.md §6). Every parse and every formatter of the package takes its zone from here.
 */
export const homeZone = (view: Pick<HostView, "home">): string => {
  const zone = view.home.HOME_TIME_ZONE
  const named = typeof zone === "string" && zone.trim() !== "" ? normalizeTimeZone(zone.trim()) : undefined
  return named ?? normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC"
}

// The formatter of the last zone asked for: the household has one zone, so this is made once, not on every read.
let lastFormatter: { readonly zone: string; readonly format: Intl.DateTimeFormat } | undefined
const formatterFor = (zone: string): Intl.DateTimeFormat => {
  if (lastFormatter?.zone !== zone) {
    lastFormatter = {
      zone,
      format: new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    }
  }
  return lastFormatter.format
}

/** The local date and clock time of an instant in a zone (seconds dropped). */
export const localOf = (instant: number, timeZone: string): { readonly date: LocalDate; readonly time: { readonly hour: number; readonly minute: number } } => {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant))
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0")
  return { date: { year: n("year"), month: n("month"), day: n("day") }, time: { hour: n("hour"), minute: n("minute") } }
}

/** A clock time: hour 0–23, minute 0–59. */
export interface ClockTime {
  readonly hour: number
  readonly minute: number
}

/**
 * The nominal local date of an instant that a rule made for the clock time `time`: the date whose `time` it stands for.
 * Most days that is the instant's own local date; when the clocks skipped `time` the instant lies after the gap (23:30 in
 * Nuuk's spring gap is 00:30 the next day), and the nominal date is the one before the shift.
 */
export const nominalDateOf = (instant: number, time: ClockTime, zone: string): LocalDate => {
  const local = localOf(instant, zone).time
  let diff = local.hour * 60 + local.minute - (time.hour * 60 + time.minute)
  if (diff > 720) diff -= 1440
  if (diff <= -720) diff += 1440
  return localOf(instant - diff * 60_000, zone).date
}

/** "2026-11-18" ⇄ a local date. */
export const dateText = (d: LocalDate): string => `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
export const dateOf = (text: string): LocalDate => ({ year: Number(text.slice(0, 4)), month: Number(text.slice(5, 7)), day: Number(text.slice(8, 10)) })
/** "06:45" ⇄ a clock time. */
export const timeText = (t: ClockTime): string => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`
export const timeOf = (text: string): ClockTime => ({ hour: Number(text.slice(0, 2)), minute: Number(text.slice(3, 5)) })

/** The longest name of a timer or an alarm (the `Timers` contract's `labelChars`). */
export const NAME_CHARS = 60

/** A name as given: trimmed and single-spaced, one line of at most `NAME_CHARS`; `undefined` for none; `false` when it is not one. */
export const cleanName = (raw: string | undefined): string | undefined | false => {
  if (raw === undefined) return undefined
  // Spaces are tidied; any other white space (a tab, a line break, a line separator) is not one line, and is refused.
  const name = raw.replace(/ +/g, " ").trim()
  if (name === "") return undefined
  return isLine(name, NAME_CHARS) ? name : false
}

const ARTICLES = new Set(["the", "a", "an", "my", "our", "de", "het", "een", "mijn", "onze"])
const KIND_WORDS = new Set(["timer", "timers", "alarm", "alarms", "wekker", "wekkers"])

/**
 * A name as it is compared: lower case, without accents and punctuation, without a leading article and a trailing
 * "timer" / "alarm" / "wekker" ("the Pasta timer" and "pasta" are one name). Exact comparison only: no sound-alikes.
 */
export const nameKey = (text: string): string => {
  const words = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "")
  while (words.length > 0 && ARTICLES.has(words[0]!)) words.shift()
  while (words.length > 0 && KIND_WORDS.has(words.at(-1)!)) words.pop()
  return words.join(" ")
}

/** "pasta" → "Pasta": a name at the start of a sentence. */
export const capitalise = (text: string): string => (text.length === 0 ? text : text[0]!.toLocaleUpperCase() + text.slice(1))

/** A text cut to `max` UTF-16 units without splitting a surrogate pair, with "…" when it was cut. */
export const cut = (text: string, max: number): string => {
  if (text.length <= max) return text
  let end = max - 1
  if (/[\ud800-\udbff]/.test(text[end - 1] ?? "")) end--
  return `${text.slice(0, end)}…`
}

/**
 * How long is left, as people say it: to the second under ten minutes ("6 minutes 10 seconds"), else to the minute
 * ("25 minutes", "1 hour 5 minutes"). At least a second.
 */
export const speakLeft = (ms: number, language: Language): string => {
  const rounded = ms < 10 * 60_000 ? Math.max(1_000, Math.ceil(ms / 1_000) * 1_000) : Math.round(ms / 60_000) * 60_000
  return speakDuration(rounded, language) ?? speakDuration(1_000, language)!
}

/** A spoken list of at most `max` items, "and N more" past it. */
export const listOf = (items: ReadonlyArray<string>, language: Language, max = 4): string => speakList(items.map((i) => cut(i, 200)), language, { max }) ?? items.join(", ")

/** One page read of a collection's list, for the bounded scan. */
export type ListPage<A> = (q: { readonly limit: number; readonly after?: Row<A> }) => Effect.Effect<ReadonlyArray<Row<A>>, StoreFailure>

/**
 * The rows of one list query, page by page (`after` continues it), at most `max`, and whether there were more: a bounded
 * scan says so when it is cut short, so nothing calls a partial read "all of them".
 */
export const scan = <A>(list: ListPage<A>, page: number, max: number): Effect.Effect<{ readonly rows: ReadonlyArray<Row<A>>; readonly cut: boolean }, StoreFailure> =>
  Effect.gen(function*() {
    const rows: Array<Row<A>> = []
    let after: Row<A> | undefined
    while (rows.length < max) {
      const want = Math.min(page, max - rows.length)
      const got = yield* list({ limit: want, ...(after !== undefined ? { after } : {}) })
      rows.push(...got)
      if (got.length < want) return { rows, cut: false }
      after = got.at(-1)
    }
    const beyond = yield* list({ limit: 1, ...(after !== undefined ? { after } : {}) })
    return { rows, cut: beyond.length > 0 }
  })

/** Whether a failure means "busy: nothing was done, try again" (the store's or a service's `busy`). */
export const isBusy = (e: unknown): boolean =>
  (e instanceof StoreError && e.reason === "busy") || (typeof e === "object" && e !== null && (e as { readonly reason?: unknown }).reason === "busy")

/** The epoch-ms schema bound every stored instant keeps (JavaScript's date range). */
export const MAX_INSTANT = 8_640_000_000_000_000
