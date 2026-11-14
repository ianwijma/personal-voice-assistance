// The house of review rounds 4 and 5 and the exhaustive provider: every row is checked
// against EVERY confident answer a decision provider could give (each action, each option of
// each parameter, "it answers" and "it does not"), the most harmful one included.
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction, Param, type ParamOption, registerActions, type RegisteredAction } from "../../src/Actions.ts"
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
} from "../../src/Decision.ts"
import { parseValues } from "../../src/ValueParsing.ts"

export const rooms: Array<ParamOption> = [
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
export const target = Param.dynamic({ label: "Room or light", options: () => rooms })
export const actions = registerActions("home", [
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

export const noul = (value: number): DecisionAnswer => ({ type: "noul", value })

/**
 * Every confident answer a provider could give for this plan: each offered action, each
 * combination of options of its parameters' questions (and of the pending answer), "fits",
 * "says which", "yes" all 0.99, compound 0.01, and "it answers the pending question" 0.99 or 0.01.
 */
export const everyAnswer = (plan: DecisionPlan): Array<DecisionResponse> => {
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

export const summary = (outcome: IntentOutcome): string => {
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

export const plan = (utterance: string, pending?: PendingIntent, acts: ReadonlyArray<RegisteredAction> = actions) =>
  buildDecisionPlan({ utterance, actions: acts, pending, parse: parseValues })

/** All outcomes over every confident answer. */
export const outcomes = (utterance: string, pending?: PendingIntent, acts?: ReadonlyArray<RegisteredAction>): Set<string> => {
  const p = plan(utterance, pending, acts)
  return new Set(everyAnswer(p).map((r) => summary(interpretDecision(p, r))))
}

/** An outcome with a side effect: acting on (or confirming) any action but the read-only `time_now`, which core does not check by design. */
export const sideEffect = (o: string) => (o.startsWith("Act") || o.startsWith("Confirm")) && !o.startsWith("Act time_now")

/**
 * The required outcome, whatever the provider answers:
 * - "Act …": some answer acts so, and no answer acts or confirms otherwise;
 * - "Confirm x": some answer asks to confirm x, and no answer acts;
 * - "Ask": no answer acts or confirms, some answer asks;
 * - "Fallback": every answer hands the sentence on.
 */
export const expectOutcome = (utterance: string, want: string, pending?: PendingIntent, acts?: ReadonlyArray<RegisteredAction>) => {
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

export const yesMan = (action: string, values: Readonly<Record<string, string>> = {}) => (p: DecisionPlan): DecisionResponse => {
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
export const decide = (utterance: string, provider: (p: DecisionPlan) => DecisionResponse, pending?: PendingIntent) => {
  const p = plan(utterance, pending)
  return interpretDecision(p, provider(p))
}
export const pendingOf = (utterance: string, provider: (p: DecisionPlan) => DecisionResponse, tag: "Ask" | "Confirm"): PendingIntent => {
  const outcome = decide(utterance, provider)
  if (outcome._tag !== tag) throw new Error(`expected ${tag}, got ${summary(outcome)}`)
  return outcome.pending
}
export const confirmAllOff = () => pendingOf("switch everything off", yesMan("all_off"), "Confirm")
export const askLevel = (room = "area:kitchen", said = "dim the kitchen lights") => pendingOf(said, yesMan("set_brightness", { target: room }), "Ask")

