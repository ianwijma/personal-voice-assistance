// P8, review round 1: `sensitivity` on everything an admitted executor gives back to the model.
// - H2 (finding 2): a generated action tool's classifier judges the action's own outcome, before it is formatted or
//   handed to the Presenter; only an admitted outcome is formatted, spoken or shown.
// - H3 (finding 3): a failure or a defect is covered by the decision its result would have had: fixed household passes;
//   fixed personal only where its result could be shown; with per-result sensitivity (after review 2, H3') a typed failure
//   is the module's own sentence and goes back as it is, a defect is withheld. The
//   host's own refusals (validation, access, policy) stay as they are.
// - H4 (finding 4): an unknown owner cannot be a person id, so it is withheld before any membership lookup, also when a
//   household member's id is the word "unknown"; a classifier that throws falls back to it.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ActionError, defineAction } from "../src/Actions.ts"
import { ToolError } from "../src/Errors.ts"
import { type GatewayDecisionRecord, makeExecutionGateway } from "../src/Gateway.ts"
import { makeTool, UNKNOWN_OWNER } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { isPersonId, makePrivacy } from "../src/Privacy.ts"
import { DEFAULT_RISK_POLICY } from "../src/RiskPolicy.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"

const WITHHELD = "Withheld: the result is personal to someone, and this device may not reveal it. Say that it cannot be shared here."
const turn: TurnContext = { turnId: 1, conversationId: "c", source: "voice", assistantId: "jeff", deviceId: "dev-kitchen-01" }

/** A gateway whose privacy rule answers `may`, recording its decisions and what reached the Presenter. */
const gatewayWith = (may: boolean) => {
  const records: Array<GatewayDecisionRecord> = []
  const presented: Array<unknown> = []
  const gateway = makeExecutionGateway({
    policy: () => DEFAULT_RISK_POLICY,
    mayReveal: () => may,
    onDecision: (r) => void records.push(r),
    present: (_m, _p, value) => Effect.sync(() => (presented.push(value), "presented"))
  })
  return { gateway, records, presented }
}

const runIn = (gateway: ReturnType<typeof makeExecutionGateway>, tools: ReadonlyArray<ReturnType<typeof makeTool>>, name: string, input: unknown = {}) =>
  makeToolRegistry([{ name: "m", tools }], { gateway }).run({ id: name, name, input }).pipe(Effect.provideService(CurrentTurn, turn))

/** A module host with one action, so its generated tool exists (the way the model calls an action). */
const actionTool = (action: ReturnType<typeof defineAction>, may: boolean) =>
  Effect.gen(function*() {
    const records: Array<GatewayDecisionRecord> = []
    const presented: Array<unknown> = []
    const host = yield* makeModuleHost({
      catalog: [defineModule({ id: "m", name: "M", description: "", start: () => Effect.succeed({ actions: [action as never] }) })],
      persistence: readOnlyPersistence({ modules: { m: { enabled: true } }, secrets: {} }),
      env: {},
      gatewayHooks: { policy: () => DEFAULT_RISK_POLICY, mayReveal: () => may, onDecision: (r) => void records.push(r) },
      present: { fromResult: (_m: string | undefined, _p: unknown, value: unknown) => Effect.sync(() => (presented.push(value), "presented")) } as never
    })
    yield* host.startEnabled
    const registry = host.snapshot().registry
    const call = (name: string) => registry.run({ id: name, name, input: {} }).pipe(Effect.provideService(CurrentTurn, turn))
    return { call, records, presented }
  })

describe("H2: a generated action's classifier judges the action's own outcome", () => {
  const seen: Array<unknown> = []
  const secret = (withPresentation: boolean) =>
    defineAction({
      id: "secret",
      label: "Secret",
      description: "",
      examples: ["secret"],
      params: {},
      speculative: true,
      sensitivity: (outcome) => {
        seen.push(outcome)
        const o = outcome as { say?: string } | undefined
        return o?.say?.startsWith("PRIVATE") === true ? { kind: "personal", owner: "p-sam" } : { kind: "household" }
      },
      run: () =>
        Effect.succeed(withPresentation
          ? { say: "PRIVATE-ACTION-ANSWER", present: { kind: "card" as const, title: "PRIVATE card", spoken: "PRIVATE" } }
          : { say: "PRIVATE-ACTION-ANSWER" })
    })

  for (const withPresentation of [false, true]) {
    it.effect(`withheld where the device may not reveal it; nothing formatted or presented (${withPresentation ? "with" : "without"} a presentation)`, () =>
      Effect.gen(function*() {
        seen.length = 0
        const { call, records, presented } = yield* actionTool(secret(withPresentation), false)
        const result = yield* call("m_secret")
        assert.deepStrictEqual([result.content, result.isError], [WITHHELD, false])
        assert.deepStrictEqual(presented, [])
        // The classifier received the action's outcome itself, not the formatted answer.
        assert.strictEqual((seen[0] as { say: string }).say, "PRIVATE-ACTION-ANSWER")
        assert.strictEqual(records[0]?.withheld, true)
      }).pipe(Effect.scoped))

    it.effect(`revealed where it may be: formatted and presented as before (${withPresentation ? "with" : "without"} a presentation)`, () =>
      Effect.gen(function*() {
        const { call, presented } = yield* actionTool(secret(withPresentation), true)
        const result = yield* call("m_secret")
        if (withPresentation) {
          assert.strictEqual(presented.length, 1)
          assert.strictEqual((presented[0] as { forModel: string }).forModel, "PRIVATE-ACTION-ANSWER")
        } else assert.strictEqual(result.content, "PRIVATE-ACTION-ANSWER")
      }).pipe(Effect.scoped))
  }
})

describe("H3: a failure is covered by the same decision as a result", () => {
  type S = NonNullable<Parameters<typeof makeTool>[0]["sensitivity"]> | undefined
  const failing = (sensitivity: S) =>
    makeTool({ name: "failed", description: "", parameters: Schema.Struct({}), speculative: true, ...(sensitivity !== undefined ? { sensitivity } : {}), execute: () => Effect.fail(new ToolError({ message: "PRIVATE-FAILURE-CONTENT" })) })
  const crashing = (sensitivity: S) =>
    makeTool({
      name: "crashed",
      description: "",
      parameters: Schema.Struct({}),
      speculative: true,
      ...(sensitivity !== undefined ? { sensitivity } : {}),
      execute: () => Effect.sync(() => {
        throw new Error("PRIVATE-DEFECT-CONTENT")
      })
    })

  it.effect("fixed personal: withheld on a device that may not reveal it (isError kept, record withheld); shown on one that may", () =>
    Effect.gen(function*() {
      const no = gatewayWith(false)
      const personal = { kind: "personal" as const, owner: "p-sam" }
      const failed = yield* runIn(no.gateway, [failing(personal)], "failed")
      const crashed = yield* runIn(no.gateway, [crashing(personal)], "crashed")
      assert.deepStrictEqual([failed.content, failed.isError], [WITHHELD, true])
      assert.deepStrictEqual([crashed.content, crashed.isError], [WITHHELD, true])
      assert.deepStrictEqual(no.records.map((r) => r.withheld), [true, true])
      const yes = gatewayWith(true)
      assert.strictEqual((yield* runIn(yes.gateway, [failing(personal)], "failed")).content, "PRIVATE-FAILURE-CONTENT")
      assert.strictEqual((yield* runIn(yes.gateway, [crashing(personal)], "crashed")).content, "Tool crashed: Error: PRIVATE-DEFECT-CONTENT")
    }))

  it.effect("H3' (after review 2): per-result sensitivity: a typed failure is the module's own sentence on both devices; a defect is withheld on both", () =>
    Effect.gen(function*() {
      const dynamic = () => ({ kind: "personal" as const, owner: "p-sam" })
      for (const may of [true, false]) {
        const g = gatewayWith(may)
        const failed = yield* runIn(g.gateway, [failing(dynamic)], "failed")
        const crashed = yield* runIn(g.gateway, [crashing(dynamic)], "crashed")
        assert.deepStrictEqual([failed.content, failed.isError, crashed.content, crashed.isError], ["PRIVATE-FAILURE-CONTENT", true, WITHHELD, true], `may: ${may}`)
        // The failure is not marked withheld; the defect is.
        assert.deepStrictEqual(g.records.map((r) => r.withheld === true), [false, true], `may: ${may}`)
      }
    }))

  it.effect("fixed household passes as before; the host's own refusals (validation, policy) are its own words", () =>
    Effect.gen(function*() {
      const no = gatewayWith(false)
      assert.strictEqual((yield* runIn(no.gateway, [failing(undefined)], "failed")).content, "PRIVATE-FAILURE-CONTENT")
      assert.strictEqual((yield* runIn(no.gateway, [crashing("household")], "crashed")).content, "Tool crashed: Error: PRIVATE-DEFECT-CONTENT")
      const typed = makeTool({ name: "typed", description: "", parameters: Schema.Struct({ n: Schema.Int }), sensitivity: "personal", speculative: true, execute: () => Effect.succeed("x") })
      assert.match((yield* runIn(no.gateway, [typed], "typed", { n: "x" })).content, /^Invalid input: /)
      const send = makeTool({ name: "send", description: "", parameters: Schema.Struct({}), sensitivity: "personal", risk: "message", execute: () => Effect.succeed("x") })
      assert.match((yield* runIn(no.gateway, [send], "send")).content, /^Not run: it would send a message/)
    }))

  it.effect("a generated action's failure: fixed personal withheld where it may not be revealed, shown where it may", () =>
    Effect.gen(function*() {
      const broken = defineAction({
        id: "broken",
        label: "Broken",
        description: "",
        examples: ["broken"],
        params: {},
        speculative: true,
        sensitivity: { kind: "personal", owner: "p-sam" },
        run: () => Effect.fail(new ActionError({ message: "PRIVATE-ACTION-FAILURE" }))
      })
      const no = yield* actionTool(broken, false)
      const withheld = yield* no.call("m_broken")
      assert.deepStrictEqual([withheld.content, withheld.isError, no.records[0]?.withheld], [WITHHELD, true, true])
      const yes = yield* actionTool(broken, true)
      assert.strictEqual((yield* yes.call("m_broken")).content, "PRIVATE-ACTION-FAILURE")
    }).pipe(Effect.scoped))
})

describe("H4: an unknown owner is not a person", () => {
  it("cannot be a person id", () => {
    assert.isFalse(isPersonId(UNKNOWN_OWNER))
    assert.isTrue(isPersonId("unknown"), "a member may be called unknown")
  })

  it.effect("ownerless personal content is withheld on the shared device whose default person's id is the word unknown; that member's own content is not", () =>
    Effect.gen(function*() {
      const privacy = makePrivacy((id) => (id === turn.deviceId ? { privacy: "shared", defaultPerson: "unknown" } : undefined), (id) => id === "unknown")
      const gateway = makeExecutionGateway({ policy: () => DEFAULT_RISK_POLICY, mayReveal: (owner, deviceId) => privacy.mayReveal(owner, deviceId) })
      const ownerless = makeTool({ name: "ownerless", description: "", parameters: Schema.Struct({}), speculative: true, sensitivity: "personal", execute: () => Effect.succeed("OWNERLESS-PRIVATE-CONTENT") })
      const theirs = makeTool({ name: "theirs", description: "", parameters: Schema.Struct({}), speculative: true, sensitivity: { kind: "personal", owner: "unknown" }, execute: () => Effect.succeed("THE-MEMBER'S-CONTENT") })
      // A classifier that throws falls back to the unknown owner.
      const throwing = makeTool({
        name: "throwing",
        description: "",
        parameters: Schema.Struct({}),
        speculative: true,
        sensitivity: () => {
          throw new Error("no")
        },
        execute: () => Effect.succeed("CLASSIFIER-FAILED-CONTENT")
      })
      assert.strictEqual((yield* runIn(gateway, [ownerless], "ownerless")).content, WITHHELD)
      assert.strictEqual((yield* runIn(gateway, [theirs], "theirs")).content, "THE-MEMBER'S-CONTENT")
      assert.strictEqual((yield* runIn(gateway, [throwing], "throwing")).content, WITHHELD)
      // Even on a private device, where anyone's personal content may be revealed.
      const open = makeExecutionGateway({ policy: () => DEFAULT_RISK_POLICY, mayReveal: () => true })
      assert.strictEqual((yield* runIn(open, [ownerless], "ownerless")).content, WITHHELD)
      assert.strictEqual((yield* runIn(open, [throwing], "throwing")).content, WITHHELD)
    }))
})

// Review round 2, finding 4: the generated-action branch of H3, complete. A generated action (the model calls an action)
// whose run fails with an ActionError or dies, with fixed personal and with dynamic sensitivity, on a device that may
// reveal it and one that may not: the model's content, isError, one decision of class `change`, and the withheld state
// on the decision's record and the turn's trace.
describe("H3 for generated actions: a typed failure and a defect, fixed personal and dynamic, reveal yes and no", () => {
  const cases = [
    { failure: "typed" as const, sensitivity: "fixed" as const },
    { failure: "defect" as const, sensitivity: "fixed" as const },
    { failure: "typed" as const, sensitivity: "dynamic" as const },
    { failure: "defect" as const, sensitivity: "dynamic" as const }
  ]
  for (const c of cases) {
    for (const may of [true, false]) {
      // H3' (after review 2): a fixed personal failure or defect is shown where its result could be; with per-result
      // sensitivity a typed failure is the module's own sentence everywhere and a defect is withheld everywhere.
      const shown = c.sensitivity === "fixed" ? may : c.failure === "typed"
      it.effect(`${c.failure} failure, ${c.sensitivity} sensitivity, the device ${may ? "may" : "may not"} reveal it: ${shown ? "its text" : "withheld"}`, () =>
        Effect.gen(function*() {
          const { CurrentTurnTrace, makeTurnTrace } = yield* Effect.promise(() => import("../src/TurnTrace.ts"))
          const broken = defineAction({
            id: "broken",
            label: "Broken",
            description: "",
            examples: ["broken"],
            params: {},
            risk: "change",
            sensitivity: c.sensitivity === "fixed" ? { kind: "personal", owner: "p-sam" } : () => ({ kind: "household" }),
            run: () =>
              c.failure === "typed"
                ? Effect.fail(new ActionError({ message: "PRIVATE-ACTION-FAILURE" }))
                : Effect.sync(() => {
                  throw new Error("PRIVATE-ACTION-DEFECT")
                })
          })
          const { call, records } = yield* actionTool(broken, may)
          const trace = makeTurnTrace().begin("voice")
          const result = yield* call("m_broken").pipe(Effect.provideService(CurrentTurnTrace, trace), Effect.provideService(CurrentTurn, { ...turn, turnId: trace.id }))
          assert.isTrue(result.isError)
          if (shown) {
            assert.strictEqual(result.content, c.failure === "typed" ? "PRIVATE-ACTION-FAILURE" : "Tool crashed: Error: PRIVATE-ACTION-DEFECT")
          } else {
            assert.strictEqual(result.content, WITHHELD)
            assert.notInclude(result.content, "PRIVATE")
          }
          // One decision, of the action's class, allowed (the failure is the executor's, not a refusal).
          assert.deepStrictEqual(records.map((r) => [r.kind, r.name, r.outcome, r.by]), [["tool", "m_broken", "allow", "change"]])
          assert.strictEqual(records[0]!.withheld === true, !shown)
          assert.strictEqual(trace.calls?.length, 1)
          assert.strictEqual(trace.calls?.[0]?.withheld === true, !shown)
        }).pipe(Effect.scoped))
    }
  }
})
