// P8, first version: the household's risk policy on every entry path into the execution gateway, through the module
// test kit (which behaves like serve mode: the same reader, decoder, decision and sentences). For each path: allowed,
// `confirm` and `deny`, for a tool or action with one class and for one whose class depends on its input; the turn's
// tool list; a change saved between the list and the call; `money` and `security` through the kit; `sensitivity` on
// the paths that return a result to a model; the decisions recorded.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineAction, Param } from "../src/Actions.ts"
import { confirmedRunnerOf } from "../src/GatewayPrivate.ts"
import type { GatewayDecisionRecord } from "../src/Gateway.ts"
import { makeTool } from "../src/Module.ts"
import type { SharedContext } from "../src/ModuleApi.ts"
import { defineModule, type ModuleContextV2 } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { DEFAULT_RISK_POLICY, type RiskPolicy } from "../src/RiskPolicy.ts"
import { startTestModule } from "../src/testing.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"

// ---------------------------------------------------------------------------------------------------------------------
// A module with one of everything a call can enter by.

const ran: Array<string> = []
const jobResults: Array<string> = []
let shared: SharedContext<any> | undefined
let started: ModuleContextV2<any> | undefined

const Which = Schema.Struct({ which: Schema.Literals(["blind", "garage"]) })
const doorRisk = { classes: ["change", "security"] as const, of: (input: { readonly which: string }) => (input.which === "garage" ? "security" as const : "change" as const) }

const risky = defineModule({
  apiVersion: 2,
  id: "risky",
  name: "Risky",
  description: "One of everything the risk policy decides.",
  enabledByDefault: false,
  shared: (ctx) =>
    Effect.gen(function*() {
      shared = ctx
      // A job runs an action through host.actions.run (a routine step does the same), for the job's principal.
      yield* ctx.scheduler.handle("step", {
        payload: Schema.Struct({ action: Schema.String, which: Schema.optionalKey(Schema.String) }),
        run: ({ action, which }) =>
          Effect.map(ctx.host.actions.run({ moduleId: "risky", actionId: action, params: which === undefined ? {} : { which } }), (r) =>
            void jobResults.push(r.ok ? "ran" : `${r.code}: ${r.message}`))
      }).pipe(Effect.orDie)
      // A press on a presentation, with one class (inferred `change`) and with a class by the press.
      yield* ctx.present.handle("press-change", { run: () => Effect.sync(() => (ran.push("press-change"), { say: "Pressed." })) }).pipe(Effect.orDie)
      yield* ctx.present.handle("press-door", {
        risk: { classes: ["change", "security"], of: (press) => (press.action === "garage" ? "security" : "change") },
        run: () => Effect.sync(() => (ran.push("press-door"), { say: "Pressed." }))
      }).pipe(Effect.orDie)
      // A press that runs an action itself (for the press's principal).
      yield* ctx.present.handle("press-action", {
        risk: "read",
        run: (press) => Effect.map(ctx.host.actions.run({ moduleId: "risky", actionId: "door", params: { which: press.action } }), (r) => ({ say: r.ok ? "Done." : r.message }))
      }).pipe(Effect.orDie)
      // An action on a notification, likewise.
      yield* ctx.notify.handle("ring-change", { run: () => Effect.sync(() => (ran.push("ring-change"), { say: "Snoozed." })) }).pipe(Effect.orDie)
      yield* ctx.notify.handle("ring-door", {
        risk: { classes: ["change", "security"], of: (press) => (press.actionId === "garage" ? "security" : "change") },
        run: () => Effect.sync(() => (ran.push("ring-door"), { say: "Snoozed." }))
      }).pipe(Effect.orDie)
      return {
        value: undefined,
        // A route has no principal: a call it makes is refused before any decision.
        routes: [{
          method: "GET" as const,
          path: "go",
          guards: ["lan" as const],
          handler: () => Effect.map(ctx.host.actions.run({ moduleId: "risky", actionId: "lamp", params: {} }), (r) => ({ status: 200, body: r }))
        }]
      }
    }),
  start: (ctx) => {
    started = ctx
    const run = (name: string) => () => Effect.sync(() => (ran.push(name), "done"))
    return Effect.succeed({
      tools: [
        makeTool({ name: "lamp", description: "Switch the lamp.", parameters: Schema.Struct({}), risk: "change", execute: run("lamp") }),
        makeTool({ name: "door", description: "Open a blind (change) or the garage door (security).", parameters: Which, risk: doorRisk, execute: run("door") }),
        makeTool({ name: "note", description: "Send a note to a friend (message).", parameters: Schema.Struct({}), risk: "message", execute: run("note") }),
        makeTool({ name: "pay", description: "Pay (money).", parameters: Schema.Struct({}), risk: "money", execute: run("pay") }),
        makeTool({ name: "look", description: "Look something up.", parameters: Schema.Struct({}), speculative: true, execute: run("look") }),
        // A result whose owner is decided per result (personal to Sam), and one that is personal with no known owner.
        makeTool({
          name: "peek",
          description: "Read Sam's note.",
          parameters: Schema.Struct({}),
          speculative: true,
          sensitivity: (result) => ({ kind: "personal", owner: (result as { owner: string }).owner }),
          execute: () => Effect.succeed({ owner: "p-sam", text: "Sam's secret note" })
        }),
        makeTool({ name: "diary", description: "Read a diary.", parameters: Schema.Struct({}), speculative: true, sensitivity: "personal", execute: () => Effect.succeed("Dear diary") }),
        // The model's way to a notification and a presentation with handlers.
        makeTool({
          name: "ring",
          description: "Ring with snooze buttons.",
          parameters: Schema.Struct({ handler: Schema.String }),
          execute: ({ handler }) =>
            Effect.as(ctx.notify.send({ title: "Ring", priority: "ring", actions: [{ id: "blind", label: "Blind" }, { id: "garage", label: "Garage" }], handler }).pipe(Effect.orDie), "rung")
        }),
        makeTool({
          name: "show",
          description: "Show a card with buttons.",
          parameters: Schema.Struct({ handler: Schema.String }),
          speculative: true,
          execute: ({ handler }) =>
            Effect.succeed({
              forModel: "shown",
              present: { kind: "card" as const, title: handler, text: "Press one", spoken: "A card.", handler, buttons: [{ id: "blind", label: "Blind" }, { id: "garage", label: "Garage" }] },
              show: { lifetime: "pinned" as const, key: handler }
            })
        })
      ],
      actions: [
        defineAction({ id: "lamp", label: "Lamp", description: "Switch the lamp.", examples: ["lamp"], params: {}, risk: "change", run: () => Effect.sync(() => (ran.push("lampAction"), { say: "Lamp on." })) }),
        defineAction({
          id: "door",
          label: "Door",
          description: "Open a blind or the garage door.",
          examples: ["open the blind"],
          params: { which: Param.choice({ label: "Which", options: [{ value: "blind", label: "Blind" }, { value: "garage", label: "Garage" }] }) },
          risk: doorRisk,
          run: () => Effect.sync(() => (ran.push("doorAction"), { say: "Opened." }))
        }),
        defineAction({ id: "secret", label: "Secret", description: "Alex's secret.", examples: ["secret"], params: {}, speculative: true, sensitivity: { kind: "personal", owner: "p-alex" }, run: () => Effect.succeed({ say: "Alex's secret" }) }),
        defineAction({ id: "wire", label: "Wire", description: "Wire money after a yes.", examples: ["wire"], params: {}, risk: "change", confirm: true, run: () => Effect.sync(() => (ran.push("wire"), { say: "Wired." })) })
      ]
    })
  }
})

const reset = () => {
  ran.length = 0
  jobResults.length = 0
}

const CONFIRM_CHANGE = "Not run: it would change something in the house, which this household has set to need the owner's confirmation, and this assistant cannot ask for it yet."
const DENY_CHANGE = "Not run: it would change something in the house, which this household does not allow."
const DENY_SECURITY = "Not run: it would act on a lock, an alarm, a door or a gate, which this assistant never does."
const SPOKEN_CONFIRM_CHANGE = "I can't do that: this household wants the owner to confirm changes first, and I can't ask for that yet."
const SPOKEN_DENY_CHANGE = "I can't do that: this household doesn't allow me to change things in the house."
const SPOKEN_DENY_SECURITY = "I can't do that: I never work locks, alarms, doors or gates."

/** The three policies each path is run under, and what a `change` call gets under them. */
const POLICIES: ReadonlyArray<{ readonly name: string; readonly policy: Partial<RiskPolicy>; readonly change: "allow" | "confirm" | "deny"; readonly model?: string; readonly spoken?: string }> = [
  { name: "allowed (the default)", policy: {}, change: "allow" },
  { name: "confirm", policy: { change: "confirm" }, change: "confirm", model: CONFIRM_CHANGE, spoken: SPOKEN_CONFIRM_CHANGE },
  { name: "deny", policy: { change: "deny" }, change: "deny", model: DENY_CHANGE, spoken: SPOKEN_DENY_CHANGE }
]

const last = (records: ReadonlyArray<GatewayDecisionRecord>) => records[records.length - 1]

describe("the risk policy on every entry path (kit = serve mode)", () => {
  for (const p of POLICIES) {
    it.effect(`a model's tool call (core loop and Claude Code bridge: the registry's run): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        const lamp = yield* kit.tool("lamp", {})
        const blind = yield* kit.tool("door", { which: "blind" })
        const garage = yield* kit.tool("door", { which: "garage" })
        if (p.change === "allow") {
          assert.deepStrictEqual([lamp.content, blind.content], ["done", "done"])
          assert.deepStrictEqual(ran, ["lamp", "door"])
        } else {
          assert.deepStrictEqual([lamp.ok, lamp.content, blind.content], [false, p.model, p.model])
          assert.deepStrictEqual(ran, [])
        }
        assert.deepStrictEqual([garage.ok, garage.content], [false, DENY_SECURITY])
        const d = kit.riskDecisions()
        assert.deepStrictEqual(d.map((r) => [r.kind, r.name, r.principal, r.outcome, r.by]), [
          ["tool", "lamp", "turn", p.change, "change"],
          ["tool", "door", "turn", p.change, "change"],
          ["tool", "door", "turn", "deny", "security"]
        ])
        assert.isTrue(d.every((r) => r.turnId !== undefined && r.moduleId === "risky"))
      }))

    it.effect(`a generated action tool (the model calls an action): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        const lamp = yield* kit.tool("risky_lamp", {})
        const blind = yield* kit.tool("risky_door", { which: "blind" })
        const garage = yield* kit.tool("risky_door", { which: "garage" })
        if (p.change === "allow") assert.deepStrictEqual([lamp.content, blind.content, ran], ["Lamp on.", "Opened.", ["lampAction", "doorAction"]])
        else assert.deepStrictEqual([lamp.content, blind.content, ran], [p.model, p.model, []])
        assert.strictEqual(garage.content, DENY_SECURITY)
        assert.deepStrictEqual(kit.riskDecisions().map((r) => [r.name, r.outcome, r.by]), [["risky_lamp", p.change, "change"], ["risky_door", p.change, "change"], ["risky_door", "deny", "security"]])
      }))

    it.effect(`a typed action (the intent agent's runAction): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        const turn = kit.turn()
        const registry = makeToolRegistry((kit.host.snapshot().assistantParts.get("jeff") ?? []).map((x) => x.module), { gateway: kit.host.gateway })
        const runAction = (name: string, values: Record<string, unknown>) =>
          Effect.result(registry.runAction!(registry.actionFor!(name)!, values).pipe(Effect.provideService(CurrentTurn, turn)))
        const lamp = yield* runAction("risky_lamp", {})
        const blind = yield* runAction("risky_door", { which: "blind" })
        const garage = yield* runAction("risky_door", { which: "garage" })
        if (p.change === "allow") assert.deepStrictEqual([lamp._tag, blind._tag, ran], ["Success", "Success", ["lampAction", "doorAction"]])
        else {
          assert.deepStrictEqual([lamp._tag === "Failure" && lamp.failure.message, blind._tag === "Failure" && blind.failure.message], [p.model, p.model])
          // What the intent agent says: the policy's spoken sentence (GatewayRefused.spoken).
          assert.strictEqual(lamp._tag === "Failure" && (lamp.failure.cause as { spoken?: string }).spoken, p.spoken)
        }
        assert.strictEqual(garage._tag === "Failure" && (garage.failure.cause as { spoken?: string }).spoken, SPOKEN_DENY_SECURITY)
        assert.deepStrictEqual(kit.riskDecisions().map((r) => [r.kind, r.outcome, r.by]), [["action", p.change, "change"], ["action", p.change, "change"], ["action", "deny", "security"]])
      }))

    it.effect(`host.actions.run in a turn (a routine step, a tool running an action): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        const lamp = yield* kit.action("lamp")
        const blind = yield* kit.action("door", { which: "blind" })
        const garage = yield* kit.action("door", { which: "garage" })
        if (p.change === "allow") assert.deepStrictEqual([lamp, blind], [{ ok: true, say: "Lamp on." }, { ok: true, say: "Opened." }])
        else assert.deepStrictEqual([lamp, blind], [{ ok: false, code: "refused", message: p.model }, { ok: false, code: "refused", message: p.model }])
        assert.deepStrictEqual(garage, { ok: false, code: "refused", message: DENY_SECURITY })
        assert.deepStrictEqual(kit.riskDecisions().map((r) => [r.principal, r.outcome, r.by]), [["turn", p.change, "change"], ["turn", p.change, "change"], ["turn", "deny", "security"]])
      }))

    it.effect(`a scheduler job running actions (the job's principal, the turn's origin): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        for (const [key, action, which] of [["a", "lamp", undefined], ["b", "door", "blind"], ["c", "door", "garage"]] as const) {
          yield* kit.asTurn(shared!.scheduler.schedule({ handler: "step", key, inMs: 1_000, payload: which === undefined ? { action } : { action, which } }).pipe(Effect.orDie))
        }
        yield* kit.advance(2_000)
        const refusedChange = p.model === undefined ? undefined : `refused: ${p.model}`
        assert.deepStrictEqual(jobResults.slice().sort(), [...(p.change === "allow" ? ["ran", "ran"] : [refusedChange, refusedChange]), `refused: ${DENY_SECURITY}`].sort())
        const d = kit.riskDecisions()
        assert.strictEqual(d.length, 3)
        assert.isTrue(d.every((r) => r.principal === "job" && r.turnId === undefined))
        assert.deepStrictEqual(d.map((r) => `${r.outcome}/${r.by}`).sort(), [`${p.change}/change`, `${p.change}/change`, "deny/security"].sort())
      }))

    it.effect(`a press on a presentation (its handler's class; an action it runs): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        for (const h of ["press-change", "press-door", "press-action"]) yield* kit.tool("show", { handler: h }, { device: "kitchen-display" })
        yield* kit.present.settle
        const byHandler = (h: string) => kit.present.shown("kitchen-display").find((x) => x.content.kind === "card" && x.content.title === h)!.id
        const one = yield* kit.present.press(byHandler("press-change"), "blind", { device: "kitchen-display" })
        const blind = yield* kit.present.press(byHandler("press-door"), "blind", { device: "kitchen-display" })
        const garage = yield* kit.present.press(byHandler("press-door"), "garage", { device: "kitchen-display" })
        if (p.change === "allow") assert.deepStrictEqual([one, blind, ran], [{ ok: true, say: "Pressed." }, { ok: true, say: "Pressed." }, ["press-change", "press-door"]])
        else assert.deepStrictEqual([one, blind, ran], [{ ok: false, say: p.spoken, code: "refused" }, { ok: false, say: p.spoken, code: "refused" }, []])
        assert.deepStrictEqual(garage, { ok: false, say: SPOKEN_DENY_SECURITY, code: "refused" })
        // The press handler that runs an action: the handler is `read` (allowed), the action is decided for the press.
        const viaAction = yield* kit.present.press(byHandler("press-action"), "blind", { device: "kitchen-display" })
        assert.deepStrictEqual(viaAction, p.change === "allow" ? { ok: true, say: "Done." } : { ok: true, say: p.model! })
        const d = kit.riskDecisions().filter((r) => r.principal === "presentation")
        assert.deepStrictEqual(d.map((r) => [r.kind, r.name, r.outcome, r.by]), [
          ["handler", "risky/press-change", p.change, "change"],
          ["handler", "risky/press-door", p.change, "change"],
          ["handler", "risky/press-door", "deny", "security"],
          ["handler", "risky/press-action", "allow", "read"],
          ["action", "risky_door", p.change, "change"]
        ])
      }))

    it.effect(`an action on a notification (its handler's class): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        const pressOn = (handler: string, actionId: string) =>
          Effect.gen(function*() {
            if (p.change === "allow") yield* kit.tool("ring", { handler }, { device: "kitchen-display" })
            else yield* kit.asTurn(started!.notify.send({ title: "Ring", priority: "ring", actions: [{ id: "blind", label: "Blind" }, { id: "garage", label: "Garage" }], handler }).pipe(Effect.orDie), { device: "kitchen-display" })
            yield* kit.notify.settle
            const ringing = kit.notify.engine.ringingOn("kitchen-display").find((n) => n.actions.some((a) => a.id === actionId))!
            const answer = yield* kit.notify.press(ringing.id, actionId, { device: "kitchen-display" })
            // Stop what still rings, so the next one is the only one.
            yield* kit.notify.engine.stopRinging("kitchen-display")
            return answer
          })
        const one = yield* pressOn("ring-change", "blind")
        const blind = yield* pressOn("ring-door", "blind")
        const garage = yield* pressOn("ring-door", "garage")
        if (p.change === "allow") assert.deepStrictEqual([one, blind, ran], [{ ok: true, say: "Snoozed." }, { ok: true, say: "Snoozed." }, ["ring-change", "ring-door"]])
        else assert.deepStrictEqual([one, blind, ran], [{ ok: false, say: p.spoken, code: "refused" }, { ok: false, say: p.spoken, code: "refused" }, []])
        assert.deepStrictEqual(garage, { ok: false, say: SPOKEN_DENY_SECURITY, code: "refused" })
        assert.deepStrictEqual(kit.riskDecisions().filter((r) => r.principal === "notification").map((r) => [r.name, r.outcome, r.by]), [
          ["risky/ring-change", p.change, "change"],
          ["risky/ring-door", p.change, "change"],
          ["risky/ring-door", "deny", "security"]
        ])
      }))

    it.effect(`core's confirmed path (an action with confirm: true after the owner's yes): ${p.name}`, () =>
      Effect.gen(function*() {
        reset()
        const kit = yield* startTestModule(risky, { household: { risk: p.policy } })
        const registry = makeToolRegistry((kit.host.snapshot().assistantParts.get("jeff") ?? []).map((x) => x.module), { gateway: kit.host.gateway })
        const confirmed = confirmedRunnerOf(registry, kit.host.gateway)!
        const wire = registry.actionFor!("risky_wire")!
        const result = yield* Effect.result(confirmed(wire, {}).pipe(Effect.provideService(CurrentTurn, kit.turn())))
        if (p.change === "allow") assert.deepStrictEqual([result._tag, ran], ["Success", ["wire"]])
        else assert.deepStrictEqual([result._tag === "Failure" && result.failure.message, ran], [p.model, []])
        assert.deepStrictEqual(kit.riskDecisions().map((r) => [r.kind, r.name, r.outcome]), [["action", "risky_wire", p.change]])
      }))
  }

  it.effect("a module route has no principal: its call is refused before the decision, and no outcome is recorded", () =>
    Effect.gen(function*() {
      reset()
      const kit = yield* startTestModule(risky)
      const route = kit.host.routes().find((r) => r.moduleId === "risky")!
      const answer = yield* route.route.handler({ method: "GET", path: "go", params: {}, query: {}, queryAll: {}, headers: {}, body: undefined, address: "127.0.0.1" })
      assert.deepStrictEqual(answer, { status: 200, body: { ok: false, code: "refused", message: "Not run: it has no turn, job or other principal to run for." } })
      assert.deepStrictEqual(kit.riskDecisions(), [])
      assert.deepStrictEqual(ran, [])
    }))

  it.effect("the CLI modes (the local principal): decided on the policy given to the host, recorded as local", () =>
    Effect.gen(function*() {
      reset()
      const records: Array<GatewayDecisionRecord> = []
      let policy: RiskPolicy = DEFAULT_RISK_POLICY
      const host = yield* makeModuleHost({
        catalog: [risky],
        persistence: readOnlyPersistence({ modules: { risky: { enabled: true } }, secrets: {} }),
        env: {},
        localPrincipal: true,
        gatewayHooks: { policy: () => policy, onDecision: (r) => void records.push(r) }
      })
      yield* host.startEnabled
      const registry = host.snapshot().registry
      const run = (name: string, input: unknown) => registry.run({ id: name, name, input })
      assert.strictEqual((yield* run("lamp", {})).content, "done")
      assert.strictEqual((yield* run("note", {})).content, "Not run: it would send a message in the owner's name, which needs the owner's confirmation, and this assistant cannot ask for it yet.")
      policy = { ...DEFAULT_RISK_POLICY, change: "deny" }
      assert.strictEqual((yield* run("lamp", {})).content, DENY_CHANGE)
      assert.deepStrictEqual(records.map((r) => [r.principal, r.name, r.outcome]), [["local", "lamp", "allow"], ["local", "note", "confirm"], ["local", "lamp", "deny"]])
    }))
})

describe("the turn's tool list (kit = serve mode)", () => {
  it.effect("every class refused: left out; some classes refused: offered; none refused: offered", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(risky)
      const names = kit.toolNames()
      // note (message: confirm) and pay (money) are refused for every class they declare.
      assert.isFalse(names.includes("note"))
      assert.isFalse(names.includes("pay"))
      // door can be change (allowed) or security (denied): offered, and each garage call is refused.
      assert.isTrue(names.includes("door"))
      assert.isTrue(names.includes("lamp"))
      assert.isTrue(names.includes("risky_door"))
      // Change denied: door's every class is refused now, and lamp too.
      kit.setRiskPolicy({ change: "deny" })
      const after = kit.toolNames()
      assert.isFalse(after.includes("door"))
      assert.isFalse(after.includes("lamp"))
      assert.isFalse(after.includes("risky_door"))
      assert.isTrue(after.includes("look"))
      // Message allowed: note comes back; pay never does.
      kit.setRiskPolicy({ message: "allow" })
      assert.isTrue(kit.toolNames().includes("note"))
      assert.isFalse(kit.toolNames().includes("pay"))
    }))

  it.effect("the host's cached registry (one per snapshot, kept across turns) reads the policy of now; so does its action list", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(risky)
      const registry = kit.host.snapshot().registry
      const has = (n: string) => registry.specs.some((s) => s.name === n)
      const first = registry.specs
      assert.strictEqual(registry.specs, first, "read twice with nothing changed: the same list (no decision per read)")
      assert.isTrue(has("lamp"))
      kit.setRiskPolicy({ change: "deny" })
      assert.isFalse(has("lamp"))
      assert.isFalse((registry.actions ?? []).some((a) => a.definition.id === "lamp"))
      kit.setRiskPolicy({})
      assert.isTrue(has("lamp"))
    }))

  it.effect("a change saved between the list and the call: the execution check wins and the model gets the refusal", () =>
    Effect.gen(function*() {
      reset()
      const kit = yield* startTestModule(risky)
      assert.isTrue(kit.toolNames().includes("lamp"))
      kit.setRiskPolicy({ change: "deny" })
      const lamp = yield* kit.tool("lamp", {})
      assert.deepStrictEqual([lamp.ok, lamp.content, ran], [false, DENY_CHANGE, []])
      // And the other way: refused in the list, allowed at the call.
      kit.setRiskPolicy({})
      kit.setRiskPolicy({ message: "confirm" })
      assert.isFalse(kit.toolNames().includes("note"))
      kit.setRiskPolicy({ message: "allow" })
      assert.strictEqual((yield* kit.tool("note", {})).content, "done")
    }))
})

describe("money and security cannot be made anything but deny through the kit", () => {
  it.effect("a household or a change that says otherwise is read as deny; the calls are refused", () =>
    Effect.gen(function*() {
      reset()
      const kit = yield* startTestModule(risky, { household: { risk: { money: "allow" as never, security: "allow" as never } } })
      assert.deepStrictEqual(kit.riskPolicy(), DEFAULT_RISK_POLICY)
      assert.strictEqual((yield* kit.tool("pay", {})).content, "Not run: it would spend money, which this assistant never does.")
      kit.setRiskPolicy({ money: "confirm" as never, security: "allow" as never, change: "allow" })
      assert.deepStrictEqual(kit.riskPolicy(), DEFAULT_RISK_POLICY)
      assert.strictEqual((yield* kit.tool("door", { which: "garage" })).content, DENY_SECURITY)
      assert.deepStrictEqual(ran, [])
    }))
})

describe("sensitivity: a personal result on its way back to the model", () => {
  it.effect("revealed where the privacy rule allows it for the asking device; otherwise a fixed sentence and nothing of it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(risky)
      // The kitchen display is shared with Sam as its default person: Sam's note may be revealed there.
      assert.strictEqual((yield* kit.tool("peek", {}, { device: "kitchen-display" })).content, "{\"owner\":\"p-sam\",\"text\":\"Sam's secret note\"}")
      // Robin's phone is private: it may reveal anyone's personal content.
      assert.strictEqual((yield* kit.tool("peek", {}, { device: "robins-phone" })).content, "{\"owner\":\"p-sam\",\"text\":\"Sam's secret note\"}")
      // The hall screen is public: withheld.
      const hall = yield* kit.tool("peek", {}, { device: "hall-screen" })
      assert.strictEqual(hall.content, "Withheld: the result is personal to someone, and this device may not reveal it. Say that it cannot be shared here.")
      assert.notInclude(hall.content, "secret")
      // Personal with no known owner is someone else's: withheld even on a private device.
      assert.match((yield* kit.tool("diary", {}, { device: "robins-phone" })).content, /^Withheld: /)
      // A generated action tool (the model calls an action): Alex's secret on Sam's kitchen display is withheld.
      assert.match((yield* kit.tool("risky_secret", {}, { device: "kitchen-display" })).content, /^Withheld: /)
      // The decision's record says the result was withheld.
      const withheld = kit.riskDecisions().filter((r) => (r as { withheld?: boolean }).withheld === true).map((r) => r.name)
      assert.deepStrictEqual(withheld, ["peek", "diary", "risky_secret"])
    }))

  it.effect("in Dutch, the withheld sentence and the refusals are Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(risky, { household: { home: { HOME_LANGUAGE: "nl-NL" }, risk: { change: "deny" } } })
      assert.match((yield* kit.tool("peek", {}, { device: "hall-screen" })).content, /^Achtergehouden: /)
      assert.strictEqual((yield* kit.tool("lamp", {})).content, "Niet uitgevoerd: het zou iets in huis veranderen, en dat staat dit huishouden niet toe.")
      assert.deepStrictEqual(yield* kit.action("door", { which: "garage" }), {
        ok: false,
        code: "refused",
        message: "Niet uitgevoerd: het zou iets doen met een slot, een alarm, een deur of een hek, en dat doet deze assistent nooit."
      })
    }))

  it.effect("a job's or a press's action returns to module code, not to a model: the gateway does not withhold it there", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(risky)
      const outcome = yield* kit.action("secret", {}, { device: "hall-screen" })
      // host.actions.run hands the module its own action's outcome; the module checks privacy itself before it shows it.
      assert.deepStrictEqual(outcome, { ok: true, say: "Alex's secret" })
    }))
})

describe("the turn's trace", () => {
  it.effect("each decision of a turn's call is on the turn's trace, with its outcome and class (no entry for a call refused before the decision)", () =>
    Effect.gen(function*() {
      const { CurrentTurnTrace, makeTurnTrace } = yield* Effect.promise(() => import("../src/TurnTrace.ts"))
      const kit = yield* startTestModule(risky, { household: { risk: { change: "confirm" } } })
      const tt = makeTurnTrace()
      const trace = tt.begin("voice")
      const turn: TurnContext = { ...kit.turn(), turnId: trace.id }
      const registry = makeToolRegistry((kit.host.snapshot().assistantParts.get("jeff") ?? []).map((x) => x.module), { gateway: kit.host.gateway })
      const call = (name: string, input: unknown) =>
        registry.run({ id: name, name, input }).pipe(Effect.provideService(CurrentTurn, turn), Effect.provideService(CurrentTurnTrace, trace))
      yield* call("look", {})
      yield* call("lamp", {})
      yield* call("door", { which: "garage" })
      yield* call("peek", {})
      yield* call("door", { which: "nonsense" }) // invalid input: never reaches the decision
      yield* call("nothing", {}) // unknown tool
      assert.deepStrictEqual(trace.calls as unknown, [
        { kind: "tool", moduleId: "risky", name: "look", principal: "turn", turnId: trace.id, outcome: "allow", by: "read" },
        { kind: "tool", moduleId: "risky", name: "lamp", principal: "turn", turnId: trace.id, outcome: "confirm", by: "change" },
        { kind: "tool", moduleId: "risky", name: "door", principal: "turn", turnId: trace.id, outcome: "deny", by: "security" },
        { kind: "tool", moduleId: "risky", name: "peek", principal: "turn", turnId: trace.id, outcome: "allow", by: "read" }
      ])
      yield* tt.finish(trace, "completed")
      const { formatTrace } = yield* Effect.promise(() => import("../src/TurnTrace.ts"))
      assert.include(formatTrace(trace), "risk: look allow(read), lamp confirm(change), door deny(security), peek allow(read)")
      assert.strictEqual(last(kit.riskDecisions())?.name, "peek")
    }))
})
