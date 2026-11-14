// Review round 6, finding 3: a name matches by stem only where the suffix carries no meaning of its
// own, and a possessive is a dependent form that must be followed by what it possesses. Every row
// is checked against every confident answer a provider could give (`support/house.ts`).
import { assert, describe, it } from "@effect/vitest"
import { defineAction, Param, type ParamOption, registerActions } from "../src/Actions.ts"
import { allOptionMentions } from "../src/Accounting.ts"
import { words } from "../src/TextMatching.ts"
import { readUtterance } from "../src/Utterance.ts"
import { Effect } from "effect"
import { askLevel, expectOutcome } from "./support/house.ts"

describe("finding 3: a dangling possessive is not a complete target", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    // The reviewer's sentences.
    ["turn on the bedroom's please", "Fallback"],
    ["turn on the living room's", "Fallback"],
    // At the end, before a closer, a manner word, a filler or a preposition; curly apostrophe; capitals.
    ["turn on the bedroom's", "Fallback"],
    ["turn on the bedroom’s", "Fallback"],
    ["turn on the Bedroom's now", "Fallback"],
    ["turn on the kitchen's thanks", "Fallback"],
    ["dim the bedroom's to 40 percent", "Fallback"],
    ["turn on the bedroom's the", "Fallback"],
    ["turn on the bedrooms' please", "Fallback"],
    // Followed by what it possesses: the action's own word explains it.
    ["turn on the bedroom's lights", "Act lights_on target=area:bedroom"],
    ["turn on the living room's lights please", "Act lights_on target=area:living_room"],
    // Without the apostrophe (a recogniser dropping it): a bare plural of a name is a dependent form too.
    ["turn on the bedrooms", "Fallback"],
    ["turn on the bedrooms lights", "Act lights_on target=area:bedroom"],
    // Unchanged: the name itself.
    ["turn on the bedroom lights", "Act lights_on target=area:bedroom"],
    ["turn on the bedroom", "Act lights_on target=area:bedroom"]
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))

  it("as the answer to a pending question too: 'the bedroom's' is no answer", () => {
    expectOutcome("the bedroom's", "Fallback", askLevel("area:bedroom", "dim the bedroom lights"))
  })

  it("the possessive survives normalisation: words() marks it, the norm drops the apostrophe", () => {
    assert.deepStrictEqual(words("the bedroom's kids' room it's").map((w) => [w.norm, w.possessive === true]), [
      ["the", false], ["bedrooms", true], ["kids", true], ["room", false], ["its", true]
    ])
  })
})

describe("finding 3: names with an apostrophe of their own still match", () => {
  const options: Array<ParamOption> = [{ value: "area:kids", label: "Kids' room" }, { value: "area:mary", label: "Mary's" }]
  const acts = registerActions("home", [defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room.",
    examples: ["turn on the kitchen lights"],
    params: { target: Param.dynamic({ label: "Room", options: () => options }) },
    run: () => Effect.void
  })])
  it("\"Kids' room\" and \"Mary's\" are named, with or without the apostrophe", () => {
    expectOutcome("turn on the kids' room", "Act lights_on target=area:kids", undefined, acts)
    expectOutcome("turn on the kids room", "Act lights_on target=area:kids", undefined, acts)
    expectOutcome("turn on mary's", "Act lights_on target=area:mary", undefined, acts)
  })
})

describe("finding 3: a stem match never discards a suffix with a meaning of its own", () => {
  const options: Array<ParamOption> = [
    { value: "wood", label: "Wood" }, { value: "list", label: "List" }, { value: "lamp", label: "Lamp" }, { value: "kitchen", label: "Kitchen" },
    { value: "nursery", label: "Nursery" }, { value: "box", label: "Box" }
  ]
  const mentioned = (said: string) => allOptionMentions(readUtterance(said).words, options).map((m) => `${String(m.option.value)}${m.possessive === true ? "(dependent)" : ""}`)
  it("-en, -er, -ing, -ed, -je and cut-off forms name nothing", () => {
    for (const said of ["wooden", "listen", "listing", "listed", "lampje", "lampen", "kitchener", "kitch", "lamper"]) assert.deepStrictEqual(mentioned(said), [], said)
  })
  it("plurals (-s, -es, -ies) name it as a dependent form; the word itself plainly", () => {
    assert.deepStrictEqual(mentioned("lamps"), ["lamp(dependent)"])
    assert.deepStrictEqual(mentioned("boxes"), ["box(dependent)"])
    assert.deepStrictEqual(mentioned("nurseries"), ["nursery(dependent)"])
    assert.deepStrictEqual(mentioned("lamp"), ["lamp"])
  })
})
