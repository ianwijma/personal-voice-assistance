// Piece C: the intent agent driven directly (docs/AGENTS-AND-INTENTS.md §3.4, §3.6).
import { assert, describe, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ActionError, defineAction, Param, registerActions } from "../src/Actions.ts"
import type { AgentEvent, AgentTurnInput } from "../src/Agent.ts"
import { choiceAnswer, confirmationQuestion, confirmQuestion, type DecisionAnswer, DecisionError, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { confirmationAnswer, makePendingIntents } from "../src/PendingIntents.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { extendIntentWords } from "../src/IntentWords.ts"
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
  conversationId: "c1",
  // Most scripted answers below pick the kitchen; core acts only on what was said (review round 3).
  text: "Turn on the kitchen lights.",
  utterance: "Hey Jev, turn on the kitchen lights.",
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
  it.live("without `input.now` the action's time-line entry is on the monotonic clock, as the trace's other times", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.96, "area:living_room": 0.04 }) }), { id: "keywords" })
      const trace: AgentTurnInput["trace"] = { id: 1, mode: "voice", speculative: false, startedAt: performance.now(), marks: {}, tools: [], voices: [] }
      const before = performance.now()
      yield* collect(makeIntentAgent().turn(makeInput({ actions: home.actions, deciders: new Map([["keywords", decider]]), trace })))
      const after = performance.now()
      const action = trace.events?.find((e) => e.name === "action")
      assert.isDefined(action)
      assert.isAtLeast(action!.at, before)
      assert.isAtMost(action!.at + action!.ms!, after)
    }))

  it.effect("act: decision, announcement, action run, in that order; one request with every parameter", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.04, "area:living_room": 0.96 }) }), { id: "keywords" })
      const agent = makeIntentAgent()
      const marks: Array<string> = []
      const events = yield* collect(agent.turn(makeInput({ text: "Turn on the lights in the living room.", actions: home.actions, deciders: new Map([["keywords", decider]]), mark: (m) => marks.push(m) })))
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

  it.effect("confirm: the agent proposes the action to core and stops; it asks nothing and never confirms anything itself (round 6)", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider((request) =>
        request.questions["pending/yes"] === undefined
          ? wants("home.all_off")(request)
          : { answers: { ...wants("home.all_off", {}, 0.1)(request).answers, "pending/answers": noul(0.9), "pending/yes": noul(0.97) } }
      )
      const deciders = new Map([["scripted", decider]])
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const asked = yield* collect(agent.turn(makeInput({ text: "Switch everything off", actions: home.actions, deciders })))
      assert.deepStrictEqual(tags(asked), ["Decision", "ConfirmAction"])
      assert.strictEqual(spoken(asked), "", "core speaks the question, not the agent")
      const proposal = asked[1]!
      assert.strictEqual(proposal._tag === "ConfirmAction" ? proposal.action : undefined, home.actions[2])
      assert.strictEqual(agent.pending(), undefined, "nothing pending in the agent")
      // A "yes" that reaches the agent is a fresh request: it is never a confirmation, so the action is proposed again, never run.
      const again = yield* collect(agent.turn(makeInput({ text: "Yes please", actions: home.actions, deciders })))
      assert.deepStrictEqual(home.runs, [])
      assert.isUndefined(decider.requests[1]!.questions["pending/yes"])
      assert.isFalse(again.some((e) => e._tag === "ActionStarted"))
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

describe("intent agent: review findings", () => {
  const confirmThenYes = (request: DecisionRequest) =>
    request.questions["pending/yes"] === undefined
      ? wants("home.all_off")(request)
      : { answers: { ...wants("home.all_off", {}, 0.1)(request).answers, "pending/answers": noul(0.9), "pending/yes": noul(0.97) } }

  it.effect("round 6: a confirmation in the shared slot is core's; the agent never answers it", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const decider = makeScriptedDecider(confirmThenYes)
      const deciders = new Map([["scripted", decider]])
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const pendingIntents = makePendingIntents()
      const intent = { action: home.actions[2]!, params: {}, missing: [], awaiting: { kind: "confirm" as const, question: "Switch everything off?" }, probability: 1 }
      pendingIntents.set({ intent, at: 0, armedAt: 0, until: 60_000, turnId: 0 })
      const events = yield* collect(agent.turn(makeInput({ turnId: 2, text: "Yes", actions: home.actions, deciders, pendingIntents })))
      assert.deepStrictEqual(home.runs, [])
      assert.isFalse(events.some((e) => e._tag === "ActionStarted"))
      assert.isUndefined(decider.requests[0]!.questions["pending/yes"], "decided as a fresh request")
    }))

  it.effect("finding 3: a pending confirmation is not transferred to a replaced module instance", () =>
    Effect.gen(function*() {
      const old = makeHome()
      const replaced = makeHome()
      const decider = makeScriptedDecider(confirmThenYes)
      const deciders = new Map([["scripted", decider]])
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      yield* collect(agent.turn(makeInput({ text: "Switch everything off", actions: old.actions, deciders })))
      const events = yield* collect(agent.turn(makeInput({ text: "Yes", actions: replaced.actions, deciders })))
      assert.deepStrictEqual(old.runs, [], "the old instance's action did not run")
      assert.deepStrictEqual(replaced.runs, [], "nor did the new instance's, on a yes given to the old one")
      assert.isFalse(events.some((e) => e._tag === "ActionStarted"))
      assert.isUndefined(decider.requests[1]!.questions["pending/yes"], "the reply was decided as a new request")
    }))

  it.effect("finding 3: a pending question whose chosen dynamic value has disappeared is dropped", () =>
    Effect.gen(function*() {
      const rooms = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:hall", label: "Hall" }]
      const runs: Array<unknown> = []
      const actions = registerActions("home", [
        defineAction({
          id: "dim",
          label: "Dim",
          description: "Set the brightness of a room.",
          params: { target: Param.dynamic({ label: "Room", options: () => rooms }), level: Param.number({ label: "Level", min: 0, max: 100 }) },
          run: (p) => Effect.sync(() => void runs.push(p))
        })
      ])
      let turn = 0
      const decider = makeScriptedDecider((request) => {
        turn++
        if (turn === 1) return wants("home.dim", { "home.dim/target": choiceAnswer({ "area:kitchen": 0.95, "area:hall": 0.05 }) })(request)
        return { answers: { ...wants("home.dim", {}, 0.1)(request).answers, "pending/answers": noul(0.95) } }
      })
      const deciders = new Map([["scripted", decider]])
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      const asked = yield* collect(agent.turn(makeInput({ text: "Dim the kitchen", actions, deciders })))
      assert.strictEqual(spoken(asked), "What level?")
      rooms.splice(0, 1) // the kitchen light was removed from the house
      yield* collect(agent.turn(makeInput({ text: "40", actions, deciders })))
      assert.deepStrictEqual(runs, [])
    }))

  it.effect("finding 8: a discarded speculative fallback leaves the committed pending question in place", () =>
    Effect.gen(function*() {
      const home = makeHome()
      let mode: "ask" | "fallback" | "error" = "ask"
      const decider = makeScriptedDecider((request) =>
        mode === "ask" ? wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, "area:living_room": 0.5 }) })(request)
        : mode === "error" ? new DecisionError({ message: "down", reason: "unavailable" })
        : { answers: { ...wants("home.lights_on", {}, 0.05)(request).answers, "pending/answers": noul(0.05) } }
      )
      const deciders = new Map([["scripted", decider]])
      const agent = makeIntentAgent({ deciders: ["scripted"] })
      yield* collect(agent.turn(makeInput({ text: "Lights on", actions: home.actions, deciders })))
      const committed = agent.pending()
      assert.isDefined(committed)
      for (const m of ["fallback", "error"] as const) {
        mode = m
        const events = yield* collect(agent.turn(makeInput({ text: "What is a", actions: home.actions, deciders, promoted: Effect.never, speculative: true })))
        assert.strictEqual(events.at(-1)?._tag, "Handoff", "the fallback is not delayed")
        yield* advance(100)
        assert.strictEqual(agent.pending(), committed, `${m}: the discarded turn left no trace`)
      }
      // Promoted: the pending question is dropped (it is not asked twice).
      mode = "fallback"
      const promoted = yield* Deferred.make<void>()
      yield* collect(agent.turn(makeInput({ text: "What is a quark", actions: home.actions, deciders, promoted: Deferred.await(promoted), speculative: true })))
      assert.strictEqual(agent.pending(), committed)
      yield* Deferred.succeed(promoted, undefined)
      yield* advance(10)
      assert.strictEqual(agent.pending(), undefined)
    }))

  it.effect("finding 11: an action whose run throws while building its effect fails the action, not the turn", () =>
    Effect.gen(function*() {
      const actions = registerActions("home", [
        defineAction({ id: "boom", label: "Boom", description: "Explodes.", params: {}, run: () => { throw new Error("kaboom") } })
      ])
      const decider = makeScriptedDecider(wants("home.boom"))
      const events = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ text: "Boom", actions, deciders: new Map([["scripted", decider]]) })))
      const finished = events.find((e) => e._tag === "ActionFinished")
      assert.strictEqual(finished?._tag === "ActionFinished" ? finished.ok : undefined, false)
      assert.match(spoken(events), /^Sorry/)
    }))

  it.effect("finding 11, same mistake: a decider, an announcement or a confirm question that throws does not end the turn", () =>
    Effect.gen(function*() {
      const runs: Array<string> = []
      const actions = registerActions("home", [
        defineAction({
          id: "on",
          label: "On",
          description: "On.",
          params: {},
          announce: () => {
            throw new Error("bad text")
          },
          run: () => Effect.sync(() => void runs.push("on"))
        }),
        defineAction({
          id: "off",
          label: "Everything off",
          description: "Off.",
          params: {},
          confirm: () => {
            throw new Error("bad question")
          },
          run: () => Effect.void
        })
      ])
      const throwing = { id: "scripted", name: "Throws", location: "local" as const, decide: () => { throw new Error("sync") } }
      const handed = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ actions, deciders: new Map([["scripted", throwing]]) })))
      assert.deepStrictEqual(tags(handed), ["Decision", "Handoff"])
      const on = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ text: "On", actions, deciders: new Map([["scripted", makeScriptedDecider(wants("home.on"))]]) })))
      assert.deepStrictEqual(runs, ["on"])
      assert.isTrue(on.some((e) => e._tag === "ActionFinished"))
      const off = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ text: "Everything off", actions, deciders: new Map([["scripted", makeScriptedDecider(wants("home.off"))]]) })))
      assert.deepStrictEqual(tags(off), ["Decision", "ConfirmAction"])
      // Core asks its own question; a module's question text is never called (after the final review), so one that throws changes nothing.
      assert.strictEqual(confirmQuestion(actions[1]!, {}), "Everything off?")
      assert.deepStrictEqual(confirmationQuestion(actions[1]!, {}), { question: "Everything off?" })
    }))
})

describe("intent agent: review round 2", () => {
  it.effect("H: a module whose option list throws does not stop an unrelated request; with nothing left, a plain hand-off", () =>
    Effect.gen(function*() {
      const home = makeHome()
      const broken = registerActions("music", [defineAction({
        id: "play",
        label: "Play music",
        description: "Play music on a speaker.",
        params: { speaker: Param.dynamic({ label: "Speaker", options: () => { throw new Error("speaker list down") } }) },
        run: () => Effect.void
      })])
      const decider = makeScriptedDecider(wants("home.lights_on", { "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.95, "area:living_room": 0.05 }) }))
      const deciders = new Map([["scripted", decider]])
      const events = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ text: "Turn on the kitchen lights", actions: [...broken, ...home.actions], deciders })))
      assert.strictEqual(spoken(events), "Kitchen lights on.")
      assert.deepStrictEqual(home.runs.map((r) => r.params), [{ target: "area:kitchen" }])
      assert.notInclude(Object.keys((decider.requests[0]!.questions.action as { options: Record<string, unknown> }).options), "music.play")

      const only = yield* collect(makeIntentAgent({ deciders: ["scripted"] }).turn(makeInput({ text: "Play some music", actions: broken, deciders })))
      assert.deepStrictEqual(tags(only), ["Decision", "Handoff"])
      assert.strictEqual(decider.requests.length, 1, "no request without an action to offer")
    }))

  it.effect("the safeguard's words can be extended: a household's own yes confirms (core's grammar, round 6)", () =>
    Effect.sync(() => {
      assert.strictEqual(confirmationAnswer("Aye"), "other")
      assert.strictEqual(confirmationAnswer("Aye", extendIntentWords({ yes: ["aye"] })), "yes")
    }))
})
