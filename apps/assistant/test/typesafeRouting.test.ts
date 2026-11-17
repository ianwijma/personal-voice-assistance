// TypeSafe routing in the session dispatcher (docs/ASSISTANTS.md §3.6, WP-14): `makeTypesafeDecide` over a scripted
// routing service (its answers and their latency under the test clock), behind the real route gate and dispatcher.
import { assert, describe, it } from "@effect/vitest"
import { DecisionError, type DecisionRequest, type DecisionResponse, makeRouteGate, type RouteConfig, type SttEvent } from "@pva/core"
import { eagerEndOfTurn, endOfTurn, interim, speechStarted } from "@pva/core/testing"
import type { RouteCandidate } from "@pva/decide-typesafe"
import { Clock, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { makeTypesafeDecide, type RoutingService } from "../src/serve/routing.ts"
import { type DispatchTarget, makeSessionDispatcher } from "../src/serve/SessionDispatcher.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

interface Scripted {
  /** Time to answer, and the answer (or an error). */
  readonly ms: number
  readonly response?: DecisionResponse
  readonly error?: DecisionError
}

/** A routing service that answers from a script after the scripted latency (test clock). */
const scriptedRouting = (answer: (request: DecisionRequest) => Scripted, ready = true) => {
  const requests: Array<{ readonly request: DecisionRequest; readonly timeoutMs: number }> = []
  let interrupted = 0
  let answered = 0
  const service: RoutingService = {
    ready: () => ready,
    decide: (request, timeoutMs) =>
      Effect.suspend(() => {
        requests.push({ request, timeoutMs })
        const a = answer(request)
        return Effect.sleep(a.ms).pipe(
          Effect.andThen(Effect.sync(() => answered++)),
          Effect.andThen(a.error !== undefined ? Effect.fail(a.error) : Effect.succeed(a.response!)),
          Effect.onInterrupt(() => Effect.sync(() => void interrupted++))
        )
      })
  }
  return { service, requests, interrupted: () => interrupted, answered: () => answered }
}

/** What Jev would answer: `choice` with probability `p` (the rest on the others), and the Noul `fits`. */
const jev = (choice: string, p: number, fits: number, ids: ReadonlyArray<string> = ["alpha", "bravo"]): DecisionResponse => ({
  answers: {
    assistant: { type: "choice", choice, probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? p : (1 - p) / (ids.length - 1)])) },
    fits: { type: "noul", value: fits }
  }
})

const alpha: RouteCandidate = { id: "alpha", name: "Alpha", purpose: "Everything", handles: "Questions about the house, timers and the weather." }
const bravo: RouteCandidate = { id: "bravo", name: "Bravo", purpose: "Jokes", handles: "" }

const routeConfig = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  phrases: [{ phrase: "hey alpha", assistant: "alpha" }, { phrase: "hey bravo", assistant: "bravo" }],
  match: "exact",
  withoutPhrase: "decide",
  fallback: "alpha",
  off: new Set(),
  followUpMs: { alpha: 8_000, bravo: 8_000 },
  ...over
})

const show = (input: { readonly _tag: string; readonly text?: string }) => (input.text !== undefined ? `${input._tag}(${input.text})` : input._tag)

/** Route gate → dispatcher (with TypeSafe's decide) → recorder conversations; times from the test clock. */
const setup = (options: {
  readonly routing: RoutingService | undefined
  readonly candidates?: ReadonlyArray<RouteCandidate>
  readonly giveUpMs?: number
  readonly config?: Partial<RouteConfig>
}) =>
  Effect.gen(function*() {
    const clock = yield* Clock.Clock
    const now = () => clock.currentTimeMillisUnsafe()
    const log: Array<string> = []
    const made: Array<string> = []
    const dispatcher = makeSessionDispatcher<DispatchTarget>({
      make: (assistant) =>
        Effect.sync(() => {
          made.push(assistant)
          return {
            push: (input) => void log.push(`${now()} ${assistant} ${show(input as { _tag: string; text?: string })}`),
            send: (input) => {
              log.push(`${now()} ${assistant} send ${show(input as { _tag: string; text?: string })}`)
              return "accepted" as const
            }
          }
        }),
      decide: makeTypesafeDecide({
        routing: () => options.routing,
        candidates: () => options.candidates ?? [alpha, bravo],
        giveUpMs: () => options.giveUpMs ?? 400,
        now
      })
    })
    const gate = makeRouteGate(routeConfig(options.config))
    /** Feeds the events in a fiber (a decision holds it), advancing `ms` of test time, then waits for the rest. */
    const feed = (events: ReadonlyArray<SttEvent>, ms = 2_000) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.forEach(events, (e) => dispatcher.dispatch(gate.filter(e, now())), { discard: true }))
        for (let t = 0; t < ms; t += 50) yield* advance(50)
        yield* Fiber.join(fiber)
      })
    return { dispatcher, gate, log, made, feed, now }
  })

describe("TypeSafe routing (scripted decider)", () => {
  it.effect("chosen: the eager event is held until the answer, the speculative turn goes to the choice, the final reuses it", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 150, response: jev("bravo", 0.9, 0.95) }))
      const s = yield* setup({ routing: r.service })
      const started = s.now()
      const fiber = yield* Effect.forkChild(
        Effect.forEach([speechStarted, interim("tell me"), eagerEndOfTurn("tell me a joke")], (e) => s.dispatcher.dispatch(s.gate.filter(e, s.now())), { discard: true })
      )
      yield* advance(100)
      assert.deepStrictEqual(s.log, [], "nothing reaches a conversation before TypeSafe has answered")
      yield* advance(100)
      yield* Fiber.join(fiber)
      yield* s.feed([endOfTurn("tell me a joke.")], 0)
      assert.deepStrictEqual(s.log, [
        `${started + 150} bravo SpeechStarted`,
        `${started + 150} bravo EagerEndOfTurn(tell me a joke)`,
        `${started + 200} bravo EndOfTurn(tell me a joke.)`
      ])
      assert.strictEqual(r.requests.length, 1, "the final is the same utterance: no second request")
      assert.deepStrictEqual(s.dispatcher.routeOf("bravo"), {
        by: "decide",
        assistant: "bravo",
        fallback: false,
        decision: { outcome: "chosen", probability: 0.9, fits: 0.95, ms: 150, sentAt: started, receivedAt: started + 150 }
      })
      // The request: the sentence, and each candidate's Handles (name and purpose when it has none), in list order.
      const { request, timeoutMs } = r.requests[0]!
      assert.strictEqual(timeoutMs, 400)
      assert.deepStrictEqual(request.state, {
        utterance: "tell me a joke",
        available_actions: { alpha: "Questions about the house, timers and the weather.", bravo: "Bravo: Jokes" }
      })
      assert.deepStrictEqual(Object.keys(request.questions), ["assistant", "fits"])
      assert.deepStrictEqual(Object.keys((request.questions.assistant as { options: object }).options), ["alpha", "bravo"])
    }))

  it.effect("none fits (low Noul, or a weak choice): the fallback answers", () =>
    Effect.gen(function*() {
      let fits = 0.2
      let p = 0.9
      const r = scriptedRouting(() => ({ ms: 100, response: jev("bravo", p, fits) }))
      const s = yield* setup({ routing: r.service })
      yield* s.feed([speechStarted, endOfTurn("what is the capital of peru")])
      assert.deepStrictEqual(s.log.map((l) => l.split(" ").slice(1).join(" ")), ["alpha SpeechStarted", "alpha EndOfTurn(what is the capital of peru)"])
      assert.deepInclude(s.dispatcher.routeOf("alpha"), { by: "decide", assistant: "alpha", fallback: true })
      assert.deepInclude((s.dispatcher.routeOf("alpha") as { decision: object }).decision, { outcome: "none-fits", probability: 0.9, fits: 0.2, ms: 100 })
      // Fits, but the choice itself is not sure enough.
      fits = 0.9
      p = 0.45
      yield* s.feed([speechStarted, endOfTurn("hmm")])
      assert.deepInclude((s.dispatcher.routeOf("alpha") as { decision: object }).decision, { outcome: "none-fits", probability: 0.45, fits: 0.9 })
      assert.deepStrictEqual(s.made, ["alpha"])
    }))

  it.effect("timeout: the fallback answers at the give-up time, the call is interrupted and a late answer is never used", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 1_000, response: jev("bravo", 0.99, 0.99) }))
      const s = yield* setup({ routing: r.service, giveUpMs: 300 })
      const started = s.now()
      yield* s.feed([speechStarted, eagerEndOfTurn("tell me a joke")], 400)
      assert.deepStrictEqual(s.log, [`${started + 300} alpha SpeechStarted`, `${started + 300} alpha EagerEndOfTurn(tell me a joke)`])
      yield* s.feed([endOfTurn("tell me a joke")], 1_500)
      assert.strictEqual(r.requests.length, 1, "the final reuses the timed-out decision")
      assert.strictEqual(r.interrupted(), 1)
      assert.strictEqual(r.answered(), 0, "the late answer never arrived")
      assert.deepStrictEqual(s.log.slice(2).map((l) => l.split(" ").slice(1).join(" ")), ["alpha EndOfTurn(tell me a joke)"])
      assert.deepStrictEqual(s.made, ["alpha"], "bravo was never given anything")
      assert.deepStrictEqual((s.dispatcher.routeOf("alpha") as { decision: object }).decision, { outcome: "timeout", ms: 300, sentAt: started })
    }))

  it.effect("error (key rejected, network): the fallback answers at once", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 40, error: new DecisionError({ reason: "unavailable", message: "TypeSafe rejected the API key (401)" }) }))
      const s = yield* setup({ routing: r.service })
      const started = s.now()
      yield* s.feed([speechStarted, endOfTurn("tell me a joke")])
      assert.deepStrictEqual(s.log, [`${started + 40} alpha SpeechStarted`, `${started + 40} alpha EndOfTurn(tell me a joke)`])
      assert.deepStrictEqual((s.dispatcher.routeOf("alpha") as { decision: object }).decision, { outcome: "error", ms: 40, sentAt: started, receivedAt: started + 40 })
    }))

  it.effect("text changed between eager and final: asked again with a fresh give-up time, and the utterance follows the new answer", () =>
    Effect.gen(function*() {
      const r = scriptedRouting((req) =>
        req.state.utterance.includes("joke") ? { ms: 120, response: jev("bravo", 0.9, 0.9) } : { ms: 80, response: jev("alpha", 0.8, 0.9) }
      )
      const s = yield* setup({ routing: r.service })
      yield* s.feed([speechStarted, eagerEndOfTurn("set a timer"), endOfTurn("set a timer and tell me a joke")])
      assert.deepStrictEqual(r.requests.map((x) => [x.request.state.utterance, x.timeoutMs]), [["set a timer", 400], ["set a timer and tell me a joke", 400]])
      assert.deepStrictEqual(s.log.map((l) => l.split(" ").slice(1).join(" ")), [
        "alpha SpeechStarted",
        "alpha EagerEndOfTurn(set a timer)",
        "alpha EndOfTurn()",
        "bravo SpeechStarted",
        "bravo EndOfTurn(set a timer and tell me a joke)"
      ])
      assert.deepInclude((s.dispatcher.routeOf("bravo") as { decision: object }).decision, { outcome: "chosen", ms: 120 })
    }))

  it.effect("a phrase and a follow-up sentence never ask TypeSafe and are not delayed", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 300, response: jev("alpha", 0.9, 0.9) }))
      const s = yield* setup({ routing: r.service })
      const t0 = s.now()
      yield* s.feed([speechStarted, eagerEndOfTurn("hey bravo tell me a joke"), endOfTurn("hey bravo tell me a joke")], 0)
      assert.deepStrictEqual(s.log, [`${t0} bravo SpeechStarted`, `${t0} bravo EagerEndOfTurn(tell me a joke)`, `${t0} bravo EndOfTurn(tell me a joke)`])
      // Bravo's reply ended: its follow-up window is open, the next sentence stays with it.
      s.gate.replyStarted("bravo", s.now())
      s.gate.replyEnded("bravo", s.now())
      yield* s.feed([speechStarted, eagerEndOfTurn("another one"), endOfTurn("another one")], 0)
      assert.deepStrictEqual(s.log.slice(3), [`${t0} bravo SpeechStarted`, `${t0} bravo EagerEndOfTurn(another one)`, `${t0} bravo EndOfTurn(another one)`])
      assert.strictEqual(r.requests.length, 0)
    }))

  it.effect("fallback nobody: none fits drops the utterance, and no conversation is made", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 100, response: jev("bravo", 0.9, 0.1) }))
      const s = yield* setup({ routing: r.service, config: { fallback: null } })
      yield* s.feed([speechStarted, eagerEndOfTurn("what is the capital of peru"), endOfTurn("what is the capital of peru")])
      assert.deepStrictEqual(s.log, [])
      assert.deepStrictEqual(s.made, [])
      assert.strictEqual(r.requests.length, 1)
    }))

  it.effect("routing not set up (switched off or no key): nobody answers without a phrase, and nothing is sent", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 10, response: jev("bravo", 0.9, 0.9) }), false)
      for (const routing of [r.service, undefined]) {
        const s = yield* setup({ routing })
        yield* s.feed([speechStarted, endOfTurn("tell me a joke")])
        assert.deepStrictEqual(s.log, [])
      }
      assert.strictEqual(r.requests.length, 0)
    }))

  it.effect("one switched-on assistant: only the Noul is asked, and it alone decides", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 50, response: { answers: { fits: { type: "noul", value: 0.8 } } } }))
      const s = yield* setup({ routing: r.service, candidates: [bravo], config: { fallback: null } })
      yield* s.feed([speechStarted, endOfTurn("tell me a joke")])
      assert.deepStrictEqual(Object.keys(r.requests[0]!.request.questions), ["fits"])
      assert.deepStrictEqual(s.log.map((l) => l.split(" ").slice(1).join(" ")), ["bravo SpeechStarted", "bravo EndOfTurn(tell me a joke)"])
      assert.deepInclude((s.dispatcher.routeOf("bravo") as { decision: object }).decision, { outcome: "chosen", fits: 0.8 })
    }))

  it.effect("typed text is never routed by TypeSafe", () =>
    Effect.gen(function*() {
      const r = scriptedRouting(() => ({ ms: 50, response: jev("bravo", 0.9, 0.9) }))
      const s = yield* setup({ routing: r.service })
      yield* s.dispatcher.send("alpha", { _tag: "TextInput", text: "tell me a joke", speak: true })
      assert.strictEqual(r.requests.length, 0)
      assert.deepStrictEqual(s.dispatcher.routeOf("alpha"), { by: "typed", assistant: "alpha" })
    }))
})
