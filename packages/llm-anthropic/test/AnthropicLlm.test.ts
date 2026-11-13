import { assert, describe, it } from "@effect/vitest"
import { Llm, LlmError, type LlmEvent, type LlmRequest } from "@pva/core"
import { ConfigProvider, Effect, Exit, Fiber, Redacted, Stream } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { type AnthropicLlmOptions, config, DEFAULT_BASE_URL, defaults, layer, layerConfig, toStopReason } from "../src/index.ts"

// ---------------------------------------------------------------------------
// A local server that records requests and replays SSE fixtures.

type Handler = (req: Http.IncomingMessage, res: Http.ServerResponse, body: any) => void

const fakeApi = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; bodies: Array<any> }>((resume) => {
      const bodies: Array<any> = []
      const server = Http.createServer((req, res) => {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const body = raw.length > 0 ? JSON.parse(raw) : undefined
          bodies.push(body)
          handler(req, res, body)
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo
        resume(Effect.succeed(Object.assign({ url: `http://127.0.0.1:${port}`, bodies }, { server })))
      })
    }),
    (api) =>
      Effect.sync(() => {
        const server = (api as unknown as { server: Http.Server }).server
        server.closeAllConnections()
        server.close()
      })
  )

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("")

const startSse = (res: Http.ServerResponse) =>
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })

const replay = (events: ReadonlyArray<Record<string, unknown>>): Handler => (_req, res) => {
  startSse(res)
  res.end(sse(events))
}

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 }
  }
}
const textStart = (index: number) => ({
  type: "content_block_start",
  index,
  content_block: { type: "text", text: "" }
})
const textDelta = (index: number, text: string) => ({
  type: "content_block_delta",
  index,
  delta: { type: "text_delta", text }
})
const toolStart = (index: number, id: string, name: string) => ({
  type: "content_block_start",
  index,
  content_block: { type: "tool_use", id, name, input: {} }
})
const jsonDelta = (index: number, partial_json: string) => ({
  type: "content_block_delta",
  index,
  delta: { type: "input_json_delta", partial_json }
})
const blockStop = (index: number) => ({ type: "content_block_stop", index })
const messageEnd = (stop_reason: string) => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
]

const options = (url: string): AnthropicLlmOptions => ({
  ...defaults,
  apiKey: Redacted.make("test-key"),
  baseURL: url,
  timeoutMs: 2_000,
  warmUp: false
})

const request: LlmRequest = {
  system: "Be brief.",
  messages: [{ role: "user", content: "Hi" }],
  tools: []
}

const collect = (url: string, req: LlmRequest = request) =>
  Effect.gen(function*() {
    const llm = yield* Llm
    return yield* Stream.runCollect(llm.stream(req))
  }).pipe(Effect.provide(layer(options(url))))

// ---------------------------------------------------------------------------

describe("AnthropicLlm", () => {
  it.live("streams text deltas and a final Done", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([
        messageStart,
        textStart(0),
        textDelta(0, "Hel"),
        textDelta(0, "lo."),
        blockStop(0),
        ...messageEnd("end_turn")
      ]))
      const events = yield* collect(api.url)
      assert.deepStrictEqual(events, [
        { _tag: "TextDelta", text: "Hel" },
        { _tag: "TextDelta", text: "lo." },
        { _tag: "Done", stopReason: "end" }
      ])
    }))

  it.live("assembles a tool call from several partial JSON deltas", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([
        messageStart,
        toolStart(0, "toolu_1", "weather"),
        jsonDelta(0, ""),
        jsonDelta(0, "{\"ci"),
        jsonDelta(0, "ty\": \"Par"),
        jsonDelta(0, "is\", \"days\": 2}"),
        blockStop(0),
        ...messageEnd("tool_use")
      ]))
      const events = yield* collect(api.url)
      assert.deepStrictEqual(events, [
        { _tag: "ToolCall", id: "toolu_1", name: "weather", input: { city: "Paris", days: 2 } },
        { _tag: "Done", stopReason: "tool_use" }
      ])
    }))

  it.live("emits text then two parallel tool calls, one without arguments", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([
        messageStart,
        textStart(0),
        textDelta(0, "Let me check."),
        blockStop(0),
        toolStart(1, "toolu_a", "weather"),
        jsonDelta(1, "{\"city\":"),
        jsonDelta(1, "\"Oslo\"}"),
        blockStop(1),
        toolStart(2, "toolu_b", "current_time"),
        blockStop(2),
        ...messageEnd("tool_use")
      ]))
      const events = yield* collect(api.url)
      assert.deepStrictEqual(events, [
        { _tag: "TextDelta", text: "Let me check." },
        { _tag: "ToolCall", id: "toolu_a", name: "weather", input: { city: "Oslo" } },
        { _tag: "ToolCall", id: "toolu_b", name: "current_time", input: {} },
        { _tag: "Done", stopReason: "tool_use" }
      ])
    }))

  it("maps stop reasons", () => {
    assert.strictEqual(toStopReason("end_turn"), "end")
    assert.strictEqual(toStopReason("stop_sequence"), "end")
    assert.strictEqual(toStopReason("tool_use"), "tool_use")
    assert.strictEqual(toStopReason("max_tokens"), "max_tokens")
    assert.strictEqual(toStopReason("refusal"), "other")
    assert.strictEqual(toStopReason("pause_turn"), "other")
    assert.strictEqual(toStopReason(null), "other")
  })

  it.live("maps max_tokens from the stream", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([messageStart, textStart(0), textDelta(0, "Wel"), ...messageEnd("max_tokens")]))
      const events = yield* collect(api.url)
      assert.deepStrictEqual(events.at(-1), { _tag: "Done", stopReason: "max_tokens" })
    }))

  it.live("maps messages, merges same-role turns and places cache_control and context", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([messageStart, ...messageEnd("end_turn")]))
      yield* collect(api.url, {
        system: "Be brief.",
        context: "Current time: 10:42",
        tools: [{ name: "weather", description: "Weather.", inputSchema: { type: "object", properties: {} } }],
        messages: [
          { role: "user", content: "Weather in Oslo?" },
          {
            role: "assistant",
            content: "Checking.",
            toolCalls: [{ id: "toolu_a", name: "weather", input: { city: "Oslo" } }]
          },
          { role: "tool", results: [{ id: "toolu_a", name: "weather", content: "{\"c\":3}", isError: false }] },
          { role: "assistant", content: "It is 3 degrees.", interrupted: true },
          { role: "user", content: "And tomorrow?" },
          { role: "assistant", content: "" }, // turn that produced nothing
          { role: "user", content: "Hello?" },
          { role: "tool", results: [{ id: "toolu_x", name: "weather", content: "boom", isError: true }] }
        ]
      })
      const body = api.bodies[0]
      assert.strictEqual(body.model, "claude-haiku-5-5")
      assert.strictEqual(body.max_tokens, 1024)
      assert.strictEqual(body.stream, true)
      assert.deepStrictEqual(body.output_config, { effort: "low" })
      assert.deepStrictEqual(body.thinking, { type: "disabled" })
      assert.isUndefined(body.temperature)
      assert.deepStrictEqual(body.system, [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }])
      assert.deepStrictEqual(body.tools, [{
        name: "weather",
        description: "Weather.",
        input_schema: { type: "object", properties: {} }
      }])
      assert.deepStrictEqual(body.messages, [
        { role: "user", content: [{ type: "text", text: "Weather in Oslo?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_a", name: "weather", input: { city: "Oslo" } }
          ]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "{\"c\":3}" }] },
        { role: "assistant", content: [{ type: "text", text: "It is 3 degrees." }] },
        {
          role: "user",
          content: [
            // tool results first, as the API requires, then the merged user texts
            { type: "tool_result", tool_use_id: "toolu_x", content: "boom", is_error: true },
            { type: "text", text: "And tomorrow?" },
            // last history block carries the history breakpoint ...
            { type: "text", text: "Hello?", cache_control: { type: "ephemeral" } },
            // ... and the per-turn context goes after it, uncached
            { type: "text", text: "<context>\nCurrent time: 10:42\n</context>" }
          ]
        }
      ])
    }))

  it.live("puts the history breakpoint on the last history block, before the context", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([messageStart, ...messageEnd("end_turn")]))
      yield* collect(api.url, {
        system: "Be brief.",
        context: "Current time: 10:42",
        tools: [],
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello." },
          { role: "user", content: "What time is it?" }
        ]
      })
      const messages = api.bodies[0].messages
      assert.deepStrictEqual(messages.at(-1), {
        role: "user",
        content: [
          { type: "text", text: "What time is it?", cache_control: { type: "ephemeral" } },
          { type: "text", text: "<context>\nCurrent time: 10:42\n</context>" }
        ]
      })
      assert.deepStrictEqual(messages[0], { role: "user", content: [{ type: "text", text: "Hi" }] })
    }))

  it.live("interrupting the consumer aborts the HTTP request", () =>
    Effect.gen(function*() {
      let closed!: () => void
      const connectionClosed = new Promise<void>((resolve) => (closed = resolve))
      const api = yield* fakeApi((_req, res) => {
        startSse(res)
        res.write(sse([messageStart, textStart(0), textDelta(0, "Once upon")]))
        res.on("close", () => closed()) // never ended by the server
      })
      const llm = yield* Llm.pipe(Effect.provide(layer(options(api.url))))
      let first!: () => void
      const gotFirst = new Promise<void>((resolve) => (first = resolve))
      const fiber = yield* llm.stream(request).pipe(
        Stream.runForEach(() => Effect.sync(() => first())),
        Effect.forkChild
      )
      yield* Effect.promise(() => gotFirst)
      yield* Fiber.interrupt(fiber)
      yield* Effect.promise(() => connectionClosed).pipe(Effect.timeout(1_000))
    }))

  it.live("maps an API error to LlmError", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi((_req, res) => {
        res.writeHead(401, { "content-type": "application/json", "request-id": "req_123" })
        res.end(JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" }
        }))
      })
      const exit = yield* Effect.exit(collect(api.url))
      assert.isTrue(Exit.isFailure(exit))
      const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      assert.isTrue(error?._tag === "Fail" && error.error instanceof LlmError)
      const message = error?._tag === "Fail" ? error.error.message : ""
      assert.include(message, "401")
      assert.include(message, "authentication_error")
      assert.include(message, "invalid x-api-key")
      assert.include(message, "req_123")
      assert.strictEqual(api.bodies.length, 1) // not retried
    }))

  it.live("retries once on overload when nothing was emitted yet", () =>
    Effect.gen(function*() {
      let calls = 0
      const api = yield* fakeApi((req, res, body) => {
        calls++
        if (calls === 1) {
          res.writeHead(529, { "content-type": "application/json" })
          res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))
        } else replay([messageStart, textStart(0), textDelta(0, "Hi"), ...messageEnd("end_turn")])(req, res, body)
      })
      const events = yield* collect(api.url)
      assert.strictEqual(calls, 2)
      assert.deepStrictEqual(events.map((e: LlmEvent) => e._tag), ["TextDelta", "Done"])
    }))

  it.live("fails without retry on a mid-stream error after text was emitted", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi((_req, res) => {
        startSse(res)
        res.end(
          sse([messageStart, textStart(0), textDelta(0, "Hi")]) +
            `event: error\ndata: ${
              JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
            }\n\n`
        )
      })
      const error = yield* Effect.flip(collect(api.url))
      assert.instanceOf(error, LlmError)
      assert.include(error.message, "overloaded_error")
      assert.strictEqual(api.bodies.length, 1)
    }))

  it.live("fails the stream on invalid tool input JSON", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([
        messageStart,
        toolStart(0, "toolu_1", "weather"),
        jsonDelta(0, "{\"city\": \"Par"),
        blockStop(0),
        ...messageEnd("max_tokens")
      ]))
      const error = yield* Effect.flip(collect(api.url))
      assert.instanceOf(error, LlmError)
      assert.include(error.message, "weather")
    }))
})

// ---------------------------------------------------------------------------
// Opt-in: runs only with a real key.

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("AnthropicLlm (live)", () => {
  it.live("streams a reply with one tool and logs time to first token", () =>
    Effect.gen(function*() {
      const llm = yield* Llm
      const started = performance.now()
      let firstToken: number | undefined
      const events = yield* llm.stream({
        system: "You are a voice assistant. Answer in one short sentence.",
        context: `Current time: ${new Date().toISOString()}`,
        tools: [{
          name: "current_time",
          description: "Returns the current local time.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        }],
        messages: [{ role: "user", content: "Say hello in five words." }]
      }).pipe(
        Stream.tap(() => Effect.sync(() => (firstToken ??= performance.now()))),
        Stream.runCollect
      )
      const done = events.at(-1)
      console.log(
        `time to first event: ${((firstToken ?? NaN) - started).toFixed(0)} ms, total: ${
          (performance.now() - started).toFixed(0)
        } ms, events: ${events.length}, done: ${JSON.stringify(done)}`
      )
      assert.strictEqual(done?._tag, "Done")
    }).pipe(Effect.provide(
      layer({
        ...defaults,
        apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY ?? ""),
        warmUp: false
      })
    )), 30_000)
})

describe("AnthropicLlm config: ANTHROPIC_BASE_URL is an explicit setting", () => {
  const read = (env: Record<string, string>) =>
    Effect.gen(function*() {
      return yield* config
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)))

  it.effect("defaults to the public API when unset (the SDK never reads process.env for it)", () =>
    Effect.gen(function*() {
      const options = yield* read({ ANTHROPIC_API_KEY: "k" })
      assert.strictEqual(options.baseURL, DEFAULT_BASE_URL)
    }))

  it.live("a value from the settings' ConfigProvider (not process.env) reaches the SDK", () =>
    Effect.gen(function*() {
      const api = yield* fakeApi(replay([messageStart, textStart(0), textDelta(0, "Hi."), blockStop(0), ...messageEnd("end_turn")]))
      const before = process.env.ANTHROPIC_BASE_URL
      // A stray export pointing elsewhere must not win over the settings.
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1"
      try {
        const events = yield* Effect.gen(function*() {
          const llm = yield* Llm
          return yield* Stream.runCollect(llm.stream(request))
        }).pipe(
          Effect.provide(layerConfig),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: api.url, ANTHROPIC_WARM_UP: "false" })
          )
        )
        assert.deepStrictEqual(events.at(-1), { _tag: "Done", stopReason: "end" })
        assert.strictEqual(api.bodies.length, 1)
      } finally {
        if (before === undefined) delete process.env.ANTHROPIC_BASE_URL
        else process.env.ANTHROPIC_BASE_URL = before
      }
    }))
})
