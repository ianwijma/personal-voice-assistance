// P8: the pure parts of what the risk policy costs on the turn path (docs/ARCHITECTURE.md quotes the printed numbers):
// - `decideRisk` alone;
// - reading a turn's tool list: after the policy changed (one decision per tool, 64 tools) and when it did not (a key
//   comparison).
// A gateway call and a whole turn with serve's production reader are measured in apps/assistant/test/riskLatency.test.ts.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeExecutionGateway } from "../src/Gateway.ts"
import { makeTool } from "../src/Module.ts"
import { decideRisk, DEFAULT_RISK_POLICY, type RiskPolicy } from "../src/RiskPolicy.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { bound } from "../../store-sqlite/test/latencyBound.ts"

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!

describe("the risk policy's cost on the turn path", () => {
  it.effect("one decision", () =>
    Effect.gen(function*() {
      // decideRisk alone.
      const N = 1_000_000
      const declared = ["change", "security"] as const
      let allowed = 0
      const t0 = performance.now()
      for (let i = 0; i < N; i++) if (decideRisk(DEFAULT_RISK_POLICY, declared, i & 1 ? "change" : "security").outcome === "allow") allowed++
      const decideNs = ((performance.now() - t0) * 1e6) / N
      assert.strictEqual(allowed, N / 2)
      console.log(`decideRisk: ${decideNs.toFixed(1)} ns per decision`)
      assert.isBelow(decideNs / 1e6, bound(0.001)) // under 1 µs per decision
    }))

  it("a turn's tool list: one decision per tool after a change, a key comparison otherwise (64 tools)", () => {
    let policy: RiskPolicy = DEFAULT_RISK_POLICY
    const gateway = makeExecutionGateway({ policy: () => policy })
    const tools = Array.from({ length: 64 }, (_, i) =>
      makeTool({ name: `t${i}`, description: "", parameters: Schema.Struct({}), risk: i % 2 === 0 ? "change" : { classes: ["change", "security"], of: () => "change" }, execute: () => Effect.succeed("") }))
    const registry = makeToolRegistry([{ name: "m", tools }], { gateway })
    const ROUNDS = 2_000
    const changed: Array<number> = []
    const steady: Array<number> = []
    for (let i = 0; i < ROUNDS; i++) {
      policy = i % 2 === 0 ? { ...DEFAULT_RISK_POLICY, change: "deny" } : DEFAULT_RISK_POLICY
      let t = performance.now()
      const list = registry.specs
      changed.push(performance.now() - t)
      assert.strictEqual(list.length, i % 2 === 0 ? 0 : 64)
      t = performance.now()
      void registry.specs
      steady.push(performance.now() - t)
    }
    console.log(
      `a tool list of 64 tools read: after a change ${(median(changed) * 1000).toFixed(1)} µs (p95 ${(p95(changed) * 1000).toFixed(1)} µs), ` +
        `unchanged ${(median(steady) * 1000).toFixed(2)} µs (p95 ${(p95(steady) * 1000).toFixed(2)} µs)`
    )
    assert.isBelow(median(changed), bound(0.2))
    assert.isBelow(median(steady), bound(0.02))
  })
})
