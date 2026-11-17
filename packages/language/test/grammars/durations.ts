// The duration grammar of the README ("Durations"), for the tests. Values: milliseconds.
import { fixed, lit, oneOf, words, type Grammar, type Rule, type Term } from "../support/Cfg.ts"
import { nlWhole, nlSpell, number, type Lang } from "./numbers.ts"

const ms: Record<string, number> = { week: 604_800_000, day: 86_400_000, hour: 3_600_000, quarter: 900_000, minute: 60_000, second: 1000 }
const order = ["week", "day", "hour", "quarter", "minute", "second"]
export const maxMs = 365 * 86_400_000

interface Part { readonly unit: string; readonly amount: number }

const enUnits = { week: "week", weeks: "week", day: "day", days: "day", hour: "hour", hours: "hour", minute: "minute", minutes: "minute", second: "second", seconds: "second" }
const enSingular = { week: "week", day: "day", hour: "hour", minute: "minute", second: "second" }
const nlUnits = { week: "week", weken: "week", dag: "day", dagen: "day", uur: "hour", uren: "hour", kwartier: "quarter", minuut: "minute", minuten: "minute", seconde: "second", seconden: "second" }
const nlSingular = { week: "week", dag: "day", uur: "hour", kwartier: "quarter", minuut: "minute", seconde: "second" }

/** "tweeënhalf", "vijfenhalf": a whole number and a half in one word. */
const nlAndAHalfWord: Term = {
  read: (w) => {
    const m = /^(.+)enhalf$/.exec(w)
    const n = m === null ? undefined : nlWhole(m[1]!)
    return n !== undefined && n >= 1 ? n + 0.5 : undefined
  },
  write: (r) => {
    const n = r.int(1, 20)
    const s = nlSpell(n)
    return `${s}${s.endsWith("e") ? "ën" : "en"}half`
  }
}

const anyAmount = (lang: Lang) => number(lang, { min: 0, max: 999_999.99 })
const wholeAmount = (lang: Lang) => number(lang, { min: 1, max: 999_999, whole: true })

/** The amount a duration part or a quantity says: a number, or one with a spoken fraction. */
export const amountRules = (lang: Lang): ReadonlyArray<Rule> => lang === "en"
  ? [
    { rhs: [anyAmount("en")], weight: 4 },
    { rhs: [wholeAmount("en"), ...words("and a half")], act: ([n]) => n + 0.5 }
  ]
  : [
    { rhs: [anyAmount("nl")], weight: 4 },
    { rhs: [wholeAmount("nl"), ...words("en een half")], act: ([n]) => n + 0.5 },
    { rhs: [wholeAmount("nl"), ...words("en een halve")], act: ([n]) => n + 0.5 },
    fixed([lit("anderhalf")], 1.5), fixed([lit("anderhalve")], 1.5), { rhs: [nlAndAHalfWord] },
    fixed(words("een half"), 0.5), fixed(words("een halve"), 0.5), fixed(words("een kwart"), 0.25), fixed([lit("driekwart")], 0.75), fixed(words("drie kwart"), 0.75)
  ]

/** The amount in hundredths, exactly: every amount the grammar writes has at most two decimals (a half and a quarter too). */
const hundredths = (amount: number): bigint => {
  const h = Math.round(amount * 100)
  if (Math.abs(amount * 100 - h) > 1e-6) throw new Error(`an amount of the grammar that is not whole hundredths: ${amount}`)
  return BigInt(h)
}
/** The value in milliseconds, in exact integer arithmetic (BigInt; review round 4, finding 5): more than 0, at most 365 days. */
export const totalMs = (parts: ReadonlyArray<Part>): number | undefined => {
  for (let k = 1; k < parts.length; k++) if (order.indexOf(parts[k - 1]!.unit) >= order.indexOf(parts[k]!.unit)) return undefined
  const sum = parts.reduce((n, p) => n + hundredths(p.amount) * BigInt(ms[p.unit]!), 0n)
  return sum % 100n === 0n && sum > 0n && sum <= BigInt(maxMs) * 100n ? Number(sum / 100n) : undefined
}
const total = totalMs

/** DURATION: parts, largest unit first, each once, optionally joined by "and" / "en". Value: { ms, units }. */
export const durationGrammar = (lang: Lang): Grammar => {
  const and = lang === "en" ? "and" : "en"
  const part: ReadonlyArray<Rule> = lang === "en"
    ? [
      { rhs: ["AMOUNT", oneOf(enUnits)], act: ([amount, unit]) => ({ unit, amount }), weight: 4 },
      { rhs: [oneOf({ a: 1, an: 1 }), oneOf(enSingular)], act: ([, unit]) => ({ unit, amount: 1 }) },
      { rhs: [oneOf({ a: 1, an: 1 }), oneOf(enSingular), ...words("and a half")], act: ([, unit]) => ({ unit, amount: 1.5 }) },
      { rhs: [lit("half"), oneOf({ a: 1, an: 1 }), oneOf(enSingular)], act: ([, , unit]) => ({ unit, amount: 0.5 }) },
      { rhs: [...words("a quarter of"), oneOf({ a: 1, an: 1 }), oneOf(enSingular)], act: (v) => ({ unit: v[4], amount: 0.25 }) },
      { rhs: [...words("three quarters of"), oneOf({ a: 1, an: 1 }), oneOf(enSingular)], act: (v) => ({ unit: v[4], amount: 0.75 }) }
    ]
    : [
      { rhs: ["AMOUNT", oneOf(nlUnits)], act: ([amount, unit]) => ({ unit, amount }), weight: 4 },
      { rhs: [lit("een"), oneOf(nlSingular)], act: ([, unit]) => ({ unit, amount: 1 }) }
    ]
  return {
    AMOUNT: amountRules(lang),
    PART: part,
    PARTS: [
      { rhs: ["PART"], act: ([p]) => [p], weight: 3 },
      { rhs: ["PART", "PARTS"], act: ([p, rest]) => [p, ...rest] },
      { rhs: ["PART", lit(and), "PARTS"], act: ([p, , rest]) => [p, ...rest] }
    ],
    DURATION: [{ rhs: ["PARTS"], act: ([parts]) => { const t = total(parts); return t === undefined ? undefined : { ms: t, units: parts.map((p: Part) => p.unit) } } }],
    MS: [{ rhs: ["DURATION"], act: ([d]) => d.ms }]
  }
}
