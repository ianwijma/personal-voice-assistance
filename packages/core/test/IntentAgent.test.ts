// Piece C: the intent agent driven directly (docs/AGENTS-AND-INTENTS.md §3.4, §3.6).
import { assert, describe, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ActionError, defineAction, Param, registerActions } from "../src/Actions.ts"
import type { AgentEvent, AgentTurnInput } from "../src/Agent.ts"
import { choiceAnswer, type DecisionAnswer, DecisionError, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

/** A tiny house: two rooms, lights on (side effect), the time (read-only), all off (asks first). */
const makeHome = (options: { readonly failWith?: string; readonly runMillis?: number } = {}) => {
  const runs: Array<{ readonly action: string; readonly params: unknown; readonly at: number }> = []
  const finished: Array<string> = []
  const record = (action: string, params: unknown) =>
    Effect.gen(function*() {
      runs.push({ action, params, at: yield* Clock.currentTimeMillis })
      if (options.runMillis !== undefined) yield* Effect.sleep(options.runMillis)
      if (options.failWith !== undefined) return yield* new ActionError({ message: options.failWith })
      finished.push(action)
    })
  const rooms = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:living_room", label: "Living room", aliases: ["lounge"] }]
  const actions = registerActions("home", [
    defineAction({
      id: "lights_on",
      label: "Turn lights on",
      description: "Switch on the lights in a room.",
      params: { target: Param.dynamic({ label: "Room or light", options: () => rooms }) },
      announce: ({ target }) => `${rooms.find((r) => r.value === target)?.label ?? target} lights on.`,
      run: (params) => record("lights_on", params)
    }),
    defineAction({
      id: "time_now",
      label: "Tell the time",
      description: "Say the time.",
      params: {},
      speculative: true,
      run: () => Effect.as(record("time_now", {}), { say: "It's 14:32." })
    }),
    defineAction({ id: "all_off", label: "Switch everything off", description: "Every light off.", params: {}, confirm: true, run: (p) => record("all_off", p) })
  ])
  return { actions, runs, finished }
}

const noul = (value: number): DecisionAnswer => ({ type: "noul", value })

/** Answers for "the owner wants `action`" with optional parameter answers. */
const wants = (action: string, extra: Record<string, DecisionAnswer> = {}, fits = 0.95) => (request: DecisionRequest) => {
  const options = Object.keys((request.questions.action as { options: Record<string, unknown> } | undefined)?.options ?? {})
  const probabilities: Record<string, number> = {}
  for (const o of options) probabilities[o] = o === action ? 0.94 : 0.06 / Math.max(1, options.length - 1)
  return { answers: { action: choiceAnswer(probabilities), fits: noul(fits), compound: noul(0.03), ...extra } }
}

const makeInput = (overrides: Partial<AgentTurnInput> & { readonly actions: AgentTurnInput["actions"] }): AgentTurnInput => ({
  turnId: 1,
  text: "Turn on the lights in the living room.",
  utterance: "Hey Jev, turn on the lights in the living room.",
  source: "voice",
  spoken: true,
  routedBy: "trigger",
  history: [],
  system: "",
  context: undefined,
  tools: makeToolRegistry([]),
  deciders: new Map(),
  promoted: Effect.void,
  speculative: false,
  mark: () => {},
  trace: { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] },
  maxToolRounds: 5,
  ...overrides
})

const collect = (stream: Stream.Stream<AgentEvent, unknown>) => Stream.runCollect(stream).pipe(Effect.map((c) => Array.from(c)))
const spoken = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) => (e._tag === "TextDelta" && e.text !== "\n" ? [e.text] : [])).join("")
const tags = (events: ReadonlyArray<AgentEvent>) => events.map((e) => (e._tag === "TextDelta" ? (e.text === "\n" ? "flush" : "text") : e._tag))

describe("intent agent", () => {
  it.effect("act: decision, announcement, action run, in that order; one request with every parameter", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.04, "area:living_room": 0.96 }) }), { id: "keywords" })
      const agent = makeIntentAgent()
      const marks: Array<string> = []
      const events = yield* collect(agent.turn(makeInput({ actions: home.actions, deciders: new Map([["keywords", decider]]), mark: (m) => marks.push(m) })))
      assert.deepStrictEqual(tags(events), ["Decision", "text", "flush", "ActionStarted", "ActionFinished"])
      assert.strictEqual(spoken(events), "Living room lights on.")
      assert.deepStrictEqual(home.runs.map((r) => [r.action, r.params]), [["lights_on", { target: "area:living_room" }]])
      const decision = events[0]!._tag === "Decision" ? events[0]!.decision : undefined
      assert.strictEqual(decision?.outcome, "act")
      assert.strictEqual(decision?.decider, "keywords")
      assert.deepStrictEqual(decision?.action, { id: "home.lights_on", label: "Turn lights on", moduleId: "home" })
      assert.deepStrictEqual(decision?.params.map((p) => [p.name, p.value]), [["target", "Living room"]])
      assert.strictEqual(decider.requests.length, 1)
      assert.deepStrictEqual(Object.keys(decider.requests[0]!.questions), ["action", "fits", "compound", "home.lights_on/target"])
      assert.deepStrictEqual(marks, ["decisionSent", "decisionReceived", "actionStarted", "actionFinished"])
    }))

  it.effect("the announcement comes before promotion; the action waits for it", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.9, "area:living_room": 0.1 }) }))
      const promoted = yield* Deferred.make<void>()
      const seen: Array<AgentEvent> = []
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const fiber = yield* agent.turn(makeInput({
        actions: home.actions,
        deciders: new Map([["scripted", decider]]),
        promoted: Deferred.await(promoted),
        speculative: true
      })).pipe(Stream.runForEach((e) => Effect.sync(() => seen.push(e))), Effect.forkChild)
      yield* advance(100)
      assert.strictEqual(spoken(seen), "Kitchen lights on.")
      assert.deepStrictEqual(home.runs, [], "nothing switched before the turn is committed")
      yield* Deferred.succeed(promoted, undefined)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(home.runs.map((r) => [r.action, r.at]), [["lights_on", 100]])
    }))

  it.effect("a read-only action runs before promotion and its answer is spoken", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.time_now"))
      const promoted = yield* Deferred.make<void>()
      const seen: Array<AgentEvent> = []
      const fiber = yield* makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({
        text: "What time is it?",
        actions: home.actions,
        deciders: new Map([["scripted", decider]]),
        promoted: Deferred.await(promoted),
        speculative: true
      })).pipe(Stream.runForEach((e) => Effect.sync(() => seen.push(e))), Effect.forkChild)
      yield* advance(100)
      assert.deepStrictEqual(home.runs.map((r) => r.action), ["time_now"])
      assert.strictEqual(spoken(seen), "It's 14:32.")
      yield* Deferred.succeed(promoted, undefined)
      yield* Fiber.join(fiber)
    }))

  it.effect("a discarded speculative turn decides but never acts and stores nothing", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, "area:living_room": 0.5 }) }))
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const fiber = yield* agent.turn(makeInput({
        actions: home.actions,
        deciders: new Map([["scripted", decider]]),
        promoted: Effect.never,
        speculative: true
      })).pipe(Stream.runDrain, Effect.forkChild)
      yield* advance(100)
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(home.runs, [])
      assert.strictEqual(agent.pending(), undefined, "the question asked speculatively is not kept")
    }))

  it.effect("ask → answer: an unclear value is asked for, the agent expects a reply, and the reply completes the action", () =>
    Effect.gen(function*() {
      const home = makeHome()
      let turn = 0
      const decider = makeScriptedDecider((request) => {
        turn++
        if (turn === 1) return wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, "area:living_room": 0.5 }) })(request)
        assert.isDefined(request.questions["pending/answer"])
        assert.strictEqual(request.state.question_asked, "Which room or light?")
        return { answers: { ...wants("home.time_now", {}, 0.1)(request).answers, "pending/answers": noul(0.95), "pending/answer": choiceAnswer({ "area:kitchen": 0.95, "area:living_room": 0.05 }) } }
      })
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const deciders = new Map([["scripted", decider]])
      const first = yield* collect(agent.turn(makeInput({ text: "Lights on", actions: home.actions, deciders })))
      assert.deepStrictEqual(tags(first), ["Decision", "text", "flush", "ExpectReply"])
      assert.strictEqual(spoken(first), "Which room or light?")
      assert.strictEqual(agent.pending()?.awaiting.kind, "param")
      const second = yield* collect(agent.turn(makeInput({ text: "The kitchen", actions: home.actions, deciders, routedBy: "armed" })))
      assert.strictEqual(spoken(second), "Kitchen lights on.")
      assert.deepStrictEqual(home.runs.map((r) => r.params), [{ target: "area:kitchen" }])
      assert.strictEqual(agent.pending(), undefined)
    }))

  it.effect("a pending question expires after pendingMs", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, "area:living_room": 0.5 }) }))
      const agent = makeIntentAgent({ deciders: ["scripted"], pendingMs: 1_000 })
      const deciders = new Map([["scripted", decider]])
      yield* collect(agent.turn(makeInput({ text: "Lights on", actions: home.actions, deciders })))
      yield* advance(2_000)
      yield* collect(agent.turn(makeInput({ text: "Lights on", actions: home.actions, deciders })))
      assert.isUndefined(decider.requests[1]!.questions["pending/answers"])
    }))

  it.effect("confirm → yes acts; confirm → no cancels", () =>
    Effect.gen(function*() {
      const home = makeHome()
      let yes = 0.97
      const decider = makeScriptedDecider((request) =>
        request.questions["pending/yes"] === undefined
          ? wants("home.all_off")(request)
          : { answers: { ...wants("home.all_off", {}, 0.1)(request).answers, "pending/answers": noul(0.9), "pending/yes": noul(yes) } }
      )
      const deciders = new Map([["scripted", decider]])
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const asked = yield* collect(agent.turn(makeInput({ text: "Switch everything off", actions: home.actions, deciders })))
      assert.strictEqual(spoken(asked), "Switch everything off?")
      assert.isTrue(asked.some((e) => e._tag === "ExpectReply"))
      const done = yield* collect(agent.turn(makeInput({ text: "Yes please", actions: home.actions, deciders })))
      assert.deepStrictEqual(home.runs.map((r) => r.action), ["all_off"])
      assert.isTrue(done.some((e) => e._tag === "ActionFinished"))

      yield* collect(agent.turn(makeInput({ text: "Switch everything off", actions: home.actions, deciders })))
      yes = 0.05
      const cancelled = yield* collect(agent.turn(makeInput({ text: "No", actions: home.actions, deciders })))
      assert.strictEqual(spoken(cancelled), "OK, I won't.")
      assert.deepStrictEqual(home.runs.map((r) => r.action), ["all_off"], "not run again")
    }))

  it.effect("no match → Decision(fallback) and Handoff, nothing said; onNoMatch 'say' speaks instead", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", {}, 0.05))
      const deciders = new Map([["scripted", decider]])
      const passed = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ text: "What is a quark?", actions: home.actions, deciders })))
      assert.deepStrictEqual(tags(passed), ["Decision", "Handoff"])
      const decision = passed[0]!._tag === "Decision" ? passed[0]!.decision : undefined
      assert.deepStrictEqual([decision?.outcome, decision?.reason], ["fallback", "no_match"])
      const strict = yield* collect(makeIntentAgent({ deciders: ["scripted"], onNoMatch: "say" }).turn(makeInput({ text: "What is a quark?", actions: home.actions, deciders })))
      assert.strictEqual(spoken(strict), "I can't do that.")
    }))

  it.effect("no actions at all: Handoff at once, no request", () =>
    Effect.gen(function*() {
      const decider = makeScriptedDecider(wants("x"))
      const events = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ actions: [], deciders: new Map([["scripted", decider]]) })))
      assert.deepStrictEqual(tags(events), ["Handoff"])
      assert.strictEqual(decider.requests.length, 0)
    }))

  it.effect("decider timeout or error → Decision(error) and Handoff", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const slow = makeScriptedDecider(wants("home.time_now"), { latency: 5_000 })
      const fiber = yield* collect(makeIntentAgent({ deciders: ["scripted"], timeoutMs: 1_200 }).turn(makeInput({ actions: home.actions, deciders: new Map([["scripted", slow]]) }))).pipe(Effect.forkChild)
      yield* advance(1_300)
      const timedOut = yield* Fiber.join(fiber)
      assert.deepStrictEqual(tags(timedOut), ["Decision", "Handoff"])
      const decision = timedOut[0]!._tag === "Decision" ? timedOut[0]!.decision : undefined
      assert.strictEqual(decision?.outcome, "error")
      assert.match(decision?.reason ?? "", /did not answer within 1200 ms/)

      const failing = makeScriptedDecider(() => new DecisionError({ message: "TypeSafe answered 429", reason: "unavailable" }))
      const failed = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ actions: home.actions, deciders: new Map([["scripted", failing]]) })))
      assert.deepStrictEqual(tags(failed), ["Decision", "Handoff"])
      assert.deepStrictEqual(home.runs, [])
    }))

  it.effect("the preferred decider not running: the next one in the list answers, and the change is reported", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const keywords = makeScriptedDecider(wants("home.time_now"), { id: "keywords" })
      const changes: Array<string | undefined> = []
      const agent = makeIntentAgent({ onDeciderChange: (d) => changes.push(d?.id) })
      const events = yield* collect(agent.turn(makeInput({ actions: home.actions, deciders: new Map([["keywords", keywords]]) })))
      assert.strictEqual(spoken(events), "It's 14:32.")
      assert.deepStrictEqual(changes, ["keywords"])
    }))

  it.effect("an action that fails: the announcement, then the error", () =>
    Effect.gen(function*() {
      const home = makeHome({ failWith: "Home Assistant did not answer." })
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.9, "area:living_room": 0.1 }) }))
      const events = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ actions: home.actions, deciders: new Map([["scripted", decider]]) })))
      assert.strictEqual(spoken(events), "Kitchen lights on. Sorry, Home Assistant did not answer.")
      const finished = events.find((e) => e._tag === "ActionFinished")
      assert.deepStrictEqual(finished?._tag === "ActionFinished" ? [finished.ok, finished.error] : [], [false, "Home Assistant did not answer."])
    }))

  it.effect("speakBeforeDone off: the announcement only after the action succeeded", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.9, "area:living_room": 0.1 }) }))
      const events = yield* collect(makeIntentAgent({ deciders: ["scripted"], speakBeforeDone: false }).turn(makeInput({ actions: home.actions, deciders: new Map([["scripted", decider]]) })))
      assert.deepStrictEqual(tags(events), ["Decision", "ActionStarted", "ActionFinished", "text", "flush"])
    }))

  it.effect("an action that has started finishes even when the turn is interrupted", () =>
    Effect.gen(function*() {
      const home = makeHome({ runMillis: 200 })
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.9, "area:living_room": 0.1 }) }))
      const fiber = yield* makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ actions: home.actions, deciders: new Map([["scripted", decider]]) })).pipe(
        Stream.runDrain,
        Effect.forkChild
      )
      yield* advance(50)
      assert.strictEqual(home.runs.length, 1)
      yield* Fiber.interrupt(fiber)
      yield* advance(500)
      assert.deepStrictEqual(home.finished, ["lights_on"])
    }))
})
