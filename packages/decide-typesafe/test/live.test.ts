/**
 * Opt-in: runs only when TYPESAFE_API_KEY is set (a key from console.typesafe.ai/keys).
 *
 *   TYPESAFE_API_KEY=… pnpm --filter @pva/decide-typesafe test live
 *
 * Optional: TYPESAFE_MODEL, TYPESAFE_BASE_URL. Logs the decision latency of a
 * cold call (new connection), a warm one, and one after 6 s idle (Node's fetch
 * closes idle connections after about 4 s, so this shows what a pause between
 * commands costs), plus what Jev answered for English and Dutch commands.
 */
import { assert, describe, it } from "@effect/vitest"
import { buildDecisionPlan, defineAction, interpretDecision, Param, registerActions } from "@pva/core"
import { Effect, Redacted } from "effect"
import { defaults, makeJevClient } from "../src/JevClient.ts"

const key = process.env.TYPESAFE_API_KEY ?? ""

const targets = [
  { value: "area:living_room", label: "Living room", aliases: ["lounge", "woonkamer"] },
  { value: "area:kitchen", label: "Kitchen", aliases: ["keuken"] },
  { value: "area:bedroom", label: "Bedroom", aliases: ["slaapkamer"] },
  { value: "all", label: "All lights", aliases: ["everywhere", "overal"] }
]
const target = Param.dynamic({ label: "Room or light", options: () => targets })
const actions = registerActions("demo-home", [
  defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room, one light, or every light. Not for dimming.",
    examples: ["turn on the kitchen lights", "doe het licht aan in de woonkamer"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({
    id: "lights_off",
    label: "Turn lights off",
    description: "Switch off the lights in a room, one light, or every light.",
    examples: ["lights off in the bedroom", "doe het licht uit"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({ id: "time_now", label: "Tell the time", description: "Say the current time.", params: {}, speculative: true, run: () => Effect.void })
])

describe.skipIf(key === "")("TypeSafe Jev (live)", () => {
  it.live("decides real utterances and logs the round trip", () =>
    Effect.gen(function*() {
      const jev = makeJevClient({
        apiKey: Redacted.make(key),
        baseUrl: process.env.TYPESAFE_BASE_URL ?? defaults.baseUrl,
        model: process.env.TYPESAFE_MODEL ?? defaults.model,
        timeoutMs: 5_000 // generous here: the point is to measure
      })
      const utterances = [
        "Turn on the lights in the living room.",
        "Lights off in the kitchen please.",
        "Doe het licht aan in de slaapkamer.",
        "What's the capital of France?"
      ]
      const timed = (utterance: string) =>
        Effect.gen(function*() {
          const plan = buildDecisionPlan({ utterance, actions })
          const started = performance.now()
          const response = yield* jev.decide(plan.request)
          const ms = performance.now() - started
          const outcome = interpretDecision(plan, response)
          const summary = outcome._tag === "Act"
            ? `act ${outcome.action.id} ${JSON.stringify(outcome.params)} p=${outcome.probability.toFixed(2)}`
            : outcome._tag === "Fallback"
            ? `fallback ${outcome.reason} p=${outcome.probability?.toFixed(2) ?? "-"}`
            : outcome._tag
          console.log(`${ms.toFixed(0).padStart(5)} ms  ${JSON.stringify(utterance)} → ${summary}  (model ${response.model ?? "?"})`)
          return { ms, outcome }
        })
      const cold = yield* timed(utterances[0]!)
      const warm = [yield* timed(utterances[1]!), yield* timed(utterances[2]!)]
      yield* Effect.sleep("6 seconds")
      const afterIdle = yield* timed(utterances[3]!)
      console.log(
        `Jev latency: cold ${cold.ms.toFixed(0)} ms, warm ${warm.map((w) => w.ms.toFixed(0)).join(" / ")} ms, after 6 s idle ${afterIdle.ms.toFixed(0)} ms`
      )
      assert.strictEqual(cold.outcome._tag, "Act")
      assert.strictEqual(afterIdle.outcome._tag, "Fallback")
    }), 60_000)
})
