// WP-14 bench pieces (src/bench/typesafe.ts): the offline TypeSafe scenarios with a simulated decider, and the live
// routing script run against a local fake of `/v1/systemone` (no request leaves this machine).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { runOffline, zeroDelays } from "../src/bench/offline.ts"
import { formatReport } from "../src/bench/report.ts"
import { formatLive, liveUtterances, parseTypesafeLiveArgs, percentile, runTypesafeLive, typesafeScenarios } from "../src/bench/typesafe.ts"

const fakeJev = (delayMs: number) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; bodies: Array<any>; server: Http.Server }>((resume) => {
      const bodies: Array<any> = []
      const server = Http.createServer((req, res) => {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const body = JSON.parse(raw)
          bodies.push(body)
          const kitchen = /timer|oven|boil|cook|koken|recept/.test(body.state.utterance)
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({
              model: "jev-1.14.0",
              answers: {
                assistant: { type: "choice", choice: kitchen ? "keuken" : "jeff", probabilities: kitchen ? { jeff: 0.1, keuken: 0.85, t3: 0.05 } : { jeff: 0.7, keuken: 0.2, t3: 0.1 } },
                fits: { type: "noul", noul: kitchen ? 0.9 : 0.4 }
              }
            }))
          }, delayMs)
        })
      })
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, server })))
    }),
    (api) =>
      Effect.sync(() => {
        api.server.closeAllConnections()
        api.server.close()
      })
  )

describe("bench --typesafe (offline, simulated decider)", () => {
  it("has the no-decider baseline and the 150, 250 and 400 ms decisions, eager off and on", () => {
    const names = typesafeScenarios(zeroDelays).map((s) => [s.eager, s.decideMs])
    assert.deepStrictEqual(names, [[false, undefined], [false, 150], [false, 250], [false, 400], [true, undefined], [true, 150], [true, 250], [true, 400]])
  })

  it.live("a decision held at the final delays playback by about its time from the recogniser's end of turn", () =>
    Effect.gen(function*() {
      const base = yield* runOffline({ name: "base", delays: zeroDelays, eager: false, dispatch: true, queued: true }, 1)
      const decided = yield* runOffline({ name: "decided", delays: zeroDelays, eager: false, decideMs: 60 }, 1)
      assert.strictEqual(decided.length, 4)
      assert.isTrue(decided.every((r) => r.trace?.outcome === "completed"))
      const eot = (rows: typeof base) => rows.map((r) => r.extra!["EOT->PLAY"]!)
      for (const v of eot(base)) assert.isBelow(v, 40)
      for (const v of eot(decided)) assert.isAtLeast(v, 58)
      assert.match(formatReport("decided", decided, { headline: { key: "EOT->PLAY", label: "recogniser EndOfTurn -> playback start" } }), /recogniser EndOfTurn -> playback start: median/)
    }))

  it.live("eager on: the decision is made at the eager point and overlaps the pause before the final", () =>
    Effect.gen(function*() {
      const delays = { ...zeroDelays, eagerLeadMs: 120 }
      const rows = yield* runOffline({ name: "eager", delays, eager: true, decideMs: 60 }, 1)
      assert.strictEqual(rows.length, 4)
      // Decided 60 ms after the eager event, 60 ms before the final: nothing is added after the final.
      for (const r of rows) assert.isBelow(r.extra!["EOT->PLAY"]!, 40)
    }))
})

describe("bench --typesafe-live (against a local fake server)", () => {
  it("sends 50 different utterances by default and parses its options", () => {
    assert.strictEqual(new Set(liveUtterances).size, 50)
    assert.deepStrictEqual(parseTypesafeLiveArgs([]), { count: 50, gapMs: 1_000, timeoutMs: 2_000 })
    assert.deepStrictEqual(parseTypesafeLiveArgs(["--count", "5", "--gap-ms", "0"]), { count: 5, gapMs: 0, timeoutMs: 2_000 })
    assert.isString(parseTypesafeLiveArgs(["--rounds", "2"]))
    assert.strictEqual(percentile([5, 1, 4, 2, 3], 0.5), 3)
    assert.strictEqual(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
  })

  it.live("measures routeReceived - routeSent per request and prints the percentiles and the choices", () =>
    Effect.scoped(Effect.gen(function*() {
      const api = yield* fakeJev(20)
      const rows = yield* runTypesafeLive({ apiKey: "ts-test-key", baseUrl: api.url, count: 6, gapMs: 0 })
      assert.strictEqual(rows.length, 6)
      assert.strictEqual(api.bodies.length, 6)
      assert.deepStrictEqual(api.bodies.map((b) => b.state.utterance), liveUtterances.slice(0, 6))
      assert.deepStrictEqual(Object.keys(api.bodies[0].state.available_actions), ["jeff", "keuken", "t3"])
      for (const r of rows) assert.isAtLeast(r.ms, 19)
      assert.deepStrictEqual(rows[1], { ...rows[1]!, outcome: "chosen", assistant: "keuken", probability: 0.85, fits: 0.9 })
      assert.deepStrictEqual(rows[0], { ...rows[0]!, outcome: "none-fits", assistant: "(jeff)" })
      const text = formatLive(rows, "fake")
      assert.match(text, /routeReceived - routeSent, answered requests: n=6 p50 \d+/)
      assert.match(text, /outcomes: chosen 2, none fits 4, timeout 0, error 0; chosen: keuken 2/)
    })))

  it.live("a request slower than its time limit is a timeout row", () =>
    Effect.scoped(Effect.gen(function*() {
      const api = yield* fakeJev(400)
      const rows = yield* runTypesafeLive({ apiKey: "k", baseUrl: api.url, count: 1, gapMs: 0, timeoutMs: 100 })
      assert.strictEqual(rows[0]!.outcome, "timeout")
      assert.isBelow(rows[0]!.ms, 350)
    })))
})
