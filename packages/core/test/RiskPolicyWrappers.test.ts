// P8, review round 1, H6 (note 9): registry wrappers carry the private association with their gateway, so core's
// confirmed path (`Conversation` looks the runner up by the turn's registry, `confirmedRunnerOf(setup.registry,
// defaultGateway)`) runs through the gateway that has the household's policy, never the policy-free fallback.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction } from "../src/Actions.ts"
import { defaultGateway } from "../src/Gateway.ts"
import { confirmedRunnerOf } from "../src/GatewayPrivate.ts"
import { withContextProvider } from "../src/HouseholdAmbient.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { proposingTools } from "../src/PendingIntents.ts"
import { DEFAULT_RISK_POLICY } from "../src/RiskPolicy.ts"
import { CurrentTurn } from "../src/TurnContext.ts"

describe("the confirmed path through the real wrapper chain", () => {
  it.effect("serve's wrappers (two context providers) and the proposal wrapper: the policy still refuses a security action after a yes", () =>
    Effect.gen(function*() {
      let runs = 0
      const wire = defineAction({
        id: "wire",
        label: "Wire",
        description: "Opens the garage after a yes.",
        examples: ["wire"],
        params: {},
        risk: "security",
        confirm: true,
        run: () => Effect.sync(() => (runs++, { say: "WIRED" }))
      })
      const host = yield* makeModuleHost({
        catalog: [defineModule({ id: "m", name: "M", description: "", start: () => Effect.succeed({ actions: [wire as never] }) })],
        persistence: readOnlyPersistence({ modules: { m: { enabled: true } }, secrets: {} }),
        env: {},
        gatewayHooks: { policy: () => DEFAULT_RISK_POLICY }
      })
      yield* host.startEnabled
      const base = host.snapshot().registry
      const provider = { name: "P", get: Effect.succeed("") }
      const wrapped = proposingTools(withContextProvider(withContextProvider(base, provider), provider), { actions: [], proposed: () => false, propose: () => false } as never)
      const action = base.actionFor!("m_wire")!
      for (const registry of [withContextProvider(base, provider), withContextProvider(withContextProvider(base, provider), provider), wrapped]) {
        const confirmed = confirmedRunnerOf(registry, defaultGateway)!
        const result = yield* Effect.result(confirmed(action, {}).pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "voice" })))
        assert.strictEqual(result._tag === "Failure" && result.failure.message, "Not run: it would act on a lock, an alarm, a door or a gate, which this assistant never does.")
      }
      assert.strictEqual(runs, 0)
      // A registry with no association at all still falls back (hand-made registries, as before).
      assert.strictEqual(confirmedRunnerOf({}, defaultGateway), confirmedRunnerOf(undefined, defaultGateway))
    }))
})
