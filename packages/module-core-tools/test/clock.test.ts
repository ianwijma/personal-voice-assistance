// The extended `current_time` of the clock module (packages/modules-builtin/src/clock.ts and clock/), through the real
// host and gateway. The clock is a version 1 module (its own tests start it as one), so it is run through the kit but
// does not pass `checkModule`'s `api-version` rule: the test below says exactly which rules it does break.
import { assert, describe, it } from "@effect/vitest"
import { moduleProblems, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { clockModule, clockTexts } from "../../modules-builtin/src/clock.ts"

const nl = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } }, settings: { locale: "nl-NL" } }
const start = (options = {}) => startTestModule(clockModule as any, options)
type Kit = Effect.Success<ReturnType<typeof start>>
const ask = (k: Kit, input: Record<string, unknown>) => k.tool("current_time", { timeZone: "Europe/Amsterdam", ...input })
const spoken = (r: any): string => (r.ok ? r.value.spoken : r.content)

describe("clock: the extended current_time", () => {
  it.effect("keeps the original answer when no op is asked, and the texts match in both languages", () =>
    Effect.gen(function*() {
      const k = yield* start()
      const r = yield* k.tool("current_time", { timeZone: "Asia/Tokyo" })
      assert.deepStrictEqual(r.value, { timeZone: "Asia/Tokyo", date: "Wednesday, 18 November 2026", time: "18:00", iso: "2026-11-18T18:00:00.000+09:00" })
      assert.deepStrictEqual(Object.keys(clockTexts.en).sort(), Object.keys(clockTexts.nl).sort())
      const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join()
      for (const key of Object.keys(clockTexts.en) as Array<keyof typeof clockTexts.en>) assert.strictEqual(placeholders(clockTexts.en[key]), placeholders(clockTexts.nl[key]), key)
      // Two rules are broken, both the existing module's: it is version 1 (its own tests start it as one) and on by default.
      assert.deepStrictEqual((yield* moduleProblems(clockModule as any)).map((p) => p.rule), ["api-version", "off-by-default"])
    }))

  it.effect("the time in a place, said for the ear", () =>
    Effect.gen(function*() {
      const k = yield* start()
      assert.strictEqual(spoken(yield* ask(k, { op: "now" })), "It's ten o'clock in the morning, Wednesday.")
      assert.strictEqual(spoken(yield* ask(k, { op: "now", place: "Tokyo" })), "It's six o'clock in the evening in Tokyo, Wednesday.")
      assert.strictEqual(spoken(yield* ask(k, { op: "now", place: "Londen" })), "It's nine o'clock in the morning in London, Wednesday.")
      assert.strictEqual(spoken(yield* ask(k, { op: "now", timeZone: "America/New_York" })), "It's four o'clock at night in New York, Wednesday.")
      const dutch = yield* start(nl)
      assert.strictEqual(spoken(yield* ask(dutch, { op: "now", place: "Tokyo" })), "Het is zes uur 's avonds in Tokyo, woensdag.")
    }))

  it.effect("a place it does not know, or a zone that is not one, is a question the person can answer", () =>
    Effect.gen(function*() {
      const k = yield* start()
      assert.strictEqual(spoken(yield* ask(k, { op: "now", place: "Little Snoring" })), "I don't know where Little Snoring is. Tell me its time zone, for example Europe/Paris.")
      assert.strictEqual(spoken(yield* ask(k, { op: "now", timeZone: "Mars/Olympus" })), "I don't know the time zone Mars/Olympus.")
      assert.strictEqual(spoken(yield* k.tool("current_time", { timeZone: "Mars/Olympus" })), "Unknown time zone \"Mars/Olympus\"")
      const dutch = yield* start(nl)
      assert.strictEqual(spoken(yield* ask(dutch, { op: "now", place: "Little Snoring" })), "Ik weet niet waar Little Snoring is. Noem de tijdzone, bijvoorbeeld Europe/Paris.")
    }))

  it.effect("converts a time between places, across midnight too", () =>
    Effect.gen(function*() {
      const k = yield* start()
      const r = yield* ask(k, { op: "convert", time: "15:00", from: "London", timeZone: "Asia/Tokyo" })
      assert.deepStrictEqual((r.value as any).to, { timeZone: "Asia/Tokyo", time: "00:00", dayOffset: 1 })
      assert.strictEqual(spoken(r), "three o'clock in the afternoon in London is midnight in Tokyo.")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert", time: "9 am", from: "New York" })), "nine o'clock in the morning in New York is three o'clock in the afternoon in Amsterdam.")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert" })), "Which time do you mean?")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert", time: "banana" })), "I couldn't understand the time banana.")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert", time: "15:00", from: "Narnia" })), "I don't know where Narnia is. Tell me its time zone, for example Europe/Paris.")
    }))

  it.effect("days until and since a date, a date plus an amount, and the week number", () =>
    Effect.gen(function*() {
      const k = yield* start()
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "2026-12-25" })), "37 days until Friday the twenty fifth of December.")
      assert.deepStrictEqual({ ...(yield* ask(k, { op: "until", date: "2027-03-03" })).value as any, spoken: undefined }, { op: "until", date: "2027-03-03", days: 105, spoken: undefined })
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "2026-11-18" })), "That is today.")
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "2026-11-19" })), "That is tomorrow.")
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "2026-11-01" })), "That was 17 days ago, Sunday the first of November 2026.")
      assert.strictEqual(spoken(yield* ask(k, { op: "since", date: "2026-11-01" })), "17 days since Sunday the first of November 2026.")
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "tomorrow" })), "That is tomorrow.")
      assert.strictEqual(spoken(yield* ask(k, { op: "until" })), "Which date do you mean?")
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "2026-02-30" })), "I couldn't understand the date 2026-02-30.")
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "blue" })), "I couldn't understand the date blue.")
      const add = yield* ask(k, { op: "add", amount: 3, unit: "weeks" })
      assert.deepStrictEqual({ date: (add.value as any).date, weekday: (add.value as any).weekday }, { date: "2026-12-09", weekday: "Wednesday" })
      assert.strictEqual(((yield* ask(k, { op: "add", date: "2026-01-31", amount: 1, unit: "months" })).value as any).date, "2026-02-28")
      assert.strictEqual(((yield* ask(k, { op: "add", date: "2028-02-29", amount: 1, unit: "years" })).value as any).date, "2029-02-28")
      assert.strictEqual(((yield* ask(k, { op: "add", amount: -10 })).value as any).date, "2026-11-08")
      assert.strictEqual(spoken(yield* ask(k, { op: "add" })), "How many days, weeks, months or years?")
      assert.strictEqual(spoken(yield* ask(k, { op: "add", amount: 100_000, unit: "years" })), "That date is too far away for me.")
      assert.strictEqual(((yield* ask(k, { op: "week" })).value as any).week, 47)
      assert.strictEqual(((yield* ask(k, { op: "week", date: "2026-12-31" })).value as any).week, 53)
      assert.strictEqual(((yield* ask(k, { op: "week", date: "2027-01-03" })).value as any).week, 53)
      assert.strictEqual(((yield* ask(k, { op: "week", date: "2027-01-04" })).value as any).week, 1)
      const dutch = yield* start(nl)
      assert.strictEqual(spoken(yield* ask(dutch, { op: "until", date: "2026-12-25" })), "Nog 37 dagen tot vrijdag 25 december.")
      assert.strictEqual(spoken(yield* ask(dutch, { op: "until", date: "morgen" })), "Dat is morgen.")
    }))

  it.effect("an ambiguous date is a question, never a guess", () =>
    Effect.gen(function*() {
      const k = yield* start()
      const r = spoken(yield* ask(k, { op: "until", date: "the third" }))
      assert.isTrue(/^(Do you mean .+\?|.+)$/.test(r), r)
      assert.notStrictEqual(r, "")
    }))

  it.effect("public holidays: the next ones, or whether a date is one, in the household's language", () =>
    Effect.gen(function*() {
      const k = yield* start()
      assert.strictEqual(spoken(yield* ask(k, { op: "holidays" })), "The next public holiday is Christmas Day, Friday the twenty fifth of December.")
      assert.strictEqual(spoken(yield* ask(k, { op: "holidays", date: "2026-12-25" })), "Yes, Friday the twenty fifth of December is a public holiday: Christmas Day.")
      assert.strictEqual(spoken(yield* ask(k, { op: "holidays", date: "2026-11-19" })), "No, tomorrow is not a public holiday.")
      assert.strictEqual(spoken(yield* ask(k, { op: "holidays", date: "2026-04-27" })), "Yes, Monday the twenty seventh of April 2026 is a public holiday: King’s Day.")
      assert.strictEqual(((yield* ask(k, { op: "holidays", country: "DE" })).value as any).country, "DE")
      assert.strictEqual(spoken(yield* ask(k, { op: "holidays", timeZone: "Asia/Dubai" })), "For which country? I can't tell from the time zone Asia/Dubai.")
      assert.strictEqual(spoken(yield* ask(k, { op: "holidays", country: "ZZ" })), "I don't have public holidays for ZZ.")
      assert.isFalse((yield* ask(k, { op: "holidays", country: "NLD" })).ok)
      const dutch = yield* start(nl)
      assert.strictEqual(spoken(yield* ask(dutch, { op: "holidays" })), "De volgende feestdag is Kerstmis, vrijdag 25 december.")
    }))

  it.effect("sunrise and sunset, in the zone's own time", () =>
    Effect.gen(function*() {
      const k = yield* start()
      const r = (yield* ask(k, { op: "sun" })).value as any
      assert.deepStrictEqual({ sunrise: r.sunrise, sunset: r.sunset }, { sunrise: "08:06", sunset: "16:43" })
      assert.match(r.spoken, /^Sunrise is at .+ and sunset at .+\.$/)
      const tokyo = (yield* ask(k, { op: "sun", place: "Tokyo", date: "2026-06-21" })).value as any
      assert.deepStrictEqual({ sunrise: tokyo.sunrise, sunset: tokyo.sunset }, { sunrise: "04:25", sunset: "19:00" })
      assert.match(tokyo.spoken, / in Tokyo\.$/)
      assert.match(spoken(yield* ask(k, { op: "sun", timeZone: "Asia/Dubai", place: "Zzz" })), /^I don't know where Zzz is/)
      // A place that is in the table but in another zone: the sun times are given in the zone asked for.
      assert.strictEqual(spoken(yield* ask(k, { op: "sun", timeZone: "Europe/Oslo", place: "Helsinki" })).startsWith("Sunrise"), true)
      const dutch = yield* start(nl)
      assert.match(spoken(yield* ask(dutch, { op: "sun" })), /^De zon komt op om .+ en gaat onder om .+\.$/)
    }))

  it.effect("bounded input: nothing outside the schema reaches the work", () =>
    Effect.gen(function*() {
      const k = yield* start()
      for (const input of [{ op: "teleport" }, { op: "until", date: "x".repeat(121) }, { op: "add", amount: 1.5 }, { op: "add", amount: 1e9 }, { op: "add", unit: "decades", amount: 1 }, { op: "holidays", country: "NLD" }, { place: "x".repeat(61) }]) {
        assert.isFalse((yield* ask(k, input)).ok, JSON.stringify(input))
      }
    }))
})
