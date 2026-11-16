// The routing service and `makeTypesafeDecide`'s edges (docs/ASSISTANTS.md §3.6, WP-14) that typesafeRouting.test.ts
// and serveTypesafe.test.ts do not reach: when routing counts as set up (off by default), settings read live, and the
// fallback when nobody is a candidate, the service defects, ignores its time limit or returns nothing usable.
import { assert, describe, it } from "@effect/vitest"
import { DecisionError, type DecisionRequest, type DecisionResponse } from "@pva/core"
import type { RouteCandidate } from "@pva/decide-typesafe"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  makeRoutingService,
  makeTypesafeDecide,
  ROUTING_KEYS,
  type RoutingService,
  type RoutingSettings,
  routingReady,
  typesafeNow
} from "../src/serve/routing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const on: RoutingSettings = { enabled: true, apiKey: "ts-key", model: undefined, baseUrl: undefined }

describe("routingReady (off by default)", () => {
  it("needs the switch on, a non-blank key and an acceptable address", () => {
    assert.isTrue(routingReady(on))
    assert.isTrue(routingReady({ ...on, apiKey: "  key  ", baseUrl: "https://jev.example.test" }))
    // Switched off, whatever else is set.
    assert.isFalse(routingReady({ ...on, enabled: false }))
    // No key, an empty key, a blank key.
    assert.isFalse(routingReady({ ...on, apiKey: undefined }))
    assert.isFalse(routingReady({ ...on, apiKey: "" }))
    assert.isFalse(routingReady({ ...on, apiKey: "   " }))
    // An address that fails the adapter's check (not http(s)); a blank one means the default address.
    assert.isFalse(routingReady({ ...on, baseUrl: "ftp://jev.example.test" }))
    assert.isFalse(routingReady({ ...on, baseUrl: "not an address" }))
    assert.isTrue(routingReady({ ...on, baseUrl: "   " }))
  })

  it("the settings keys are the routing section's", () => {
    assert.deepStrictEqual(ROUTING_KEYS, {
      enabled: "TYPESAFE_ROUTING",
      apiKey: "TYPESAFE_API_KEY",
      model: "TYPESAFE_MODEL",
      baseUrl: "TYPESAFE_BASE_URL"
    })
  })
})

const request: DecisionRequest = {
  state: { utterance: "hello", available_actions: { a: "x", b: "y" } },
  questions: { fits: { type: "noul", instructions: "fits?", role: { kind: "fits" } } }
}

const okBody = JSON.stringify({ model: "m", answers: { fits: { type: "noul", noul: 0.9 } } })
const jsonResponse = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } })

/** A fetch that records each call and answers like Jev would, so the real client runs. */
const recordingFetch = () => {
  const calls: Array<{ readonly url: string; readonly authorization: string | null; readonly body: any }> = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) })
    return Promise.resolve(jsonResponse(200, okBody))
  }
  return { calls, fetch }
}

describe("makeRoutingService", () => {
  it.effect("decide when routing is not set up fails as unavailable and sends nothing", () =>
    Effect.gen(function*() {
      const { calls, fetch } = recordingFetch()
      for (const settings of [{ ...on, enabled: false }, { ...on, apiKey: undefined }]) {
        const service = makeRoutingService(() => settings, { fetch })
        assert.isFalse(service.ready())
        const result = yield* Effect.result(service.decide(request, 500))
        assert.strictEqual(result._tag, "Failure")
        if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "unavailable")
      }
      assert.strictEqual(calls.length, 0)
    }))

  it.effect("reads the settings at each call: key, model and address follow a change, the defaults fill blanks", () =>
    Effect.gen(function*() {
      const { calls, fetch } = recordingFetch()
      let settings: RoutingSettings = { enabled: true, apiKey: "  first-key ", model: "  ", baseUrl: undefined }
      const service = makeRoutingService(() => settings, { fetch })
      yield* service.decide(request, 500)
      yield* service.decide(request, 500)
      settings = { enabled: true, apiKey: "second-key", model: "jev-pinned", baseUrl: "https://jev.example.test" }
      yield* service.decide(request, 500)
      assert.deepStrictEqual(calls.map((c) => c.authorization), ["Bearer first-key", "Bearer first-key", "Bearer second-key"])
      assert.isTrue(calls[0]!.url.endsWith("/v1/systemone"))
      assert.isTrue(calls[2]!.url.startsWith("https://jev.example.test/"))
      assert.isString(calls[0]!.body.model)
      assert.isAbove(calls[0]!.body.model.length, 0, "a blank model falls back to the default")
      assert.strictEqual(calls[2]!.body.model, "jev-pinned")
    }))

  it.effect("switching routing off takes effect on the next decision", () =>
    Effect.gen(function*() {
      const { calls, fetch } = recordingFetch()
      let settings: RoutingSettings = on
      const service = makeRoutingService(() => settings, { fetch })
      assert.isTrue(service.ready())
      yield* service.decide(request, 500)
      settings = { ...on, enabled: false }
      assert.isFalse(service.ready())
      const result = yield* Effect.result(service.decide(request, 500))
      assert.strictEqual(result._tag, "Failure")
      assert.strictEqual(calls.length, 1)
    }))

  it.effect("a key the service rejected is not sent again, but a changed key is", () =>
    Effect.gen(function*() {
      let status = 401
      const keys: Array<string | null> = []
      const fetch: typeof globalThis.fetch = (_input, init) => {
        keys.push(new Headers(init?.headers).get("authorization"))
        return Promise.resolve(status === 200 ? jsonResponse(200, okBody) : jsonResponse(status, JSON.stringify({ detail: "bad key" })))
      }
      let key = "bad-key"
      const service = makeRoutingService(() => ({ ...on, apiKey: key }), { fetch })
      assert.strictEqual((yield* Effect.result(service.decide(request, 500)))._tag, "Failure")
      assert.strictEqual((yield* Effect.result(service.decide(request, 500)))._tag, "Failure")
      assert.strictEqual(keys.length, 1, "the same rejected key is remembered, not sent again")
      key = "good-key"
      status = 200
      assert.strictEqual((yield* Effect.result(service.decide(request, 500)))._tag, "Success")
      assert.deepStrictEqual(keys, ["Bearer bad-key", "Bearer good-key"])
    }))
})

const alpha: RouteCandidate = { id: "alpha", name: "Alpha", purpose: "Everything", handles: "House things." }
const bravo: RouteCandidate = { id: "bravo", name: "Bravo", purpose: "Jokes", handles: "Jokes." }

const noulOnly = (value: number): DecisionResponse => ({ answers: { fits: { type: "noul", value } } })

/** `makeTypesafeDecide` over a service `decide`; the trace clock is fixed at 0 so `ms` comes out 0. */
const decideWith = (
  decide: RoutingService["decide"],
  over: { readonly candidates?: ReadonlyArray<RouteCandidate>; readonly giveUpMs?: number; readonly log?: (line: string) => void } = {}
) => {
  const sent: Array<number> = []
  const routing: RoutingService = {
    ready: () => true,
    decide: (req, ms) => {
      sent.push(ms)
      return decide(req, ms)
    }
  }
  const run = makeTypesafeDecide({
    routing: () => routing,
    candidates: () => over.candidates ?? [alpha, bravo],
    giveUpMs: () => over.giveUpMs ?? 300,
    now: () => 0,
    ...(over.log !== undefined ? { log: over.log } : {})
  })
  return { run, sent }
}

const ask = { text: "tell me a joke", fallback: "alpha", final: true } as const

describe("makeTypesafeDecide: the fallback", () => {
  it.effect("routing not set up: nobody, marked so the dispatcher does not swap in the fallback", () =>
    Effect.gen(function*() {
      const run = makeTypesafeDecide({ routing: () => undefined, candidates: () => [alpha, bravo], giveUpMs: () => 300, now: () => 0 })
      assert.deepStrictEqual(yield* run(ask), { assistant: null, fallback: true, notSetUp: true })
    }))

  it("typesafeNow: the candidates and fallback only while the device routes by TypeSafe", () => {
    const on = new Map([["alpha", { on: true }], ["bravo", { on: true }]])
    const assistants = [{ assistant: "alpha", phrases: [] }, { assistant: "bravo", phrases: [] }]
    assert.deepStrictEqual(typesafeNow({ assistants, withoutPhrase: { mode: "typesafe", fallback: "alpha", giveUpMs: 400 } }, on), {
      candidates: ["alpha", "bravo"],
      fallback: "alpha"
    })
    assert.deepStrictEqual(typesafeNow({ assistants, withoutPhrase: { mode: "typesafe", fallback: null, giveUpMs: 400 } }, on), {
      candidates: ["alpha", "bravo"],
      fallback: null
    })
    assert.deepStrictEqual(typesafeNow({ assistants, withoutPhrase: { mode: "nobody" } }, on), { candidates: [], fallback: null })
    assert.deepStrictEqual(typesafeNow({ assistants, withoutPhrase: { mode: "assistant", assistant: "alpha" } }, on), { candidates: [], fallback: null })
  })

  it.effect("nobody switched on: the fallback answers at once, with no request and no decision", () =>
    Effect.gen(function*() {
      const { run, sent } = decideWith(() => Effect.succeed(noulOnly(1)), { candidates: [] })
      assert.deepStrictEqual(yield* run(ask), { assistant: "alpha", fallback: true })
      assert.deepStrictEqual(yield* run({ ...ask, fallback: null }), { assistant: null, fallback: true })
      assert.strictEqual(sent.length, 0)
    }))

  it.effect("a defect in the service is an error decision, never a failure or a crash", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const { run } = decideWith(() => Effect.die(new Error("boom")), { log: (l) => lines.push(l) })
      const result = yield* run(ask)
      assert.strictEqual(result.assistant, "alpha")
      assert.isTrue(result.fallback)
      assert.deepInclude(result.decision, { outcome: "error" })
      assert.strictEqual(lines.length, 1)
      assert.include(lines[0]!, "boom")
    }))

  it.effect("a service that ignores its time limit is cut off at the give-up time (timeout, not logged)", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      let finished = false
      let done = false
      const { run, sent } = decideWith(
        () => Effect.sleep(10_000).pipe(Effect.andThen(Effect.sync(() => (finished = true))), Effect.as(noulOnly(1))),
        { giveUpMs: 250, log: (l) => lines.push(l) }
      )
      const fiber = yield* Effect.forkChild(Effect.tap(run(ask), () => Effect.sync(() => (done = true))))
      yield* advance(249)
      assert.isFalse(done, "still waiting just before the give-up time")
      yield* advance(1)
      const result = yield* Fiber.join(fiber)
      assert.isTrue(done)
      assert.strictEqual(result.assistant, "alpha")
      assert.isTrue(result.fallback)
      assert.deepStrictEqual(result.decision, { outcome: "timeout", ms: 0, sentAt: 0 })
      assert.deepStrictEqual(sent, [250], "the service is told the same limit")
      assert.isFalse(finished)
      assert.deepStrictEqual(lines, [], "a timeout is expected, not logged")
    }))

  it.effect("an answer with nothing usable (no answers at all) is none fits: the fallback, not a failure", () =>
    Effect.gen(function*() {
      const { run } = decideWith(() => Effect.succeed({ answers: {} }))
      const result = yield* run(ask)
      assert.strictEqual(result.assistant, "alpha")
      assert.isTrue(result.fallback)
      assert.deepInclude(result.decision, { outcome: "none-fits", fits: 0 })
    }))

  it.effect("one candidate that fits is chosen even when it is not the fallback", () =>
    Effect.gen(function*() {
      const { run } = decideWith(() => Effect.succeed(noulOnly(0.5)), { candidates: [bravo] })
      const result = yield* run(ask)
      assert.strictEqual(result.assistant, "bravo")
      assert.isFalse(result.fallback)
      assert.deepInclude(result.decision, { outcome: "chosen", fits: 0.5 })
    }))
})

describe("makeTypesafeDecide: logging failures", () => {
  it.effect("logs a failure once per distinct message in a row, and again after a success", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const failing = (message: string): Effect.Effect<DecisionResponse, DecisionError> =>
        Effect.fail(new DecisionError({ reason: "unavailable", message }))
      let next = failing("rejected the key")
      const { run } = decideWith(() => next, { log: (l) => lines.push(l) })
      yield* run(ask)
      yield* run(ask)
      assert.deepStrictEqual(lines, ["TypeSafe routing failed, the fallback answers: rejected the key"])
      next = failing("network down")
      yield* run(ask)
      assert.strictEqual(lines.length, 2)
      assert.include(lines[1]!, "network down")
      next = Effect.succeed(noulOnly(0.9))
      yield* run(ask)
      assert.strictEqual(lines.length, 2, "a success logs nothing")
      next = failing("network down")
      yield* run(ask)
      assert.strictEqual(lines.length, 3, "the same message after a success is news again")
    }))

  it.effect("a timeout reported by the service is a timeout decision and is not logged", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const { run } = decideWith(() => Effect.fail(new DecisionError({ reason: "timeout", message: "slow" })), { log: (l) => lines.push(l) })
      const result = yield* run(ask)
      assert.deepInclude(result.decision, { outcome: "timeout" })
      assert.strictEqual(result.assistant, "alpha")
      assert.deepStrictEqual(lines, [])
    }))
})
