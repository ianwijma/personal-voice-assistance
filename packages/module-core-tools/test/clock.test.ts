// The extended `current_time` of the clock module (packages/modules-builtin/src/clock.ts and clock/), through the real
// host and gateway. The clock is an existing module that is on by default (its own tests start it with the version 1
// context), so it is run through the kit but does not pass `checkModule`'s `off-by-default` rule: the test below says
// exactly which rule it breaks.
import { assert, describe, it } from "@effect/vitest"
import { moduleProblems, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
      // One rule is broken, the existing module's: it is on by default.
      assert.deepStrictEqual((yield* moduleProblems(clockModule as any)).map((p) => p.rule), ["off-by-default"])
    }))

  it.effect("an existing installation's call answers as before, and loading the clock imports no library", () =>
    Effect.gen(function*() {
      // The call an existing installation makes: a zone and nothing else, in the date format's words.
      const k = yield* start({ settings: { locale: "nl-NL" } })
      assert.deepStrictEqual((yield* k.tool("current_time", { timeZone: "Europe/Amsterdam" })).value, {
        timeZone: "Europe/Amsterdam",
        date: "woensdag 18 november 2026",
        time: "10:00",
        iso: "2026-11-18T10:00:00.000+01:00"
      })
      // The clock's files import only the workspace's own packages and effect: no holiday or sun library, at the start or later.
      const dir = join(import.meta.dirname, "../../modules-builtin/src")
      const files = [join(dir, "clock.ts"), ...readdirSync(join(dir, "clock")).map((f) => join(dir, "clock", f))]
      for (const file of files) {
        const imports = [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!)
        for (const name of imports) assert.isTrue(name.startsWith("./") || name.startsWith("@pva/") || name === "effect", `${file}: ${name}`)
        assert.notMatch(readFileSync(file, "utf8"), /date-holidays|suncalc/, file)
      }
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
      assert.deepStrictEqual((r.value as any).from, { timeZone: "Europe/London", date: "2026-11-18", time: "15:00" })
      assert.deepStrictEqual((r.value as any).to, { timeZone: "Asia/Tokyo", date: "2026-11-19", time: "00:00", dayOffset: 1 })
      assert.strictEqual(spoken(r), "three o'clock in the afternoon in London today is midnight in Tokyo tomorrow.")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert", time: "9 am", from: "New York" })), "nine o'clock in the morning in New York is three o'clock in the afternoon in Amsterdam.")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert" })), "Which time do you mean?")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert", time: "banana" })), "I couldn't understand the time banana.")
      assert.strictEqual(spoken(yield* ask(k, { op: "convert", time: "15:00", from: "Narnia" })), "I don't know where Narnia is. Tell me its time zone, for example Europe/Paris.")
    }))

  it.effect("converts on the date asked for, read in the source zone, and gives both dates", () =>
    Effect.gen(function*() {
      const k = yield* start()
      // 15 March 2026: daylight saving time has begun in New York (8 March) and not yet in Amsterdam (29 March): five hours apart, not six.
      const march = yield* ask(k, { op: "convert", time: "09:00", from: "New York", date: "2026-03-15" })
      assert.deepStrictEqual({ from: (march.value as any).from, to: (march.value as any).to }, {
        from: { timeZone: "America/New_York", date: "2026-03-15", time: "09:00" },
        to: { timeZone: "Europe/Amsterdam", date: "2026-03-15", time: "14:00" }
      })
      assert.strictEqual(spoken(march), "On Sunday the fifteenth of March 2026, nine o'clock in the morning in New York is two o'clock in the afternoon in Amsterdam.")
      // Today, the same conversion is six hours.
      assert.strictEqual(((yield* ask(k, { op: "convert", time: "09:00", from: "New York" })).value as any).to.time, "15:00")
      // A date in words, read in the source zone: at 23:30 in Amsterdam it is already the 19th in Tokyo, so "tomorrow" there is the 20th.
      const late = yield* start({ startAt: Date.UTC(2026, 10, 18, 22, 30) })
      const tokyo = (yield* ask(late, { op: "convert", time: "08:00", from: "Tokyo", date: "tomorrow" })).value as any
      assert.deepStrictEqual({ from: tokyo.from.date, to: tokyo.to.date, time: tokyo.to.time, dayOffset: tokyo.to.dayOffset }, { from: "2026-11-20", to: "2026-11-20", time: "00:00", dayOffset: undefined })
      // Crossing midnight on a date: both dates are said.
      assert.strictEqual(spoken(yield* ask(k, { op: "convert", time: "23:00", from: "London", timeZone: "Asia/Tokyo", date: "2026-12-24" })), "eleven o'clock at night in London on Thursday the twenty fourth of December is eight o'clock in the morning in Tokyo on Friday the twenty fifth of December.")
      const dutch = yield* start(nl)
      assert.strictEqual(spoken(yield* ask(dutch, { op: "convert", time: "09:00", from: "New York", date: "2026-03-15" })), "Op zondag 15 maart 2026, negen uur 's ochtends in New York is twee uur 's middags in Amsterdam.")
    }))

  it.effect("a time the clocks jump over is said not to exist, and one they go back over is a question: Amsterdam and Sydney", () =>
    Effect.gen(function*() {
      const k = yield* start()
      const utc = (input: Record<string, unknown>) => ask(k, { timeZone: "UTC", op: "convert", time: "02:30", ...input })
      // Amsterdam, spring forward (29 March) and fall back (25 October).
      assert.strictEqual(spoken(yield* utc({ from: "Amsterdam", date: "2026-03-29" })), "half past two at night does not exist in Amsterdam on Sunday the twenty ninth of March 2026: the clocks go forward over it.")
      assert.strictEqual(spoken(yield* utc({ from: "Amsterdam", date: "2026-10-25" })), "half past two at night happens twice in Amsterdam on Sunday the twenty fifth of October 2026, because the clocks go back. Do you mean the earlier one or the later one?")
      assert.strictEqual(((yield* utc({ from: "Amsterdam", date: "2026-10-25", repeat: "earlier" })).value as any).to.time, "00:30")
      assert.strictEqual(((yield* utc({ from: "Amsterdam", date: "2026-10-25", repeat: "later" })).value as any).to.time, "01:30")
      // Sydney, the southern hemisphere: spring forward on 4 October, fall back on 5 April.
      assert.strictEqual(spoken(yield* utc({ from: "Sydney", date: "2026-10-04" })), "half past two at night does not exist in Sydney on Sunday the fourth of October 2026: the clocks go forward over it.")
      assert.strictEqual(spoken(yield* utc({ from: "Sydney", date: "2026-04-05" })), "half past two at night happens twice in Sydney on Sunday the fifth of April 2026, because the clocks go back. Do you mean the earlier one or the later one?")
      const earlier = (yield* utc({ from: "Sydney", date: "2026-04-05", repeat: "earlier" })).value as any
      const later = (yield* utc({ from: "Sydney", date: "2026-04-05", repeat: "later" })).value as any
      assert.deepStrictEqual([earlier.to, later.to], [{ timeZone: "UTC", date: "2026-04-04", time: "15:30", dayOffset: -1 }, { timeZone: "UTC", date: "2026-04-04", time: "16:30", dayOffset: -1 }])
      // An ordinary time on those days is answered without a question; `repeat` changes nothing there.
      assert.strictEqual(((yield* utc({ from: "Amsterdam", date: "2026-03-29", time: "03:30" })).value as any).to.time, "01:30")
      assert.strictEqual(((yield* utc({ from: "Amsterdam", date: "2026-10-25", time: "04:00", repeat: "later" })).value as any).to.time, "03:00")
      const dutch = yield* start(nl)
      assert.strictEqual(spoken(yield* ask(dutch, { timeZone: "UTC", op: "convert", time: "02:30", from: "Amsterdam", date: "2026-03-29" })), "half drie 's nachts bestaat niet in Amsterdam op zondag 29 maart 2026: de klok springt er dan overheen.")
      assert.strictEqual(spoken(yield* ask(dutch, { timeZone: "UTC", op: "convert", time: "02:30", from: "Sydney", date: "2026-04-05" })), "half drie 's nachts komt twee keer voor in Sydney op zondag 5 april 2026, omdat de klok dan teruggaat. Bedoel je de eerste of de tweede keer?")
    }))

  it.effect("the new operations speak and read the household's language as it is set now, not the date format", () =>
    Effect.gen(function*() {
      // Dutch household, English date format: the new operations are Dutch; the original answer keeps the date format.
      const k = yield* start({ household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } }, settings: { locale: "en-GB" } })
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "morgen" })), "Dat is morgen.")
      assert.strictEqual(spoken(yield* ask(k, { op: "until", date: "2026-12-25" })), "Nog 37 dagen tot vrijdag 25 december.")
      assert.strictEqual(spoken(yield* ask(k, { op: "now", place: "Tokyo" })), "Het is zes uur 's avonds in Tokyo, woensdag.")
      assert.strictEqual(((yield* k.tool("current_time", { timeZone: "Europe/Amsterdam" })).value as any).date, "Wednesday, 18 November 2026")
      // English household, Dutch date format: English words, and "tomorrow" is read as English.
      const en = yield* start({ household: { home: { HOME_LANGUAGE: "en-GB", HOME_TIME_ZONE: "Europe/Amsterdam" } }, settings: { locale: "nl-NL" } })
      assert.strictEqual(spoken(yield* ask(en, { op: "until", date: "tomorrow" })), "That is tomorrow.")
      assert.strictEqual(spoken(yield* ask(en, { op: "until", date: "morgen" })), "I couldn't understand the date morgen.")
      assert.strictEqual(((yield* en.tool("current_time", { timeZone: "Europe/Amsterdam" })).value as any).date, "woensdag 18 november 2026")
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
      // On Wednesday 18 November, "next friday" is the 20th or the 27th: the person is asked, and no date or count is given.
      const r = yield* ask(k, { op: "until", date: "next friday" })
      assert.isFalse(r.ok)
      assert.strictEqual(r.content, "Do you mean Friday or Friday the twenty seventh?")
      const dutch = yield* start(nl)
      assert.strictEqual((yield* ask(dutch, { op: "until", date: "volgende vrijdag" })).content, "Bedoel je overmorgen of vrijdag de zevenentwintigste?")
    }))

  it.effect("bounded input: nothing outside the schema reaches the work, and the operations left out are not offered", () =>
    Effect.gen(function*() {
      const k = yield* start()
      for (const input of [{ op: "teleport" }, { op: "holidays" }, { op: "sun" }, { op: "until", date: "x".repeat(121) }, { op: "add", amount: 1.5 }, { op: "add", amount: 1e9 }, { op: "add", unit: "decades", amount: 1 }, { op: "convert", time: "02:30", repeat: "both" }, { place: "x".repeat(61) }]) {
        assert.isFalse((yield* ask(k, input)).ok, JSON.stringify(input))
      }
    }))
})
