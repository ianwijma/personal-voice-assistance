/**
 * Third review: finding 3 (a malformed address containing the key died with a
 * raw `SyntaxError: Invalid URL: …key…`), the rest of the credential edges
 * (an address with credentials of its own, cuts with whitespace before the
 * key, construction that throws), and finding 7 (one clause with audio hid a
 * later speakable clause that got none).
 */
import { assert, describe, it } from "@effect/vitest"
import { TtsError } from "@pva/core"
import { Cause, Effect, Exit, Redacted, Stream } from "effect"
import { type WebSocket, WebSocketServer } from "ws"
import { make } from "../src/index.ts"
import { ADDRESS_SECRETS, captureLogs, KEYS, leaksOf, loadedError, serialise, straddling } from "./leaks.ts"

type Msg = Record<string, any>

const KEY = KEYS[0]
const { user, password, query } = ADDRESS_SECRETS

const server = (script: (ws: WebSocket, msg: Msg) => void, onConnection: (ws: WebSocket) => void = () => {}) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; wss: WebSocketServer }>((resume) => {
      const wss = new WebSocketServer({ port: 0 })
      wss.on("connection", (ws) => {
        onConnection(ws)
        ws.on("message", (data) => script(ws, JSON.parse(data.toString()) as Msg))
      })
      wss.on("listening", () => {
        const address = wss.address()
        resume(Effect.succeed({ url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, wss }))
      })
    }),
    ({ wss }) =>
      Effect.callback<void>((resume) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resume(Effect.void))
      })
  )

const send = (ws: WebSocket, msg: Msg) => ws.send(JSON.stringify(msg))
const pcm = Buffer.from([1, 0, 2, 0]).toString("base64")

const withLogs = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const exit = yield* effect.pipe(
      Effect.exit,
      Effect.provide(captureLogs(logs))
    )
    return { exit, logs: logs.join("\n") }
  })

const turn = (options: Omit<Parameters<typeof make>[0], "apiKey"> & { readonly key?: string }, clauses: ReadonlyArray<string> = ["Hello there."]) =>
  withLogs(Effect.scoped(Effect.gen(function*() {
    const tts = yield* make({ apiKey: Redacted.make(options.key ?? KEY), connectTimeoutMs: 300, handshakeTimeoutMs: 200, drainTimeoutMs: 300, ...options })
    const result = yield* Stream.runCollect(tts.synthesize(Stream.fromIterable(clauses)))
    yield* Effect.sleep(30)
    return result
  })))

const textOf = (exit: Exit.Exit<unknown, unknown>, logs = "") => `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs}`

const assertNoLeak = (secrets: ReadonlyArray<string>, what: string, text: string) => {
  for (const s of secrets) assert.deepStrictEqual(leaksOf(s, text), [], `${what} leaked ${s}: ${text.slice(0, 1500)}`)
}

const assertTypedFailure = (exit: Exit.Exit<unknown, unknown>, what: string) => {
  assert.isTrue(Exit.isFailure(exit), `${what}: expected a failure`)
  if (Exit.isFailure(exit)) {
    assert.isFalse(Cause.hasDies(exit.cause), `${what}: died instead of failing: ${String(exit.cause)}`)
    assert.instanceOf(Cause.squash(exit.cause), TtsError)
  }
}

describe("malformed and credential-carrying addresses (finding 3, tts-cartesia)", () => {
  for (const baseUrl of [`wss://[${KEY}`, `wss://u:${KEY}@[::1`, `ht tp://${KEY}`, `https://api.cartesia.test/${encodeURIComponent(KEY)}`]) {
    it.live(`address ${JSON.stringify(baseUrl.slice(0, 14))}: a sanitised TtsError, never a raw Die`, () =>
      Effect.gen(function*() {
        const { exit, logs } = yield* turn({ baseUrl, key: "other" })
        assertTypedFailure(exit, baseUrl)
        assertNoLeak([KEY], baseUrl, textOf(exit, logs))
      }))
  }

  it.live("user-info and a query in the address are refused without echoing them", () =>
    Effect.gen(function*() {
      const { exit, logs } = yield* turn({ baseUrl: `wss://${user}:${password}@api.cartesia.test?api_key=${query}` })
      assertTypedFailure(exit, "credentials")
      assertNoLeak([KEY, user, password, query], "credentials", textOf(exit, logs))
      assert.match(String(exit), /user name or password/)
    }))

  it.live("options whose address throws when read: a sanitised TtsError", () =>
    Effect.gen(function*() {
      const { exit, logs } = yield* withLogs(Effect.scoped(Effect.gen(function*() {
        const tts = yield* make({
          apiKey: Redacted.make(KEYS[1]),
          get baseUrl(): string {
            throw loadedError(KEYS[1])
          }
        })
        return yield* Stream.runCollect(tts.synthesize(Stream.make("Hello.")))
      })))
      assertTypedFailure(exit, "getter")
      assertNoLeak([KEYS[1]], "getter", textOf(exit, logs))
    }))

  it.live("clause input that dies with the loaded error: a sanitised TtsError", () =>
    Effect.gen(function*() {
      const { url } = yield* server(() => {})
      const { exit, logs } = yield* withLogs(Effect.scoped(Effect.gen(function*() {
        const tts = yield* make({ apiKey: Redacted.make(KEYS[1]), baseUrl: url, connectTimeoutMs: 300 })
        return yield* Stream.runCollect(tts.synthesize(Stream.die(loadedError(KEYS[1]))))
      })))
      assertTypedFailure(exit, "input dies")
      assertNoLeak([KEYS[1]], "input dies", textOf(exit, logs))
    }))
})

describe("cuts with whitespace before the key (tts-cartesia)", () => {
  it.live("error fields and close reasons at every cut (200, 300, 400, 500, the upstream window)", () =>
    Effect.gen(function*() {
      for (const length of [200, 300, 400, 500, 65_536]) {
        for (const fill of [" ", "\n", "y"]) {
          for (const text of straddling(KEY, length - "Cartesia error: ".length, KEY.length, fill)) {
            const s = yield* server((ws, m) => {
              if (typeof m.transcript === "string" && m.transcript !== "") send(ws, { type: "error", context_id: m.context_id, message: text })
            })
            const { exit, logs } = yield* turn({ baseUrl: s.url })
            assertNoLeak([KEY], `cut ${length}`, textOf(exit, logs))
          }
        }
      }
      for (const fill of [" ", "y"]) {
        for (const reason of straddling(KEY, 100, KEY.length, fill)) {
          const s = yield* server(() => {}, (ws) => ws.close(4000, reason.slice(-120)))
          const { exit, logs } = yield* turn({ baseUrl: s.url })
          assertNoLeak([KEY], "close reason", textOf(exit, logs))
        }
      }
    }), 120_000)
})

describe("every speakable clause needs its own audio (finding 7)", () => {
  /** Audio and flush_done for the first clause; only flush_done for the second; then `done` (or nothing). */
  const firstOnly = (withDone: boolean) => {
    let clause = 0
    return (ws: WebSocket, msg: Msg) => {
      if (msg.flush === true) send(ws, { type: "flush_done", done: false, flush_done: true, context_id: msg.context_id })
      else if (msg.continue === false) {
        if (withDone) send(ws, { type: "done", done: true, context_id: msg.context_id })
      } else if (typeof msg.transcript === "string" && msg.transcript !== "") {
        if (clause++ === 0) send(ws, { type: "chunk", data: pcm, context_id: msg.context_id })
      }
    }
  }

  it.live("two clauses, audio only for the first, then flush_done and done: the turn fails", () =>
    Effect.gen(function*() {
      const { url } = yield* server(firstOnly(true))
      const { exit } = yield* turn({ baseUrl: url }, ["Hello there.", "How are you?"])
      assert.isTrue(Exit.isFailure(exit), String(exit))
      assert.match(String(exit), /no audio for clause 2/)
    }))

  it.live("the same without `done`: the drain timeout fails it too", () =>
    Effect.gen(function*() {
      const { url } = yield* server(firstOnly(false))
      const { exit } = yield* turn({ baseUrl: url }, ["Hello there.", "How are you?"])
      assert.isTrue(Exit.isFailure(exit), String(exit))
      assert.match(String(exit), /no audio for clause 2/)
    }))

  it.live("a silent punctuation-only clause between spoken ones is fine; every spoken clause with audio succeeds", () =>
    Effect.gen(function*() {
      const { url } = yield* server((ws, msg) => {
        if (msg.flush === true) send(ws, { type: "flush_done", done: false, flush_done: true, context_id: msg.context_id })
        else if (msg.continue === false) send(ws, { type: "done", done: true, context_id: msg.context_id })
        else if (typeof msg.transcript === "string" && /[a-z]/i.test(msg.transcript)) send(ws, { type: "chunk", data: pcm, context_id: msg.context_id })
      })
      const { exit } = yield* turn({ baseUrl: url }, ["Hello there.", "…", "How are you?"])
      assert.isTrue(Exit.isSuccess(exit), String(exit))
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(Array.from(exit.value, (a) => a.clause), [0, 2])
    }))
})
