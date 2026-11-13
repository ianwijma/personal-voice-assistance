// Review round 4 (docs/AGENTS-AND-INTENTS.md, "Review fixes, fourth round"): each piece of the
// sentence is used for exactly one purpose, in a form that means what the action needs. Every row
// is checked against EVERY confident answer a decision provider could give (each action, each
// option of each parameter, "it answers" and "it does not"): the most harmful one included.
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { assignRoles, NUMBER_ROLE } from "../src/Accounting.ts"
import { defineAction, Param, type ParamOption, registerActions, type RegisteredAction } from "../src/Actions.ts"
import {
  buildDecisionPlan,
  choiceAnswer,
  type DecisionAnswer,
  type DecisionPlan,
  type DecisionResponse,
  type IntentOutcome,
  interpretDecision,
  type PendingIntent,
  Q
} from "../src/Decision.ts"
import { defaultIntentWords, isConfirmation } from "../src/IntentWords.ts"
import { canonicalUtterance, sameUtterance } from "../src/Utterance.ts"
import { parseValues, unitFits } from "../src/ValueParsing.ts"

const rooms: Array<ParamOption> = [
  { value: "area:living_room", label: "Living room", aliases: ["lounge", "woonkamer"] },
  { value: "area:kitchen", label: "Kitchen", aliases: ["keuken"] },
  { value: "area:bedroom", label: "Bedroom", aliases: ["slaapkamer"] },
  // Option names with a number word, fillers, a yes-word, a number with a unit, a prohibition word.
  { value: "area:two", label: "Room two", aliases: ["kamer twee"] },
  { value: "light:hall", label: "Lamp in the hall", aliases: ["hallamp"] },
  { value: "light:ok", label: "OK lamp" },
  { value: "light:forty", label: "Forty degrees lamp" },
  { value: "light:stop", label: "Stop light" },
  { value: "light:desk_lamp", label: "Desk lamp", aliases: ["bureaulamp"] },
  { value: "all", label: "All lights", aliases: ["every light", "everything", "alle lampen", "alles"] }
]
const target = Param.dynamic({ label: "Room or light", options: () => rooms })
const actions = registerActions("home", [
  defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room, one lamp, or every light. Not for dimming: that is set_brightness.",
    examples: ["turn on the kitchen lights", "lights on in the bedroom", "switch on the desk lamp", "doe het licht aan in de woonkamer"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({
    id: "lights_off",
    label: "Turn lights off",
    description: "Switch off the lights in a room, one lamp, or every light.",
    examples: ["turn off the kitchen lights", "lights off in the bedroom", "doe het licht uit in de keuken"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({
    id: "set_brightness",
    label: "Set brightness",
    description: "Dim or brighten the lights in a room or one lamp to a level in percent.",
    examples: ["dim the living room to 40 percent", "set the desk lamp to 70%", "zet de woonkamer op veertig procent"],
    params: { target, level: Param.number({ label: "Brightness", min: 0, max: 100, integer: true, unit: "percent" }) },
    run: () => Effect.void
  }),
  defineAction({
    id: "set_heating",
    label: "Set the heating",
    description: "Set the heating in a room to a temperature in degrees.",
    examples: ["set the heating in the kitchen to 20 degrees", "zet de verwarming in de keuken op twintig graden"],
    params: { target, temp: Param.number({ label: "Temperature", min: 5, max: 30, unit: "degrees" }) },
    run: () => Effect.void
  }),
  defineAction({
    id: "set_colour",
    label: "Set colour",
    description: "Set the colour of the lights in a room: a hue in degrees and a brightness in percent.",
    examples: ["set the kitchen colour to 120 degrees at 50 percent"],
    params: {
      target,
      hue: Param.number({ label: "Hue", min: 0, max: 360, unit: "degrees" }),
      level: Param.number({ label: "Brightness", min: 0, max: 100, integer: true, unit: "percent" })
    },
    run: () => Effect.void
  }),
  defineAction({
    id: "timer",
    label: "Start a timer",
    description: "Start a countdown timer.",
    examples: ["start a timer for 10 minutes", "zet een timer van tien minuten"],
    params: { duration: Param.duration({ label: "Duration", minMs: 1_000, maxMs: 86_400_000 }) },
    run: () => Effect.void
  }),
  defineAction({
    id: "all_off",
    label: "Switch everything off",
    description: "Switch off every light in the house at once.",
    examples: ["switch everything off", "all off", "alles uit"],
    params: {},
    confirm: true,
    run: () => Effect.void
  }),
  defineAction({
    id: "time_now",
    label: "Tell the time",
    description: "Say what time it is now.",
    examples: ["what time is it", "hoe laat is het"],
    params: {},
    speculative: true,
    run: () => Effect.succeed({ say: "It's 14:32." })
  })
])

const noul = (value: number): DecisionAnswer => ({ type: "noul", value })

/**
 * Every confident answer a provider could give for this plan: each offered action, each
 * combination of options of its parameters' questions (and of the pending answer), "fits",
 * "says which", "yes" all 0.99, compound 0.01, and "it answers the pending question" 0.99 or 0.01.
 */
const everyAnswer = (plan: DecisionPlan): Array<DecisionResponse> => {
  const q = plan.request.questions
  const actionQ = q[Q.action]
  const actionIds = actionQ?.type === "choice" ? Object.keys(actionQ.options) : [""]
  const out: Array<DecisionResponse> = []
  for (const act of actionIds) {
    const choices = Object.entries(q).filter(([name, d]) =>
      d.type === "choice" && ((d.role.kind === "param" && d.role.action === act && name !== Q.pendingAnswer) || name === Q.pendingAnswer)
    )
    let combos: Array<Record<string, string>> = [{}]
    for (const [name, d] of choices) {
      if (d.type !== "choice") continue
      const ids = Object.keys(d.options).filter((id) => id !== "none")
      combos = combos.flatMap((c) => ids.map((id) => ({ ...c, [name]: id })))
    }
    for (const combo of combos) {
      for (const answers of plan.pending !== undefined ? [0.99, 0.01] : [0.99]) {
        const a: Record<string, DecisionAnswer> = {}
        for (const [name, d] of Object.entries(q)) {
          if (d.type === "choice") {
            const pick = name === Q.action ? act : combo[name]
            if (pick !== undefined) a[name] = choiceAnswer(Object.fromEntries(Object.keys(d.options).map((id) => [id, id === pick ? 0.99 : 0.001])))
          } else {
            a[name] = noul(d.role.kind === "compound" ? 0.01 : d.role.kind === "answers" ? answers : 0.99)
          }
        }
        out.push({ answers: a })
      }
    }
  }
  return out
}

const summary = (outcome: IntentOutcome): string => {
  switch (outcome._tag) {
    case "Act":
      return [`Act ${outcome.action.id.slice(5)}`, ...Object.entries(outcome.params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`)].join(" ")
    case "Ask":
    case "Confirm":
      return `${outcome._tag} ${outcome.pending.action.id.slice(5)}`
    case "Cancelled":
      return "Cancelled"
    case "Fallback":
      return `Fallback ${outcome.reason}`
  }
}

const plan = (utterance: string, pending?: PendingIntent, acts: ReadonlyArray<RegisteredAction> = actions) =>
  buildDecisionPlan({ utterance, actions: acts, pending, parse: parseValues })

/** All outcomes over every confident answer. */
const outcomes = (utterance: string, pending?: PendingIntent, acts?: ReadonlyArray<RegisteredAction>): Set<string> => {
  const p = plan(utterance, pending, acts)
  return new Set(everyAnswer(p).map((r) => summary(interpretDecision(p, r))))
}

/** An outcome with a side effect: acting on (or confirming) any action but the read-only `time_now`, which core does not check by design. */
const sideEffect = (o: string) => (o.startsWith("Act") || o.startsWith("Confirm")) && !o.startsWith("Act time_now")

/**
 * The required outcome, whatever the provider answers:
 * - "Act …": some answer acts so, and no answer acts or confirms otherwise;
 * - "Confirm x": some answer asks to confirm x, and no answer acts;
 * - "Ask": no answer acts or confirms, some answer asks;
 * - "Fallback": every answer hands the sentence on.
 */
const expectOutcome = (utterance: string, want: string, pending?: PendingIntent, acts?: ReadonlyArray<RegisteredAction>) => {
  const got = outcomes(utterance, pending, acts)
  const acting = [...got].filter(sideEffect)
  const label = `${JSON.stringify(utterance)}: ${[...got].join(" | ")}`
  if (want.startsWith("Act") || want.startsWith("Confirm")) {
    assert.deepStrictEqual(acting, [want], label)
  } else if (want === "Ask") {
    assert.deepStrictEqual(acting, [], label)
    assert.isTrue([...got].some((o) => o.startsWith("Ask")), label)
  } else {
    assert.deepStrictEqual([...got].filter((o) => !o.startsWith("Fallback") && o !== "Cancelled" && o !== "Act time_now"), [], label)
  }
}

const yesMan = (action: string, values: Readonly<Record<string, string>> = {}) => (p: DecisionPlan): DecisionResponse => {
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, q] of Object.entries(p.request.questions)) {
    if (q.type === "choice") {
      const ids = Object.keys(q.options)
      const wanted = q.role.kind === "action" ? `home.${action}` : q.role.kind === "param" ? values[q.role.param] : undefined
      const pick = wanted !== undefined && ids.includes(wanted) ? wanted : ids.find((id) => id !== "none") ?? ids[0]!
      answers[name] = choiceAnswer(Object.fromEntries(ids.map((id) => [id, id === pick ? 0.99 : 0.001])))
    } else answers[name] = noul(q.role.kind === "compound" ? 0.01 : 0.99)
  }
  return { answers }
}
const decide = (utterance: string, provider: (p: DecisionPlan) => DecisionResponse, pending?: PendingIntent) => {
  const p = plan(utterance, pending)
  return interpretDecision(p, provider(p))
}
const pendingOf = (utterance: string, provider: (p: DecisionPlan) => DecisionResponse, tag: "Ask" | "Confirm"): PendingIntent => {
  const outcome = decide(utterance, provider)
  if (outcome._tag !== tag) throw new Error(`expected ${tag}, got ${summary(outcome)}`)
  return outcome.pending
}
const confirmAllOff = () => pendingOf("switch everything off", yesMan("all_off"), "Confirm")
const askLevel = (room = "area:kitchen", said = "dim the kitchen lights") => pendingOf(said, yesMan("set_brightness", { target: room }), "Ask")

// ---------------------------------------------------------------------------

describe("the seven findings of review round 4, against every confident answer", () => {
  it("1: a final 'yes?' does not confirm (the promotion comparison is the shared canonical text)", () => {
    assert.isFalse(sameUtterance("yes", "yes?"), "eager 'yes' is not promoted for a final 'yes?'")
    assert.isTrue(sameUtterance("Yes", "Yes."))
    expectOutcome("yes?", "Fallback", confirmAllOff())
    expectOutcome("yes", "Act all_off", confirmAllOff())
  })
  it("2: '.5 percent' and '–5 percent' (any dash) never act with 5", () => {
    for (const utterance of ["dim the kitchen to .5 percent", "dim the kitchen to –5 percent"]) {
      expectOutcome(utterance, "Ask")
      const asked = decide(utterance, yesMan("set_brightness", { target: "area:kitchen", level: "c0" }))
      assert.strictEqual(asked._tag === "Ask" ? asked.question : summary(asked), `I can't use ${utterance.slice("dim the kitchen to ".length)}. What brightness?`)
    }
  })
  it("3: 'room two' names the room; its 'two' is not also the brightness", () => {
    expectOutcome("dim room two", "Ask")
    assert.strictEqual(summary(decide("dim room two", yesMan("set_brightness", { target: "area:two", level: "c0" }))), "Ask set_brightness")
    // Pending variant: room two chosen, "What brightness?" pending, the reply "room two".
    const pending = askLevel("area:two", "dim room two")
    expect(pending.params).toEqual({ target: "area:two" })
    expectOutcome("room two", "Fallback", pending)
    expectOutcome("two", "Act set_brightness target=area:two level=2", pending)
  })
  it("4: degrees are not percent", () => {
    expectOutcome("dim the kitchen to 40 degrees", "Fallback")
    expectOutcome("40 degrees", "Fallback", askLevel())
  })
  it("5: statements and questions about the world built from allowed words are handed on", () => {
    expectOutcome("I like the kitchen lights on", "Fallback")
    expectOutcome("will the kitchen lights turn on", "Fallback")
    expectOutcome("can you turn on the kitchen lights?", "Act lights_on target=area:kitchen")
  })
  it("7: an action beyond the 255-action cap cannot be confirmed through a pending confirmation", () => {
    const filler = registerActions("x", Array.from({ length: 260 }, (_, i) => defineAction({ id: `a${i}`, label: `Action ${i}`, description: "Nothing.", params: {}, run: () => Effect.void })))
    const late = actions.find((a) => a.id === "home.all_off")!
    const pending: PendingIntent = { action: late, params: {}, missing: [], awaiting: { kind: "confirm", question: "Switch everything off?" }, probability: 0.99 }
    const p = buildDecisionPlan({ utterance: "yes", actions: [...filler, late], pending, parse: parseValues })
    assert.isUndefined(p.pending, "the pending confirmation is dropped: its action is not offered")
    assert.include(p.warnings.join(" "), "no longer offered")
    for (const r of everyAnswer(p)) assert.isFalse(sideEffect(summary(interpretDecision(p, r))))
  })
})

// ---------------------------------------------------------------------------
// Rule 1: every character is accounted for.

const ALL_DASHES = ["-", "‐", "‑", "‒", "–", "—", "―", "−", "﹘", "﹣", "－"]

describe("rule 1: every character is accounted for (one shared normalisation)", () => {
  const rows: Array<readonly [string, string]> = []
  for (const d of ALL_DASHES) {
    rows.push([`dim the kitchen to ${d}5 percent`, "Ask"], [`dim the kitchen to ${d} 5 percent`, "Ask"], [`zet de keuken op ${d}vijf procent`, "Ask"])
    rows.push([`dim the kitchen to${d}5 percent`, "Fallback"]) // glued to a word: not a sign, and not consumed
    rows.push([`dim the kitchen to 5${d} percent`, "Ask"]) // a dash after the number: one span, no reading
  }
  const fixed: ReadonlyArray<readonly [string, string]> = [
    ["dim the kitchen to .5 percent", "Ask"],
    ["zet de keuken op ,5 procent", "Ask"],
    ["dim the kitchen to 40 ,5 percent", "Ask"],
    ["dim the kitchen to 5.percent", "Fallback"], // the point is in no number span: unaccounted
    ["dim the kitchen to 5,percent", "Ask"],
    ["dim the kitchen to 5, percent", "Ask"],
    ["dim the kitchen to 40,5 percent", "Ask"],
    ["dim the kitchen to 5. percent", "Act set_brightness target=area:kitchen level=5"], // a sentence mark followed by a space: not part of the number
    ["dim the kitchen to 40.", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to 40, please", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to 40 %", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to 40%!", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to 40?", "Fallback"],
    ["dim the kitchen to +40 percent", "Fallback"],
    ["dim the kitchen to 40°", "Fallback"],
    ["dim the kitchen to 4:30", "Fallback"],
    ["dim the kitchen to 40/100", "Fallback"],
    ["can you dim the kitchen to 40 percent?", "Act set_brightness target=area:kitchen level=40"],
    ["turn on the kitchen lights?", "Fallback"],
    ["turn on the kitchen lights?!", "Fallback"],
    ["turn on the kitchen lights!", "Act lights_on target=area:kitchen"],
    ["Turn on the kitchen lights.", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights…", "Act lights_on target=area:kitchen"],
    ["turn on the \"kitchen\" lights", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen-lights", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights #2", "Fallback"],
    ["turn on the kitchen lights & bedroom", "Fallback"],
    ["turn on the kitchen lights +", "Fallback"],
    ["turn on the kitchen lights - now", "Fallback"],
    ["could you turn on the kitchen lights?", "Act lights_on target=area:kitchen"],
    ["I want the kitchen lights on?", "Fallback"],
    ["doe het licht aan in de keuken!", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken?", "Fallback"],
    ["kun je het licht aan in de keuken?", "Act lights_on target=area:kitchen"],
    ["zet de keuken op 40 procent.", "Act set_brightness target=area:kitchen level=40"],
    ["zet de keuken op 40 procent?", "Fallback"],
    ["switch everything off?", "Fallback"],
    ["switch everything off!", "Confirm all_off"]
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))
  for (const d of ALL_DASHES) {
    it(`What brightness? → ${JSON.stringify(`${d}5`)} → Ask (never 5)`, () => expectOutcome(`${d}5`, "Ask", askLevel()))
  }
  for (const [utterance, want] of fixed) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))

  // Confirmations: the same canonical text decides, in eager and in final position.
  const confirmations: ReadonlyArray<readonly [string, boolean]> = [
    ["yes", true], ["Yes.", true], ["yes!", true], ["yes…", true], ["yes, please", true], ["ja.", true], ["ja!", true], ["doe maar.", true],
    ["yes?", false], ["Yes?", false], ["yes?!", false], ["yes!?", false], ["ja?", false], ["ok?", false], ["yes -", false], ["yes –", false],
    ["yes +", false], ["yes.?", false], ["yes ?", false], ["zeker?", false]
  ]
  for (const [reply, confirms] of confirmations) {
    it(`Switch everything off? → ${JSON.stringify(reply)}: ${confirms ? "confirms" : "does not confirm"}`, () => {
      assert.strictEqual(isConfirmation(reply), confirms)
      expectOutcome(reply, confirms ? "Act all_off" : "Fallback", confirmAllOff())
      // Eager "yes", final `reply`: the speculative decision is promoted only for the same canonical text.
      assert.strictEqual(sameUtterance("yes", reply), canonicalUtterance(reply) === "yes")
    })
  }
  it("the normalisation is shared and idempotent: the parser reads the canonical text", () => {
    for (const raw of ["Dim the kitchen to –5 percent!", "yes?!", "zet de keuken op ,5 procent.", "40, 5", "forty, five", "lights, please", "a.,", "5.,", "“kitchen”"]) {
      const once = canonicalUtterance(raw)
      assert.strictEqual(canonicalUtterance(once), once, raw)
      assert.deepStrictEqual(parseValues("number", raw), parseValues("number", once), raw)
    }
    assert.strictEqual(canonicalUtterance("forty, five"), "forty, five", "a comma between numbers is kept")
    assert.strictEqual(canonicalUtterance("lights, please."), "lights please")
    assert.deepStrictEqual(parseValues("number", "dim to forty, five").map((c) => c.value), [Number.NaN])
  })
})

// ---------------------------------------------------------------------------
// Rule 2: each span has exactly one role.

describe("rule 2: each span has exactly one role", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["dim room two", "Ask"],
    ["dim room two to 40 percent", "Act set_brightness target=area:two level=40"],
    ["turn on room two", "Act lights_on target=area:two"],
    ["dim kamer twee", "Ask"],
    ["zet kamer twee op veertig procent", "Act set_brightness target=area:two level=40"],
    ["dim room 2", "Ask"],
    ["dim room two hundred percent", "Ask"], // "room two" and "two hundred percent" cross: ambiguous
    ["turn on the OK lamp", "Act lights_on target=light:ok"],
    ["ok turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["ok lamp on", "Act lights_on target=light:ok"],
    ["turn on the lamp in the hall", "Act lights_on target=light:hall"],
    ["dim the lamp in the hall to 30 percent", "Act set_brightness target=light:hall level=30"],
    ["dim the forty degrees lamp to 40 percent", "Act set_brightness target=light:forty level=40"],
    ["dim the forty degrees lamp", "Ask"],
    ["set the kitchen colour to 40", "Ask"], // one number cannot be both the hue and the brightness
    ["set the kitchen colour to 40 at 60", "Fallback"], // round 5: "at 60" is a time
    ["set the kitchen colour to 40 degrees at 60", "Fallback"], // round 5: "at 60" is a time
    ["set the kitchen colour to 40 at 60 percent", "Act set_colour target=area:kitchen hue=40 level=60"], // "60 percent" can only be the level
    ["set the kitchen colour to 40 degrees at 60 percent", "Act set_colour target=area:kitchen hue=40 level=60"], // the unit decides
    ["set the kitchen colour to 120 degrees at 50 percent", "Act set_colour target=area:kitchen hue=120 level=50"],
    ["turn on the kitchen and the bedroom lights", "Fallback"],
    ["dim the kitchen to 40 percent 50 percent", "Ask"],
    ["doe het licht aan in kamer twee", "Act lights_on target=area:two"],
    ["zet kamer twee op twee procent", "Act set_brightness target=area:two level=2"],
    ["zet kamer twee", "Fallback"], // "zet": brightness, heating or a timer?
    ["switch everything off", "Confirm all_off"], // "everything" is all_off's own word, and only lights_off's value: all_off is the more specific reading
    ["alles uit", "Confirm all_off"],
    ["turn the kitchen lights", "Fallback"], // on or off? two actions explain it equally
    ["set the kitchen to 20", "Fallback"] // brightness or heating?
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))

  it("replies: a value already decided may be repeated, but its words fill nothing else", () => {
    const two = askLevel("area:two", "dim room two")
    expectOutcome("room two", "Fallback", two)
    expectOutcome("room two at 40 percent", "Act set_brightness target=area:two level=40", two)
    expectOutcome("room two at 40", "Fallback", two) // round 5: a number after "at" without its unit is a time
    expectOutcome("room two 40", "Fallback", two) // "two 40" is one number span that crosses the name
    expectOutcome("kamer twee", "Fallback", two)
    expectOutcome("40 percent", "Act set_brightness target=area:kitchen level=40", askLevel())
    expectOutcome("the forty degrees lamp", "Fallback", askLevel())
  })
  it("two options with the same name are ambiguous: asked, never guessed", () => {
    const twins = [{ value: "light:a", label: "Desk lamp" }, { value: "light:b", label: "Desk lamp" }, { value: "area:kitchen", label: "Kitchen" }]
    const on = registerActions("twins", [defineAction({
      id: "on",
      label: "Turn lights on",
      description: "Switch on the lights.",
      examples: ["turn on the kitchen lights"],
      params: { target: Param.dynamic({ label: "Room or light", options: () => twins }) },
      run: () => Effect.void
    })])
    const got = outcomes("turn on the desk lamp", undefined, on)
    assert.deepStrictEqual([...got].filter((o) => o.startsWith("Act")), [], [...got].join(" | "))
  })
  it("assignRoles: longest first, contained spans consumed, crossing or equal spans ambiguous", () => {
    const r = assignRoles([
      { from: 1, to: 3, role: "target" },
      { from: 2, to: 3, role: NUMBER_ROLE },
      { from: 5, to: 7, role: "target" },
      { from: 6, to: 8, role: NUMBER_ROLE },
      { from: 9, to: 10, role: "a" },
      { from: 9, to: 10, role: "b" }
    ])
    expect(r.taken.map((t) => [t.from, t.to, t.role])).toEqual([[1, 3, "target"]])
    expect(r.ambiguous.map((a) => [a.from, a.to, [...a.roles].sort()])).toEqual([[5, 8, ["#number", "target"]], [9, 10, ["a", "b"]]])
  })
})

// ---------------------------------------------------------------------------
// Rule 3: a value carries its unit, and the unit must fit.

describe("rule 3: a number's unit must be the parameter's unit (or none)", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["dim the kitchen to 40 degrees", "Fallback"],
    ["dim the kitchen to 40 degree", "Fallback"],
    ["dim the kitchen to 40°", "Fallback"],
    ["dim the kitchen to 40 graden", "Fallback"],
    ["zet de keuken op veertig graden", "Ask"], // never the brightness; the heating asks again (40 is out of its range)
    ["zet de keuken op twintig graden", "Act set_heating target=area:kitchen temp=20"], // degrees: the heating, never the brightness
    ["dim the kitchen to 40 pct", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to 40 procent", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to 40 minutes", "Fallback"],
    ["dim the kitchen to 40 seconds", "Fallback"],
    ["dim the kitchen to an hour", "Fallback"],
    ["zet de keuken op tien minuten", "Act timer duration=600000"], // "zet een timer"… no: a timer has no room
    ["set the heating in the kitchen to 20 percent", "Fallback"],
    ["set the heating in the kitchen to 20%", "Fallback"],
    ["set the heating in the kitchen to 20 degrees", "Act set_heating target=area:kitchen temp=20"],
    ["set the heating in the kitchen to 20°", "Act set_heating target=area:kitchen temp=20"],
    ["set the heating in the kitchen to 20", "Act set_heating target=area:kitchen temp=20"],
    ["zet de verwarming in de keuken op twintig procent", "Fallback"],
    ["zet de verwarming in de keuken op twintig graden", "Act set_heating target=area:kitchen temp=20"],
    ["start a timer for 10 percent", "Fallback"],
    ["start a timer for 10 degrees", "Fallback"],
    ["start a timer for ten", "Fallback"],
    ["start a timer for 10 minutes", "Act timer duration=600000"],
    ["zet een timer van tien minuten", "Act timer duration=600000"],
    ["set the kitchen colour to 50 percent at 120 degrees", "Act set_colour target=area:kitchen hue=120 level=50"],
    ["set the kitchen colour to 120 percent at 50 degrees", "Ask"]
  ]
  for (const [utterance, want] of rows) {
    if (utterance === "zet de keuken op tien minuten") continue // see below: a room is no part of a timer
    it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))
  }
  it("zet de keuken op tien minuten: no action takes a room and a duration", () => expectOutcome("zet de keuken op tien minuten", "Fallback"))
  const replies: ReadonlyArray<readonly [string, string]> = [
    ["40 degrees", "Fallback"], ["40 graden", "Fallback"], ["40°", "Fallback"], ["40 minutes", "Fallback"], ["veertig minuten", "Fallback"],
    ["40 procent", "Act set_brightness target=area:kitchen level=40"], ["40%", "Act set_brightness target=area:kitchen level=40"],
    ["40 pct", "Act set_brightness target=area:kitchen level=40"], ["40", "Act set_brightness target=area:kitchen level=40"]
  ]
  for (const [reply, want] of replies) it(`What brightness? → ${JSON.stringify(reply)} → ${want}`, () => expectOutcome(reply, want, askLevel()))
  it("unitFits: closed aliases", () => {
    assert.isTrue(unitFits("percent", "percent"))
    assert.isTrue(unitFits("%", "percent"))
    assert.isTrue(unitFits("degrees", "degree"))
    assert.isTrue(unitFits("°C", "degree"))
    assert.isTrue(unitFits("percent", undefined))
    assert.isFalse(unitFits("percent", "degree"))
    assert.isFalse(unitFits(undefined, "percent"))
    assert.isFalse(unitFits("lux", "percent"))
  })
})

// ---------------------------------------------------------------------------
// Rule 4: fillers are positional; a sentence must be a request.

describe("rule 4: a sentence must be a request (positional fillers)", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    // Statements, questions about the world, reported speech, conditionals: every word individually allowed.
    ["I like the kitchen lights on", "Fallback"],
    ["will the kitchen lights turn on", "Fallback"],
    ["did you turn on the kitchen lights", "Fallback"],
    ["you turn on the kitchen lights", "Fallback"],
    ["you turned on the kitchen lights", "Fallback"],
    ["the kitchen lights turn on", "Fallback"],
    ["the kitchen lights turned on", "Fallback"],
    ["turning on the kitchen lights", "Fallback"],
    ["I turn on the kitchen lights", "Fallback"],
    ["I will turn on the kitchen lights", "Fallback"],
    ["can the kitchen lights turn on", "Fallback"],
    ["would the kitchen lights turn on", "Fallback"],
    ["he said turn on the kitchen lights", "Fallback"],
    ["she wants the kitchen lights on", "Fallback"],
    ["if it gets dark turn on the kitchen lights", "Fallback"],
    ["turn on the kitchen lights if it gets dark", "Fallback"],
    ["turn on the kitchen lights at midnight", "Fallback"],
    ["turn on the kitchen lights I", "Fallback"],
    ["turn on like the kitchen lights", "Fallback"],
    ["turn on the kitchen lights you", "Fallback"],
    ["turn on the kitchen lights will", "Fallback"],
    ["the kitchen", "Fallback"],
    ["kitchen lights", "Fallback"],
    ["ik vind het licht in de keuken aan fijn", "Fallback"],
    ["is het licht in de keuken aan", "Fallback"],
    ["ik doe het licht aan in de keuken", "Fallback"],
    ["hij zei doe het licht aan in de keuken", "Fallback"],
    ["als het donker wordt doe het licht aan in de keuken", "Fallback"],
    ["de keuken doe het licht aan", "Fallback"],
    // Requests.
    ["turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["can you turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["can you turn on the kitchen lights?", "Act lights_on target=area:kitchen"],
    ["could you please turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["would you turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["will you turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["please turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["I want the kitchen lights on", "Act lights_on target=area:kitchen"],
    ["I'd like the kitchen lights on", "Act lights_on target=area:kitchen"],
    ["I would like you to turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["let's turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["hey, turn on my kitchen lights", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken", "Act lights_on target=area:kitchen"],
    ["doe even het licht aan in de keuken", "Act lights_on target=area:kitchen"],
    ["ik wil het licht aan in de keuken", "Act lights_on target=area:kitchen"],
    ["kun je het licht aan in de keuken", "Act lights_on target=area:kitchen"],
    ["wil je de woonkamer op veertig procent zetten", "Fallback"] // "zetten" is not the action's word
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))
})

// ---------------------------------------------------------------------------
// Usability within the rule.

describe("usability: closed politeness and manner lists at the edges", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["turn on the kitchen lights thank you", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights, thanks", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights thank you very much", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights cheers", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights for me please", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken dank je", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken dank je wel", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken, bedankt", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken alsjeblieft", "Act lights_on target=area:kitchen"],
    ["quickly turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights quickly", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights right now", "Act lights_on target=area:kitchen"],
    ["immediately turn on the kitchen lights", "Act lights_on target=area:kitchen"],
    ["turn on the kitchen lights now thanks", "Act lights_on target=area:kitchen"],
    ["snel het licht aan in de keuken", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken meteen", "Act lights_on target=area:kitchen"],
    ["doe het licht aan in de keuken nu", "Act lights_on target=area:kitchen"],
    ["dim the kitchen to 40 percent quickly please", "Act set_brightness target=area:kitchen level=40"],
    // Still refused.
    ["thank you turn on the kitchen lights", "Fallback"],
    ["turn on quickly the kitchen lights", "Fallback"],
    ["doe snel het licht aan in de keuken", "Fallback"],
    ["please turn on the kitchen lights for my mother", "Fallback"],
    ["turn on the kitchen lights thank you and lock the door", "Fallback"],
    ["turn on the kitchen lights please and the bedroom", "Fallback"],
    ["turn on the kitchen lights at midnight thanks", "Fallback"],
    ["turn on the attic lights thanks", "Fallback"],
    ["dim 3 lights in the kitchen to 40 percent", "Fallback"],
    ["turn up the lights", "Fallback"],
    ["dim the kitchen lights a bit", "Fallback"],
    ["turn on the stop light", "Fallback"]
  ]
  for (const [utterance, want] of rows) it(`${JSON.stringify(utterance)} → ${want}`, () => expectOutcome(utterance, want))
})

// ---------------------------------------------------------------------------
// The property of round 4 (its oracle reused the production word lists and frame stripping, and so
// shared their bugs) is replaced by test/PropertyRound5.test.ts, whose valid commands are built by
// construction from literal data.

// ---------------------------------------------------------------------------

describe("cost of round 4's rules", () => {
  it("planning and interpreting one sentence stays well under a millisecond, with no extra decision request", () => {
    const pending = askLevel()
    const sentences = [
      "can you turn on the lights in the living room please", "dim the kitchen to one hundred and forty percent", "the attic 40",
      "zet de woonkamer op veertig procent", "dim room two", "I like the kitchen lights on", "dim the kitchen to –5 percent?"
    ]
    const provider = yesMan("set_brightness", { target: "area:kitchen" })
    const run = (utterance: string, p?: PendingIntent) => {
      const built = plan(utterance, p)
      interpretDecision(built, provider(built))
    }
    for (let i = 0; i < 200; i++) for (const s of sentences) run(s, pending)
    const n = 1_000
    const start = performance.now()
    // Trailing spaces vary the raw text (same canonical text), so the small read cache does not hide the normalisation.
    for (let i = 0; i < n; i++) for (const s of sentences) run(`${s}${" ".repeat(i % 5)}`, i % 2 === 0 ? pending : undefined)
    const each = (performance.now() - start) / (n * sentences.length)
    console.log(`round 4: plan + interpret ${(each * 1000).toFixed(0)} µs per sentence (${actions.length} actions, one decision request)`)
    assert.isBelow(each, 1)
    // One request per utterance: the plan holds exactly one request.
    expect(Object.keys(plan("turn on the kitchen lights").request.questions)).toContain(Q.action)
  })
})
