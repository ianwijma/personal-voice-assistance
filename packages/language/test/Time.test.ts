// Round 3: the American "of" / "till", Dutch "twintig voor" and "19u30" were removed (decision 5); "13 pm" agrees
// with its settled hour, so it is read (finding 19: a part of the day that agrees is accepted).
import { describe, expect, it } from "@effect/vitest"
import { parseTimeOfDay } from "../src/Time.ts"
import { hm } from "./helpers.ts"

type Row = readonly [text: string, expected: string, guessed?: boolean]

const read = (text: string, language: "en" | "nl", options?: Parameters<typeof parseTimeOfDay>[2]) => {
  const r = parseTimeOfDay(text, language, options)
  return r.kind === "ok" ? [hm(r.value), r.value.guessed] : r.kind
}

describe("parseTimeOfDay: English", () => {
  const rows: ReadonlyArray<Row> = [
    ["seven", "07:00", true], ["7", "07:00", true], ["7:30", "07:30", true], ["7.30", "07:30", true], ["at seven", "07:00", true],
    ["half past seven", "07:30", true], ["quarter past seven", "07:15", true], ["a quarter past seven", "07:15", true],
    ["quarter to seven", "18:45", true], ["a quarter to four", "15:45", true], ["twenty to seven", "18:40", true], ["ten past eleven", "11:10", true],
    ["five to eleven", "10:55", true], ["twenty five past six", "18:25", true], ["ten of seven", "not-understood"], ["quarter till nine", "not-understood"],
    ["seven thirty", "07:30", true], ["seven fifteen", "07:15", true], ["seven forty five", "07:45", true], ["seven oh five", "07:05", true], ["eight o'clock", "08:00", true],
    ["seven thirty pm", "19:30", false], ["7 pm", "19:00", false], ["7pm", "19:00", false], ["7:30 p.m.", "19:30", false], ["7 a.m.", "07:00", false],
    ["seven in the evening", "19:00", false], ["seven in the morning", "07:00", false], ["half past eight in the evening", "20:30", false],
    ["ten at night", "22:00", false], ["three in the afternoon", "15:00", false], ["two at night", "02:00", false],
    ["12 pm", "12:00", false], ["12 am", "00:00", false], ["12:15 am", "00:15", false], ["noon", "12:00", false], ["midnight", "00:00", false], ["half past twelve", "12:30", true],
    ["nineteen thirty", "19:30", false], ["19:45", "19:45", false], ["07:30", "07:30", false], ["0:30", "00:30", false], ["23:59", "23:59", false], ["13", "13:00", false]
  ]
  for (const [text, expected, guessed] of rows) it(`"${text}" is ${expected}${guessed ? " (guessed)" : ""}`, () => expect(read(text, "en")).toEqual(guessed === undefined ? expected : [expected, guessed]))

  it('"half seven" is 7:30 in English (not 6:30)', () => {
    expect(read("half seven", "en")).toEqual(["07:30", true])
    expect(read("half five", "en")).toEqual(["17:30", true])
    expect(read("half six", "en")).toEqual(["18:30", true])
  })
  for (const bad of ["", "tomorrow", "banana", "25:00", "7:75", "quarter to", "half", "seven thirty-one pm tomorrow", "0 pm", "seven please", "around seven", "until seven", "seven or eight", "seven UTC", "not seven", "24:00"]) it(`"${bad}" is not a time`, () => expect(read(bad, "en")).toBe("not-understood"))
})

describe("parseTimeOfDay: Dutch", () => {
  const rows: ReadonlyArray<Row> = [
    ["zeven", "07:00", true], ["zeven uur", "07:00", true], ["om zeven uur", "07:00", true], ["7 uur", "07:00", true], ["7:30", "07:30", true],
    ["half acht", "07:30", true], ["half zeven", "18:30", true], ["half twaalf", "11:30", true], ["half een", "12:30", true], ["half twee", "13:30", true], ["om half drie", "14:30", true],
    ["kwart voor zeven", "18:45", true], ["kwart over zeven", "07:15", true], ["kwart voor acht", "07:45", true], ["kwart over twaalf", "12:15", true],
    ["vijf over zeven", "07:05", true], ["vijf voor zeven", "18:55", true], ["tien over acht", "08:10", true], ["twintig voor negen", "not-understood"],
    ["tien voor half acht", "07:20", true], ["tien over half acht", "07:40", true], ["vijf over half zes", "17:35", true], ["vijf voor half twee", "13:25", true],
    ["vijf minuten voor zeven", "18:55", true], ["zeven uur dertig", "07:30", true], ["zeven uur vijftien", "07:15", true],
    ["zeven uur 's avonds", "19:00", false], ["acht uur 's ochtends", "08:00", false], ["kwart over zeven 's avonds", "19:15", false], ["half zeven 's avonds", "18:30", false],
    ["half twaalf 's avonds", "23:30", false], ["twaalf uur 's middags", "12:00", false], ["twaalf uur 's nachts", "00:00", false], ["twee uur 's nachts", "02:00", false],
    ["tien uur 's avonds", "22:00", false], ["drie uur in de middag", "15:00", false], ["acht uur in de avond", "20:00", false], ["middernacht", "00:00", false],
    ["19:30", "19:30", false], ["19u30", "not-understood"], ["dertien uur", "13:00", false], ["07:30", "07:30", false]
  ]
  for (const [text, expected, guessed] of rows) it(`"${text}" is ${expected}${guessed ? " (guessed)" : ""}`, () => expect(read(text, "nl")).toEqual(guessed === undefined ? expected : [expected, guessed]))

  it('"half zeven" is 6:30 in Dutch (the hour before), so half past six in the evening', () => {
    expect(read("half zeven", "nl", { band: { from: "00:00", to: "11:59" } })).toEqual(["06:30", true])
    expect(read("half zeven 's ochtends", "nl")).toEqual(["06:30", false])
    expect(read("half acht 's ochtends", "nl")).toEqual(["07:30", false])
  })
  for (const bad of ["", "morgen", "banaan", "25 uur", "half", "kwart voor", "half dertien", "zeven uur alsjeblieft", "rond zeven uur", "tot zeven uur", "zeven of acht uur", "niet om zeven uur"]) it(`"${bad}" is not a time`, () => expect(read(bad, "nl")).toBe("not-understood"))
})

describe("parseTimeOfDay: the band", () => {
  it("reports what else fits inside the band", () => {
    const r = parseTimeOfDay("nine", "en")
    expect(r.kind === "ok" && r.value.alternatives).toEqual([{ hour: 21, minute: 0 }])
    expect(r.kind === "ok" && hm(r.value)).toBe("09:00")
    const seven = parseTimeOfDay("seven", "en")
    expect(seven.kind === "ok" && seven.value.alternatives).toEqual([{ hour: 19, minute: 0 }])
    const five = parseTimeOfDay("five", "en")
    expect(five.kind === "ok" && five.value.alternatives).toEqual([])
  })
  it("a wider or narrower band changes the reading", () => {
    expect(read("six", "en")).toEqual(["18:00", true])
    expect(read("six", "en", { band: { from: "05:00", to: "09:00" } })).toEqual(["06:00", true])
    expect(read("ten", "en", { band: { from: "16:00", to: "23:00" } })).toEqual(["22:00", true])
    expect(read("ten", "en", { band: { from: 600, to: 720 } })).toEqual(["10:00", true])
  })
  it("the next reading after now wins when asked", () => {
    expect(read("seven", "en", { afterMinutes: 10 * 60 })).toEqual(["19:00", true])
    expect(read("seven", "en", { afterMinutes: 5 * 60 })).toEqual(["07:00", true])
    expect(read("half acht", "nl", { afterMinutes: 8 * 60 })).toEqual(["19:30", true])
  })
  it("is ambiguous when no reading is inside the band", () => {
    const r = parseTimeOfDay("three", "en", { band: { from: "09:00", to: "11:00" } })
    expect(r.kind).toBe("ambiguous")
    expect(r.kind === "ambiguous" && r.candidates.map(hm)).toEqual(["03:00", "15:00"])
    expect(read("three pm", "en", { band: { from: "09:00", to: "11:00" } })).toEqual(["15:00", false])
  })
  it("says what it read", () => {
    const r = parseTimeOfDay("at half past seven", "en")
    expect(r.kind === "ok" && r.said).toBe("half past seven")
  })
})
