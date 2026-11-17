import { describe, expect, it } from "@effect/vitest"
import { parseDuration } from "../src/index.ts"
import { parseQuantity } from "../src/Quantity.ts"
import { speakAmount, speakDate, speakDuration, speakList, speakMoment, speakNumber, speakTime } from "../src/Speak.ts"
import { parseTimeOfDay } from "../src/Time.ts"
import { numberToWords, ordinalToWords } from "../src/Words.ts"

describe("numberToWords", () => {
  const en: ReadonlyArray<readonly [number, string]> = [[0, "zero"], [7, "seven"], [13, "thirteen"], [20, "twenty"], [42, "forty two"], [100, "one hundred"], [101, "one hundred and one"], [250, "two hundred and fifty"], [1000, "one thousand"], [1005, "one thousand and five"], [2026, "two thousand and twenty six"], [12_345, "twelve thousand three hundred and forty five"]]
  const nl: ReadonlyArray<readonly [number, string]> = [[0, "nul"], [7, "zeven"], [13, "dertien"], [20, "twintig"], [21, "eenentwintig"], [22, "tweeëntwintig"], [23, "drieëntwintig"], [42, "tweeënveertig"], [100, "honderd"], [101, "honderdeen"], [250, "tweehonderdvijftig"], [1000, "duizend"], [2026, "tweeduizend zesentwintig"], [12_345, "twaalfduizend driehonderdvijfenveertig"]]
  for (const [n, w] of en) it(`en ${n}`, () => expect(numberToWords(n, "en")).toBe(w))
  for (const [n, w] of nl) it(`nl ${n}`, () => expect(numberToWords(n, "nl")).toBe(w))
  it("cannot word anything but a whole number 0–999 999: undefined (round 3, decision 1)", () => {
    expect(numberToWords(1.5, "en")).toBeUndefined()
    expect(numberToWords(-3, "nl")).toBeUndefined()
    expect(numberToWords(1_000_000, "en")).toBeUndefined()
  })
  it("ordinals", () => {
    expect([1, 2, 3, 12, 20, 21, 30, 31].map((n) => ordinalToWords(n, "en"))).toEqual(["first", "second", "third", "twelfth", "twentieth", "twenty first", "thirtieth", "thirty first"])
    expect([1, 2, 3, 12, 20, 21, 22, 30, 31].map((n) => ordinalToWords(n, "nl"))).toEqual(["eerste", "tweede", "derde", "twaalfde", "twintigste", "eenentwintigste", "tweeëntwintigste", "dertigste", "eenendertigste"])
  })
})

describe("speakNumber", () => {
  const rows: ReadonlyArray<readonly [number, "en" | "nl", string]> = [
    [7, "en", "7"], [2.5, "en", "2.5"], [2.5, "nl", "2,5"], [0.25, "nl", "0,25"], [999_999, "en", "999999"], [3.14159, "en", "3.14"], [-4, "en", "minus 4"], [-4.5, "nl", "min 4,5"], [2.0, "nl", "2"]
  ]
  for (const [n, l, expected] of rows) it(`${n} (${l})`, () => expect(speakNumber(n, l)).toBe(expected))
  it("in words", () => {
    expect(speakNumber(42, "en", { words: true })).toBe("forty two")
    expect(speakNumber(2.5, "en", { words: true })).toBe("two point five")
    expect(speakNumber(2.5, "nl", { words: true })).toBe("twee komma vijf")
    expect(speakNumber(0.05, "nl", { words: true })).toBe("nul komma nul vijf")
  })
})

describe("speakAmount", () => {
  const rows: ReadonlyArray<readonly [Parameters<typeof speakAmount>[0], "en" | "nl", Parameters<typeof speakAmount>[2], string]> = [
    [{ amount: 750, unit: "g", approx: true }, "en", {}, "about 750 grams"],
    [{ amount: 750, unit: "g", approx: true }, "nl", {}, "ongeveer 750 gram"],
    [{ amount: 1500, unit: "g" }, "en", {}, "1.5 kilograms"],
    [{ amount: 1500, unit: "g" }, "nl", {}, "1,5 kilo"],
    [{ amount: 1500, unit: "g" }, "en", { humanize: false }, "1500 grams"],
    [{ amount: 2, unit: "kg" }, "en", { item: "potatoes" }, "2 kilograms of potatoes"],
    [{ amount: 2, unit: "kg" }, "nl", { item: "aardappelen" }, "2 kilo aardappelen"],
    [{ amount: 1, unit: "kg" }, "en", {}, "1 kilogram"],
    [{ amount: 0.5, unit: "kg" }, "en", {}, "500 grams"],
    [{ amount: 2, unit: "l" }, "nl", { item: "melk" }, "2 liter melk"],
    [{ amount: 1.5, unit: "l" }, "en", { item: "milk" }, "1.5 litres of milk"],
    [{ amount: 250, unit: "ml" }, "en", {}, "250 millilitres"],
    [{ amount: 1500, unit: "ml" }, "nl", {}, "1,5 liter"],
    [{ amount: 3, unit: "tbsp" }, "en", { item: "oil" }, "3 tablespoons of oil"],
    [{ amount: 3, unit: "tbsp" }, "nl", { item: "olie" }, "3 eetlepels olie"],
    [{ amount: 1, unit: "tsp" }, "en", {}, "1 teaspoon"],
    [{ amount: 2, unit: "cup" }, "en", { item: "flour" }, "2 cups of flour"],
    [{ amount: 1, unit: "pack" }, "en", { item: "milk" }, "a pack of milk"],
    [{ amount: 1, unit: "pack" }, "nl", { item: "melk" }, "een pak melk"],
    [{ amount: 2, unit: "pack" }, "nl", { item: "pasta" }, "2 pakken pasta"],
    [{ amount: 3, unit: "can" }, "en", { item: "tomatoes" }, "3 cans of tomatoes"],
    [{ amount: 1, unit: "bottle" }, "en", {}, "a bottle"],
    [{ amount: 12, unit: "piece" }, "en", { item: "eggs" }, "12 eggs"],
    [{ amount: 6, unit: "piece" }, "nl", {}, "6 stuks"],
    [{ amount: 1, unit: "piece" }, "en", {}, "1 piece"],
    [{ amount: 1, unit: "handful", approx: true }, "en", { item: "nuts" }, "a handful of nuts"],
    [{ amount: 1, unit: "handful", approx: true }, "nl", { item: "noten" }, "een handvol noten"],
    [{ amount: 1, unit: "pinch" }, "en", { item: "salt" }, "a pinch of salt"],
    [{ approx: true }, "en", { item: "milk" }, "some milk"],
    [{ approx: true }, "nl", { item: "melk" }, "wat melk"],
    [{ rest: true }, "en", {}, "the rest"],
    [{ rest: true }, "en", { item: "the rice" }, "the rest of the rice"],
    [{ rest: true }, "nl", { item: "de rijst" }, "de rest van de rijst"],
    [{ amount: 4 }, "en", { item: "apples" }, "4 apples"]
  ]
  for (const [q, l, o, expected] of rows) it(`${JSON.stringify(q)} ${l}`, () => expect(speakAmount(q, l, o)).toBe(expected))

  it("round trip: parse, then speak, gives back what was said", () => {
    const cases: ReadonlyArray<readonly [string, "en" | "nl", string]> = [
      ["about 750 grams of flour", "en", "about 750 grams of flour"], ["two litres of milk", "en", "2 litres of milk"], ["a pack of milk", "en", "a pack of milk"],
      ["ongeveer 750 gram bloem", "nl", "ongeveer 750 gram bloem"], ["twee liter melk", "nl", "2 liter melk"], ["een pak melk", "nl", "een pak melk"],
      ["een handvol noten", "nl", "een handvol noten"], ["a handful of nuts", "en", "a handful of nuts"], ["some milk", "en", "some milk"], ["de rest", "nl", "de rest"], ["12 eggs", "en", "12 eggs"]
    ]
    for (const [text, l, expected] of cases) {
      const r = parseQuantity(text, l)
      expect(r.kind === "ok" && speakAmount(r.value, l, { item: r.value.item })).toBe(expected)
    }
  })
})

describe("speakTime", () => {
  type Row = readonly [hour: number, minute: number, en: string, nl: string]
  const rows: ReadonlyArray<Row> = [
    [0, 0, "midnight", "middernacht"], [0, 5, "five past twelve", "vijf over twaalf"], [12, 0, "noon", "twaalf uur"], [12, 30, "half past twelve", "half een"],
    [7, 0, "seven o'clock", "zeven uur"], [7, 5, "five past seven", "vijf over zeven"], [7, 10, "ten past seven", "tien over zeven"], [7, 15, "quarter past seven", "kwart over zeven"],
    [7, 20, "twenty past seven", "tien voor half acht"], [7, 25, "twenty five past seven", "vijf voor half acht"], [7, 30, "half past seven", "half acht"],
    [7, 35, "twenty five to eight", "vijf over half acht"], [7, 40, "twenty to eight", "tien over half acht"], [7, 45, "quarter to eight", "kwart voor acht"],
    [7, 50, "ten to eight", "tien voor acht"], [7, 55, "five to eight", "vijf voor acht"], [7, 7, "seven oh seven", "zeven uur zeven"], [7, 12, "seven twelve", "zeven uur twaalf"],
    [11, 45, "quarter to twelve", "kwart voor twaalf"], [11, 30, "half past eleven", "half twaalf"], [23, 45, "quarter to twelve", "kwart voor twaalf"], [19, 15, "quarter past seven", "kwart over zeven"],
    [15, 0, "three o'clock", "drie uur"], [12, 15, "quarter past twelve", "kwart over twaalf"]
  ]
  for (const [h, m, en, nl] of rows) {
    it(`${h}:${String(m).padStart(2, "0")} in 12-hour style`, () => {
      expect(speakTime({ hour: h, minute: m }, "en")).toBe(en)
      expect(speakTime({ hour: h, minute: m }, "nl")).toBe(nl)
    })
  }
  it("24-hour style", () => {
    const rows24: ReadonlyArray<readonly [number, number, string, string]> = [
      [19, 30, "nineteen thirty", "negentien uur dertig"], [19, 0, "nineteen hundred", "negentien uur"], [7, 5, "oh seven oh five", "zeven uur vijf"], [7, 30, "oh seven thirty", "zeven uur dertig"],
      [0, 0, "midnight", "middernacht"], [0, 15, "zero fifteen", "nul uur vijftien"], [12, 0, "twelve hundred", "twaalf uur"], [23, 59, "twenty three fifty nine", "drieëntwintig uur negenenvijftig"]
    ]
    for (const [h, m, en, nl] of rows24) {
      expect(speakTime({ hour: h, minute: m }, "en", { style: "24h" })).toBe(en)
      expect(speakTime({ hour: h, minute: m }, "nl", { style: "24h" })).toBe(nl)
    }
  })
  it("with the part of the day", () => {
    expect(speakTime({ hour: 7, minute: 30 }, "en", { period: true })).toBe("half past seven in the morning")
    expect(speakTime({ hour: 19, minute: 30 }, "en", { period: true })).toBe("half past seven in the evening")
    expect(speakTime({ hour: 15, minute: 0 }, "en", { period: true })).toBe("three o'clock in the afternoon")
    expect(speakTime({ hour: 2, minute: 0 }, "en", { period: true })).toBe("two o'clock at night")
    expect(speakTime({ hour: 12, minute: 0 }, "en", { period: true })).toBe("noon")
    expect(speakTime({ hour: 19, minute: 15 }, "nl", { period: true })).toBe("kwart over zeven 's avonds")
    expect(speakTime({ hour: 7, minute: 30 }, "nl", { period: true })).toBe("half acht 's ochtends")
    expect(speakTime({ hour: 23, minute: 0 }, "nl", { period: true })).toBe("elf uur 's nachts")
  })
  it("round trip: every minute of the day, spoken in 12-hour style with the period and read back, is the same minute", () => {
    for (const language of ["en", "nl"] as const) {
      for (let minutes = 0; minutes < 24 * 60; minutes += 1) {
        const t = { hour: Math.floor(minutes / 60), minute: minutes % 60 }
        const said = speakTime(t, language, { period: true })!
        const back = parseTimeOfDay(said, language)
        const got = back.kind === "ok" ? back.value.hour * 60 + back.value.minute : back.kind
        if (got !== minutes) throw new Error(`${language} ${t.hour}:${t.minute} said "${said}" came back as ${JSON.stringify(back)}`)
      }
    }
  })
})

describe("speakDuration", () => {
  const rows: ReadonlyArray<readonly [number, string, string]> = [
    [370_000, "6 minutes 10 seconds", "6 minuten 10 seconden"], [1000, "1 second", "1 seconde"], [45_000, "45 seconds", "45 seconden"],
    [60_000, "1 minute", "1 minuut"], [3_600_000, "1 hour", "1 uur"], [7_200_000, "2 hours", "2 uur"], [3_661_000, "1 hour 1 minute 1 second", "1 uur 1 minuut 1 seconde"],
    [5_400_000, "an hour and a half", "anderhalf uur"], [9_000_000, "two and a half hours", "twee en een half uur"], [1_800_000, "half an hour", "een half uur"],
    [900_000, "a quarter of an hour", "een kwartier"], [2_700_000, "three quarters of an hour", "drie kwartier"], [90_000, "a minute and a half", "anderhalve minuut"],
    [150_000, "two and a half minutes", "twee en een halve minuut"], [600_000, "10 minutes", "10 minuten"], [86_400_000, "1 day", "1 dag"], [90_000_000, "1 day 1 hour", "1 dag 1 uur"],
    [1499, "1 second", "1 seconde"]
  ]
  for (const [ms, en, nl] of rows) {
    it(`${ms} ms`, () => {
      expect(speakDuration(ms, "en")).toBe(en)
      expect(speakDuration(ms, "nl")).toBe(nl)
    })
  }
  it("digits only on request", () => {
    expect(speakDuration(5_400_000, "en", { natural: false })).toBe("1 hour 30 minutes")
    expect(speakDuration(5_400_000, "nl", { natural: false })).toBe("1 uur 30 minuten")
  })
  it("round trip with the package's own parseDuration (digit style; Durations.test.ts does the whole grid)", () => {
    for (const ms of [370_000, 3_661_000, 600_000, 45_000, 7_200_000, 60_000]) {
      for (const language of ["en", "nl"] as const) expect(parseDuration(speakDuration(ms, language, { natural: false })!, language)).toMatchObject({ kind: "ok", value: ms })
    }
  })
  it("0 and less than half a second cannot be said", () => {
    for (const ms of [0, -5, 499]) expect(speakDuration(ms, "en")).toBeUndefined()
  })
})

describe("speakDate and speakMoment", () => {
  const today = { year: 2026, month: 11, day: 18 } // Wednesday
  const rows: ReadonlyArray<readonly [{ year: number; month: number; day: number }, string, string]> = [
    [{ year: 2026, month: 11, day: 18 }, "today", "vandaag"], [{ year: 2026, month: 11, day: 19 }, "tomorrow", "morgen"], [{ year: 2026, month: 11, day: 17 }, "yesterday", "gisteren"],
    [{ year: 2026, month: 11, day: 20 }, "Friday", "overmorgen"], [{ year: 2026, month: 11, day: 21 }, "Saturday", "zaterdag"], [{ year: 2026, month: 11, day: 24 }, "Tuesday", "dinsdag"],
    [{ year: 2026, month: 11, day: 15 }, "Sunday the fifteenth of November 2026", "zondag 15 november 2026"], [{ year: 2026, month: 11, day: 16 }, "Monday the sixteenth of November 2026", "eergisteren"],
    [{ year: 2026, month: 11, day: 27 }, "Friday the twenty seventh", "vrijdag de zevenentwintigste"], [{ year: 2026, month: 11, day: 30 }, "Monday the thirtieth", "maandag de dertigste"],
    [{ year: 2026, month: 12, day: 3 }, "Thursday the third of December", "donderdag 3 december"], [{ year: 2027, month: 3, day: 3 }, "Wednesday the third of March 2027", "woensdag 3 maart 2027"],
    [{ year: 2026, month: 11, day: 3 }, "Tuesday the third of November 2026", "dinsdag 3 november 2026"]
  ]
  for (const [d, en, nl] of rows) it(`${d.year}-${d.month}-${d.day}`, () => {
    expect(speakDate(d, "en", today)).toBe(en)
    expect(speakDate(d, "nl", today)).toBe(nl)
  })
  it("moments", () => {
    expect(speakMoment({ date: { year: 2026, month: 11, day: 19 }, time: { hour: 7, minute: 30 } }, "en", today)).toBe("tomorrow at half past seven")
    expect(speakMoment({ date: { year: 2026, month: 11, day: 19 }, time: { hour: 7, minute: 30 } }, "nl", today)).toBe("morgen om half acht")
    expect(speakMoment({ date: { year: 2026, month: 11, day: 20 }, time: { hour: 19, minute: 0 } }, "en", today, { period: true })).toBe("Friday at seven o'clock in the evening")
    expect(speakMoment({ date: { year: 2026, month: 11, day: 19 } }, "en", today)).toBe("tomorrow")
  })
  it("month and year boundaries", () => {
    expect(speakDate({ year: 2027, month: 1, day: 1 }, "en", { year: 2026, month: 12, day: 31 })).toBe("tomorrow")
    expect(speakDate({ year: 2027, month: 1, day: 3 }, "nl", { year: 2026, month: 12, day: 31 })).toBe("zondag")
    expect(speakDate({ year: 2027, month: 2, day: 1 }, "en", { year: 2026, month: 12, day: 31 })).toBe("Monday the first of February 2027")
  })
})

describe("speakList", () => {
  it("no items, or an empty item, cannot be said", () => {
    expect(speakList([], "en")).toBeUndefined()
    expect(speakList(["milk", " "], "en")).toBeUndefined()
  })
  const rows: ReadonlyArray<readonly [ReadonlyArray<string>, "en" | "nl", string]> = [
    [["milk"], "en", "milk"], [["milk", "eggs"], "en", "milk and eggs"], [["milk", "eggs", "bread"], "en", "milk, eggs and bread"],
    [["milk", "eggs", "bread", "rice"], "en", "milk, eggs and two more"], [["a", "b", "c", "d", "e"], "en", "a, b and three more"], [["a", "b", "c", "d", "e", "f"], "en", "a, b and four more"],
    [["a", "b", "c", "d"], "nl", "a, b en nog twee"], [["melk", "eieren"], "nl", "melk en eieren"], [["melk", "eieren", "brood"], "nl", "melk, eieren en brood"],
    [["a", "b", "c", "d", "e"], "nl", "a, b en nog drie"]
  ]
  for (const [items, l, expected] of rows) it(`${l} ${items.length} items`, () => expect(speakList(items, l)).toBe(expected))
  it("max", () => {
    expect(speakList(["a", "b", "c", "d"], "en", { max: 5 })).toBe("a, b, c and d")
    expect(speakList(["a", "b", "c", "d"], "en", { max: 2 })).toBe("a and three more")
    expect(speakList(Array.from({ length: 30 }, (_, i) => String(i)), "en")).toBe("0, 1 and 28 more")
  })
})
