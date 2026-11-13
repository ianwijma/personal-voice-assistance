/**
 * Credentials at the edges of the adapter (third review, finding 3): a
 * malformed address that contains the key used to escape as a raw `TypeError`
 * whose enumerable `input` holds it; an address with credentials of its own;
 * every cut with whitespace before the key; a socket that cannot be built.
 */
import { assert, describe, it } from "@effect/vitest"
import { SttError } from "@pva/core"
import { Cause, Effect, Exit, Redacted, Stream } from "effect"
import { type WebSocket, WebSocketServer } from "ws"
import { FluxConnection } from "../src/FluxConnection.ts"
import { make } from "../src/index.ts"
import { ADDRESS_SECRETS, captureLogs, KEYS, leaksOf, loadedError, serialise, straddling } from "./leaks.ts"

const KEY = KEYS[0]
const { user, password, query } = ADDRESS_SECRETS

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
  if (Exit.isFailure(exit)) {
    assert.isFalse(Cause.hasDies(exit.cause), `${what}: died instead of failing: ${String(exit.cause)}`)
    assert.instanceOf(Cause.squash(exit.cause), SttError)
  }
}

/** Builds the service and runs one short transcription; a `make` that throws is caught here, as a defect. */
const transcribe = (url: string, key: string = KEY, ms = 150) =>
  withLogs(Effect.suspend(() => {
    const stt = make({ apiKey: Redacted.make(key), url, handshakeTimeoutMs: 100, backoffInitialMs: 20, backoffMaxMs: 40 })
    return Stream.runDrain(stt.transcribe(Stream.make(new Uint8Array(2560)).pipe(Stream.concat(Stream.fromEffect(Effect.sleep(ms)).pipe(Stream.drain)))))
  }))

const wsServer = (onConnection: (ws: WebSocket) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; wss: WebSocketServer }>((resume) => {
      const wss = new WebSocketServer({ port: 0 })
      wss.on("connection", onConnection)
      wss.on("listening", () => {
        const address = wss.address()
        resume(Effect.succeed({ url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v2/listen`, wss }))
      })
    }),
    ({ wss }) =>
      Effect.callback<void>((resume) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resume(Effect.void))
      })
  )

describe("malformed and credential-carrying addresses (finding 3, stt-deepgram)", () => {
  for (const url of [`wss://[${KEY}/v2/listen`, `wss://u:${KEY}@[::1/v2/listen`, `ht tp://${KEY}`, `http://example.test/${encodeURIComponent(KEY)}`]) {
    it.live(`malformed or wrong-scheme address ${JSON.stringify(url.slice(0, 14))}: a sanitised SttError, no raw throw`, () =>
      Effect.gen(function*() {
        const { exit, logs } = yield* transcribe(url, "other")
        assertTypedFailure(exit, url)
        assertNoLeak([KEY], url, textOf(exit, logs))
      }))
  }

  it.live("user-info is refused without echoing it; a query value is used but never shown", () =>
    Effect.gen(function*() {
      const refused = yield* transcribe(`wss://${user}:${password}@api.deepgram.test/v2/listen`)
      assertTypedFailure(refused.exit, "user-info")
      assertNoLeak([KEY, user, password], "user-info", textOf(refused.exit, refused.logs))
      assert.match(String(refused.exit), /user name or password/)
      // A query parameter goes to Deepgram, but its value is a secret in every message (here the peer
      // echoes it back in an Error).
      const echoed = yield* Effect.scoped(Effect.gen(function*() {
        const s = yield* wsServer((ws) => ws.send(JSON.stringify({ type: "Error", code: "X", description: `bad request with tag=${query}` })))
        return yield* transcribe(`${s.url}?tag=${query}`)
      }))
      assertTypedFailure(echoed.exit, "query")
      assertNoLeak([KEY, query], "query", textOf(echoed.exit, echoed.logs))
    }))
})

describe("cuts and construction failures (stt-deepgram)", () => {
  it.live("every cut (300 and the upstream window) with whitespace or filler before the key", () =>
    Effect.gen(function*() {
      for (const length of [300, 65_536]) {
        for (const fill of [" ", "\n", "y"]) {
          const descriptions = straddling(KEY, length - "Deepgram error 1: ".length, KEY.length, fill)
          for (const description of descriptions) {
            const failures: Array<SttError> = []
            const logs: Array<string> = []
            const result = yield* Effect.scoped(Effect.gen(function*() {
              const s = yield* wsServer((ws) => ws.send(JSON.stringify({ type: "Warning", code: 1, description })))
              const flux = new FluxConnection(
                { url: s.url, apiKey: KEY, chunkMs: 80, reconnectBufferMs: 480, backoffInitialMs: 30, backoffMaxMs: 60, keepAliveMs: 3000, stableMs: 10_000, closeTimeoutMs: 300, handshakeTimeoutMs: 300 },
                { emit: () => {}, fail: (e) => failures.push(e), end: () => {}, log: (_l, m) => logs.push(m) }
              )
              flux.start()
              yield* Effect.sleep(60)
              flux.stop()
              return `${serialise(failures)}\n${logs.join("\n")}`
            }))
            assertNoLeak([KEY], `cut ${length}`, result)
          }
        }
      }
    }), 120_000)

  it.live("an option getter that throws: a sanitised SttError, not a raw throw", () =>
    Effect.gen(function*() {
      const thrown = () => loadedError(KEYS[1])
      const { exit, logs } = yield* withLogs(Effect.suspend(() => {
        const stt = make({
          apiKey: Redacted.make(KEYS[1]),
          get url(): string {
            throw thrown()
          }
        })
        return Stream.runDrain(stt.transcribe(Stream.make(new Uint8Array(2560))))
      }))
      assertTypedFailure(exit, "getter")
      assertNoLeak([KEYS[1]], "getter", textOf(exit, logs))
    }))

  it.live("audio input that dies with the loaded error: a sanitised SttError", () =>
    Effect.gen(function*() {
      const s = yield* wsServer(() => {})
      const stt = make({ apiKey: Redacted.make(KEYS[1]), url: s.url })
      const { exit, logs } = yield* withLogs(Stream.runDrain(stt.transcribe(Stream.die(loadedError(KEYS[1])))))
      assertTypedFailure(exit, "input dies")
      assertNoLeak([KEYS[1]], "input dies", textOf(exit, logs))
    }))
})
