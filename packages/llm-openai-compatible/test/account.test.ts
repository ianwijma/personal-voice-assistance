import { assert, describe, it } from "@effect/vitest"
import { Llm, LlmError, type LlmRequest } from "@pva/core"
import { ConfigProvider, Effect, Exit, Redacted, Stream } from "effect"
import { accountConfig, accountLayer, checkAccountAddress, notSetUpMessage } from "../src/account.ts"
import { fakeServer, finish, type Handler, replay, text, toolDelta } from "./fakeServer.ts"

const withEnv = (env: Record<string, string>) => Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))
const request: LlmRequest = { system: "Be brief.", messages: [{ role: "user", content: "Hi" }], tools: [] }
const fail = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason?._tag === "Fail" && reason.error instanceof LlmError ? reason.error.message : "other"
}

describe("accountConfig", () => {
  it.effect("OpenRouter: the key is required, the address defaults, the assistant's fields come from the settings", () =>
    Effect.gen(function*() {
      const none = yield* Effect.exit(accountConfig("openrouter").pipe(withEnv({ OPENROUTER_MODEL: "v/m" })))
      assert.strictEqual(fail(none), notSetUpMessage("openrouter", "key"))
      assert.strictEqual(
        notSetUpMessage("openrouter", "key"),
        "OpenRouter is not set up: add its API key in Shared settings › Language model accounts."
      )
      const options = yield* accountConfig("openrouter").pipe(withEnv({
        OPENROUTER_API_KEY: " sk-x ",
        OPENROUTER_MODEL: "v/m",
        OPENROUTER_MAX_TOKENS: "300",
        OPENROUTER_TIMEOUT_MS: "3500"
      }))
      assert.strictEqual(options.baseUrl, "https://openrouter.ai/api/v1")
      assert.strictEqual(Redacted.value(options.apiKey!), "sk-x")
      assert.deepStrictEqual([options.model, options.maxTokens, options.timeoutMs, options.sortByLatency, options.warmUp], ["v/m", 300, 3500, true, "models"])
      assert.strictEqual((options.profile as { id: string }).id, "openrouter")
    }))

  it.effect("home model: the address is required (and gets /v1), the key is optional, no reasoning field is read", () =>
    Effect.gen(function*() {
      const none = yield* Effect.exit(accountConfig("home-model").pipe(withEnv({ HOME_MODEL_MODEL: "qwen3" })))
      assert.strictEqual(fail(none), "Home model is not set up: add the server address in Shared settings › Language model accounts.")
      const bare = yield* accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "http://192.168.1.20:11434", HOME_MODEL_MODEL: "qwen3", HOME_MODEL_WARM_UP: "false" }))
      assert.strictEqual(bare.baseUrl, "http://192.168.1.20:11434/v1")
      assert.strictEqual(bare.apiKey, undefined)
      assert.strictEqual(bare.warmUp, undefined)
      assert.strictEqual((bare.profile as { id: string }).id, "generic")
      const full = yield* accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "http://h:8000/openai/v1/", HOME_MODEL_MODEL: "qwen3", HOME_MODEL_API_KEY: "k" }))
      assert.strictEqual(full.baseUrl, "http://h:8000/openai/v1")
      assert.strictEqual(full.warmUp, "completion")
    }))

  it.effect("a refused address and a missing model are sentences, never carrying a credential", () =>
    Effect.gen(function*() {
      const secret = yield* Effect.exit(accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "http://user:pw-secret@h:1", HOME_MODEL_MODEL: "m" })))
      assert.isDefined(fail(secret))
      assert.notInclude(fail(secret)!, "pw-secret")
      const ftp = yield* Effect.exit(accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "ftp://h", HOME_MODEL_MODEL: "m" })))
      assert.isDefined(fail(ftp))
      const noModel = yield* Effect.exit(accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "http://h:1" })))
      assert.strictEqual(fail(noModel), "Choose a model for Home model.")
      assert.isUndefined(checkAccountAddress(""))
      assert.isUndefined(checkAccountAddress("http://192.168.1.20:11434"))
      assert.isDefined(checkAccountAddress("not an address"))
    }))
})

/** `GET /models` answers a list; the chat route runs the handler. */
const api = (chat: Handler): Handler => (req, res, body) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "m" }] }))
  } else chat(req, res, body)
}

describe("accountLayer", () => {
  it.live("a home model streams text and tool calls through the account's instance (address without /v1)", () =>
    Effect.gen(function*() {
      const server = yield* fakeServer(api((req, res, body) => {
        replay(body.tools !== undefined
          ? [toolDelta([{ index: 0, id: "c1", type: "function", function: { name: "lights", arguments: "{\"on\":true}" } }]), finish("tool_calls")]
          : [text("Hel"), text("lo"), finish("stop")])(req, res, body)
      }))
      const env = { HOME_MODEL_BASE_URL: server.url.replace(/\/v1$/, ""), HOME_MODEL_MODEL: "qwen3", HOME_MODEL_MAX_TOKENS: "99", HOME_MODEL_WARM_UP: "false" }
      const run = (req: LlmRequest) =>
        Effect.gen(function*() {
          const l = yield* Llm
          return yield* Stream.runCollect(l.stream(req))
        }).pipe(Effect.provide(accountLayer("home-model")), withEnv(env))
      const events = yield* run(request)
      assert.deepStrictEqual(events, [{ _tag: "TextDelta", text: "Hel" }, { _tag: "TextDelta", text: "lo" }, { _tag: "Done", stopReason: "end" }])
      const tools = yield* run({ ...request, tools: [{ name: "lights", description: "d", inputSchema: { type: "object", properties: {} } }] })
      assert.deepStrictEqual(tools, [
        { _tag: "ToolCall", id: "c1", name: "lights", input: { on: true } },
        { _tag: "Done", stopReason: "tool_use" }
      ])
      assert.strictEqual(server.requests[0]!.path, "/v1/chat/completions")
      assert.strictEqual(server.requests[0]!.body.max_tokens, 99)
      assert.strictEqual(server.requests[0]!.body.model, "qwen3")
      assert.strictEqual(server.requests[0]!.headers.authorization, "Bearer none")
    }))

  it.live("the give-up time fails a silent server fast with a readable error", () =>
    Effect.gen(function*() {
      const server = yield* fakeServer(api(() => {})) // never answers the chat request
      const env = { HOME_MODEL_BASE_URL: server.url, HOME_MODEL_MODEL: "m", HOME_MODEL_TIMEOUT_MS: "200", HOME_MODEL_WARM_UP: "false" }
      const started = Date.now()
      const exit = yield* Effect.exit(
        Effect.gen(function*() {
          const l = yield* Llm
          return yield* Stream.runCollect(l.stream(request))
        }).pipe(Effect.provide(accountLayer("home-model")), withEnv(env))
      )
      const took = Date.now() - started
      assert.match(fail(exit)!, /No response from OpenAI-compatible server within 200 ms/)
      assert.isTrue(took >= 380 && took < 1500, `took ${took} ms (one retry, 2 x 200 ms)`)
    }))

  it.live("awaitWarmUp: a home model is returned only after its one-token request ended; a failing warm-up does not fail the build", () =>
    Effect.gen(function*() {
      let warmEnded = false
      const server = yield* fakeServer(api((req, res, body) => {
        if (body.max_tokens === 1) {
          setTimeout(() => {
            warmEnded = true
            replay([text("x"), finish("length")])(req, res, body)
          }, 150)
        } else replay([text("ok"), finish("stop")])(req, res, body)
      }))
      const env = { HOME_MODEL_BASE_URL: server.url, HOME_MODEL_MODEL: "m", HOME_MODEL_WARM_UP: "true" }
      yield* Effect.scoped(Effect.gen(function*() {
        yield* Llm
        assert.isTrue(warmEnded)
      }).pipe(Effect.provide(accountLayer("home-model", true)), withEnv(env)))
      // Not awaited: returned at once.
      warmEnded = false
      yield* Effect.scoped(Effect.gen(function*() {
        yield* Llm
        assert.isFalse(warmEnded)
      }).pipe(Effect.provide(accountLayer("home-model", false)), withEnv(env)))
      // A server that refuses the warm-up request: still built.
      const broken = yield* fakeServer((_req, res) => {
        res.writeHead(500, { "content-type": "application/json" })
        res.end("{}")
      })
      yield* Effect.scoped(Effect.gen(function*() {
        yield* Llm
      }).pipe(Effect.provide(accountLayer("home-model", true)), withEnv({ ...env, HOME_MODEL_BASE_URL: broken.url })))
    }))

  it.live("OpenRouter warms the connection with the model list and sends the key and latency preference", () =>
    Effect.gen(function*() {
      const server = yield* fakeServer(api(replay([text("hi"), finish("stop")])))
      const env = { OPENROUTER_BASE_URL: server.url, OPENROUTER_API_KEY: "sk-or-1", OPENROUTER_MODEL: "v/m", OPENROUTER_SORT_BY_LATENCY: "true" }
      const events = yield* Effect.scoped(Effect.gen(function*() {
        const l = yield* Llm
        return yield* Stream.runCollect(l.stream(request))
      }).pipe(Effect.provide(accountLayer("openrouter", true)), withEnv(env)))
      assert.strictEqual(events.length, 2)
      assert.deepStrictEqual(server.requests.map((r) => `${r.method} ${r.path}`), ["GET /v1/models", "POST /v1/chat/completions"])
      assert.strictEqual(server.requests[0]!.headers.authorization, "Bearer sk-or-1")
      assert.deepStrictEqual(server.requests[1]!.body.provider, { sort: "latency" })
    }))
})
