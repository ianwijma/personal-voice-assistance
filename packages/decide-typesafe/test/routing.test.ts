// The routing request and its reading (docs/ASSISTANTS.md §3.6, WP-14) over HTTP, against a local fake of the
// documented `POST /v1/systemone` (docs/research/typesafe-jev.md §2.2, §2.3). The shapes are the documented ones;
// nothing here has been checked against the real service.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { makeJevClient } from "../src/JevClient.ts"
import { describeCandidate, readRouting, ROUTE_CHOICE_MIN, ROUTE_FITS_MIN, type RouteCandidate, routingRequest } from "../src/routing.ts"

interface Recorded {
  readonly path: string
  readonly headers: Http.IncomingHttpHeaders
  readonly body: any
}
type Handler = (req: Http.IncomingMessage, res: Http.ServerResponse, body: any) => void

const fakeJev = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; requests: Array<Recorded>; aborted: () => number }>((resume) => {
      const requests: Array<Recorded> = []
      let aborted = 0
      const server = Http.createServer((req, res) => {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const body = raw.length > 0 ? JSON.parse(raw) : undefined
          requests.push({ path: req.url ?? "", headers: req.headers, body })
          res.on("close", () => {
            if (!res.writableFinished) aborted++
          })
          handler(req, res, body)
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo
        resume(Effect.succeed({ url: `http://127.0.0.1:${port}`, requests, aborted: () => aborted, server }))
      })
    }),
    (api) =>
      Effect.sync(() => {
        const server = (api as unknown as { server: Http.Server }).server
        server.closeAllConnections()
        server.close()
      })
  )

const json = (status: number, body: unknown, delayMs = 0): Handler => (_req, res) => {
  const send = () => {
    if (res.destroyed) return
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  if (delayMs > 0) setTimeout(send, delayMs)
  else send()
}

/** As Jev would answer for the kitchen sentence (documented response shape, OpenAPI example values). */
const answer = (choice: string, p: number, fits: number) => ({
  model: "jev-1.14.0",
  answers: {
    assistant: { type: "choice", choice, confidence: 0.8, probabilities: { jeff: choice === "jeff" ? p : 1 - p, keuken: choice === "keuken" ? p : 1 - p } },
    fits: { type: "noul", noul: fits }
  },
  usage: { input_tokens: 96, output_tokens: 4 }
})

const jeff: RouteCandidate = { id: "jeff", name: "Jeff", purpose: "Everything else", handles: "General questions, conversation, the news." }
const keuken: RouteCandidate = { id: "keuken", name: "Keuken", purpose: "Kitchen timers and recipes", handles: "" }

describe("routing request (§3.6)", () => {
  it("one Choice over the candidates in list order plus the companion Noul; Handles, else name and purpose", () => {
    const request = routingRequest("zet een timer van tien minuten", [jeff, keuken])
    assert.deepStrictEqual(request.state, {
      utterance: "zet een timer van tien minuten",
      available_actions: { jeff: "General questions, conversation, the news.", keuken: "Keuken: Kitchen timers and recipes" }
    })
    assert.deepStrictEqual(request.questions, {
      assistant: {
        type: "choice",
        instructions: "Which assistant is this sentence meant for?",
        options: { jeff: "General questions, conversation, the news.", keuken: "Keuken: Kitchen timers and recipes" },
        role: { kind: "action" }
      },
      fits: { type: "noul", instructions: "Is the sentence meant for one of the available assistants?", role: { kind: "fits" } }
    })
    assert.strictEqual(describeCandidate({ id: "x", name: "X", purpose: "", handles: "  " }), "X")
    assert.deepStrictEqual(Object.keys(routingRequest("hi", [keuken]).questions), ["fits"])
  })

  it("reading: chosen only when fits and the choice's probability reach the thresholds; an unknown choice is none fits", () => {
    const both = [jeff, keuken]
    const res = (choice: string, p: number, fits: number) => ({
      answers: {
        assistant: { type: "choice" as const, choice, probabilities: { [choice]: p } },
        fits: { type: "noul" as const, value: fits }
      }
    })
    assert.strictEqual(ROUTE_FITS_MIN, 0.5)
    assert.strictEqual(ROUTE_CHOICE_MIN, 0.5)
    assert.deepStrictEqual(readRouting(res("keuken", 0.91, 0.97), both), { outcome: "chosen", assistant: "keuken", probability: 0.91, fits: 0.97 })
    assert.deepStrictEqual(readRouting(res("keuken", 0.5, 0.5), both), { outcome: "chosen", assistant: "keuken", probability: 0.5, fits: 0.5 })
    assert.deepStrictEqual(readRouting(res("keuken", 0.91, 0.3), both), { outcome: "none-fits", best: "keuken", probability: 0.91, fits: 0.3 })
    assert.deepStrictEqual(readRouting(res("keuken", 0.4, 0.9), both), { outcome: "none-fits", best: "keuken", probability: 0.4, fits: 0.9 })
    assert.deepStrictEqual(readRouting(res("ghost", 0.99, 0.99), both), { outcome: "none-fits", fits: 0.99 })
    assert.deepStrictEqual(readRouting({ answers: {} }, both), { outcome: "none-fits", fits: 0 })
    assert.deepStrictEqual(readRouting({ answers: { fits: { type: "noul", value: 0.7 } } }, [keuken]), { outcome: "chosen", assistant: "keuken", fits: 0.7 })
    assert.deepStrictEqual(readRouting({ answers: { fits: { type: "noul", value: 0.2 } } }, [keuken]), { outcome: "none-fits", best: "keuken", fits: 0.2 })
  })
})

describe("routing over HTTP (local fake of /v1/systemone)", () => {
  it.live("sends the documented body (options as criteria, no roles) with the bearer key, and reads the answer", () =>
    Effect.scoped(Effect.gen(function*() {
      const api = yield* fakeJev(json(200, answer("keuken", 0.93, 0.96)))
      const client = makeJevClient({ apiKey: Redacted.make("ts-test-key"), baseUrl: api.url, model: "jev-1.14.0", timeoutMs: 5_000 })
      const candidates = [jeff, keuken]
      const response = yield* client.decide(routingRequest("zet een timer van tien minuten", candidates), { timeoutMs: 400 })
      assert.deepStrictEqual(readRouting(response, candidates), { outcome: "chosen", assistant: "keuken", probability: 0.93, fits: 0.96 })
      assert.strictEqual(response.model, "jev-1.14.0")
      const [sent] = api.requests
      assert.strictEqual(sent!.path, "/v1/systemone")
      assert.strictEqual(sent!.headers.authorization, "Bearer ts-test-key")
      assert.strictEqual(sent!.headers["content-type"], "application/json")
      assert.deepStrictEqual(sent!.body, {
        model: "jev-1.14.0",
        state: {
          utterance: "zet een timer van tien minuten",
          available_actions: { jeff: "General questions, conversation, the news.", keuken: "Keuken: Kitchen timers and recipes" }
        },
        questions: {
          assistant: {
            type: "choice",
            instructions: "Which assistant is this sentence meant for?",
            criteria: { jeff: "General questions, conversation, the news.", keuken: "Keuken: Kitchen timers and recipes" }
          },
          fits: { type: "noul", instructions: "Is the sentence meant for one of the available assistants?" }
        }
      })
    })))

  it.live("the call's own time limit (the give-up time) aborts a slow request", () =>
    Effect.scoped(Effect.gen(function*() {
      const api = yield* fakeJev(json(200, answer("jeff", 0.9, 0.9), 1_000))
      const client = makeJevClient({ apiKey: Redacted.make("k"), baseUrl: api.url, timeoutMs: 5_000 })
      const started = Date.now()
      const result = yield* Effect.result(client.decide(routingRequest("hello", [jeff, keuken]), { timeoutMs: 150 }))
      const took = Date.now() - started
      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "timeout")
      assert.isBelow(took, 900, "gave up at the call's limit, not the client's")
      // The server sees the connection go.
      for (let i = 0; i < 100 && api.aborted() === 0; i++) yield* Effect.sleep(10)
      assert.strictEqual(api.aborted(), 1)
    })))

  it.live("a rejected key, an overloaded service and a malformed answer are errors (the caller falls back)", () =>
    Effect.scoped(Effect.gen(function*() {
      for (const [status, body, reason] of [[401, { detail: "bad key" }, "unavailable"], [529, { detail: "overloaded" }, "unavailable"], [200, { nope: 1 }, "invalid"]] as const) {
        const api = yield* fakeJev(json(status, body))
        const client = makeJevClient({ apiKey: Redacted.make("k"), baseUrl: api.url })
        const result = yield* Effect.result(client.decide(routingRequest("hello", [jeff, keuken]), { timeoutMs: 1_000 }))
        assert.strictEqual(result._tag, "Failure")
        if (result._tag === "Failure") assert.strictEqual(result.failure.reason, reason)
      }
    })))
})
