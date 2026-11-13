// "Hey Jev, turn on the lights in the living room" end to end, with no keys: the
// real Conversation, router, module host, jev agent, offline keyword decider and
// demo home; scripted speech recognition, TTS and speaker; a scripted
// conversational agent for what Jev passes on.
import { assert, describe, it } from "@effect/vitest"
import {
  Conversation,
  type ConversationEvent,
  type ConversationInput,
  defaultRoutingConfig,
  defineAgent,
  formatTrace,
  makeModuleHost,
  makeTriggerRouter,
  readOnlyPersistence,
  TurnTrace
} from "@pva/core"
import {
  agentText,
  eagerEndOfTurn,
  endOfTurn,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedAgent,
  scripted,
  type Sleep,
  sleep,
  testTurnTraceLayer
} from "@pva/core/testing"
import { clockModule, demoHomeModule } from "@pva/modules-builtin"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { jevAgent } from "../src/jev.ts"
import { keywordsDecider } from "../src/keywords.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

/** The app's wiring in miniature (piece F does this for real): host snapshot → agent setup per turn. */
const assemble = (options: { readonly live: boolean }) =>
  Effect.gen(function*() {
    const main = makeScriptedAgent({ id: "main", name: "Assistant" }, (input) => [agentText(`(conversational answer to ${input.text})`)])
    const mainModule = defineAgent({ id: "main", name: "Assistant", description: "scripted", kind: "model", enabledByDefault: true, start: () => Effect.succeed({ turn: main.agent.turn }) })
    const host = yield* makeModuleHost({
      catalog: [demoHomeModule, clockModule, mainModule, jevAgent, keywordsDecider],
      persistence: readOnlyPersistence(),
      env: { CLOCK_TIME_ZONE: "Europe/Amsterdam" }
    })
    yield* host.startEnabled
    const routing = { ...defaultRoutingConfig, defaultAgent: "main" }
    const router = makeTriggerRouter(routing)
    const setup = Effect.sync(() => {
      const snapshot = host.snapshot()
      return {
        system: "You are a voice assistant.",
        registry: snapshot.registry,
        agents: { router, agents: snapshot.agents, defaultAgent: routing.defaultAgent, actions: snapshot.actions, deciders: snapshot.deciders, armedMs: routing.armedMs }
      }
    })
    const events: Array<ConversationEvent> = []
    const out = makeRecordingAudioOutput({ chunkMillis: options.live ? 0 : 100 })
    const layer = Layer.mergeAll(
      Conversation.layerWithAgents({ setup, onEvent: (e) => events.push(e) }).pipe(Layer.provideMerge(options.live ? TurnTrace.layer() : testTurnTraceLayer)),
      makeMarkerTts().layer,
      out.layer
    )
    const lights = Effect.map(host.snapshot().registry.run({ id: "s", name: "demo_home_state", input: {} }), (r) => {
      const state = JSON.parse(r.content) as { rooms: Array<{ name: string; lights: Array<{ on: boolean }> }> }
      return state.rooms.filter((room) => room.lights.some((l) => l.on)).map((room) => room.name)
    })
    return { host, main, events, out, layer, lights }
  })

const voice = (script: ReadonlyArray<ConversationInput | Sleep>) => Effect.flatMap(Effect.service(Conversation), (c) => c.voice(scripted(script)))

describe("hey Jev, end to end with the keyword decider and the demo home", () => {
  it.effect("commands act, questions ask, the rest goes to the conversational agent", () =>
    Effect.scoped(Effect.gen(function*() {
      const t = yield* assemble({ live: false })
      yield* TestClock.setTime(Date.UTC(2026, 10, 13, 13, 32))
      yield* Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(voice([
          // The eager end of turn comes 270 ms before the final one.
          eagerEndOfTurn("Hey Jeff, turn on the lights in the living room."),
          sleep(270),
          endOfTurn("Hey Jeff, turn on the lights in the living room."),
          sleep(2_000),
          endOfTurn("Hey Jev, lights on."),
          sleep(2_000),
          endOfTurn("The bedroom."),
          sleep(2_000),
          endOfTurn("Hey Jev, what is a quark?"),
          sleep(2_000),
          endOfTurn("Hey Jev, what time is it in Tokyo?"),
          sleep(2_000),
          endOfTurn("Thanks!")
        ]))
        yield* advance(20_000)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(t.layer))

      assert.deepStrictEqual(t.out.probe.chunks.map((c) => c.text), [
        "<Living room lights on.>",
        "<Which room or light?>",
        "<Bedroom lights on.>",
        "<(conversational answer to What is a quark?)>",
        "<In Tokyo it's 22:32.>",
        "<(conversational answer to Thanks!)>"
      ])
      assert.deepStrictEqual(yield* t.lights, ["Living room", "Bedroom"])
      // The first command was decided and announced during the speculative turn and played at promotion.
      assert.strictEqual(t.out.probe.chunks[0]!.at, Date.UTC(2026, 10, 13, 13, 32) + 270)
      const decisions = t.events.flatMap((e) => (e._tag === "IntentDecided" ? [`${e.decision.outcome}${e.decision.action ? ` ${e.decision.action.id}` : ""}${e.decision.reason ? ` (${e.decision.reason})` : ""}`] : []))
      assert.deepStrictEqual(decisions, [
        "act demo-home.lights_on",
        "ask demo-home.lights_on",
        "act demo-home.lights_on",
        "fallback (no_match)",
        "act clock.time_now"
      ])
      assert.deepStrictEqual(t.events.flatMap((e) => (e._tag === "TurnAgentChanged" ? [`${e.from}→${e.agentId} ${e.reason}`] : [])), ["jev→main handoff"])
      assert.deepStrictEqual(t.main.probe.inputs.map((i) => [i.text, i.routedBy]), [["What is a quark?", "trigger"], ["Thanks!", "default"]])
    })))

  it.live("one spoken command on the real clock: transcript and trace", () =>
    Effect.scoped(Effect.gen(function*() {
      const t = yield* assemble({ live: true })
      const utterance = "Hey Jeff, turn on the lights in the living room."
      const traces = yield* Effect.gen(function*() {
        // Warm up once (JIT), then the measured turn.
        yield* voice([eagerEndOfTurn("Hey Jev, which lights are on?"), sleep(50), endOfTurn("Hey Jev, which lights are on?")])
        t.events.length = 0
        yield* voice([eagerEndOfTurn(utterance), sleep(270), endOfTurn(utterance)])
        return yield* Effect.flatMap(Effect.service(TurnTrace), (tt) => tt.recent)
      }).pipe(Effect.provide(t.layer))
      const trace = traces.at(-1)!
      const decision = t.events.find((e) => e._tag === "IntentDecided")
      const action = t.events.find((e) => e._tag === "ActionStarted")
      const lines = [
        `heard:    ${utterance}`,
        `routed:   ${JSON.stringify(t.events.find((e) => e._tag === "TurnStarted"))}`,
        `decision: ${JSON.stringify(decision?._tag === "IntentDecided" ? decision.decision : undefined)}`,
        `action:   ${JSON.stringify(action)}`,
        `spoken:   ${t.out.probe.chunks.map((c) => c.text).join(" ")}`,
        `lights on: ${(yield* t.lights).join(", ")}`,
        `trace:    ${formatTrace(trace)}`
      ]
      console.log(lines.join("\n"))
      assert.strictEqual(trace.outcome, "completed")
      assert.isDefined(trace.marks.decisionReceived)
      assert.isBelow(trace.marks.playbackStart! - trace.marks.endOfTurn!, 20, "plays within milliseconds of the end of turn: the decision was made speculatively")
      assert.isAbove(trace.marks.actionStarted!, trace.marks.endOfTurn! - 0.001, "the light switched only after the turn was committed")
    })), 20_000)
})

