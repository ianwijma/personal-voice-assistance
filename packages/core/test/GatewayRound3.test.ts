// The execution gateway, review round 3 (p1-r3b): nothing runs a published tool or action without admission
// (finding 3); the risk function runs after the access checks, bounded, and its failure is a generic refusal
// (finding 7); the intent agent keeps each turn's pending state and announces nothing before admission (findings 5, 8);
// and the cost of the whole tool path, measured with `TurnTrace`'s tool times (finding 9).
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { defineAction, Param } from "../src/Actions.ts"
import type { AgentEvent, AgentTurnInput } from "../src/Agent.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { makeExecutionGateway, RISK_BUDGET_MS } from "../src/Gateway.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { makeModelAgent } from "../src/ModelAgent.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { makePendingIntents } from "../src/PendingIntents.ts"
import { Llm } from "../src/Services.ts"
import { makeScriptedLlm, textDelta, toolCall } from "../src/testing.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"

const turnOf = (assistantId: string, turnId = 1): TurnContext => ({ turnId, conversationId: `c-${assistantId}`, assistantId, deviceId: "d1", source: "voice" })

describe("finding 3: no way around admission", () => {
  it.effect("a published tool's execute and a published action's run only refuse; through the gateway, the checks decide", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []
      let on = true
      const mod = defineModule({
        id: "home",
        name: "Home",
        description: "",
        start: () =>
          Effect.succeed({
            tools: [makeTool({ name: "home_peek", description: "", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.sync(() => (ran.push("tool"), "ok")) })],
            actions: [defineAction({ id: "open", label: "Open", description: "", params: {}, run: () => Effect.sync(() => void ran.push("action")) })]
          })
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence(),
        env: {},
        demand: () => new Map<string, ReadonlyArray<ModuleDemand>>([["home", [{ assistantId: "a" }]]]),
        access: { moduleOn: () => on, toolOff: () => false }
      })
      yield* host.startEnabled
      const snapshot = host.snapshot()
      const tool = snapshot.parts[0]!.module.tools!.find((t) => t.name === "home_peek")!
      const generated = snapshot.parts[0]!.module.tools!.find((t) => t.name === "home_open")!
      const action = snapshot.actions[0]!
      // Directly: refused, for the tool, the generated action tool and the action, whoever calls.
      for (const direct of [tool.execute({}), generated.execute({}), action.definition.run({} as never)]) {
        const error = yield* Effect.flip(Effect.provideService(direct as Effect.Effect<unknown, { readonly message: string }>, CurrentTurn, turnOf("a")))
        assert.match(error.message, /only through the execution gateway|can only be run through the execution gateway/)
      }
      assert.deepStrictEqual(ran, [])
      // Through the published registry: no principal in serve mode, refused; module off, refused; on, it runs.
      const none = yield* snapshot.registry.run({ id: "1", name: "home_peek", input: {} })
      assert.isTrue(none.isError)
      on = false
      const off = yield* Effect.provideService(snapshot.registry.run({ id: "2", name: "home_peek", input: {} }), CurrentTurn, turnOf("a"))
      assert.strictEqual(off.content, "Not run: the home module is not on for this assistant.")
      assert.deepStrictEqual(ran, [])
      on = true
      const ok = yield* Effect.provideService(snapshot.registry.run({ id: "3", name: "home_peek", input: {} }), CurrentTurn, turnOf("a"))
      assert.strictEqual(ok.content, "ok")
      assert.deepStrictEqual(ran, ["tool"])
    }).pipe(Effect.scoped))
})

describe("finding 7: the risk function runs after the access checks, bounded, and fails closed without its text", () => {
  it.effect("module off: never called; on: a throw, an undeclared class or a slow answer is a generic refusal; nothing runs", () =>
    Effect.gen(function*() {
      let classified = 0
      let mode: "throw" | "undeclared" | "slow" | "ok" = "throw"
      let on = false
      const ran: Array<string> = []
      const door = makeTool({
        name: "door",
        description: "",
        parameters: Schema.Struct({}),
        risk: {
          classes: ["change"],
          of: () => {
            classified++
            if (mode === "throw") throw new Error("token SECRET-123 at http://10.0.0.2")
            if (mode === "undeclared") return "security"
            if (mode === "slow") {
              const until = performance.now() + RISK_BUDGET_MS * 3
              while (performance.now() < until) {
                // busy: a classifier that does too much on the turn path
              }
            }
            return "change"
          }
        },
        execute: () => Effect.sync(() => (ran.push("door"), "opened"))
      })
      const gateway = makeExecutionGateway({ access: { moduleOn: () => on, toolOff: () => false } })
      const registry = makeToolRegistry([{ name: "home", tools: [door] }], { gateway })
      const call = (id: string) => Effect.provideService(registry.run({ id, name: "door", input: {} }), CurrentTurn, turnOf("a"))
      const off = yield* call("1")
      assert.strictEqual(off.content, "Not run: the home module is not on for this assistant.")
      assert.strictEqual(classified, 0, "the module's classifier is not called for a call the access checks refuse")
      on = true
      for (const m of ["throw", "undeclared", "slow"] as const) {
        mode = m
        const refused = yield* call(m)
        assert.strictEqual(refused.content, "Not run: what it would do could not be judged.", m)
        assert.notInclude(refused.content, "SECRET")
      }
      assert.deepStrictEqual(ran, [])
      mode = "ok"
      assert.strictEqual((yield* call("ok")).content, "opened")
    }))
})

describe("the intent path (findings 5, 8)", () => {
  const noul = (value: number): DecisionAnswer => ({ type: "noul", value })
  const lights = defineAction({
    id: "on",
    label: "Lights on",
    description: "Switch the lights on in a room",
    params: { room: Param.choice({ label: "Room", options: [{ value: "kitchen", label: "Kitchen" }, { value: "hall", label: "Hall" }] }) },
    announce: ({ room }) => `${room === "kitchen" ? "Kitchen" : "Hall"} lights on.`,
    run: () => Effect.void
  })
  const inputOf = (actions: AgentTurnInput["actions"], tools: AgentTurnInput["tools"], deciders: AgentTurnInput["deciders"], extra: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
    turnId: 1,
    conversationId: "c1",
    text: "Lights on.",
    utterance: "Lights on.",
    source: "voice",
    spoken: true,
    routedBy: "trigger",
    history: [],
    system: "",
    context: undefined,
    tools,
    actions,
    deciders,
    promoted: Effect.void,
    speculative: false,
    mark: () => {},
    trace: { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] },
    maxToolRounds: 5,
    ...extra
  })
  const spokenOf = (events: ReadonlyArray<AgentEvent>) => events.flatMap((e) => (e._tag === "TextDelta" && e.text !== "\n" ? [e.text] : [])).join("")

  it.effect("5: two concurrent turns of one intent agent keep their questions in their own conversations", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      let calls = 0
      // The decision names the action but no room: the agent asks which room, for its own conversation.
      const scripted = makeScriptedDecider((request: DecisionRequest) => {
        const options = Object.keys((request.questions.action as { options: Record<string, unknown> } | undefined)?.options ?? {})
        const probabilities: Record<string, number> = {}
        for (const o of options) probabilities[o] = o.endsWith(".on") ? 0.95 : 0.05 / Math.max(1, options.length - 1)
        return { answers: { action: choiceAnswer(probabilities), fits: noul(0.95), compound: noul(0.02) } }
      })
      // The first turn's decision waits until the second turn has run to its end.
      const decider = { ...scripted, decide: (request: DecisionRequest) => (++calls === 1 ? Effect.andThen(Deferred.await(gate), scripted.decide(request)) : scripted.decide(request)) }
      const host = yield* makeModuleHost({ catalog: [defineModule({ id: "home", name: "Home", description: "", start: () => Effect.succeed({ actions: [lights] }) })], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      const registry = makeToolRegistry(host.snapshot().parts.map((p) => p.module), { gateway: host.gateway })
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const storeA = makePendingIntents()
      const storeB = makePendingIntents()
      const deciders = new Map([["scripted", decider]])
      const first = yield* Effect.forkChild(Stream.runCollect(agent.turn(inputOf(registry.actions ?? [], registry, deciders, { pendingIntents: storeA, conversationId: "A" }))))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      const second = Array.from(yield* Stream.runCollect(agent.turn(inputOf(registry.actions ?? [], registry, deciders, { pendingIntents: storeB, conversationId: "B", turnId: 2 }))))
      yield* Deferred.succeed(gate, undefined)
      const firstEvents = Array.from(yield* Fiber.join(first))
      assert.match(spokenOf(firstEvents), /room|which/i)
      assert.match(spokenOf(second), /room|which/i)
      const now = 0 // the turns' test clock
      assert.strictEqual(storeA.current(now)?.turnId, 1, `turn 1's question is in conversation A ${JSON.stringify(firstEvents)} ${JSON.stringify(storeB.current(now))}`)
      assert.strictEqual(storeB.current(now)?.turnId, 2, "turn 2's question is in conversation B")
    }).pipe(Effect.scoped))

  it.effect("8: an action the gateway refuses is never announced; an admitted one is announced before it is started", () =>
    Effect.gen(function*() {
      let off = true
      const rooms = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:hall", label: "Hall" }]
      const lightsOn = defineAction({
        id: "lights_on",
        label: "Turn lights on",
        description: "Switch on the lights in a room.",
        params: { target: Param.dynamic({ label: "Room or light", options: () => rooms }) },
        announce: ({ target }) => `${rooms.find((r) => r.value === target)?.label ?? target} lights on.`,
        run: () => Effect.void
      })
      const decider = makeScriptedDecider((request: DecisionRequest) => {
        const options = Object.keys((request.questions.action as { options: Record<string, unknown> } | undefined)?.options ?? {})
        const probabilities: Record<string, number> = {}
        for (const o of options) probabilities[o] = o === "home.lights_on" ? 0.94 : 0.06 / Math.max(1, options.length - 1)
        return { answers: { action: choiceAnswer(probabilities), fits: noul(0.95), compound: noul(0.03), "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.96, "area:hall": 0.04 }) } }
      })
      const host = yield* makeModuleHost({
        catalog: [defineModule({ id: "home", name: "Home", description: "", start: () => Effect.succeed({ actions: [lightsOn] }) })],
        persistence: readOnlyPersistence(),
        env: {},
        access: { moduleOn: () => true, toolOff: () => off }
      })
      yield* host.startEnabled
      const registry = makeToolRegistry(host.snapshot().parts.map((p) => p.module), { gateway: host.gateway })
      const run = () =>
        Effect.map(
          Stream.runCollect(
            makeIntentAgent({ deciders: ["scripted"] }).turn(
              inputOf(registry.actions ?? [], registry, new Map([["scripted", decider]]), { text: "Turn on the kitchen lights.", utterance: "Turn on the kitchen lights." })
            )
          ).pipe(Effect.provideService(CurrentTurn, turnOf("a"))),
          (c) => Array.from(c)
        )
      const refused = yield* run()
      assert.isTrue(refused.some((e) => e._tag === "Decision"), JSON.stringify(refused))
      assert.notInclude(spokenOf(refused), "Kitchen lights on.")
      assert.isTrue(refused.some((e) => e._tag === "ActionFinished" && !e.ok), JSON.stringify(refused))
      off = false
      const admitted = yield* run()
      const tags = admitted.map((e) => (e._tag === "TextDelta" ? `text:${e.text}` : e._tag))
      assert.isBelow(tags.indexOf("text:Kitchen lights on."), tags.indexOf("ActionStarted"))
      assert.isTrue(admitted.some((e) => e._tag === "ActionFinished" && e.ok))
    }).pipe(Effect.scoped))
})

describe("finding 9: the cost of the tool path, measured with TurnTrace's tool times", () => {
  it.live("a module tool through the host's gateway (access checks, a risk function, sealing, in-flight tracking) against a bare registry", () =>
    Effect.gen(function*() {
      const turns = 400
      const run = (registry: ReturnType<typeof makeToolRegistry>) =>
        Effect.gen(function*() {
          const llm = makeScriptedLlm((_, i) => (i % 2 === 0 ? [toolCall(`t${i}`, "peek", {})] : [textDelta("ok")]))
          const agent = makeModelAgent({ llm: yield* Effect.provide(Effect.gen(function*() {
            return yield* Llm
          }), llm.layer) })
          const times: Array<number> = []
          for (let i = 0; i < turns; i++) {
            const trace = { id: i, mode: "text" as const, speculative: false, startedAt: 0, marks: {}, tools: [] as Array<{ name: string; ms: number }>, voices: [] }
            const input: AgentTurnInput = {
              turnId: i,
              conversationId: "c",
              text: "peek",
              utterance: "peek",
              source: "text",
              spoken: false,
              routedBy: "explicit",
              history: [],
              system: "",
              context: undefined,
              tools: registry,
              actions: [],
              deciders: new Map(),
              promoted: Effect.void,
              speculative: false,
              mark: () => {},
              trace,
              maxToolRounds: 2,
              now: () => performance.now()
            }
            yield* Stream.runDrain(agent.turn(input)).pipe(Effect.provideService(CurrentTurn, turnOf("a", i)))
            times.push(trace.tools[0]!.ms)
          }
          return times.slice(50).sort((a, b) => a - b)
        })
      const peek = () => makeTool({ name: "peek", description: "", parameters: Schema.Struct({}), speculative: true, risk: { classes: ["read"], of: () => "read" }, execute: () => Effect.succeed("ok") })
      const bare = yield* run(makeToolRegistry([{ name: "home", tools: [peek()] }]))
      const host = yield* makeModuleHost({
        catalog: [defineModule({ id: "home", name: "Home", description: "", start: () => Effect.succeed({ tools: [peek()] }) })],
        persistence: readOnlyPersistence(),
        env: {},
        demand: () => new Map<string, ReadonlyArray<ModuleDemand>>([["home", [{ assistantId: "a" }]]]),
        access: { moduleOn: () => true, toolOff: () => false, principalProblem: () => undefined }
      })
      yield* host.startEnabled
      const gated = yield* run(makeToolRegistry(host.snapshot().assistantParts.get("a")!.map((p) => p.module), { gateway: host.gateway }))
      const at = (xs: ReadonlyArray<number>, q: number) => xs[Math.floor(q * (xs.length - 1))]!
      const line = `tool path (TurnTrace tool ms, ${turns - 50} turns): bare p50 ${at(bare, 0.5).toFixed(3)} p95 ${at(bare, 0.95).toFixed(3)}; host gateway p50 ${at(gated, 0.5).toFixed(3)} p95 ${at(gated, 0.95).toFixed(3)}`
      if (process.env.PVA_PRINT_BENCH !== undefined) console.log(line)
      // The budget (docs/ARCHITECTURE.md "The execution gateway"): well under a millisecond added at the median.
      assert.isBelow(at(gated, 0.5) - at(bare, 0.5), 1, line)
    }).pipe(Effect.scoped), { timeout: 60_000 })
})

void Layer
