/**
 * No configured credential leaks into an error or a log line, whatever the
 * upstream (the API, or a gateway at `baseURL`) sends back: every failure the
 * adapter has, with the credential planted in every position the upstream
 * controls (bodies, error types, request ids, other headers, stream events).
 */
import { assert, describe, it } from "@effect/vitest"
import type { LlmRequest } from "@pva/core"
import { Effect, Exit, Redacted, Stream } from "effect"
import { defaults, make } from "../src/index.ts"
import { captureLogs, KEYS, leaksOf, planted, serialise } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const request: LlmRequest = { system: "", messages: [{ role: "user", content: "Hi" }], tools: [] }

const respond = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

const sse = (events: ReadonlyArray<readonly [string, string]>) =>
  new Response(events.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })

const messageStart = JSON.stringify({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    model: "m",
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }
})

const hang: Fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
  })

const brokenStream = (error: unknown) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${messageStart}\n\n`))
        c.error(error)
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  )

const scenarios = (p: string): ReadonlyArray<readonly [string, Fetch]> => {
  const headers = { "request-id": p, "retry-after": p, "x-should-retry": "false", "anthropic-organization-id": p }
  const errorBody = JSON.stringify({ type: "error", error: { type: p, message: p }, request_id: p })
  return [
    ...[400, 401, 403, 404, 408, 409, 413, 429, 500, 503, 529].flatMap((status) => [
      [`${status} error body`, async () => respond(status, errorBody, headers)] as const,
      [`${status} text body`, async () => respond(status, `gateway: ${p}`, { ...headers, "content-type": "text/plain" })] as const
    ]),
    ["stream error event", async () => sse([["message_start", messageStart], ["error", JSON.stringify({ type: "error", error: { type: "overloaded_error", message: p } })]])],
    ["stream error event, unknown type", async () => sse([["message_start", messageStart], ["error", JSON.stringify({ type: "error", error: { type: p, message: p } })]])],
    ["stream data that is not JSON", async () => sse([["message_start", messageStart], ["content_block_delta", p]])],
    [
      "tool input that is not JSON",
      async () =>
        sse([
          ["message_start", messageStart],
          ["content_block_start", JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: p, input: {} } })],
          ["content_block_delta", JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{${p}` } })],
          ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })]
        ])
    ],
    ["stream read error", async () => brokenStream(new Error(`socket hang up ${p}`))],
    ["connection error with a cause", () => Promise.reject(new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${p}`) }))],
    ["connection error", () => Promise.reject(new Error(p))],
    ["timeout", hang]
  ]
}

const withLogs = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const exit = yield* effect.pipe(
      Effect.exit,
      Effect.provide(captureLogs(logs))
    )
    return { exit, logs }
  })

const assertNoLeak = (key: string, what: string, text: string) =>
  assert.deepStrictEqual(leaksOf(key, text), [], `${what} leaked the credential: ${text.slice(0, 2000)}`)

describe("credentials never leak (llm-anthropic)", () => {
  for (const key of KEYS) {
    it.live(`every failure of a streamed call, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        for (const [what, fetch] of scenarios(planted(key))) {
          const { exit, logs } = yield* withLogs(
            Effect.scoped(Effect.gen(function*() {
              const llm = yield* make({ ...defaults, apiKey: Redacted.make(key), baseURL: "http://upstream.test", timeoutMs: 200, warmUp: false, fetch })
              return yield* Stream.runCollect(llm.stream(request))
            }))
          )
          assert.isTrue(Exit.isFailure(exit), `${what}: expected a failure`)
          assertNoLeak(key, what, `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs.join("\n")}`)
          if (Exit.isFailure(exit)) assert.match(String(exit.cause), /Anthropic|anthropic|ECONNREFUSED|fetch|aborted|timed out|JSON|tool|socket|\d{3}/, what)
        }
      }), 60_000)

    it.live(`a failed warm-up logs no credential, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        for (const [what, fetch] of scenarios(planted(key))) {
          const { logs } = yield* withLogs(
            Effect.scoped(Effect.gen(function*() {
              yield* make({ ...defaults, apiKey: Redacted.make(key), baseURL: "http://upstream.test", timeoutMs: 200, warmUp: true, fetch })
              yield* Effect.sleep(250)
            }))
          )
          assertNoLeak(key, `warm-up: ${what}`, logs.join("\n"))
        }
      }), 60_000)
  }

  it.live("a request id is shown only when it is a plain id", () =>
    Effect.gen(function*() {
      const run = (requestId: string) =>
        withLogs(Effect.scoped(Effect.gen(function*() {
          const llm = yield* make({
            ...defaults,
            apiKey: Redacted.make("sk-ant-test-0123456789"),
            baseURL: "http://upstream.test",
            timeoutMs: 200,
            warmUp: false,
            fetch: async () => respond(401, "{}", { "request-id": requestId })
          })
          return yield* Stream.runCollect(llm.stream(request))
        })))
      const plain = yield* run("req_011CXyz")
      assert.include(String(plain.exit), "Anthropic rejected the API key (401) (request-id req_011CXyz)")
      const odd = yield* run("req 1; <script>")
      assert.include(String(odd.exit), "Anthropic rejected the API key (401)")
      assert.notInclude(String(odd.exit), "script")
    }))
})
