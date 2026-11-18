// The execution gateway and the intent path, review round 4 (p1-r4b): a held action refused at its second admission
// does not run, and the refusal follows the success sentence already released (finding 4, kept as a known limit for
// latency); waiting for promotion and running are bounded separately (finding 6); a classifier's failure is logged as
// a bounded category, never its text (finding 7).
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Logger, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { defineAction, Param, type RegisteredAction } from "../src/Actions.ts"
import type { AgentEvent, AgentTurnInput } from "../src/Agent.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { makeExecutionGateway } from "../src/Gateway.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"

const turnOf = (assistantId: string): TurnContext => ({ turnId: 1, conversationId: `c-${assistantId}`, assistantId, deviceId: "d1", source: "voice" })
const noul = (value: number): DecisionAnswer => ({ type: "noul", value })
const spokenOf = (events: ReadonlyArray<AgentEvent>) => events.flatMap((e) => (e._tag === "TextDelta" && e.text !== "\n" ? [e.text] : [])).join("")
const settle = Effect.repeat(Effect.yieldNow, { times: 50 })

const decider = makeScriptedDecider((request: DecisionRequest) => {
  const options = Object.keys((request.questions.action as { options: Record<string, unknown> } | undefined)?.options ?? {})
  const probabilities: Record<string, number> = {}
  for (const o of options) probabilities[o] = o === "home.lights_on" ? 0.94 : 0.06 / Math.max(1, options.length - 1)
  return { answers: { action: choiceAnswer(probabilities), fits: noul(0.95), compound: noul(0.03), "home.lights_on/room": choiceAnswer({ kitchen: 0.96, hall: 0.04 }) } }
})

const inputOf = (registry: ReturnType<typeof makeToolRegistry>, extra: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
  turnId: 1,
  conversationId: "c1",
  text: "Turn on the kitchen lights.",
  utterance: "Turn on the kitchen lights.",
  source: "voice",
  spoken: true,
  routedBy: "trigger",
  history: [],
  system: "",
  context: undefined,
  tools: registry,
  actions: registry.actions ?? [],
  deciders: new Map([["scripted", decider]]),
  promoted: Effect.void,
  speculative: false,
  mark: () => {},
  trace: { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] },
  maxToolRounds: 5,
  ...extra
})

/** A host with one "home" module whose `lights_on` action runs `run`; `on` decides the gateway's access check. */
const homeWith = (run: () => Effect.Effect<void>, on: { current: boolean }) =>
  Effect.gen(function*() {
    const lightsOn: RegisteredAction["definition"] = defineAction({
      id: "lights_on",
      label: "Turn lights on",
      description: "Switch on the lights in a room.",
      params: { room: Param.choice({ label: "Room", options: [{ value: "kitchen", label: "Kitchen" }, { value: "hall", label: "Hall" }] }) },
      announce: () => "Kitchen lights on.",
      run
    }) as never
    const host = yield* makeModuleHost({
      catalog: [defineModule({ id: "home", name: "Home", description: "", start: () => Effect.succeed({ actions: [lightsOn as never] }) })],
      persistence: readOnlyPersistence(),
      env: {},
      access: { moduleOn: () => on.current, toolOff: () => false }
    })
    yield* host.startEnabled
    return makeToolRegistry(host.snapshot().parts.map((p) => p.module), { gateway: host.gateway })
  })

describe("finding 4 (decision reversed after measurement; a known limit): access withdrawn between the two admissions", () => {
  it.effect("the success sentence was released at the first admission; after promotion the action does not run and the refusal is spoken after it", () =>
    Effect.gen(function*() {
      const on = { current: true }
      let runs = 0
      const registry = yield* homeWith(() => Effect.sync(() => void runs++), on)
      const promoted = yield* Deferred.make<void>()
      const events: Array<AgentEvent> = []
      const turn = yield* Effect.forkChild(
        Stream.runForEach(makeIntentAgent({ deciders: ["scripted"] }).turn(inputOf(registry, { promoted: Deferred.await(promoted), speculative: true })), (e) => Effect.sync(() => void events.push(e)))
          .pipe(Effect.provideService(CurrentTurn, turnOf("a")))
      )
      yield* settle
      assert.isTrue(events.some((e) => e._tag === "Decision"), "decided while speculative")
      assert.strictEqual(spokenOf(events), "Kitchen lights on.", "released at the first admission, so it can be synthesised before promotion")
      on.current = false
      yield* Deferred.succeed(promoted, undefined)
      yield* Fiber.join(turn)
      assert.strictEqual(runs, 0, "the second admission refuses it: nothing runs")
      const spoken = spokenOf(events)
      assert.match(spoken, /^Kitchen lights on\. Sorry, Not run: the home module is not on for this assistant\.$/, spoken)
      const finished = events.find((e) => e._tag === "ActionFinished")
      assert.isTrue(finished !== undefined && finished._tag === "ActionFinished" && !finished.ok)
    }).pipe(Effect.scoped))
})

describe("finding 6: waiting for promotion and running the action are bounded separately", () => {
  const finishedOf = (events: ReadonlyArray<AgentEvent>) => events.find((e): e is Extract<AgentEvent, { _tag: "ActionFinished" }> => e._tag === "ActionFinished")

  it.effect("an already-promoted action that takes 6 s is stopped at 5 s", () =>
    Effect.gen(function*() {
      let done = false
      const registry = yield* homeWith(() => Effect.andThen(Effect.sleep(6_000), Effect.sync(() => void (done = true))), { current: true })
      const events: Array<AgentEvent> = []
      const turn = yield* Effect.forkChild(
        Stream.runForEach(makeIntentAgent({ deciders: ["scripted"] }).turn(inputOf(registry)), (e) => Effect.sync(() => void events.push(e))).pipe(Effect.provideService(CurrentTurn, turnOf("a")))
      )
      yield* settle
      yield* TestClock.adjust(5_100)
      yield* settle
      const finished = finishedOf(events)
      assert.isDefined(finished, "finished by its limit")
      assert.isFalse(finished!.ok)
      assert.match(finished!.error ?? "", /did not finish within 5 seconds/)
      assert.isFalse(done)
      yield* TestClock.adjust(2_000)
      yield* Fiber.join(turn)
      assert.isFalse(done, "interrupted, not finished later")
    }).pipe(Effect.scoped))

  it.effect("an action promoted 3 s late that never finishes is stopped 5 s after it started (8 s), not after 5 s plus the pending window", () =>
    Effect.gen(function*() {
      const registry = yield* homeWith(() => Effect.never, { current: true })
      const promoted = yield* Deferred.make<void>()
      const events: Array<AgentEvent> = []
      const turn = yield* Effect.forkChild(
        Stream.runForEach(makeIntentAgent({ deciders: ["scripted"] }).turn(inputOf(registry, { promoted: Deferred.await(promoted), speculative: true })), (e) =>
          Effect.sync(() => void events.push(e))).pipe(Effect.provideService(CurrentTurn, turnOf("a")))
      )
      yield* settle
      yield* TestClock.adjust(3_000)
      yield* Deferred.succeed(promoted, undefined)
      yield* settle
      yield* TestClock.adjust(4_900)
      yield* settle
      assert.isUndefined(finishedOf(events), "still within its 5 s")
      yield* TestClock.adjust(200)
      yield* settle
      assert.match(finishedOf(events)?.error ?? "", /did not finish within 5 seconds/)
      yield* Fiber.join(turn)
    }).pipe(Effect.scoped))

  it.effect("a turn never promoted within the pending window: the held action is not run", () =>
    Effect.gen(function*() {
      let runs = 0
      const registry = yield* homeWith(() => Effect.sync(() => void runs++), { current: true })
      const events: Array<AgentEvent> = []
      const turn = yield* Effect.forkChild(
        Stream.runForEach(makeIntentAgent({ deciders: ["scripted"], pendingMs: 2_000 }).turn(inputOf(registry, { promoted: Effect.never, speculative: true })), (e) =>
          Effect.sync(() => void events.push(e))).pipe(Effect.provideService(CurrentTurn, turnOf("a")))
      )
      yield* settle
      yield* TestClock.adjust(2_100)
      yield* settle
      yield* TestClock.adjust(30_000)
      yield* settle
      assert.strictEqual(runs, 0, "never run, however long the turn then lasts")
      yield* Fiber.interrupt(turn)
    }).pipe(Effect.scoped))
})

describe("finding 7: a classifier's failure is logged as a category, never its text", () => {
  it.effect("a classifier that throws a secret: the refusal and the log both lack it", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const door = makeTool({
        name: "door",
        description: "",
        parameters: Schema.Struct({}),
        risk: {
          classes: ["change"],
          of: () => {
            throw new Error("token SECRET-123 at http://10.0.0.2")
          }
        },
        execute: () => Effect.succeed("opened")
      })
      const registry = makeToolRegistry([{ name: "home", tools: [door] }], { gateway: makeExecutionGateway({ access: { moduleOn: () => true, toolOff: () => false } }) })
      const result = yield* registry.run({ id: "1", name: "door", input: {} }).pipe(
        Effect.provideService(CurrentTurn, turnOf("a")),
        Effect.provide(Logger.layer([Logger.make(({ message }) => void logs.push(JSON.stringify(message)))]))
      )
      assert.strictEqual(result.content, "Not run: what it would do could not be judged.")
      assert.isTrue(logs.some((l) => l.includes("its risk function threw or answered a class it does not declare")), JSON.stringify(logs))
      for (const l of logs) {
        assert.notInclude(l, "SECRET")
        assert.notInclude(l, "10.0.0.2")
      }
    }))
})
