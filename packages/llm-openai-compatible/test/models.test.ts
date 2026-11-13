import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { listModels, parseModelList } from "../src/models.ts"
import { profiles, resolveBaseUrl } from "../src/profiles.ts"
import { fakeServer, json } from "./fakeServer.ts"

describe("parseModelList", () => {
  it("keeps OpenRouter models that take tools and whose reasoning is optional", () => {
    const models = parseModelList(profiles.openrouter, {
      data: [
        {
          id: "anthropic/claude-haiku-5.5",
          name: "Anthropic: Claude Haiku 5.5",
          supported_parameters: ["tools", "reasoning", "max_tokens"],
          reasoning: { mandatory: false, supported_efforts: ["none", "low", "medium", "high"] }
        },
        { id: "anthropic/claude-sonnet-5.5", name: "Sonnet", supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true } },
        { id: "some/no-tools", name: "No tools", supported_parameters: ["max_tokens"] },
        { id: "openai/gpt-4.1-nano", name: "GPT-4.1 Nano", supported_parameters: ["tools"] },
        { name: "no id" }
      ]
    })
    assert.deepStrictEqual(models, [
      { id: "anthropic/claude-haiku-5.5", label: "Anthropic: Claude Haiku 5.5", reasoningEfforts: ["none", "low", "medium", "high"], reasoning: true },
      { id: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano", reasoning: false }
    ])
  })

  it("reads the plain OpenAI shape, a `models` list, and drops duplicates", () => {
    assert.deepStrictEqual(
      parseModelList(profiles.ollama, { object: "list", data: [{ id: "qwen3:8b", object: "model" }, { id: "qwen3:8b" }, { id: "llama3.1:8b" }] }),
      [{ id: "qwen3:8b", label: "qwen3:8b" }, { id: "llama3.1:8b", label: "llama3.1:8b" }]
    )
    assert.deepStrictEqual(parseModelList(profiles.llamacpp, { models: [{ model: "gemma.gguf", name: "gemma" }] }), [{ id: "gemma.gguf", label: "gemma.gguf" }])
    assert.isUndefined(parseModelList(profiles.generic, { nope: true }))
  })
})

describe("listModels", () => {
  it.live("fetches the list with the key as a bearer token", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(json(200, { data: [{ id: "a" }, { id: "b" }] }))
      const models = yield* listModels({ profile: "vllm", baseUrl: api.url, apiKey: Redacted.make("k") })
      assert.deepStrictEqual(models.map((m) => m.id), ["a", "b"])
      assert.strictEqual(api.requests[0]?.path, "/v1/models")
      assert.strictEqual(api.requests[0]?.headers.authorization, "Bearer k")
    }))

  it.live("distinguishes a rejected key, a wrong address, an unreachable and a slow server", () =>
    Effect.gen(function*() {
      const denied = yield* fakeServer(json(401, { error: { message: "Invalid API key" } }))
      const e1 = yield* Effect.flip(listModels({ profile: "llamacpp", baseUrl: denied.url }))
      assert.strictEqual(e1.reason, "unauthorized")
      assert.match(e1.message, /rejected the API key \(401\)$/)

      const html = yield* fakeServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" })
        res.end("<html>router login</html>")
      })
      const e2 = yield* Effect.flip(listModels({ profile: "ollama", baseUrl: html.url }))
      assert.strictEqual(e2.reason, "invalid")
      assert.include(e2.message, "right address")

      const e3 = yield* Effect.flip(listModels({ profile: "ollama", baseUrl: "http://127.0.0.1:1/v1" }))
      assert.strictEqual(e3.reason, "unreachable")
      assert.include(e3.message, "Could not reach Ollama at http://127.0.0.1:1/v1")

      const slow = yield* fakeServer(() => {})
      const started = Date.now()
      const e4 = yield* Effect.flip(listModels({ profile: "ollama", baseUrl: slow.url, timeoutMs: 150 }))
      assert.strictEqual(e4.reason, "timeout")
      assert.isBelow(Date.now() - started, 1_000)
    }))
})

describe("resolveBaseUrl", () => {
  it("uses the profile default, adds /v1 to a bare local address, and refuses nonsense", () => {
    assert.strictEqual(resolveBaseUrl(profiles.openrouter, ""), "https://openrouter.ai/api/v1")
    assert.strictEqual(resolveBaseUrl(profiles.ollama, undefined), "http://localhost:11434/v1")
    assert.strictEqual(resolveBaseUrl(profiles.ollama, " http://192.168.1.20:11434/ "), "http://192.168.1.20:11434/v1")
    assert.strictEqual(resolveBaseUrl(profiles.llamacpp, "http://gpu:8080/v1/"), "http://gpu:8080/v1")
    assert.strictEqual(resolveBaseUrl(profiles.generic, "http://box:9000"), "http://box:9000")
    assert.isUndefined(resolveBaseUrl(profiles.generic, ""))
    assert.isUndefined(resolveBaseUrl(profiles.ollama, "not a url"))
    assert.isUndefined(resolveBaseUrl(profiles.ollama, "ftp://x/v1"))
  })
})

describe("listModels review regressions", () => {
  it.live("a rejected key that the server echoes back never reaches the error", () =>
    Effect.gen(function*() {
      const key = "sk-live-0123456789abcdefSECRET"
      const denied = yield* fakeServer(json(401, { error: { message: `Invalid API key: ${key}` } }))
      const e1 = yield* Effect.flip(listModels({ profile: "generic", baseUrl: denied.url, apiKey: Redacted.make(key) }))
      assert.strictEqual(e1.reason, "unauthorized")
      assert.include(e1.message, "rejected the API key (401)")
      assert.notInclude(e1.message, key)
      assert.notInclude(String(e1.cause), key)

      const broken = yield* fakeServer(json(500, { error: { message: `upstream failed for ${key}` } }))
      const e2 = yield* Effect.flip(listModels({ profile: "generic", baseUrl: broken.url, apiKey: Redacted.make(key) }))
      assert.include(e2.message, "answered 500")
      assert.notInclude(e2.message, key)
    }))
})
