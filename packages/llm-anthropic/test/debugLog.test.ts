/**
 * The SDK's own log lines at every level, debug included (fourth review, finding 1): with
 * `ANTHROPIC_LOG=debug` and Effect debug logging on, the SDK logs request and response details as
 * objects. Those used to be turned into text by `inspect`, which cuts every string at 10 000
 * characters, before redaction: a credential straddling that cut survived as a prefix. Here the
 * credential sits at every position across the limit, and the log is captured in full (no
 * inspection limit of its own).
 */
import { assert, describe, it } from "@effect/vitest"
import { type LlmRequest } from "@pva/core"
import { Effect, Exit, Logger, Redacted, References, Stream } from "effect"
import { defaults, make } from "../src/index.ts"
import { logText } from "../src/redact.ts"
import { leaksOf, serialise } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const request: LlmRequest = { system: "", messages: [{ role: "user", content: "Hi" }], tools: [] }
/** 40 characters, shaped like nothing the generic patterns know: only the configured-secret match can catch it. */
const KEY = "Qk7vR2mX9pL4wT8nB3cZ6hJ1fD5sG0yUeAiOoPxW"
/** Node's `inspect` default `maxStringLength`. */
const INSPECT_LIMIT = 10_000

/** Everything logged, as plain text: strings as they are, anything else in full JSON (never cut). */
const fullText = (u: unknown): string => {
  if (typeof u === "string") return u
  if (Array.isArray(u)) return u.map(fullText).join(" ")
  try {
    return JSON.stringify(u) ?? String(u)
  } catch {
    return String(u)
  }
}

const runWithLogs = (fetch: Fetch) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const before = process.env.ANTHROPIC_LOG
    process.env.ANTHROPIC_LOG = "debug"
    const exit = yield* Effect.scoped(Effect.flatMap(make({ ...defaults, apiKey: Redacted.make(KEY), baseURL: "http://gateway.test", warmUp: false, timeoutMs: 1_000, fetch }), (llm) => Stream.runCollect(llm.stream(request)))).pipe(
      Effect.exit,
      Effect.provide(Logger.layer([Logger.make(({ logLevel, message }) => logs.push(`${logLevel} ${fullText(message)}`))])),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.ensuring(Effect.sync(() => {
        if (before === undefined) delete process.env.ANTHROPIC_LOG
        else process.env.ANTHROPIC_LOG = before
      }))
    )
    // The SDK's log lines are forked: let them land.
    yield* Effect.sleep(20)
    return { exit, logs }
  })

describe("the SDK's debug log (llm-anthropic, fourth review finding 1)", () => {
  it.live("an HTTP 400 whose message holds the credential straddling inspect's 10 000-character limit: no part of it is logged", () =>
    Effect.gen(function*() {
      let debugLines = 0
      // Positions from 30 characters before the limit to past it: the cut falls before, inside and after the key.
      for (let before = INSPECT_LIMIT - KEY.length - 30; before <= INSPECT_LIMIT + 4; before += 3) {
        const message = `${"f".repeat(before)}${KEY}`
        const fetch: Fetch = async () =>
          new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
            status: 400,
            headers: { "content-type": "application/json", "request-id": "req_1" }
          })
        const { exit, logs } = yield* runWithLogs(fetch)
        assert.isTrue(Exit.isFailure(exit))
        debugLines += logs.filter((l) => l.startsWith("Debug Anthropic SDK")).length
        const text = `${logs.join("\n")}\n${serialise(exit)}`
        assert.deepStrictEqual(leaksOf(KEY, text), [], `key at ${before}: ${text.slice(0, 600)}`)
        // A prefix of 12 characters or more is a leak too (the reviewer saw the first 20).
        for (let i = 0; i + 12 <= KEY.length; i++) assert.notInclude(text, KEY.slice(i, i + 12), `key at ${before}: part ${i}`)
      }
      // The scenario really ran at debug level (the SDK wrote its request and response details).
      assert.isAbove(debugLines, 0)
    }), 60_000)

  it.live("every level the SDK can log at: a warning, info and debug carrying the key in nested strings and errors", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const exit = yield* Effect.scoped(Effect.flatMap(make({ ...defaults, apiKey: Redacted.make(KEY), baseURL: "http://gateway.test", warmUp: false, timeoutMs: 1_000, fetch: async () => new Response("{}", { status: 500 }) }), (llm) => Stream.runCollect(llm.stream(request)))).pipe(
        Effect.exit,
        Effect.provide(Logger.layer([Logger.make(({ logLevel, message }) => logs.push(`${logLevel} ${fullText(message)}`))])),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
      assert.isTrue(Exit.isFailure(exit))
      // What the SDK's logger does with its arguments (a message, then objects), at every inspection limit.
      for (const before of [0, INSPECT_LIMIT - 20, INSPECT_LIMIT - 1, 65_536 - 20]) {
        const nested = { response: { body: { error: { message: `${"f".repeat(before)}${KEY}` } } }, list: [`${"g".repeat(before)}${KEY}`] }
        const error = Object.assign(new Error(`${"e".repeat(before)}${KEY}`), { body: `${"b".repeat(before)}${KEY}` })
        const text = logText(["debug details", nested, error, `${"s".repeat(before)}${KEY}`], [KEY])
        assert.deepStrictEqual(leaksOf(KEY, text), [], `nested at ${before}`)
        for (let i = 0; i + 12 <= KEY.length; i++) assert.notInclude(text, KEY.slice(i, i + 12), `nested at ${before}: part ${i}`)
      }
      assert.deepStrictEqual(leaksOf(KEY, logs.join("\n")), [])
    }))

  it.live("a stream event that is not JSON and starts with the credential: the runtime's parse error (which quotes the first 10 characters, already cut) is never used as text", () =>
    Effect.gen(function*() {
      const start = JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      for (const data of [KEY, `${KEY}x`, `<${KEY}`, ` ${KEY}`]) {
        const fetch: Fetch = async () =>
          new Response(`event: message_start\ndata: ${start}\n\nevent: content_block_delta\ndata: ${data}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
        const { exit, logs } = yield* runWithLogs(fetch)
        assert.isTrue(Exit.isFailure(exit))
        const text = `${logs.join("\n")}\n${serialise(exit)}`
        for (let i = 0; i + 8 <= KEY.length; i++) assert.notInclude(text, KEY.slice(i, i + 8), `data ${JSON.stringify(data.slice(0, 3))}: part ${i}: ${text.slice(0, 400)}`)
      }
    }))
})
