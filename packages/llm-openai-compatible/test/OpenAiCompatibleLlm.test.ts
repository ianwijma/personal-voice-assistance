import { assert, describe, it } from "@effect/vitest"
import { Llm, LlmError, type LlmEvent, type LlmRequest } from "@pva/core"
import { Effect, Exit, Fiber, Redacted, Stream } from "effect"
import { layer, type OpenAiCompatibleLlmOptions, toBody, toStopReason } from "../src/OpenAiCompatibleLlm.ts"
import type { ProfileId } from "../src/profiles.ts"
import { SseParser } from "../src/sse.ts"
import { fakeServer, finish, type Handler, json, reasoning, replay, role, sse, startSse, text, toolDelta, usage } from "./fakeServer.ts"

const options = (url: string, extra: Partial<OpenAiCompatibleLlmOptions> = {}): OpenAiCompatibleLlmOptions => ({
  profile: "generic",
  baseUrl: url,
  model: "test-model",
  maxTokens: 512,
  timeoutMs: 2_000,
  ...extra
})

const request: LlmRequest = { system: "Be brief.", messages: [{ role: "user", content: "Hi" }], tools: [] }

const collect = (url: string, req: LlmRequest = request, extra: Partial<OpenAiCompatibleLlmOptions> = {}) =>
  Effect.gen(function*() {
    const llm = yield* Llm
    return yield* Stream.runCollect(llm.stream(req))
  }).pipe(Effect.provide(layer(options(url, extra))))

const failure = (exit: Exit.Exit<unknown, unknown>): LlmError | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason?._tag === "Fail" && reason.error instanceof LlmError ? reason.error : undefined
}

describe("SseParser", () => {
  it("handles CRLF, events split across chunks, comments and multi-line data", () => {
    const parser = new SseParser()
    const events = [
      ...parser.push(": OPENROUTER PROCESSING\r\n\r\nda"),
      ...parser.push("ta: {\"a\":1}\r\n\r\ndata: line1\ndata: line2\n\nevent: error\ndata: {\"b\":2}\n"),
      ...parser.push("\n"),
      ...parser.push("data: [DONE]")
    ]
    assert.deepStrictEqual(events, [
      { event: undefined, data: "{\"a\":1}" },
      { event: undefined, data: "line1\nline2" },
      { event: "error", data: "{\"b\":2}" }
    ])
    assert.strictEqual(parser.comments, 1)
    assert.deepStrictEqual(parser.end(), [{ event: undefined, data: "[DONE]" }])
  })
})

describe("OpenAiCompatibleLlm streaming", () => {
  it.live("streams text deltas, skips keep-alive comments and never emits reasoning", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([
        ": OPENROUTER PROCESSING",
        role(),
        reasoning("The user greets me. "),
        reasoning("I should greet back.", "reasoning_content"),
        ": OPENROUTER PROCESSING",
        text("Hel"),
        text("lo."),
        finish("stop"),
        usage(),
        "[DONE]"
      ]))
      const events = yield* collect(api.url)
      assert.deepStrictEqual(events, [
        { _tag: "TextDelta", text: "Hel" },
        { _tag: "TextDelta", text: "lo." },
        { _tag: "Done", stopReason: "end" }
      ])
    }))

  it.live("ends at the finish reason without waiting for the usage chunk or [DONE]", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer((_req, res) => {
        startSse(res)
        res.write(sse([text("Hi."), finish("stop")])) // and then nothing: the connection stays open
      })
      const started = Date.now()
      const events = yield* collect(api.url)
      assert.deepStrictEqual(events.map((e) => e._tag), ["TextDelta", "Done"])
      assert.isBelow(Date.now() - started, 1_000)
    }))

  it.live("assembles tool calls from fragments by index and emits each as soon as it is complete", () =>
    Effect.gen(function*() {
      let continueServer!: () => void
      const resume = new Promise<void>((resolve) => (continueServer = resolve))
      const api = yield* fakeServer((_req, res) => {
        startSse(res)
        res.write(sse([
          text("Let me check."),
          toolDelta([{ index: 0, id: "call_a", type: "function", function: { name: "weather", arguments: "" } }]),
          toolDelta([{ index: 0, function: { arguments: "{\"ci" } }]),
          toolDelta([{ index: 0, function: { arguments: "ty\": \"Oslo\"}" } }]),
          toolDelta([{ index: 1, id: "call_b", type: "function", function: { name: "current_time", arguments: "" } }])
        ]))
        // The rest only after the consumer has seen the first call.
        void resume.then(() => res.end(sse([toolDelta([{ index: 1, function: { arguments: "{}" } }]), finish("tool_calls"), "[DONE]"])))
      })
      const llm = yield* Llm.pipe(Effect.provide(layer(options(api.url))))
      const events: Array<LlmEvent> = []
      yield* llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event)
            if (event._tag === "ToolCall" && event.id === "call_a") continueServer()
          })
        )
      )
      assert.deepStrictEqual(events, [
        { _tag: "TextDelta", text: "Let me check." },
        { _tag: "ToolCall", id: "call_a", name: "weather", input: { city: "Oslo" } },
        { _tag: "ToolCall", id: "call_b", name: "current_time", input: {} },
        { _tag: "Done", stopReason: "tool_use" }
      ])
    }))

  it.live("accepts whole tool calls without index or id, arguments as an object, and 'stop' after tools", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([
        toolDelta([{ function: { name: "lights_on", arguments: { target: "kitchen" } } }]),
        toolDelta([{ id: "x2", function: { name: "lights_off", arguments: "{\"target\":\"hall\"}" } }]),
        finish("stop")
      ]))
      const events = yield* collect(api.url)
      assert.strictEqual(events.length, 3)
      const [first, second, done] = events
      assert.isTrue(first?._tag === "ToolCall" && first.name === "lights_on" && first.id.startsWith("call_0_"))
      assert.deepStrictEqual(first?._tag === "ToolCall" ? first.input : undefined, { target: "kitchen" })
      assert.deepStrictEqual(second, { _tag: "ToolCall", id: "x2", name: "lights_off", input: { target: "hall" } })
      assert.deepStrictEqual(done, { _tag: "Done", stopReason: "tool_use" })
    }))

  it.live("treats a missing finish reason as the end ([DONE] or end of body)", () =>
    Effect.gen(function*() {
      const withDone = yield* fakeServer(replay([text("A"), "[DONE]"]))
      assert.deepStrictEqual((yield* collect(withDone.url)).at(-1), { _tag: "Done", stopReason: "end" })
      const bare = yield* fakeServer(replay([text("A"), toolDelta([{ index: 0, id: "c", function: { name: "t", arguments: "{}" } }])]))
      assert.deepStrictEqual((yield* collect(bare.url)).map((e) => e._tag), ["TextDelta", "ToolCall", "Done"])
      const length = yield* fakeServer(replay([text("Wel"), finish("length")]))
      assert.deepStrictEqual((yield* collect(length.url)).at(-1), { _tag: "Done", stopReason: "max_tokens" })
    }))

  it.live("fails on an empty response", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([]))
      const error = yield* Effect.flip(collect(api.url))
      assert.include(error.message, "without sending anything")
    }))

  it.live("handles a server that ignores stream: true and answers with JSON", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(json(200, {
        choices: [{ index: 0, message: { role: "assistant", content: "Hello.", reasoning_content: "hmm" }, finish_reason: "stop" }]
      }))
      assert.deepStrictEqual(yield* collect(api.url), [{ _tag: "TextDelta", text: "Hello." }, { _tag: "Done", stopReason: "end" }])
    }))

  it("maps stop reasons", () => {
    assert.strictEqual(toStopReason("stop", false), "end")
    assert.strictEqual(toStopReason(undefined, false), "end")
    assert.strictEqual(toStopReason("length", false), "max_tokens")
    assert.strictEqual(toStopReason("tool_calls", true), "tool_use")
    assert.strictEqual(toStopReason("stop", true), "tool_use")
    assert.strictEqual(toStopReason("content_filter", false), "other")
  })
})

describe("OpenAiCompatibleLlm errors, retries, timeouts and interruption", () => {
  it.live("fails on a mid-stream error chunk after text, without retry", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([
        text("Hi"),
        { id: "x", object: "chat.completion.chunk", error: { code: 502, message: "Provider disconnected" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }
      ]))
      const error = yield* Effect.flip(collect(api.url))
      assert.instanceOf(error, LlmError)
      assert.include(error.message, "Provider disconnected")
      assert.strictEqual(api.requests.length, 1)
    }))

  it.live("retries once on a 5xx error chunk before anything was emitted", () =>
    Effect.gen(function*() {
      let calls = 0
      const api = yield* fakeServer((req, res, body) => {
        calls++
        if (calls === 1) replay([": OPENROUTER PROCESSING", { error: { code: 503, message: "No provider available" } }])(req, res, body)
        else replay([text("Hi"), finish("stop")])(req, res, body)
      })
      const events = yield* collect(api.url)
      assert.strictEqual(calls, 2)
      assert.deepStrictEqual(events.map((e) => e._tag), ["TextDelta", "Done"])
    }))

  it.live("fails on finish_reason error", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([finish("error")]))
      const error = yield* Effect.flip(collect(api.url))
      assert.include(error.message, "error in the stream")
    }))

  it.live("a rejected key is a clear error and is not retried", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(json(401, { error: { message: "No auth credentials found", code: 401 } }))
      const exit = yield* Effect.exit(collect(api.url, request, { profile: "openrouter" }))
      const error = failure(exit)
      // Fixed text: the upstream body is not repeated (a gateway may echo the key in it).
      assert.strictEqual(error?.message, "OpenRouter rejected the API key (401)")
      assert.strictEqual(api.requests.length, 1)
    }))

  it.live("a 429 is not retried; a 503 is retried once", () =>
    Effect.gen(function*() {
      const limited = yield* fakeServer(json(429, { error: { message: "Rate limit exceeded" } }))
      const error = yield* Effect.flip(collect(limited.url))
      assert.include(error.message, "rate limiting (429)")
      assert.strictEqual(limited.requests.length, 1)

      let calls = 0
      const flaky = yield* fakeServer((req, res, body) => {
        calls++
        if (calls === 1) json(503, { error: "loading model" })(req, res, body)
        else replay([text("Hi"), finish("stop")])(req, res, body)
      })
      assert.deepStrictEqual((yield* collect(flaky.url)).map((e) => e._tag), ["TextDelta", "Done"])
      assert.strictEqual(calls, 2)
    }))

  it.live("an unreachable server fails fast with a readable message", () =>
    Effect.gen(function*() {
      const started = Date.now()
      const error = yield* Effect.flip(collect("http://127.0.0.1:1/v1", request, { profile: "ollama" }))
      assert.include(error.message, "Could not reach Ollama")
      assert.isBelow(Date.now() - started, 1_500)
    }))

  it.live("a server that sends no headers fails after the timeout (one retry)", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(() => {}) // never answers
      const started = Date.now()
      const error = yield* Effect.flip(collect(api.url, request, { timeoutMs: 200 }))
      const elapsed = Date.now() - started
      assert.include(error.message, "No response from OpenAI-compatible server within 200 ms")
      assert.strictEqual(api.requests.length, 2)
      assert.isBelow(elapsed, 1_200)
    }))

  it.live("keep-alive comments alone do not keep a stalled stream alive", () =>
    Effect.gen(function*() {
      const timers: Array<ReturnType<typeof setInterval>> = []
      const handler: Handler = (_req, res) => {
        startSse(res)
        const t = setInterval(() => res.write(": OPENROUTER PROCESSING\n\n"), 50)
        timers.push(t)
        res.on("close", () => clearInterval(t))
      }
      const api = yield* fakeServer(handler)
      const error = yield* Effect.flip(collect(api.url, request, { timeoutMs: 250 }))
      timers.forEach(clearInterval)
      assert.include(error.message, "No stream data from OpenAI-compatible server within 250 ms")
    }))

  it.live("a stall after text fails without retry", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer((_req, res) => {
        startSse(res)
        res.write(sse([text("Once upon")]))
      })
      const exit = yield* Effect.exit(collect(api.url, request, { timeoutMs: 200 }))
      assert.include(failure(exit)?.message, "No stream data")
      assert.strictEqual(api.requests.length, 1)
    }))

  it.live("interrupting the consumer aborts the HTTP request", () =>
    Effect.gen(function*() {
      let closed!: () => void
      const connectionClosed = new Promise<void>((resolve) => (closed = resolve))
      const api = yield* fakeServer((_req, res) => {
        startSse(res)
        res.write(sse([text("Once upon")]))
        res.on("close", () => closed()) // never ended by the server
      })
      const llm = yield* Llm.pipe(Effect.provide(layer(options(api.url, { timeoutMs: 10_000 }))))
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

  it.live("interrupting before the response headers aborts the request too", () =>
    Effect.gen(function*() {
      let closed!: () => void
      const connectionClosed = new Promise<void>((resolve) => (closed = resolve))
      let arrived!: () => void
      const requestArrived = new Promise<void>((resolve) => (arrived = resolve))
      const api = yield* fakeServer((req) => {
        req.socket.on("close", () => closed())
        arrived()
      })
      const llm = yield* Llm.pipe(Effect.provide(layer(options(api.url, { timeoutMs: 10_000 }))))
      const fiber = yield* llm.stream(request).pipe(Stream.runDrain, Effect.forkChild)
      yield* Effect.promise(() => requestArrived)
      yield* Fiber.interrupt(fiber)
      yield* Effect.promise(() => connectionClosed).pipe(Effect.timeout(1_000))
    }))

  it.live("fails on invalid tool arguments", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([toolDelta([{ index: 0, id: "c", function: { name: "weather", arguments: "{\"city\": \"Par" } }]), finish("tool_calls")]))
      const error = yield* Effect.flip(collect(api.url))
      assert.include(error.message, "weather")
    }))
})

describe("OpenAiCompatibleLlm request", () => {
  const history: LlmRequest = {
    system: "Be brief.",
    context: "Current time: 10:42",
    tools: [{ name: "weather", description: "Weather.", inputSchema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "Weather in Oslo?" },
      { role: "assistant", content: "Checking.", toolCalls: [{ id: "call_a", name: "weather", input: { city: "Oslo" } }] },
      { role: "tool", results: [{ id: "call_a", name: "weather", content: "{\"c\":3}", isError: false }] },
      { role: "assistant", content: "It is 3 degrees.", interrupted: true },
      { role: "user", content: "And tomorrow?" },
      { role: "assistant", content: "" },
      { role: "user", content: "Hello?" }
    ]
  }

  it.live("sends messages, tools, context last, and the key as a bearer token", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([finish("stop")]))
      yield* collect(api.url, history, { apiKey: Redacted.make("sk-test"), temperature: 0.3 })
      const [recorded] = api.requests
      assert.strictEqual(recorded?.path, "/v1/chat/completions")
      assert.strictEqual(recorded?.headers.authorization, "Bearer sk-test")
      assert.deepStrictEqual(recorded?.body, {
        model: "test-model",
        stream: true,
        max_tokens: 512,
        temperature: 0.3,
        tools: [{ type: "function", function: { name: "weather", description: "Weather.", parameters: { type: "object", properties: {} } } }],
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Weather in Oslo?" },
          {
            role: "assistant",
            content: "Checking.",
            tool_calls: [{ id: "call_a", type: "function", function: { name: "weather", arguments: "{\"city\":\"Oslo\"}" } }]
          },
          { role: "tool", tool_call_id: "call_a", content: "{\"c\":3}" },
          { role: "assistant", content: "It is 3 degrees." },
          // consecutive user messages joined; the empty assistant turn dropped; context at the very end
          { role: "user", content: "And tomorrow?\n\nHello?\n\n<context>\nCurrent time: 10:42\n</context>" }
        ]
      })
    }))

  it("puts the context in its own user message after tool results, marks failed results, omits empty tools", () => {
    const body = toBody({
      system: "S",
      context: "C",
      tools: [],
      messages: [
        { role: "user", content: "Q" },
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", input: {} }] },
        { role: "tool", results: [{ id: "1", name: "t", content: "boom", isError: true }] }
      ]
    }, options("http://x/v1"))
    assert.isUndefined(body.tools)
    assert.isUndefined(body.temperature)
    assert.deepStrictEqual((body.messages as Array<unknown>).slice(2), [
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "Error: boom" },
      { role: "user", content: "<context>\nC\n</context>" }
    ])
  })

  it.live("sends 'none' as the key when there is none", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([finish("stop")]))
      yield* collect(api.url, request, { profile: "llamacpp" })
      assert.strictEqual(api.requests[0]?.headers.authorization, "Bearer none")
    }))

  const extras = (profile: ProfileId, extra: Partial<OpenAiCompatibleLlmOptions>) => {
    const body = toBody(request, options("http://x/v1", { profile, ...extra }))
    const { model: _m, messages: _ms, stream: _s, max_tokens: _t, ...rest } = body
    return rest
  }

  it("sends profile-specific fields only to that server", () => {
    // OpenRouter: latency sort; reasoning only to a model that lists the effort
    assert.deepStrictEqual(extras("openrouter", { sortByLatency: true, reasoningEffort: "none" }), { provider: { sort: "latency" } })
    assert.deepStrictEqual(
      extras("openrouter", { sortByLatency: true, reasoningEffort: "none", modelInfo: { id: "m", label: "M", reasoningEfforts: ["none", "low"] } }),
      { provider: { sort: "latency" }, reasoning: { effort: "none" } }
    )
    assert.deepStrictEqual(
      extras("openrouter", { reasoningEffort: "minimal", modelInfo: { id: "m", label: "M", reasoningEfforts: ["none", "low"] } }),
      {}
    )
    assert.deepStrictEqual(extras("openrouter", { reasoningEffort: "low", modelInfo: { id: "m", label: "M", reasoning: true } }), {
      reasoning: { effort: "low" }
    })
    // Ollama: reasoning_effort when set
    assert.deepStrictEqual(extras("ollama", { reasoningEffort: "none", sortByLatency: true }), { reasoning_effort: "none" })
    assert.deepStrictEqual(extras("ollama", {}), {})
    // Strict servers: nothing extra
    for (const p of ["llamacpp", "lmstudio", "vllm", "generic"] as const) {
      assert.deepStrictEqual(extras(p, { reasoningEffort: "none", sortByLatency: true }), {})
    }
  })
})

describe("OpenAiCompatibleLlm review regressions", () => {
  it.live("tool headers that all precede their interleaved argument fragments get their real arguments", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(replay([
        toolDelta([{ index: 0, id: "call_a", type: "function", function: { name: "lights_on", arguments: "" } }]),
        toolDelta([{ index: 1, id: "call_b", type: "function", function: { name: "lights_off", arguments: "" } }]),
        toolDelta([{ index: 0, function: { arguments: "{\"target\":" } }]),
        toolDelta([{ index: 1, function: { arguments: "{\"target\":" } }]),
        toolDelta([{ index: 0, function: { arguments: " \"kitchen\"}" } }]),
        toolDelta([{ index: 1, function: { arguments: " \"hall\"}" } }]),
        toolDelta([{ index: 2, id: "call_c", type: "function", function: { name: "current_time", arguments: "" } }]),
        finish("tool_calls")
      ]))
      const events = yield* collect(api.url)
      assert.deepStrictEqual([...events], [
        { _tag: "ToolCall", id: "call_a", name: "lights_on", input: { target: "kitchen" } },
        { _tag: "ToolCall", id: "call_b", name: "lights_off", input: { target: "hall" } },
        { _tag: "ToolCall", id: "call_c", name: "current_time", input: {} },
        { _tag: "Done", stopReason: "tool_use" }
      ])
    }))

  const KEY = "sk-or-v1-0123456789abcdefSECRET"

  it.live("a 401 that echoes the submitted key never puts the key in the error", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(json(401, { error: { message: `Invalid API key: ${KEY}` } }))
      const error = yield* Effect.flip(collect(api.url, request, { profile: "openrouter", apiKey: Redacted.make(KEY) }))
      assert.include(error.message, "OpenRouter rejected the API key (401)")
      assert.notInclude(error.message, KEY)
      assert.notInclude(String(error.cause), KEY)
    }))

  it.live("other HTTP errors, stream errors and protocol errors that echo the key are redacted", () =>
    Effect.gen(function*() {
      const opts = { apiKey: Redacted.make(KEY) }
      const http = yield* fakeServer(json(400, { error: { message: `bad request for key ${KEY}` } }))
      const e1 = yield* Effect.flip(collect(http.url, request, opts))
      assert.include(e1.message, "answered 400")
      assert.notInclude(e1.message, KEY)

      const inStream = yield* fakeServer(replay([text("Hi"), { error: { code: 400, message: `key ${KEY} is over quota` } }]))
      const e2 = yield* Effect.flip(collect(inStream.url, request, opts))
      assert.include(e2.message, "over quota")
      assert.notInclude(e2.message, KEY)

      const notJson = yield* fakeServer((_req, res) => {
        startSse(res)
        res.end(`data: oops ${KEY}\n\n`)
      })
      const e3 = yield* Effect.flip(collect(notJson.url, request, opts))
      assert.include(e3.message, "not JSON")
      assert.notInclude(e3.message, KEY)
      // A key cut in half by the 120-character limit must not leak its first half either.
      assert.notInclude(e3.message, KEY.slice(0, 12))
    }))
})
