// P8: what a speaker and the trace get. The intent agent says a refusal of the risk policy in its own spoken sentence
// (the household's language), and a held action is decided again on the policy of now after promotion. A real
// Conversation provides the turn's trace around its tool calls, so the gateway records each decision there.
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { defineAction, Param, type RegisteredAction } from "../src/Actions.ts"
import type { AgentEvent, AgentTurnInput } from "../src/Agent.ts"
import { Conversation } from "../src/Conversation.ts"
import type { ConversationEvent } from "../src/ConversationEvents.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { makeExecutionGateway } from "../src/Gateway.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { DEFAULT_RISK_POLICY, type RiskLanguage, type RiskPolicy } from "../src/RiskPolicy.ts"
import { done, endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, speechStarted, textDelta, toolCall } from "../src/testing.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"
import { type Trace, TurnTrace } from "../src/TurnTrace.ts"
import { Schema } from "effect"

const turnOf: TurnContext = { turnId: 1, conversationId: "c-a", assistantId: "a", deviceId: "d1", source: "voice" }
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

/** A host with one "home" module whose `lights_on` action (`change`) counts its runs; the policy and language are read live. */
const homeWith = (live: { policy: RiskPolicy; language: RiskLanguage }, runs: { n: number }) =>
  Effect.gen(function*() {
    const lightsOn: RegisteredAction["definition"] = defineAction({
      id: "lights_on",
      label: "Turn lights on",
      description: "Switch on the lights in a room.",
      params: { room: Param.choice({ label: "Room", options: [{ value: "kitchen", label: "Kitchen" }, { value: "hall", label: "Hall" }] }) },
      announce: () => "Kitchen lights on.",
      risk: "change",
      run: () => Effect.sync(() => void runs.n++)
    }) as never
    const host = yield* makeModuleHost({
      catalog: [defineModule({ id: "home", name: "Home", description: "", start: () => Effect.succeed({ actions: [lightsOn as never] }) })],
      persistence: readOnlyPersistence(),
      env: {},
      access: { moduleOn: () => true, toolOff: () => false },
      gatewayHooks: { policy: () => live.policy, language: () => live.language }
    })
    yield* host.startEnabled
    // The registry is made while the policy allows it, as at a turn's start; what changes later is read at execution.
    const allowed = live.policy
    live.policy = DEFAULT_RISK_POLICY
    const registry = makeToolRegistry(host.snapshot().parts.map((p) => p.module), { gateway: host.gateway })
    const actions = registry.actions
    live.policy = allowed
    return { registry, actions }
  })

describe("what the person hears (the intent agent)", () => {
  for (
    const c of [
      { policy: { ...DEFAULT_RISK_POLICY, change: "confirm" as const }, language: "en" as const, spoken: "I can't do that: this household wants the owner to confirm changes first, and I can't ask for that yet." },
      { policy: { ...DEFAULT_RISK_POLICY, change: "deny" as const }, language: "en" as const, spoken: "I can't do that: this household doesn't allow me to change things in the house." },
      { policy: { ...DEFAULT_RISK_POLICY, change: "confirm" as const }, language: "nl" as const, spoken: "Dat kan ik niet doen: dit huishouden wil dat de eigenaar wijzigingen eerst bevestigt, en daar kan ik nog niet om vragen." },
      { policy: { ...DEFAULT_RISK_POLICY, change: "deny" as const }, language: "nl" as const, spoken: "Dat kan ik niet doen: dit huishouden staat niet toe dat ik iets in huis verander." }
    ]
  ) {
    it.effect(`a typed action refused (${c.policy.change}, ${c.language}) is said in the policy's own sentence; nothing runs`, () =>
      Effect.gen(function*() {
        const runs = { n: 0 }
        const { registry, actions } = yield* homeWith({ policy: c.policy, language: c.language }, runs)
        const events: Array<AgentEvent> = []
        yield* Stream.runForEach(makeIntentAgent({ deciders: ["scripted"] }).turn(inputOf(registry, { actions: actions ?? [] })), (e) => Effect.sync(() => void events.push(e)))
          .pipe(Effect.provideService(CurrentTurn, turnOf))
        assert.strictEqual(runs.n, 0)
        assert.strictEqual(spokenOf(events), c.spoken)
      }).pipe(Effect.scoped))
  }

  it.effect("a held action is decided again after promotion, on the policy of now: a change saved meanwhile refuses it", () =>
    Effect.gen(function*() {
      const runs = { n: 0 }
      const live = { policy: DEFAULT_RISK_POLICY as RiskPolicy, language: "en" as RiskLanguage }
      const { registry } = yield* homeWith(live, runs)
      const promoted = yield* Deferred.make<void>()
      const events: Array<AgentEvent> = []
      const turn = yield* Effect.forkChild(
        Stream.runForEach(makeIntentAgent({ deciders: ["scripted"] }).turn(inputOf(registry, { promoted: Deferred.await(promoted), speculative: true })), (e) => Effect.sync(() => void events.push(e)))
          .pipe(Effect.provideService(CurrentTurn, turnOf))
      )
      yield* settle
      assert.strictEqual(spokenOf(events), "Kitchen lights on.", "admitted while speculative")
      live.policy = { ...DEFAULT_RISK_POLICY, change: "deny" }
      yield* Deferred.succeed(promoted, undefined)
      yield* Fiber.join(turn)
      assert.strictEqual(runs.n, 0)
      assert.strictEqual(spokenOf(events), "Kitchen lights on. I can't do that: this household doesn't allow me to change things in the house.")
    }).pipe(Effect.scoped))
})

describe("the turn's trace in a real Conversation", () => {
  const lamp = makeTool({ name: "lamp", description: "Lamp.", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.succeed("on") })
  const note = makeTool({ name: "note", description: "Note.", parameters: Schema.Struct({}), risk: "message", execute: () => Effect.succeed("sent") })

  const oneTurn = (turnContext: TurnContext | undefined) =>
    Effect.gen(function*() {
      const gateway = makeExecutionGateway({ policy: () => DEFAULT_RISK_POLICY })
      const registry = makeToolRegistry([{ name: "home", tools: [lamp, note] }], { gateway })
      const ended = yield* Queue.unbounded<Trace>()
      const onEvent = (e: ConversationEvent) => {
        if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
      }
      let round = 0
      const llm = makeScriptedLlm(() => (round++ === 0 ? [toolCall("t1", "lamp", {}), toolCall("t2", "note", {}), done("tool_use")] : [textDelta("Done.")]))
      const layer = Conversation.layerWithSetup({
        onEvent,
        setup: Effect.sync(() => ({
          system: "Test.",
          registry,
          ...(turnContext !== undefined ? { turnContext: { assistantId: turnContext.assistantId!, deviceId: turnContext.deviceId! } } : {})
        }))
      }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, TurnTrace.layer())))
      let trace: Trace | undefined
      yield* Effect.gen(function*() {
        const c = yield* Conversation
        yield* c.voice(Stream.make(speechStarted, endOfTurn("Lamp on and tell Sam.")).pipe(Stream.concat(Stream.fromEffectDrain(Effect.map(Queue.take(ended), (t) => void (trace = t))))))
      }).pipe(Effect.provide(Layer.mergeAll(layer, makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
      return trace!
    })

  it.effect("serve mode's turn (a turn principal): each tool call's decision is on the turn's trace and its log line", () =>
    Effect.gen(function*() {
      const trace = yield* oneTurn(turnOf)
      assert.deepStrictEqual(trace.calls?.map((c) => [c.name, c.outcome, c.by, (c as { principal?: string }).principal, (c as { turnId?: number }).turnId]), [
        ["lamp", "allow", "change", "turn", trace.id],
        ["note", "confirm", "message", "turn", trace.id]
      ])
    }))

  it.effect("a CLI turn (the local principal, no turn context): the same", () =>
    Effect.gen(function*() {
      const trace = yield* oneTurn(undefined)
      assert.deepStrictEqual(trace.calls?.map((c) => [c.name, c.outcome, c.by]), [["lamp", "allow", "change"], ["note", "confirm", "message"]])
    }))
})
