// Review round 5 (docs/AGENTS-AND-INTENTS.md, "Review fixes, fifth round"): character ownership
// follows role assignment (finding 2), an unfinished request never acts (finding 3), and a number
// after a time or condition word is no value (finding 5). Every row is checked against every
// confident answer a provider could give (`support/house.ts`).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction, Param, registerActions } from "../src/Actions.ts"
import { account, NOT_PARTITIONED } from "../src/Accounting.ts"
import { readUtterance } from "../src/Utterance.ts"
import { askLevel, confirmAllOff, expectOutcome } from "./support/house.ts"

describe("finding 2: a number absorbed into an option's name owns none of its sign, decimal mark or unit", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["turn on room two", "Act lights_on target=area:two"],
    ["turn on room -two", "Fallback"],
    ["turn on room –two", "Fallback"],
    ["turn on room −two", "Fallback"],
    ["turn on room two%", "Fallback"],
    ["turn on room two°", "Fallback"],
    ["turn on room two %", "Fallback"],
    ["turn on room .two", "Fallback"],
    ["turn on room -2", "Fallback"],
    ["turn on kamer -twee", "Fallback"],
    ["turn on the forty degrees lamp", "Act lights_on target=light:forty"],
    ["turn on the -forty degrees lamp", "Fallback"],
    ["turn on the forty° degrees lamp", "Fallback"],
    ["turn on the forty degrees° lamp", "Fallback"]
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))
  it("as the answer to 'Which room?' too", () => {
    // A pending choice: "dim to 40 percent" asks which room.
    expectOutcome("room -two", "Fallback", askLevel("area:two", "dim room two"))
  })
})

describe("finding 3: an unfinished request is never acted on", () => {
  const tails = ["for my", "at", "to", "for", "in the", "for the", "to my", "of", "in", "op de", "voor", "naar", "the", "my", "a"]
  for (const tail of tails) {
    for (const base of ["turn on the kitchen lights", "turn off the bedroom lights", "dim the living room to 40 percent"]) {
      it(`${JSON.stringify(`${base} ${tail}`)} → not acted on`, () => expectOutcome(`${base} ${tail}`, "Fallback"))
    }
    it(`before politeness: ${JSON.stringify(`turn on the kitchen lights ${tail} please`)} → not acted on`, () =>
      expectOutcome(`turn on the kitchen lights ${tail} please`, "Fallback"))
    it(`before a manner word: ${JSON.stringify(`turn on the kitchen lights ${tail} now`)} → not acted on`, () =>
      expectOutcome(`turn on the kitchen lights ${tail} now`, "Fallback"))
  }
  it("complete requests with a trailing politeness phrase still act", () => {
    expectOutcome("turn on the kitchen lights please", "Act lights_on target=area:kitchen")
    expectOutcome("turn on the kitchen lights for me", "Act lights_on target=area:kitchen")
    expectOutcome("doe het licht aan in de keuken voor mij", "Act lights_on target=area:kitchen")
  })
})

describe("finding 5: a number introduced by a time or condition word is not a value", () => {
  const rows: ReadonlyArray<string> = [
    "dim the kitchen at 7", "dim the kitchen by 7 percent", "dim the kitchen to 40 at 7", "dim the kitchen by 7",
    "dim the kitchen until 7", "dim the kitchen after 7", "dim the kitchen before 7", "dim the kitchen in 5 minutes",
    "dim the kitchen to 40 percent in 5 minutes", "dim the kitchen to 40 percent at 7", "zet de keuken om 7 op veertig procent",
    "zet de keuken op veertig procent om 7", "zet de keuken tot 7", "zet de keuken na 7", "zet de keuken voor 7 uur op 40",
    "zet de keuken over 5 minuten op 40", "dim the kitchen at seven", "dim the kitchen at 7 o'clock"
  ]
  for (const utterance of rows) it(`${JSON.stringify(utterance)} → not acted on`, () => expectOutcome(utterance, "Fallback"))
  it("as the answer to 'What brightness?' too", () => {
    expectOutcome("at 7", "Fallback", askLevel())
    expectOutcome("by 7", "Fallback", askLevel())
    expectOutcome("40", "Act set_brightness target=area:kitchen level=40", askLevel())
  })
  it("the value prepositions still place a value, and so does 'at' with the parameter's unit", () => {
    expectOutcome("dim the kitchen at 7 percent", "Act set_brightness target=area:kitchen level=7")
    expectOutcome("dim the kitchen to 40 percent", "Act set_brightness target=area:kitchen level=40")
    expectOutcome("zet de keuken op veertig procent", "Act set_brightness target=area:kitchen level=40")
  })
  it("a duration parameter keeps 'in … minutes'", () => {
    expectOutcome("start a timer for 10 minutes", "Act timer duration=600000")
  })
})

describe("the partition invariant is checked, not assumed", () => {
  const base = (text: string) => {
    const u = readUtterance(text)
    // Stems (round 7: no -en stripping, so "kitchen" stays "kitchen").
    return { ws: u.words, text: u.text, marks: u.marks, vocabulary: new Set(["dim", "kitchen"]), reserved: [], mode: "reply" as const }
  }
  it("a well-formed accounting partitions the text", () => {
    const a = base("dim kitchen 40%")
    const r = account({ ...a, covered: [{ from: 2, to: 3 }], consumed: [{ start: 12, end: 15 }] })
    assert.deepStrictEqual(r.unexplained, [])
  })
  it("two winning spans over the same word: not accounted for", () => {
    const a = base("dim kitchen 40")
    const r = account({ ...a, covered: [{ from: 1, to: 3 }, { from: 2, to: 3 }] })
    assert.include(r.unexplained, NOT_PARTITIONED)
  })
  it("two winning spans claiming the same mark: not accounted for", () => {
    const a = base("dim kitchen 40%")
    const r = account({ ...a, covered: [{ from: 2, to: 3 }], consumed: [{ start: 12, end: 15 }, { start: 14, end: 15 }] })
    assert.include(r.unexplained, NOT_PARTITIONED)
  })
  it("a text that is not canonical (a character neither word, mark nor single space): not accounted for", () => {
    const a = base("dim kitchen")
    const r = account({ ...a, text: "dim  kitchen", ws: [{ norm: "dim", start: 0, end: 3 }, { norm: "kitchen", start: 5, end: 12 }], marks: [], covered: [] })
    assert.include(r.unexplained, NOT_PARTITIONED)
  })
})

describe("neighbours", () => {
  it("unfinished replies to a pending question are not answers", () => {
    for (const reply of ["40 percent for", "40 percent to my", "40 for the", "op veertig procent voor", "40 percent at please"]) {
      expectOutcome(reply, "Fallback", askLevel())
    }
    expectOutcome("40 percent please", "Act set_brightness target=area:kitchen level=40", askLevel())
  })
  it("a time word before a duration: only 'for', 'in', 'voor', 'van', 'over', 'binnen' introduce one", () => {
    expectOutcome("start a timer at 10 minutes", "Fallback")
    expectOutcome("start a timer until 10 minutes", "Fallback")
    expectOutcome("start a timer in 10 minutes", "Act timer duration=600000")
    expectOutcome("zet een timer van tien minuten", "Act timer duration=600000")
  })
  it("marks inside an option's own name are still its own", () => {
    // "Lamp in the hall" has none; a "-" glued to it is no part of it.
    expectOutcome("turn on the lamp in the hall", "Act lights_on target=light:hall")
    expectOutcome("turn on the lamp in the -hall", "Fallback")
  })
})

describe("found by the property: an action is not chosen by the range of its rival's parameter", () => {
  it("'set the kitchen to 35' is brightness or heating: handed on, as 'set the kitchen to 20' is", () => {
    expectOutcome("set the kitchen to 20", "Fallback")
    expectOutcome("set the kitchen to 35", "Fallback")
    expectOutcome("set the kitchen to 3", "Fallback")
    expectOutcome("set the kitchen to 35 percent", "Act set_brightness target=area:kitchen level=35")
  })
})

describe("found by the property: a sign, a bare decimal mark or a dangling word in front", () => {
  it("'-0', '−0', 'minus zero' are no value (a sign flip never acts, even where it stays in range)", () => {
    expectOutcome("dim the kitchen to -0 percent", "Ask")
    expectOutcome("-0", "Ask", askLevel()) // asked again: "I can't use -0."
    expectOutcome("minus zero", "Ask", askLevel())
    expectOutcome("dim the kitchen to 0 percent", "Act set_brightness target=area:kitchen level=0")
  })
  it("',0' and '.0' (a decimal mark with only zeros after it) are no way to say 0", () => {
    expectOutcome(",0", "Ask", askLevel())
    expectOutcome(".0", "Ask", askLevel())
    expectOutcome("dim the kitchen to .00 percent", "Ask")
    expectOutcome("dim the kitchen to 4,0 percent", "Act set_brightness target=area:kitchen level=4")
  })
  it("an article or preposition right before the verb: not a request", () => {
    expectOutcome("at set the kitchen to 74 percent", "Fallback")
    expectOutcome("the dim the kitchen to 40 percent", "Fallback")
    expectOutcome("of turn on the kitchen lights", "Fallback")
    expectOutcome("ok dim the kitchen to 40 percent", "Act set_brightness target=area:kitchen level=40")
  })
})

describe("found by the property: a quote mark inside a word does not split it", () => {
  it("'a`t 82' is no 'a t 82': the mark stays and is unexplained", () => {
    expectOutcome("the kitchen a`t 82", "Fallback", askLevel())
    expectOutcome("dim the kit“chen to 40 percent", "Fallback")
    expectOutcome("dim the “kitchen” to 40 percent", "Act set_brightness target=area:kitchen level=40")
  })
})

describe("found by the property: a glued comma is no part of a confirmation", () => {
  it("',yes' and 'yes,ok' do not confirm; 'yes, please' does", () => {
    expectOutcome(",nu correct yeah", "Fallback", confirmAllOff())
    expectOutcome("yes,ok", "Fallback", confirmAllOff())
    expectOutcome("yes, please", "Act all_off", confirmAllOff())
  })
})

describe("found by the property: a broken longer name never falls back to the shorter name inside it", () => {
  const options = [
    { value: "light:hall_lamp", label: "Lamp in the hall" },
    { value: "area:hall", label: "Hall" },
    { value: "light:desk", label: "Desk" },
    { value: "light:desk_lamp", label: "Desk lamp" }
  ]
  const acts = registerActions("home", [
    defineAction({
      id: "set_brightness",
      label: "Set brightness",
      description: "Dim or brighten the lights in a room or one lamp to a level in percent.",
      examples: ["dim the hall to 40 percent"],
      params: { target: Param.dynamic({ label: "Room or light", options: () => options }), level: Param.number({ label: "Brightness", min: 0, max: 100, integer: true, unit: "percent" }) },
      run: () => Effect.void
    })
  ])
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["dim the lamp in the hall to 40 percent", "Act set_brightness target=light:hall_lamp level=40"],
    ["dim the hall to 40 percent", "Act set_brightness target=area:hall level=40"],
    ["dim the lights in the hall to 40 percent", "Act set_brightness target=area:hall level=40"],
    ["dim the desk lamp to 40 percent", "Act set_brightness target=light:desk_lamp level=40"],
    ["dim the desk to 40 percent", "Act set_brightness target=light:desk level=40"],
    ["dim the lamp in in the hall to 40 percent", "Ask"],
    ["dim the lamp in the the hall to 40 percent", "Ask"],
    ["dim the desk to lamp 40 percent", "Ask"],
    ["dim the lamp desk to 40 percent", "Ask"],
    ["dim the lamp in the to hall to 40 percent", "Ask"]
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want, undefined, acts))
})

describe("found by the property: a cut-off number word is not the Dutch article 't", () => {
  it("'for t eight seconds' (cut from 'thirty eight') does not start an 8 second timer", () => {
    expectOutcome("start a timer for t eight seconds", "Fallback")
    expectOutcome("dim the kitchen to t 40 percent", "Fallback")
    expectOutcome("t 40", "Fallback", askLevel())
    expectOutcome("doe t licht aan in de keuken", "Act lights_on target=area:kitchen")
  })
})

