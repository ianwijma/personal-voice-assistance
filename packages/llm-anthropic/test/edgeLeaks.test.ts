/**
 * Credentials at the edges of the adapter (third review, family 1): a base
 * address with credentials of its own, a malformed address, text that the SDK
 * or the adapter shortens, and anything thrown while building a request.
 */
import { assert, describe, it } from "@effect/vitest"
import { LlmError, type LlmRequest } from "@pva/core"
import { Cause, Effect, Exit, Redacted, Stream } from "effect"
import { defaults, make } from "../src/index.ts"
import { ADDRESS_SECRETS, captureLogs, KEYS, leaksOf, loadedError, serialise, straddling } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const request: LlmRequest = { system: "", messages: [{ role: "user", content: "Hi" }], tools: [] }
const KEY = KEYS[0]
const { user, password, query } = ADDRESS_SECRETS

const undiciLike: Fetch = (input) =>
  Promise.reject(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${String(input)}`))

const base = { ...defaults, apiKey: Redacted.make(KEY), warmUp: false, timeoutMs: 300 }

const withLogs = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const exit = yield* effect.pipe(
      Effect.exit,
      Effect.provide(captureLogs(logs))
    )
    return { exit, logs: logs.join("\n") }
  })

const textOf = (exit: Exit.Exit<unknown, unknown>, logs = "") => `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs}`

const assertNoLeak = (secrets: ReadonlyArray<string>, what: string, text: string) => {
  for (const s of secrets) assert.deepStrictEqual(leaksOf(s, text), [], `${what} leaked ${s}: ${text.slice(0, 1500)}`)
}

const assertTypedFailure = (exit: Exit.Exit<unknown, unknown>, what: string) => {
  assert.isTrue(Exit.isFailure(exit), `${what}: expected a failure`)
  if (Exit.isFailure(exit)) assert.isFalse(Cause.hasDies(exit.cause), `${what}: died instead of failing: ${String(exit.cause)}`)
}

const turn = (options: Parameters<typeof make>[0], req: LlmRequest = request) =>
  withLogs(Effect.scoped(Effect.flatMap(make(options), (llm) => Stream.runCollect(llm.stream(req)))))

describe("credentials in the configured address (llm-anthropic)", () => {
  it.live("user-info and query in the base address are refused without echoing them (also with warm-up)", () =>
    Effect.gen(function*() {
      for (const warmUp of [false, true]) {
        const { exit, logs } = yield* turn({ ...base, warmUp, baseURL: `http://${user}:${password}@gateway.test?token=${query}`, fetch: undiciLike })
        assertTypedFailure(exit, "turn")
        assertNoLeak([KEY, user, password, query], "turn", textOf(exit, logs))
        assert.match(String(exit), /user name or password/)
      }
    }))

  it.live("ANTHROPIC_BASE_URL with credentials is refused the same way", () =>
    Effect.gen(function*() {
      const before = process.env.ANTHROPIC_BASE_URL
      process.env.ANTHROPIC_BASE_URL = `https://${user}:${password}@gateway.test/`
      try {
        const { exit, logs } = yield* turn({ ...base, fetch: undiciLike })
        assertTypedFailure(exit, "env")
        assertNoLeak([KEY, user, password], "env", textOf(exit, logs))
      } finally {
        if (before === undefined) delete process.env.ANTHROPIC_BASE_URL
        else process.env.ANTHROPIC_BASE_URL = before
      }
    }))

  for (const address of [`http://[${KEY}`, `http://u:${KEY}@[::1`, `ht tp://${KEY}`]) {
    it.live(`malformed address ${JSON.stringify(address.slice(0, 12))}: a sanitised failure`, () =>
      Effect.gen(function*() {
        const { exit, logs } = yield* turn({ ...base, apiKey: Redacted.make("other"), baseURL: address, fetch: undiciLike })
        assertTypedFailure(exit, address)
        assertNoLeak([KEY], address, textOf(exit, logs))
      }))
  }
})

describe("shortened text and construction failures (llm-anthropic)", () => {
  it.live("a tool's invalid JSON input with the key straddling any cut, after whitespace", () =>
    Effect.gen(function*() {
      for (const fill of [" ", "y"]) {
        for (const json of straddling(KEY, 200, KEY.length, fill)) {
          const events = [
            ["message_start", JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })],
            ["content_block_start", JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "x", input: {} } })],
            ["content_block_delta", JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{${json}` } })],
            ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })]
          ] as const
          const fetch: Fetch = async () =>
            new Response(events.map(([e, d]) => `event: ${e}\ndata: ${d}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
          const { exit, logs } = yield* turn({ ...base, baseURL: "http://gateway.test", fetch })
          assertTypedFailure(exit, "tool json")
          assertNoLeak([KEY], "tool json", textOf(exit, logs))
        }
      }
    }), 60_000)

  it.live("options whose base address throws when read, a request that throws while serialised, a fetch that throws", () =>
    Effect.gen(function*() {
      const thrown = () => loadedError(KEYS[1])
      const secrets = [KEYS[1]]
      const throwing = {
        ...base,
        apiKey: Redacted.make(KEYS[1]),
        get baseURL(): string {
          throw thrown()
        }
      }
      const a = yield* turn(throwing)
      assertTypedFailure(a.exit, "getter")
      assertNoLeak(secrets, "getter", textOf(a.exit, a.logs))

      const bad: LlmRequest = { ...request, tools: [{ name: "t", description: "d", inputSchema: { toJSON: () => { throw thrown() } } as never }] }
      for (const fetch of [(() => { throw thrown() }) as unknown as Fetch, (() => Promise.reject(thrown())) as Fetch]) {
        const b = yield* turn({ ...base, apiKey: Redacted.make(KEYS[1]), baseURL: "http://gateway.test", fetch }, bad)
        assertTypedFailure(b.exit, "request")
        assertNoLeak(secrets, "request", textOf(b.exit, b.logs))
        const c = yield* turn({ ...base, apiKey: Redacted.make(KEYS[1]), baseURL: "http://gateway.test", fetch })
        assertTypedFailure(c.exit, "fetch")
        assertNoLeak(secrets, "fetch", textOf(c.exit, c.logs))
        if (Exit.isFailure(c.exit)) assert.instanceOf(Cause.squash(c.exit.cause), LlmError)
      }
    }))
})
