// P8: an installation that never saves the risk policy behaves exactly as before the policy was a setting. Proven
// against a frozen copy of P1's policy (the function the gateway called before this change, verbatim), through the real
// gateway: every class, every set of declared classes, a string that is no class, a risk function that fails; the
// refusal sentence for the model, the tool list (`offers`), and P1's exported function itself. (Every existing gateway
// and kit test runs unchanged on the default as well: the kit now reads the saved policy, which is the default there.)
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeExecutionGateway } from "../src/Gateway.ts"
import { makeTool, type ToolRisk } from "../src/Module.ts"
import { DEFAULT_RISK_POLICY, defaultRiskPolicy, decodeRiskPolicy, RISK_CLASSES } from "../src/RiskPolicy.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"

/** P1's `defaultRiskPolicy`, as it was in `RiskPolicy.ts` before P8 (copied, not imported). */
type P1Verdict = { readonly outcome: "allow" } | { readonly outcome: "confirm" | "deny"; readonly reason: string }
const P1_ALLOWED: P1Verdict = { outcome: "allow" }
const P1_MESSAGE: P1Verdict = {
  outcome: "confirm",
  reason: "it would send a message in the owner's name, which needs the owner's confirmation, and this assistant cannot ask for it yet."
}
const P1_MONEY: P1Verdict = { outcome: "deny", reason: "it would spend money, which this assistant never does." }
const P1_SECURITY: P1Verdict = { outcome: "deny", reason: "it would act on a lock, an alarm, a door or a gate, which this assistant never does." }
const p1Policy = (risk: ToolRisk): P1Verdict => {
  switch (risk) {
    case "read":
    case "change":
      return P1_ALLOWED
    case "message":
      return P1_MESSAGE
    case "money":
      return P1_MONEY
    case "security":
      return P1_SECURITY
    default:
      return { outcome: "deny", reason: "what it would do is not a risk class this assistant knows." }
  }
}
/** P1's gateway: a call is refused with "Not run: " and the verdict's reason; a tool is offered when one declared class is allowed. */
const p1Message = (risk: ToolRisk): string | undefined => {
  const v = p1Policy(risk)
  return v.outcome === "allow" ? undefined : `Not run: ${v.reason}`
}
const p1Offers = (declared: ReadonlyArray<ToolRisk>) => declared.some((r) => p1Policy(r).outcome === "allow")

const ALL_DECLARED: ReadonlyArray<ReadonlyArray<ToolRisk>> = Array.from({ length: 31 }, (_, i) => RISK_CLASSES.filter((_c, b) => (i + 1) & (1 << b)))

/** The policy an installation reads when nothing was saved: serve mode's decoder over no saved value. */
const unsaved = decodeRiskPolicy(() => undefined)

describe("the default policy equals P1's behaviour exactly", () => {
  it("an installation that never saved the setting reads the default", () => {
    assert.deepStrictEqual(unsaved, DEFAULT_RISK_POLICY)
  })

  it("P1's exported function answers as before for every class and a string that is no class", () => {
    for (const risk of [...RISK_CLASSES, "launch" as ToolRisk]) assert.deepStrictEqual(defaultRiskPolicy(risk), p1Policy(risk), risk)
  })

  it.effect("through the gateway: every declared set × every class its input can have: the same outcome and the same sentence", () =>
    Effect.gen(function*() {
      const gateway = makeExecutionGateway({ policy: () => unsaved })
      let calls = 0
      for (const declared of ALL_DECLARED) {
        for (const risk of declared) {
          let ran = false
          const tool = makeTool({
            name: "t",
            description: "",
            parameters: Schema.Struct({}),
            ...(declared.length === 1 ? { risk: declared[0]! } : { risk: { classes: declared, of: () => risk } }),
            execute: () => Effect.sync(() => (ran = true, "ran"))
          })
          const exit = yield* Effect.exit(gateway.tool(undefined, tool, {}))
          const expected = p1Message(risk)
          if (expected === undefined) assert.isTrue(exit._tag === "Success" && ran, `${declared} ${risk}`)
          else {
            assert.isFalse(ran)
            assert.strictEqual(exit._tag === "Failure" ? (exit.cause.reasons[0] as { error?: { message: string } }).error?.message : "ran", expected, `${declared} ${risk}`)
          }
          calls++
        }
      }
      assert.strictEqual(calls, 80)
    }))

  it.effect("a class that is not one (a typo past the start check) and a risk function that fails: P1's sentences", () =>
    Effect.gen(function*() {
      const gateway = makeExecutionGateway({ policy: () => unsaved })
      const typo = makeTool({ name: "t", description: "", parameters: Schema.Struct({}), risk: "launch" as ToolRisk, execute: () => Effect.succeed("ran") })
      assert.strictEqual((yield* Effect.flip(gateway.tool(undefined, typo, {}))).message, "Not run: what it would do is not a risk class this assistant knows.")
      const broken = makeTool({ name: "t", description: "", parameters: Schema.Struct({}), risk: { classes: ["change"], of: () => { throw new Error("no") } }, execute: () => Effect.succeed("ran") })
      assert.strictEqual((yield* Effect.flip(gateway.tool(undefined, broken, {}))).message, "Not run: what it would do could not be judged.")
    }))

  it("the tool list: every declared set is offered exactly when P1 offered it", () => {
    const gateway = makeExecutionGateway({ policy: () => unsaved })
    for (const declared of ALL_DECLARED) {
      const tool = makeTool({ name: "t", description: "", parameters: Schema.Struct({}), risk: declared.length === 1 ? declared[0]! : { classes: declared, of: () => declared[0]! }, execute: () => Effect.succeed("") })
      assert.strictEqual(gateway.offers(tool), p1Offers(declared), String(declared))
      assert.strictEqual(makeToolRegistry([{ name: "m", tools: [tool] }], { gateway }).specs.length, p1Offers(declared) ? 1 : 0)
    }
    // Inferred classes: a speculative tool is read (offered), any other change (offered).
    assert.isTrue(gateway.offers({ speculative: true }))
    assert.isTrue(gateway.offers({}))
  })
})
