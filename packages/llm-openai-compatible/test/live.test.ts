/**
 * Opt-in: each block runs only when its environment variables are set.
 *
 *   OPENROUTER_API_KEY=… [OPENROUTER_MODEL=…] pnpm --filter @pva/llm-openai-compatible test live
 *   HOME_MODEL_BASE_URL=http://host:11434/v1 HOME_MODEL_MODEL=qwen3:8b [HOME_MODEL_SERVER=ollama] \
 *     [HOME_MODEL_API_KEY=…] [HOME_MODEL_REASONING_EFFORT=none] pnpm --filter @pva/llm-openai-compatible test live
 *
 * Each logs the model list size, time to first text (cold, then warm), and
 * whether the model called a tool when it should.
 */
import { assert, describe, it } from "@effect/vitest"
import type { LlmEvent, LlmRequest } from "@pva/core"
import { Effect, Redacted, Stream } from "effect"
import { listModels } from "../src/models.ts"
import { make } from "../src/OpenAiCompatibleLlm.ts"
import { type ProfileId, profiles, type ReasoningEffort, resolveBaseUrl } from "../src/profiles.ts"

const env = process.env

const timeTool = {
  name: "current_time",
  description: "Returns the current local time.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
}

const greeting: LlmRequest = {
  system: "You are a voice assistant. Answer in one short sentence, plain text.",
  tools: [timeTool],
  messages: [{ role: "user", content: "Say hello in five words." }]
}
const askTime: LlmRequest = { ...greeting, messages: [{ role: "user", content: "What time is it? Use the tool." }] }

const run = (profileId: ProfileId, baseUrlSetting: string | undefined, model: string, key: string | undefined, effort: ReasoningEffort | undefined) =>
  Effect.gen(function*() {
    const profile = profiles[profileId]
    const baseUrl = resolveBaseUrl(profile, baseUrlSetting)
    assert.isDefined(baseUrl, "base address")
    const apiKey = key !== undefined && key !== "" ? Redacted.make(key) : undefined
    const listStarted = performance.now()
    const models = yield* listModels({ profile, baseUrl: baseUrl!, apiKey, timeoutMs: 5_000 })
    const info = models.find((m) => m.id === model)
    console.log(
      `${profile.label}: ${models.length} models listed in ${(performance.now() - listStarted).toFixed(0)} ms; ${model} ${
        info === undefined ? "NOT in the (filtered) list" : `listed (reasoning efforts: ${info.reasoningEfforts?.join(",") ?? "unknown"})`
      }`
    )
    const llm = yield* make({
      profile,
      baseUrl: baseUrl!,
      apiKey,
      model,
      maxTokens: 200,
      reasoningEffort: effort,
      sortByLatency: true,
      modelInfo: info,
      timeoutMs: 15_000 // generous here: the point is to measure (a cold local model load takes seconds)
    })
    const timed = (label: string, request: LlmRequest) =>
      Effect.gen(function*() {
        const started = performance.now()
        let first: number | undefined
        const events = yield* llm.stream(request).pipe(
          Stream.tap((e: LlmEvent) => Effect.sync(() => (e._tag !== "Done" ? (first ??= performance.now()) : undefined))),
          Stream.runCollect
        )
        const textOut = events.flatMap((e) => (e._tag === "TextDelta" ? [e.text] : [])).join("")
        const tools = events.flatMap((e) => (e._tag === "ToolCall" ? [e.name] : []))
        console.log(
          `${label}: first event ${first === undefined ? "-" : (first - started).toFixed(0)} ms, total ${(performance.now() - started).toFixed(0)} ms, ` +
            `text ${JSON.stringify(textOut)}, tools [${tools.join(", ")}], ${JSON.stringify(events.at(-1))}`
        )
        return events
      })
    const cold = yield* timed("cold", greeting)
    yield* timed("warm", greeting)
    const withTool = yield* timed("tool", askTime)
    assert.strictEqual(cold.at(-1)?._tag, "Done")
    assert.isTrue(withTool.some((e) => e._tag === "ToolCall"), "the model called the tool")
  })

describe.skipIf(!env.OPENROUTER_API_KEY)("OpenRouter (live)", () => {
  it.live("lists models, streams a reply and a tool call, logs time to first text", () =>
    run("openrouter", env.OPENROUTER_BASE_URL, env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-5.5", env.OPENROUTER_API_KEY, "none"), 90_000)
})

describe.skipIf(!env.HOME_MODEL_BASE_URL || !env.HOME_MODEL_MODEL)("Home model server (live)", () => {
  it.live("lists models, streams a reply and a tool call, logs time to first text", () =>
    run(
      (env.HOME_MODEL_SERVER as ProfileId | undefined) ?? "ollama",
      env.HOME_MODEL_BASE_URL,
      env.HOME_MODEL_MODEL ?? "",
      env.HOME_MODEL_API_KEY,
      env.HOME_MODEL_REASONING_EFFORT as ReasoningEffort | undefined
    ), 90_000)
})
