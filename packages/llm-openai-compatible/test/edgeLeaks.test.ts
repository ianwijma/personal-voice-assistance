/**
 * Credentials at the edges of the adapter (third review, findings 1 and 2):
 * credentials inside the configured address, text shortened before it was
 * redacted, malformed addresses, and anything thrown while building a request.
 */
import { assert, describe, it } from "@effect/vitest"
import { LlmError, type LlmRequest } from "@pva/core"
import { Cause, Effect, Exit, Redacted, Stream } from "effect"
import { checkUrl, openAiCompatibleAgent } from "../src/agent.ts"
import { listModels } from "../src/models.ts"
import { make } from "../src/OpenAiCompatibleLlm.ts"
import { ADDRESS_SECRETS, captureLogs, KEYS, leaksOf, loadedError, serialise, straddling } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const request: LlmRequest = { system: "", messages: [{ role: "user", content: "Hi" }], tools: [] }
const KEY = KEYS[0]
const { user, password, query } = ADDRESS_SECRETS
/** The base address with credentials of its own: user-info and a query value, distinct from the API key. */
const credentialAddress = `http://${user}:${password}@upstream.test/v1?token=${query}`

/** What undici says about a URL with credentials: the whole URL, password included. */
const undiciLike: Fetch = (input) =>
  Promise.reject(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${String(input)}`))

const respond = (status: number, body: string): Fetch => async () => new Response(body, { status, headers: { "content-type": "text/plain" } })

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

/** A failure that is a typed error of the adapter, not a defect. */
const assertTypedFailure = (exit: Exit.Exit<unknown, unknown>, what: string) => {
  assert.isTrue(Exit.isFailure(exit), `${what}: expected a failure`)
  if (Exit.isFailure(exit)) assert.isFalse(Cause.hasDies(exit.cause), `${what}: died instead of failing: ${String(exit.cause)}`)
}

describe("credentials in the configured address (finding 1)", () => {
  it.live("model list: user-info and query in the base address are refused without echoing them", () =>
    Effect.gen(function*() {
      const { exit, logs } = yield* withLogs(
        listModels({ profile: "generic", baseUrl: credentialAddress, apiKey: Redacted.make(KEY), timeoutMs: 200, fetch: undiciLike })
      )
      assertTypedFailure(exit, "model list")
      assertNoLeak([KEY, user, password, query], "model list", textOf(exit, logs))
    }))

  it.live("chat: user-info and query in the base address are refused without echoing them", () =>
    Effect.gen(function*() {
      const llm = yield* make({ profile: "generic", baseUrl: credentialAddress, apiKey: Redacted.make(KEY), model: "m", maxTokens: 8, timeoutMs: 200, fetch: undiciLike })
      const { exit, logs } = yield* withLogs(Stream.runCollect(llm.stream(request)))
      assertTypedFailure(exit, "chat")
      assertNoLeak([KEY, user, password, query], "chat", textOf(exit, logs))
    }))

  it.live("agent: an address with credentials is a start error that does not repeat them", () =>
    Effect.gen(function*() {
      const statuses: Array<string> = []
      const agent = openAiCompatibleAgent({ id: "home-model", name: "Home", envPrefix: "HOME_MODEL_", fetch: undiciLike })
      const settings = {
        server: "generic", baseUrl: credentialAddress, apiKey: KEY, model: "", systemPrompt: "", maxTokens: 16,
        temperature: "", reasoningEffort: "default", timeoutMs: 200, warmUp: false
      }
      const { exit, logs } = yield* withLogs(Effect.scoped(agent.start({ settings: settings as never, setStatus: (s) => void (s && statuses.push(s.text)) })))
      assertTypedFailure(exit, "agent")
      assertNoLeak([KEY, user, password, query], "agent", `${textOf(exit, logs)}\n${statuses.join("\n")}`)
      assert.match(String(exit), /user name or password/)
    }))

  it("the setting check refuses credentials in the address", () => {
    const problem = checkUrl(credentialAddress)
    assert.isDefined(problem)
    assertNoLeak([user, password, query], "check", problem!)
    assert.isUndefined(checkUrl("http://192.168.1.20:11434/v1"))
    assert.isDefined(checkUrl(`http://[${KEY}/v1`))
    assertNoLeak([KEY], "check (malformed)", checkUrl(`http://[${KEY}/v1`)!)
  })

  for (const [what, address] of [
    ["malformed address containing the key", `http://[${KEY}/v1`],
    ["malformed address with the key as password", `http://u:${KEY}@[::1/v1`],
    ["address with a space and the key", `http://exa mple/${KEY}`]
  ] as const) {
    it.live(`${what}: a sanitised failure`, () =>
      Effect.gen(function*() {
        const models = yield* withLogs(listModels({ profile: "generic", baseUrl: address, apiKey: Redacted.make("other"), timeoutMs: 200, fetch: undiciLike }))
        assertTypedFailure(models.exit, `${what} (models)`)
        assertNoLeak([KEY], `${what} (models)`, textOf(models.exit, models.logs))
        const llm = yield* make({ profile: "generic", baseUrl: address, apiKey: Redacted.make("other"), model: "m", maxTokens: 8, timeoutMs: 200, fetch: undiciLike })
        const chat = yield* withLogs(Stream.runCollect(llm.stream(request)))
        assertTypedFailure(chat.exit, `${what} (chat)`)
        assertNoLeak([KEY], `${what} (chat)`, textOf(chat.exit, chat.logs))
      }))
  }
})

describe("text shortened before it was redacted (finding 2)", () => {
  it.live("a 400 body of 4,080 spaces and the key, and every other cut in the adapter, leaks nothing", () =>
    Effect.gen(function*() {
      const bodies: Array<readonly [string, string]> = [["finding 2", `${" ".repeat(4_080)}${KEY}`]]
      // Every length at which this adapter shortens upstream text, with leading whitespace (a later trim
      // moves the retained part to the front) and plain filler, the key straddling the cut.
      for (const length of [120, 200, 300, 4_096, 65_536]) {
        for (const fill of [" ", "y", "\n"]) {
          for (const body of straddling(KEY, length, KEY.length, fill)) bodies.push([`cut ${length} fill ${JSON.stringify(fill)}`, body])
        }
      }
      for (const [what, body] of bodies) {
        const llm = yield* make({ profile: "generic", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(KEY), model: "m", maxTokens: 8, timeoutMs: 500, fetch: respond(400, body) })
        const chat = yield* withLogs(Stream.runCollect(llm.stream(request)))
        assertNoLeak([KEY], `${what} (chat 400)`, textOf(chat.exit, chat.logs))
        const json = yield* withLogs(Stream.runCollect(
          (yield* make({ profile: "generic", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(KEY), model: "m", maxTokens: 8, timeoutMs: 500, fetch: respond(400, JSON.stringify({ error: { message: body } })) })).stream(request)
        ))
        assertNoLeak([KEY], `${what} (chat 400 JSON)`, textOf(json.exit, json.logs))
        const sse = yield* withLogs(Stream.runCollect(
          (yield* make({
            profile: "generic", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(KEY), model: "m", maxTokens: 8, timeoutMs: 500,
            fetch: async () => new Response(`data: ${body.replace(/\n/g, " ")}x\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
          })).stream(request)
        ))
        assertNoLeak([KEY], `${what} (stream line)`, textOf(sse.exit, sse.logs))
        const models = yield* withLogs(listModels({ profile: "generic", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(KEY), timeoutMs: 500, fetch: respond(400, body) }))
        assertNoLeak([KEY], `${what} (models 400)`, textOf(models.exit, models.logs))
      }
    }), 120_000)
})

describe("construction is inside the boundary; nothing raw escapes", () => {
  const thrown = () => loadedError(KEYS[1])
  const secrets = [KEYS[1]]

  it.live("options whose base address throws when read", () =>
    Effect.gen(function*() {
      const options = {
        profile: "generic" as const,
        get baseUrl(): string {
          throw thrown()
        },
        apiKey: Redacted.make(KEYS[1]),
        timeoutMs: 200,
        fetch: undiciLike
      }
      const models = yield* withLogs(listModels(options))
      assertTypedFailure(models.exit, "models")
      assertNoLeak(secrets, "models", textOf(models.exit, models.logs))
      const chatOptions = {
        profile: "generic" as const,
        get baseUrl(): string {
          throw thrown()
        },
        apiKey: Redacted.make(KEYS[1]),
        model: "m",
        maxTokens: 8,
        timeoutMs: 200,
        fetch: undiciLike
      }
      const built = yield* withLogs(Effect.flatMap(make(chatOptions), (llm) => Stream.runCollect(llm.stream(request))))
      assertTypedFailure(built.exit, "chat")
      assertNoLeak(secrets, "chat", textOf(built.exit, built.logs))
    }))

  it.live("a request that throws while it is serialised", () =>
    Effect.gen(function*() {
      const llm = yield* make({ profile: "generic", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(KEYS[1]), model: "m", maxTokens: 8, timeoutMs: 200, fetch: respond(200, "") })
      const bad: LlmRequest = {
        ...request,
        tools: [{ name: "t", description: "d", inputSchema: { toJSON: () => { throw thrown() } } as never }]
      }
      const { exit, logs } = yield* withLogs(Stream.runCollect(llm.stream(bad)))
      assertTypedFailure(exit, "serialise")
      assertNoLeak(secrets, "serialise", textOf(exit, logs))
      if (Exit.isFailure(exit)) assert.instanceOf(Cause.squash(exit.cause), LlmError)
    }))

  it.live("a fetch that throws synchronously, and one that rejects with the loaded error", () =>
    Effect.gen(function*() {
      for (const fetch of [(() => { throw thrown() }) as unknown as Fetch, (() => Promise.reject(thrown())) as Fetch]) {
        const llm = yield* make({ profile: "generic", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(KEYS[1]), model: "m", maxTokens: 8, timeoutMs: 200, fetch })
        const chat = yield* withLogs(Stream.runCollect(llm.stream(request)))
        assertTypedFailure(chat.exit, "chat")
        assertNoLeak(secrets, "chat", textOf(chat.exit, chat.logs))
        const models = yield* withLogs(listModels({ profile: "generic", baseUrl: "http://upstream.test/v1", apiKey: Redacted.make(KEYS[1]), timeoutMs: 200, fetch }))
        assertTypedFailure(models.exit, "models")
        assertNoLeak(secrets, "models", textOf(models.exit, models.logs))
      }
    }))
})
