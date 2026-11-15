import { assert, describe, it } from "@effect/vitest"
import {
  type AgentEvent,
  type AgentTurnInput,
  type ExtendedModuleInstance,
  makeToolRegistry,
  type ModuleStartError,
  type Trace
} from "@pva/core"
import { Effect, Schema, Stream } from "effect"
import { homeModelAgent, openAiCompatibleAgent, openRouterAgent } from "../src/agent.ts"
import { fakeServer, finish, type Handler, json, replay, text, toolDelta } from "./fakeServer.ts"

/** `/models` answers a list; `/chat/completions` runs the given handler. */
const server = (models: unknown, chat: Handler, modelsStatus = 200): Handler => (req, res, body) => {
  if (req.url?.endsWith("/models")) json(modelsStatus, models)(req, res, body)
  else chat(req, res, body)
}

const homeSettings = (url: string, extra: Record<string, unknown> = {}) => ({
  server: "ollama",
  baseUrl: url,
  apiKey: undefined,
  model: "",
  systemPrompt: "",
  maxTokens: 512,
  temperature: "",
  reasoningEffort: "default",
  timeoutMs: 2_000,
  warmUp: false,
  ...extra
})

const start = (settings: Record<string, unknown>, statuses: Array<string> = [], def = homeModelAgent) =>
  Effect.scoped(Effect.gen(function*() {
    const instance: ExtendedModuleInstance = yield* def.start({
      settings: settings as never,
      setStatus: (s) => {
        if (s !== undefined) statuses.push(`${s.tone}: ${s.text}`)
      }
    })
    return instance
  }))

const trace = (): Trace => ({ id: 1, mode: "text", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] })

const timeTool = {
  name: "current_time",
  description: "The time.",
  parameters: Schema.Struct({}),
  speculative: true,
  execute: () => Effect.succeed("14:32")
}

const input = (marks: Array<string>, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
  turnId: 1,
  conversationId: "c1",
  text: "What time is it?",
  utterance: "Hey local, what time is it?",
  source: "text",
  spoken: false,
  routedBy: "trigger",
  history: [],
  system: "Be brief.",
  context: undefined,
  tools: makeToolRegistry([{ name: "clock", tools: [timeTool] }]),
  actions: [],
  deciders: new Map(),
  promoted: Effect.void,
  speculative: false,
  mark: (m) => void marks.push(m),
  trace: trace(),
  maxToolRounds: 3,
  ...overrides
})

describe("openrouter and home-model agent definitions", () => {
  it("declare model agents, disabled by default, with their settings in form order", () => {
    assert.deepStrictEqual([openRouterAgent.id, openRouterAgent.kind, openRouterAgent.agentKind, openRouterAgent.enabledByDefault], [
      "openrouter",
      "agent",
      "model",
      false
    ])
    assert.deepStrictEqual(Object.keys(openRouterAgent.settings), [
      "apiKey",
      "model",
      "systemPrompt",
      "sortByLatency",
      "maxTokens",
      "temperature",
      "reasoningEffort",
      "timeoutMs",
      "baseUrl"
    ])
    assert.deepStrictEqual(Object.keys(homeModelAgent.settings), [
      "server",
      "baseUrl",
      "model",
      "apiKey",
      "systemPrompt",
      "maxTokens",
      "temperature",
      "timeoutMs",
      "reasoningEffort",
      "warmUp"
    ])
    const or = openRouterAgent.settings as Record<string, { env: string | undefined; defaultValue: unknown }>
    assert.strictEqual(or.apiKey?.env, "OPENROUTER_API_KEY")
    assert.strictEqual(or.model?.defaultValue, "anthropic/claude-haiku-5.5")
    assert.strictEqual(or.reasoningEffort?.defaultValue, "none")
    assert.strictEqual((openRouterAgent.settings.apiKey as unknown as { required: boolean }).required, true)
    const home = homeModelAgent.settings as Record<string, { env: string | undefined; defaultValue: unknown }>
    assert.deepStrictEqual(
      ["server", "baseUrl", "apiKey", "model", "maxTokens", "timeoutMs"].map((k) => home[k]?.env),
      ["HOME_MODEL_SERVER", "HOME_MODEL_BASE_URL", "HOME_MODEL_API_KEY", "HOME_MODEL_MODEL", "HOME_MODEL_MAX_TOKENS", "HOME_MODEL_TIMEOUT_MS"]
    )
    assert.strictEqual(home.maxTokens?.defaultValue, 512)
    assert.strictEqual(home.timeoutMs?.defaultValue, 5_000)
  })

  it.live("start checks reachability, picks the first listed model, offers the list, and answers a turn with a tool round", () =>
    Effect.gen(function*() {
      let chats = 0
      const api = yield* fakeServer(server({ data: [{ id: "qwen3:8b" }, { id: "llama3.1:8b" }] }, (req, res, body) => {
        chats++
        if (chats === 1) replay([toolDelta([{ index: 0, id: "c1", function: { name: "current_time", arguments: "{}" } }]), finish("tool_calls")])(req, res, body)
        else replay([text("It's 14:32."), finish("stop")])(req, res, body)
      }))
      const statuses: Array<string> = []
      const instance = yield* start(homeSettings(api.url, { systemPrompt: "Speak like a pirate." }), statuses)
      const agent = instance.agents![0]!
      assert.deepStrictEqual([agent.id, agent.kind, agent.speculate, agent.systemPrompt, agent.firstEventTimeoutMs], [
        "home-model",
        "model",
        true,
        "Speak like a pirate.",
        2_000
      ])
      assert.deepStrictEqual(instance.settingOptions?.(), {
        model: [{ value: "qwen3:8b", label: "qwen3:8b" }, { value: "llama3.1:8b", label: "llama3.1:8b" }]
      })
      assert.deepStrictEqual(statuses.at(-1), "ok: Ollama · qwen3:8b")

      const marks: Array<string> = []
      const events: ReadonlyArray<AgentEvent> = yield* Stream.runCollect(agent.turn(input(marks)))
      assert.deepStrictEqual(events.map((e) => e._tag), ["ToolStarted", "ToolFinished", "TextDelta"])
      assert.deepStrictEqual(events.at(-1), { _tag: "TextDelta", text: "It's 14:32." })
      assert.includeMembers(marks, ["llmRequestSent", "llmFirstToken"])
      const second = api.requests.filter((r) => r.path.endsWith("/chat/completions"))[1]!.body
      assert.strictEqual(second.model, "qwen3:8b")
      assert.deepStrictEqual(second.messages.at(-1), { role: "tool", tool_call_id: "c1", content: "14:32" })
    }))

  it.live("a wrong address, a rejected key and an empty model list are start errors", () =>
    Effect.gen(function*() {
      const unreachable = yield* Effect.flip(start(homeSettings("http://127.0.0.1:1")))
      assert.include(unreachable.message, "Could not reach Ollama at http://127.0.0.1:1/v1")
      assert.include(unreachable.message, "Is the server running")

      const denied = yield* fakeServer(server({ error: { message: "Invalid API key" } }, () => {}, 401))
      const e401: ModuleStartError = yield* Effect.flip(start(homeSettings(denied.url, { server: "llamacpp" })))
      assert.include(e401.message, "rejected the API key")

      const empty = yield* fakeServer(server({ data: [] }, () => {}))
      const none = yield* Effect.flip(start(homeSettings(empty.url, { server: "vllm" })))
      assert.include(none.message, "vLLM lists no models")

      const generic = yield* Effect.flip(start(homeSettings("", { server: "generic" })))
      assert.include(generic.message, "Set the server address")
    }))

  it.live("OpenRouter needs a key, sends latency sort and gated reasoning, and warns about a model outside the list", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(server(
        {
          data: [{
            id: "openai/gpt-6-luna",
            name: "OpenAI: GPT-6 Luna",
            supported_parameters: ["tools", "reasoning"],
            reasoning: { mandatory: false, supported_efforts: ["none", "low"] }
          }]
        },
        replay([text("Hello."), finish("stop")])
      ))
      const base = {
        baseUrl: api.url,
        apiKey: "sk-or-test",
        model: "openai/gpt-6-luna",
        systemPrompt: "",
        sortByLatency: true,
        maxTokens: 512,
        temperature: "0.2",
        reasoningEffort: "none",
        timeoutMs: 2_000
      }
      const missingKey = yield* Effect.flip(start({ ...base, apiKey: undefined }, [], openRouterAgent))
      assert.include(missingKey.message, "Add your OpenRouter API key")

      const instance = yield* start(base, [], openRouterAgent)
      yield* Stream.runDrain(instance.agents![0]!.turn(input([], { tools: makeToolRegistry([]) })))
      const chat = api.requests.find((r) => r.path.endsWith("/chat/completions"))!
      assert.strictEqual(chat.headers.authorization, "Bearer sk-or-test")
      assert.deepStrictEqual(chat.body.provider, { sort: "latency" })
      assert.deepStrictEqual(chat.body.reasoning, { effort: "none" })
      assert.strictEqual(chat.body.temperature, 0.2)
      assert.isUndefined(chat.body.tools)

      const statuses: Array<string> = []
      yield* start({ ...base, model: "some/other-model" }, statuses, openRouterAgent)
      assert.strictEqual(statuses.at(-1), "warning: some/other-model is not in OpenRouter's list of models with tools")
    }))

  it.live("warm-up loads the model in the background with a one-token request", () =>
    Effect.gen(function*() {
      const api = yield* fakeServer(server({ data: [{ id: "m" }] }, replay([text("H"), finish("length")])))
      const statuses: Array<string> = []
      yield* Effect.scoped(Effect.gen(function*() {
        yield* homeModelAgent.start({
          settings: homeSettings(api.url, { warmUp: true }) as never,
          setStatus: (s) => void (s && statuses.push(`${s.tone}: ${s.text}`))
        })
        for (let i = 0; i < 50 && statuses.at(-1) !== "ok: Ollama · m"; i++) yield* Effect.sleep("20 millis")
      }))
      const chat = api.requests.find((r) => r.path.endsWith("/chat/completions"))!
      assert.strictEqual(chat.body.max_tokens, 1)
      assert.deepStrictEqual(statuses, ["neutral: Connecting to Ollama…", "neutral: Loading m…", "ok: Ollama · m"])
    }))

  it("a third endpoint is one call", () => {
    const lab = openAiCompatibleAgent({ id: "lab-vllm", name: "Lab server", envPrefix: "LAB_" })
    assert.strictEqual((lab.settings as Record<string, { env?: string }>).baseUrl?.env, "LAB_BASE_URL")
  })
})
