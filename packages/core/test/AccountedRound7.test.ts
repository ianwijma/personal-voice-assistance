// Review round 7, finding 7: an action's vocabulary matches a word only by itself or by a closed set of
// regular inflections (plural -s/-es/-ies, third-person -s) — no -en, -er, -ing, -ed stripping. Each
// row is checked against every confident answer a provider could give (`support/house.ts`).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction, Param, registerActions } from "../src/Actions.ts"
import { stemWord } from "../src/Accounting.ts"
import { expectOutcome } from "./support/house.ts"

const acts = registerActions("home", [
  defineAction({
    id: "list_music",
    label: "List music",
    description: "Read out the music in a playlist.",
    examples: ["list music"],
    params: {},
    run: () => Effect.void
  }),
  defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room.",
    examples: ["turn on the kitchen lights", "zet het licht aan in de keuken"],
    params: { target: Param.dynamic({ label: "Room", options: () => [{ value: "area:kitchen", label: "Kitchen", aliases: ["keuken"] }] }) },
    run: () => Effect.void
  })
])

describe("round 7 finding 7: action words match only themselves or a regular inflection", () => {
  it("the reviewer's sentence: \"listen music\" does not act on \"List music\"", () => {
    expectOutcome("listen music", "Fallback", undefined, acts)
  })

  const rows: ReadonlyArray<readonly [string, string]> = [
    ["list music", "Act list_music"],
    ["lists music", "Act list_music"], // third person -s: the same verb
    ["listing music", "Fallback"],
    ["listed music", "Fallback"],
    ["lister music", "Fallback"],
    ["turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen light", "Act lights_on target=area:kitchen"], // plural -s, both ways
    // Dutch verb forms are not derived: "zetten" is not "zet", "lichten" is not "licht".
    ["zetten het licht aan in de keuken", "Fallback"],
    ["zet de lichten aan in de keuken", "Fallback"]
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want, undefined, acts))

  it("stemWord strips only -s, -es (after a sibilant) and -ies", () => {
    assert.deepStrictEqual(
      ["listen", "lichten", "zetten", "lampen", "lights", "switches", "boxes", "batteries", "listing", "listed"].map(stemWord),
      ["listen", "lichten", "zetten", "lampen", "light", "switch", "box", "battery", "listing", "listed"]
    )
  })
})
