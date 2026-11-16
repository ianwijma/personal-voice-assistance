import { assert, describe, it } from "@effect/vitest"
import { LlmError } from "@pva/core"
import { ConfigProvider, Effect, Exit, Redacted } from "effect"
import { accountConfig, defaultAddress, isAccountId, notSetUpMessage, WARM_UP_LOAD_MS } from "../src/account.ts"

const withEnv = (env: Record<string, string>) => Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))
const failure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason?._tag === "Fail" ? reason.error : undefined
}
const message = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  const e = failure(exit)
  return e instanceof LlmError ? e.message : undefined
}

describe("account helpers", () => {
  it("recognises only the two account ids (not inherited object keys)", () => {
    assert.isTrue(isAccountId("openrouter"))
    assert.isTrue(isAccountId("home-model"))
    assert.isFalse(isAccountId("anthropic"))
    assert.isFalse(isAccountId("toString"))
    assert.isFalse(isAccountId(""))
  })

  it("OpenRouter has a default address, a home model has none", () => {
    assert.strictEqual(defaultAddress("openrouter"), "https://openrouter.ai/api/v1")
    assert.isUndefined(defaultAddress("home-model"))
  })

  it("the not-set-up sentence names the account and what is missing", () => {
    assert.strictEqual(notSetUpMessage("home-model", "key"), "Home model is not set up: add its API key in Shared settings › Language model accounts.")
    assert.strictEqual(notSetUpMessage("openrouter", "address"), "OpenRouter is not set up: add the server address in Shared settings › Language model accounts.")
  })

  it("a home model's load warm-up may take a minute", () => {
    assert.strictEqual(WARM_UP_LOAD_MS, 60_000)
  })
})

describe("accountConfig: defaults and edges", () => {
  it.effect("defaults: 512 tokens, 5 s give-up, warm-up on", () =>
    Effect.gen(function*() {
      const o = yield* accountConfig("openrouter").pipe(withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "v/m" }))
      assert.deepStrictEqual([o.maxTokens, o.timeoutMs, o.warmUp, o.sortByLatency], [512, 5000, "models", true])
    }))

  it.effect("a blank or whitespace-only OpenRouter key counts as not set", () =>
    Effect.gen(function*() {
      for (const key of ["", "   "]) {
        const exit = yield* Effect.exit(accountConfig("openrouter").pipe(withEnv({ OPENROUTER_API_KEY: key, OPENROUTER_MODEL: "v/m" })))
        assert.strictEqual(message(exit), notSetUpMessage("openrouter", "key"))
      }
    }))

  it.effect("a blank home-model key is no key; a whitespace address is no address", () =>
    Effect.gen(function*() {
      const o = yield* accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "http://h:1", HOME_MODEL_API_KEY: "  ", HOME_MODEL_MODEL: "m" }))
      assert.isUndefined(o.apiKey)
      const none = yield* Effect.exit(accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "   ", HOME_MODEL_MODEL: "m" })))
      assert.strictEqual(message(none), notSetUpMessage("home-model", "address"))
    }))

  it.effect("an OpenRouter address replaces the default (a gateway), and OpenRouter's switches are read", () =>
    Effect.gen(function*() {
      const o = yield* accountConfig("openrouter").pipe(withEnv({
        OPENROUTER_API_KEY: "k",
        OPENROUTER_MODEL: "v/m",
        OPENROUTER_BASE_URL: "https://gateway.example/or/v1",
        OPENROUTER_SORT_BY_LATENCY: "false",
        OPENROUTER_WARM_UP: "false"
      }))
      assert.strictEqual(o.baseUrl, "https://gateway.example/or/v1")
      assert.strictEqual(o.sortByLatency, false)
      assert.isUndefined(o.warmUp)
    }))

  it.effect("the home model never sorts by latency, whatever OPENROUTER_ says", () =>
    Effect.gen(function*() {
      const o = yield* accountConfig("home-model").pipe(withEnv({ HOME_MODEL_BASE_URL: "http://h:1", HOME_MODEL_MODEL: "m", OPENROUTER_SORT_BY_LATENCY: "true" }))
      assert.strictEqual(o.sortByLatency, false)
    }))

  it.effect("the two accounts read only their own prefix", () =>
    Effect.gen(function*() {
      const env = { OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "or/m", HOME_MODEL_BASE_URL: "http://h:1", HOME_MODEL_MODEL: "home-m" }
      const or = yield* accountConfig("openrouter").pipe(withEnv(env))
      const home = yield* accountConfig("home-model").pipe(withEnv(env))
      assert.strictEqual(or.model, "or/m")
      assert.strictEqual(home.model, "home-m")
      assert.isUndefined(home.apiKey)
      assert.strictEqual(Redacted.value(or.apiKey!), "k")
    }))

  it.effect("a malformed number is a config error, not an LlmError", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(accountConfig("openrouter").pipe(withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m", OPENROUTER_MAX_TOKENS: "lots" })))
      assert.isTrue(Exit.isFailure(exit))
      assert.isFalse(failure(exit) instanceof LlmError)
    }))

  it.effect("the missing-model sentence names the account; an OpenRouter address with a query is refused without the key in it", () =>
    Effect.gen(function*() {
      const noModel = yield* Effect.exit(accountConfig("openrouter").pipe(withEnv({ OPENROUTER_API_KEY: "sk-or-secret" })))
      assert.strictEqual(message(noModel), "Choose a model for OpenRouter.")
      const query = yield* Effect.exit(accountConfig("openrouter").pipe(withEnv({
        OPENROUTER_API_KEY: "sk-or-secret",
        OPENROUTER_MODEL: "m",
        OPENROUTER_BASE_URL: "https://gw.example/v1?token=sk-or-secret"
      })))
      assert.isDefined(message(query))
      assert.notInclude(message(query)!, "sk-or-secret")
    }))
})
