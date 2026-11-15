/**
 * No configured credential leaks into an error or a log line, whatever the
 * upstream sends back: every failure the adapter has, with the credential
 * planted (as is, URL-encoded, base64, inside a Basic header, JSON-escaped) in
 * every position the upstream controls.
 */
import { assert, describe, it } from "@effect/vitest"
import type { LlmRequest } from "@pva/core"
import { Effect, Exit, Redacted, Stream } from "effect"
import { readFileSync } from "node:fs"
import { homeModelAgent, openAiCompatibleAgent } from "../src/agent.ts"
import { listModels } from "../src/models.ts"
import { make } from "../src/OpenAiCompatibleLlm.ts"
import { addressSecrets, redact, sanitize, secretList } from "../src/redact.ts"
import { alignedB64, b64, captureLogs, KEYS, leaksOf, planted, serialise, unicodeEscaped } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const request: LlmRequest = { system: "", messages: [{ role: "user", content: "Hi" }], tools: [] }

const respond = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

const sseBody = (lines: ReadonlyArray<string>) =>
  new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream" } })

/** A body that sends one chunk and then fails with `error`. */
const brokenStream = (error: unknown) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"))
        c.error(error)
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  )

/** A request that never gets an answer (but honours its abort signal, like `fetch`). */
const hang: Fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
  })

/** Every upstream-influenced failure of the chat call, with `p` (the planted credential text) wherever the upstream decides. */
const chatScenarios = (p: string): ReadonlyArray<readonly [string, Fetch]> => {
  const headers = { "retry-after": p, "x-request-id": p, "www-authenticate": `Bearer realm="${p}"` }
  const statusCases = [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 529].flatMap((status) => [
    [`${status} {error:{message}}`, async () => respond(status, JSON.stringify({ error: { message: p, code: p } }), headers)] as const,
    [`${status} {error: string}`, async () => respond(status, JSON.stringify({ error: p }), headers)] as const,
    [`${status} {detail}`, async () => respond(status, JSON.stringify({ detail: p }), headers)] as const,
    [`${status} text`, async () => respond(status, `upstream says ${p}`, { ...headers, "content-type": "text/plain" })] as const
  ])
  return [
    ...statusCases,
    ["200 JSON that does not parse", async () => respond(200, `{"oops": ${p}`)],
    ["200 JSON with an error field", async () => respond(200, JSON.stringify({ error: { message: p, code: 500 } }))],
    ["200 JSON with no choices", async () => respond(200, JSON.stringify({ note: p }))],
    ["stream line that is not JSON", async () => sseBody([`data: ${p}\n\n`])],
    ["stream error event", async () => sseBody([`event: error\ndata: ${JSON.stringify({ error: { message: p, code: p } })}\n\n`])],
    ["stream chunk with an error", async () => sseBody([`data: ${JSON.stringify({ error: { message: p, code: 503 } })}\n\n`])],
    ["stream error that is not an object", async () => sseBody([`data: ${JSON.stringify({ error: p })}\n\n`])],
    [
      "finish_reason error",
      async () => sseBody([`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "error", error: { message: p } }] })}\n\n`])
    ],
    [
      "tool call with invalid JSON arguments",
      async () =>
        sseBody([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: p, function: { name: p, arguments: `{${p}` } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`
        ])
    ],
    [
      "tool call without a name",
      async () =>
        sseBody([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: p, function: { arguments: "{}" } }] } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`
        ])
    ],
    ["empty stream", async () => sseBody([`: ${p}\n\n`])],
    ["stream read error", async () => brokenStream(new Error(p))],
    ["stream read error with a cause", async () => brokenStream(new TypeError("terminated", { cause: new Error(p) }))],
    ["connection error (TypeError with cause)", () => Promise.reject(new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${p}`) }))],
    ["connection error (plain Error)", () => Promise.reject(new Error(p))],
    ["connection error (not an Error)", () => Promise.reject({ detail: p })],
    ["stall: no response", hang]
  ]
}

const modelScenarios = (p: string): ReadonlyArray<readonly [string, Fetch]> => [
  ...[400, 401, 403, 404, 429, 500, 503].map((status) =>
    [`${status}`, async () => respond(status, JSON.stringify({ error: { message: p } }), { "retry-after": p })] as const
  ),
  ["200 not JSON", async () => respond(200, `<html>${p}</html>`)],
  ["200 unknown format", async () => respond(200, JSON.stringify({ list: p }))],
  ["connection error", () => Promise.reject(new TypeError("fetch failed", { cause: new Error(p) }))],
  ["non-Error rejection", () => Promise.reject(p)],
  ["timeout", hang]
]

/** Runs `effect` with a logger that records every line; returns the exit and the log text. */
const withLogs = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const exit = yield* effect.pipe(
      Effect.exit,
      Effect.provide(captureLogs(logs))
    )
    return { exit, logs: logs.join("\n") }
  })

const assertNoLeak = (key: string, what: string, exit: Exit.Exit<unknown, unknown>, logs: string, mustFail = true) => {
  if (mustFail) assert.isTrue(Exit.isFailure(exit), `${what}: expected a failure`)
  const text = `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs}`
  assert.deepStrictEqual(leaksOf(key, text), [], `${what} leaked the credential: ${text.slice(0, 2000)}`)
}

describe("credentials never leak (llm-openai-compatible)", () => {
  for (const key of KEYS) {
    it.live(`chat completions: every failure, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        for (const [what, fetch] of chatScenarios(planted(key))) {
          const llm = yield* make({
            profile: "openrouter",
            baseUrl: "http://upstream.test/v1",
            apiKey: Redacted.make(key),
            model: "m",
            maxTokens: 16,
            timeoutMs: 150,
            fetch
          })
          const { exit, logs } = yield* withLogs(Stream.runCollect(llm.stream(request)))
          assertNoLeak(key, what, exit, logs)
          if (Exit.isFailure(exit)) assert.notStrictEqual(String(exit.cause).replace(/\[redacted\]/g, "").trim(), "", what)
        }
      }), 60_000)

    it.live(`model list: every failure, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        for (const [what, fetch] of modelScenarios(planted(key))) {
          const { exit, logs } = yield* withLogs(
            listModels({ profile: "openrouter", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(key), timeoutMs: 150, fetch })
          )
          assertNoLeak(key, what, exit, logs)
        }
      }))

    it.live(`agent start and status lines, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        const scenarios: ReadonlyArray<readonly [string, Fetch, boolean]> = [
          ...modelScenarios(p).map(([what, fetch]) => [what, fetch, true] as const),
          // A model list whose only model id is the echoed key: start succeeds, the status line names the model.
          ["model id echoes the key", async () => respond(200, JSON.stringify({ data: [{ id: p }] })), false],
          // Warm-up fails with the key in the body: the status line carries the error.
          [
            "warm-up fails",
            async (input) =>
              String(input).endsWith("/models")
                ? respond(200, JSON.stringify({ data: [{ id: "m" }] }))
                : respond(500, JSON.stringify({ error: { message: p } })),
            false
          ]
        ]
        for (const [what, fetch, mustFail] of scenarios) {
          const statuses: Array<string> = []
          const agent = openAiCompatibleAgent({ id: "home-model", name: "Home", envPrefix: "HOME_MODEL_", fetch })
          const { exit, logs } = yield* withLogs(
            Effect.scoped(
              agent.start({
                settings: {
                  server: "generic",
                  baseUrl: "http://upstream.test/v1",
                  apiKey: key,
                  model: "",
                  systemPrompt: "",
                  maxTokens: 16,
                  temperature: "",
                  reasoningEffort: "default",
                  timeoutMs: 150,
                  warmUp: what === "warm-up fails"
                } as never,
                setStatus: (s) => {
                  if (s !== undefined) statuses.push(s.text)
                }
              }).pipe(Effect.andThen(Effect.sleep(300)))
            )
          )
          assertNoLeak(key, what, exit, `${logs}\n${statuses.join("\n")}`, mustFail)
        }
        assert.isDefined(homeModelAgent)
      }))
  }

  it("masks every form, at any length, and keeps the rest of the message readable", () => {
    const key = "abc+def/ghi="
    assert.strictEqual(redact("invalid key p4ss", ["p4ss"]), "invalid key [redacted]")
    assert.strictEqual(redact(`echo ${encodeURIComponent(key)}`, [key]), "echo [redacted]")
    assert.strictEqual(redact(`echo ${encodeURIComponent(key).toLowerCase()}`, [key]), "echo [redacted]")
    assert.strictEqual(redact(`echo ${encodeURIComponent(encodeURIComponent(key))}`, [key]), "echo [redacted]")
    assert.strictEqual(redact(`raw ${b64(key)} end`, [key]), "raw [redacted] end")
    assert.strictEqual(redact(JSON.stringify({ m: `x${key}y` }), [key]), "{\"m\":\"x[redacted]y\"}")
    // Inside a longer base64 value at each of the three alignments ("user:" puts the key at offset 2). The
    // characters checked are the ones that depend only on the key (computed independently in leaks.ts), and
    // each input is first checked to contain them: an assertion that could not fail would prove nothing.
    for (const prefix of ["auth:", "u:", "us:", "use:", "user:"]) {
      const encoded = b64(prefix + key + "!")
      const fragment = alignedB64(key, prefix.length % 3)
      assert.include(encoded, fragment, prefix)
      assert.isAtLeast(fragment.length, 12, prefix)
      const masked = redact(`auth ${encoded}`, [key])
      assert.notInclude(masked, fragment, prefix)
      assert.include(masked, "[redacted]", prefix)
    }
    // Forms the adapter tests cannot reach with their keys (each assertion first checks its input holds the
    // form, so it can fail): a space sent as "+", the whole base64 of a key too short for fragments, the
    // generic patterns for tokens nobody configured, nested fields, a key configured with spaces around it.
    assert.include("q=a+b+c9", "a+b+c9")
    assert.strictEqual(redact("q=a+b+c9 end", ["a b c9"]), "q=[redacted] end")
    assert.strictEqual(redact(`raw ${b64("a7")} end`, ["a7"]), "raw [redacted] end") // too short for fragments: only the whole encoding
    assert.strictEqual(redact("Authorization: Bearer abcdef123456", []), "Authorization: Bearer [redacted]")
    assert.strictEqual(redact("key sk-abcdefgh12345 refused", []), "key [redacted] refused")
    assert.strictEqual(redact("GET /x?api_key=zzz&b=1", []), "GET /x?api_key=[redacted]&b=1")
    assert.strictEqual(redact(`u ${unicodeEscaped(key)} v`, [key]), "u [redacted] v")
    const nested = sanitize([key], { message: "m", detail: { inner: [`x ${key}`] } } as { message: string; detail: unknown })
    assert.deepStrictEqual(leaksOf(key, JSON.stringify(nested)), [])
    assert.include(JSON.stringify(nested), "[redacted]")
    assert.strictEqual(redact(`got ${key}.`, secretList(`  ${key} `)), "got [redacted].")
    for (const [address, parts] of [
      ["http://alice:pw%20x@h.test/v1?token=qq1&b=2", ["alice", "pw%20x", "pw x", "qq1"]],
      ["http://bob:pass word@[bad/v1?k=zz9", ["bob", "pass word", "zz9"]]
    ] as const) {
      const found = addressSecrets(address)
      for (const part of parts) assert.include(found, part, address)
    }
    // A placeholder-length credential is masked where it stands alone, not inside ordinary words.
    assert.strictEqual(redact("key x refused by example.com", ["x"]), "key [redacted] refused by example.com")
  })

  it("the redaction helper is identical in every adapter", () => {
    const read = (pkg: string) => readFileSync(new URL(`../../${pkg}/src/redact.ts`, import.meta.url), "utf8")
    const readTest = (pkg: string) => readFileSync(new URL(`../../${pkg}/test/leaks.ts`, import.meta.url), "utf8")
    const mine = read("llm-openai-compatible")
    const mineTest = readTest("llm-openai-compatible")
    for (const pkg of ["llm-anthropic", "decide-typesafe", "module-home-assistant", "stt-deepgram", "tts-cartesia", "tts-elevenlabs", "agent-claude-code"]) {
      assert.strictEqual(read(pkg), mine, `${pkg}/src/redact.ts differs`)
      assert.strictEqual(readTest(pkg), mineTest, `${pkg}/test/leaks.ts differs`)
    }
  })
})
