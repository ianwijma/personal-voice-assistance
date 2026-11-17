import { dicts } from "./Dict.ts"
import { guarded, isLanguage, isText, maxDurationMs } from "./Domain.ts"
import { alt, from, many1, map, oneOf, opt, seq, whole, words, type Input, type P } from "./Grammar.ts"
import { amountNumber, enFractionBeforeArticle } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type Language, type Parsed } from "./Result.ts"
import { sliceText, tokenize } from "./Tokens.ts"

/**
 * Durations, the package's own grammar per language (review round 3, decision 3: no longer core's `parseDuration`). The same
 * production reads a duration inside a date ("in two hours and thirty minutes"). A duration is one or more parts, largest unit first,
 * each unit at most once, optionally joined by "and" / "en":
 * - English part: AMOUNT UNIT ("2 hours", "1.5 hours", "two and a half hours"), "a" / "an" UNIT ["and a half"] ("an hour and a half"),
 *   "half" / "a quarter of" / "three quarters of" "a" / "an" UNIT ("half an hour", "a quarter of an hour");
 * - Dutch part: AMOUNT UNIT ("2 uur", "anderhalf uur", "twee en een half uur", "tweeënhalf uur", "een half uur", "drie kwartier"),
 *   "een" UNIT ("een uur", "een kwartier").
 * Units: weeks, days, hours, minutes, seconds (English singular or plural); Dutch weken, dagen, uren / uur, minuten, seconden, and
 * "kwartier" (15 minutes, between the hour and the minute). The value is in whole milliseconds, more than 0 and at most 365 days.
 */
export type DurationUnit = "week" | "day" | "hour" | "quarter" | "minute" | "second"

export const unitMs: Readonly<Record<DurationUnit, number>> = { week: 604_800_000, day: 86_400_000, hour: 3_600_000, quarter: 900_000, minute: 60_000, second: 1000 }
const rank: Readonly<Record<DurationUnit, number>> = { week: 0, day: 1, hour: 2, quarter: 3, minute: 4, second: 5 }

const unitWords = dicts<Language, DurationUnit>({
  en: { week: "week", weeks: "week", day: "day", days: "day", hour: "hour", hours: "hour", minute: "minute", minutes: "minute", second: "second", seconds: "second" },
  nl: { week: "week", weken: "week", dag: "day", dagen: "day", uur: "hour", uren: "hour", kwartier: "quarter", minuut: "minute", minuten: "minute", seconde: "second", seconden: "second" }
})
const singularWords = dicts<Language, DurationUnit>({
  en: { week: "week", day: "day", hour: "hour", minute: "minute", second: "second" },
  nl: { week: "week", dag: "day", uur: "hour", kwartier: "quarter", minuut: "minute", seconde: "second" }
})

export interface DurationPart {
  readonly unit: DurationUnit
  readonly amount: number
}

const article = oneOf("a", "an")
const partOf: Record<Language, P<DurationPart>> = {
  en: alt(
    map(seq(amountNumber.en, from(unitWords.en)), ([amount, unit]) => ({ unit, amount })),
    map(seq(article, from(singularWords.en), opt(words("and", "a", "half"))), ([, unit, half]) => ({ unit, amount: half === undefined ? 1 : 1.5 })),
    map(seq(enFractionBeforeArticle, article, from(singularWords.en)), ([f, , unit]) => ({ unit, amount: f }))
  ),
  nl: alt(
    map(seq(amountNumber.nl, from(unitWords.nl)), ([amount, unit]) => ({ unit, amount })),
    map(seq(oneOf("een"), from(singularWords.nl)), ([, unit]) => ({ unit, amount: 1 }))
  )
}

/** The parts, largest unit first, each unit once: every reading. */
export const durationParts: Record<Language, P<ReadonlyArray<DurationPart>>> = {
  en: map(many1(partOf.en, opt(words("and")), 6), (parts) => (ordered(parts) ? parts : undefined)),
  nl: map(many1(partOf.nl, opt(words("en")), 6), (parts) => (ordered(parts) ? parts : undefined))
}
const ordered = (parts: ReadonlyArray<DurationPart>): boolean => parts.every((p, k) => k === 0 || rank[parts[k - 1]!.unit] < rank[p.unit])

/**
 * The milliseconds of the parts, or `undefined` when they are 0 or more than `maxDurationMs`. Exact: every amount the grammar reads is
 * whole hundredths (two decimals, a half, a quarter), so the sum is taken in hundredths of a millisecond, integers all the way, and no
 * floating-point tolerance decides (review round 4, finding 5: "128.05 days" is 11 063 520 000 ms).
 */
export const durationMs = (parts: ReadonlyArray<DurationPart>): number | undefined => {
  let hundredthsMs = 0
  for (const p of parts) {
    const h = Math.round(p.amount * 100)
    // Not whole hundredths: no amount of the grammar is, so this is no duration (never rounded into one).
    if (Math.abs(p.amount * 100 - h) > 1e-6 * Math.max(1, Math.abs(h))) return undefined
    const part = h * unitMs[p.unit]
    // Each part is checked before it is added, so the sum stays far below 2^53 and exact.
    if (part > maxDurationMs * 100) return undefined
    hundredthsMs += part
  }
  if (hundredthsMs <= 0 || hundredthsMs > maxDurationMs * 100 || hundredthsMs % 100 !== 0) return undefined
  return hundredthsMs / 100
}

/** A duration phrase, every reading, with its milliseconds and units. */
export const duration: Record<Language, P<{ readonly ms: number; readonly units: ReadonlyArray<DurationUnit> }>> = {
  en: map(durationParts.en, (parts) => { const ms = durationMs(parts); return ms === undefined ? undefined : { ms, units: parts.map((p) => p.unit) } }),
  nl: map(durationParts.nl, (parts) => { const ms = durationMs(parts); return ms === undefined ? undefined : { ms, units: parts.map((p) => p.unit) } })
}

/**
 * A phrase that is only a duration (see the top of this file): `ok` with milliseconds, else `not-understood`. "not two hours",
 * "two hours please", "less than two hours", "1 day 12 hours" (the day kept: 36 hours), "three quarters of an hour" (45 minutes);
 * "1e308", "0x10" and "" are `not-understood`.
 */
export const parseDuration: (text: string, language: Language) => Parsed<number> = guarded((text: string, language: Language): Parsed<number> => {
  if (!isText(text) || !isLanguage(language)) return notUnderstood
  const toks = tokenize(text)
  if (toks === undefined || toks.length === 0) return notUnderstood
  const input: Input = { text, toks, norms: toks.map((t) => t.norm) }
  const values = [...new Set(whole(duration[language], input).map((d) => d.ms))]
  const said = sliceText(text, toks, 0, toks.length)
  if (values.length === 0) return notUnderstood
  return values.length === 1 ? ok(values[0]!, said) : ambiguous(values, said, "The words read as more than one duration")
}, notUnderstood)
