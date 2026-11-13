import { assert, describe, it } from "@effect/vitest"
import type { AudioError, SttEvent } from "@pva/core"
import { Cause, Effect, Exit, Fiber, Queue, Redacted, Stream } from "effect"
import type { IncomingMessage } from "node:http"
import { type WebSocket, WebSocketServer } from "ws"
import { connectionUrl, make } from "../src/index.ts"

// A local `ws` server standing in for Deepgram Flux.

interface Conn {
  readonly ws: WebSocket
  readonly url: URL
  readonly headers: IncomingMessage["headers"]
  readonly audio: Array<Buffer>
  readonly text: Array<string>
  closeCode: number | undefined
}

const mockServer = (options: {
  readonly onConnection?: (conn: Conn, index: number) => void
  readonly rejectWith?: number
} = {}) =>
  Effect.acquireRelease(
    Effect.callback<{ port: number; conns: Array<Conn>; attempts: () => number; wss: WebSocketServer }>((resume) => {
      const conns: Array<Conn> = []
      let attempts = 0
      const wss = new WebSocketServer({
        port: 0,
        verifyClient: (_info, cb) => {
          attempts++
          if (options.rejectWith) cb(false, options.rejectWith)
          else cb(true)
        }
      })
      wss.on("connection", (ws, req) => {
        const conn: Conn = {
          ws,
          url: new URL(req.url ?? "/", "ws://localhost"),
          headers: req.headers,
          audio: [],
          text: [],
          closeCode: undefined
        }
        conns.push(conn)
        ws.on("message", (data, isBinary) => {
          if (isBinary) conn.audio.push(data as Buffer)
          else {
            conn.text.push(data.toString())
            // Like Flux: CloseStream → close without a status code.
            if (JSON.parse(data.toString()).type === "CloseStream") setTimeout(() => ws.close(), 10)
          }
        })
        ws.on("close", (code) => {
          conn.closeCode = code
        })
        options.onConnection?.(conn, conns.length - 1)
      })
      wss.on("listening", () => {
        const address = wss.address()
        resume(Effect.succeed({
          port: typeof address === "object" && address ? address.port : 0,
          conns,
          attempts: () => attempts,
          wss
        }))
      })
    }),
    ({ wss }) =>
      Effect.callback<void>((resume) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resume(Effect.void))
      })
  )

const send = (conn: Conn, message: object) => conn.ws.send(JSON.stringify(message))
const turnInfo = (conn: Conn, event: string, transcript: string, extra: object = {}) =>
  send(conn, {
    type: "TurnInfo",
    request_id: "r",
    sequence_id: 0,
    event,
    turn_index: 0,
    audio_window_start: 0,
    audio_window_end: 1,
    transcript,
    words: [],
    end_of_turn_confidence: 0.5,
    ...extra
  })

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function*() {
    while (!predicate()) yield* Effect.sleep(5)
  }).pipe(Effect.timeout(3000))

/** Runs `transcribe` against the mock server, with audio fed through a queue the test controls. */
const startStt = (port: number, options: { backoffInitialMs?: number } = {}) =>
  Effect.gen(function*() {
    const audio = yield* Queue.unbounded<Uint8Array, AudioError | Cause.Done>()
    const events: Array<SttEvent> = []
    const stt = make({
      apiKey: Redacted.make("test-key"),
      url: `ws://127.0.0.1:${port}/v2/listen`,
      backoffInitialMs: options.backoffInitialMs ?? 20
    })
    const fiber = yield* stt.transcribe(Stream.fromQueue(audio)).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild
    )
    return { audio, events, fiber }
  })

const pcm = (length: number, start: number) => Uint8Array.from({ length }, (_, i) => (start + i) & 255)

describe("DeepgramStt", () => {
  it("builds the URL with defaults", () => {
    const url = new URL(connectionUrl({ apiKey: Redacted.make("k") }))
    assert.strictEqual(url.origin + url.pathname, "wss://api.deepgram.com/v2/listen")
    assert.deepStrictEqual(Object.fromEntries(url.searchParams), {
      model: "flux-general-en",
      encoding: "linear16",
      sample_rate: "16000",
      eot_threshold: "0.7",
      eager_eot_threshold: "0.5",
      eot_timeout_ms: "5000"
    })
    const noEager = new URL(connectionUrl({ apiKey: Redacted.make("k"), eagerEotThreshold: 0 }))
    assert.isFalse(noEager.searchParams.has("eager_eot_threshold"))
  })

  it.live("connects with the query parameters and auth header", () =>
    Effect.gen(function*() {
      const server = yield* mockServer()
      yield* startStt(server.port)
      yield* waitUntil(() => server.conns.length === 1)
      const conn = server.conns[0]!
      assert.strictEqual(conn.url.pathname, "/v2/listen")
      assert.strictEqual(conn.url.searchParams.get("model"), "flux-general-en")
      assert.strictEqual(conn.url.searchParams.get("encoding"), "linear16")
      assert.strictEqual(conn.url.searchParams.get("sample_rate"), "16000")
      assert.strictEqual(conn.url.searchParams.get("eager_eot_threshold"), "0.5")
      assert.strictEqual(conn.headers.authorization, "Token test-key")
    }))

  it.live("sends audio re-framed into 80 ms frames, complete, and closes with CloseStream when audio ends", () =>
    Effect.gen(function*() {
      const server = yield* mockServer()
      const { audio, fiber } = yield* startStt(server.port)
      yield* waitUntil(() => server.conns.length === 1)
      yield* Effect.sleep(50) // let the client see the socket open
      const chunks = [...Array.from({ length: 25 }, (_, i) => pcm(640, i * 640)), pcm(1000, 25 * 640)]
      for (const chunk of chunks) yield* Queue.offer(audio, chunk)
      yield* Queue.end(audio)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isSuccess(exit))

      const conn = server.conns[0]!
      const sizes = conn.audio.map((frame) => frame.length)
      // 17000 bytes = 6 full 2560-byte frames + 1640-byte tail flushed at the end.
      assert.deepStrictEqual(sizes, [2560, 2560, 2560, 2560, 2560, 2560, 1640])
      assert.deepStrictEqual(new Uint8Array(Buffer.concat(conn.audio)), pcm(17000, 0))
      assert.deepStrictEqual(conn.text, [JSON.stringify({ type: "CloseStream" })])
    }))

  it.live("maps TurnInfo events, including eager → resumed → eager → end with cumulative transcripts", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({
        onConnection: (conn) => {
          send(conn, { type: "Connected", request_id: "r", sequence_id: 0 })
          turnInfo(conn, "Update", "") // silence before the turn: nothing
          turnInfo(conn, "StartOfTurn", "Hi I")
          turnInfo(conn, "Update", "Hi I need to")
          turnInfo(conn, "Update", "Hi I need to") // unchanged: no duplicate Interim
          turnInfo(conn, "EagerEndOfTurn", "Hi I need to cancel.")
          turnInfo(conn, "TurnResumed", "Hi I need to cancel")
          turnInfo(conn, "Update", "Hi I need to cancel my plan")
          turnInfo(conn, "EagerEndOfTurn", "Hi I need to cancel my plan.")
          turnInfo(conn, "EndOfTurn", "Hi I need to cancel my plan.", { trigger: "model" })
          send(conn, { type: "Warning", request_id: "r", sequence_id: 0, code: "X", description: "y" })
          turnInfo(conn, "StartOfTurn", "Thanks", { turn_index: 1 })
          turnInfo(conn, "EndOfTurn", "Thanks.", { turn_index: 1, trigger: "timeout" })
        }
      })
      const { events } = yield* startStt(server.port)
      yield* waitUntil(() => events.length === 11)
      yield* Effect.sleep(20)
      assert.deepStrictEqual(events, [
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "Hi I" },
        { _tag: "Interim", text: "Hi I need to" },
        { _tag: "EagerEndOfTurn", text: "Hi I need to cancel." },
        { _tag: "TurnResumed" },
        { _tag: "Interim", text: "Hi I need to cancel my plan" },
        { _tag: "EagerEndOfTurn", text: "Hi I need to cancel my plan." },
        { _tag: "EndOfTurn", text: "Hi I need to cancel my plan." },
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "Thanks" },
        { _tag: "EndOfTurn", text: "Thanks." }
      ])
    }))

  it.live("when audio ends mid-turn, sends ForceEndTurn before CloseStream and emits the EndOfTurn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({
        onConnection: (conn) => {
          turnInfo(conn, "StartOfTurn", "what time")
          conn.ws.on("message", (data, isBinary) => {
            if (!isBinary && JSON.parse(data.toString()).type === "ForceEndTurn") {
              turnInfo(conn, "EndOfTurn", "what time is it", { trigger: "manual" })
            }
          })
        }
      })
      const { audio, events, fiber } = yield* startStt(server.port)
      yield* waitUntil(() => events.length === 2)
      yield* Queue.end(audio)
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
      assert.deepStrictEqual(server.conns[0]!.text.map((t) => JSON.parse(t).type), ["ForceEndTurn", "CloseStream"])
      assert.deepStrictEqual(events.at(-1), { _tag: "EndOfTurn", text: "what time is it" })
    }))

  it.live("interrupting the consumer sends CloseStream and closes the socket", () =>
    Effect.gen(function*() {
      const server = yield* mockServer()
      const { fiber } = yield* startStt(server.port)
      yield* waitUntil(() => server.conns.length === 1)
      yield* Effect.sleep(50)
      yield* Fiber.interrupt(fiber)
      const conn = server.conns[0]!
      yield* waitUntil(() => conn.closeCode !== undefined)
      assert.deepStrictEqual(conn.text, [JSON.stringify({ type: "CloseStream" })])
      assert.strictEqual(conn.closeCode, 1000)
    }))

  it.live("reconnects after a drop, ends the open turn, buffers audio and keeps emitting", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({
        onConnection: (conn, index) => {
          if (index === 0) {
            turnInfo(conn, "StartOfTurn", "turn off")
            turnInfo(conn, "EagerEndOfTurn", "turn off the lights")
            setTimeout(() => conn.ws.terminate(), 30)
          } else {
            turnInfo(conn, "StartOfTurn", "hello")
          }
        }
      })
      const { audio, events, fiber } = yield* startStt(server.port, { backoffInitialMs: 200 })
      yield* waitUntil(() => server.conns[0]?.closeCode !== undefined)
      // Disconnected now (reconnect waits 100–200 ms): this audio must reach the next connection.
      yield* Queue.offer(audio, pcm(2560, 7))
      yield* waitUntil(() => events.length === 6)
      assert.deepStrictEqual(events, [
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "turn off" },
        { _tag: "EagerEndOfTurn", text: "turn off the lights" },
        { _tag: "EndOfTurn", text: "turn off the lights" }, // synthesized for the dropped turn
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "hello" }
      ])
      yield* waitUntil(() => server.conns[1]?.audio.length === 1)
      assert.deepStrictEqual(new Uint8Array(server.conns[1]!.audio[0]!), pcm(2560, 7))
      assert.isUndefined(fiber.pollUnsafe())
    }))

  it.live("a Deepgram Error message fails the stream with SttError instead of retrying", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({
        onConnection: (conn) => {
          send(conn, { type: "Error", sequence_id: 0, code: "UNPARSABLE_CLIENT_MESSAGE", description: "bad" })
          conn.ws.close()
        }
      })
      const { fiber } = yield* startStt(server.port)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      assert.include(String((error as any)?.message), "UNPARSABLE_CLIENT_MESSAGE")
      assert.strictEqual((error as any)?._tag, "SttError")
      assert.strictEqual(server.conns.length, 1)
    }))

  it.live("an authentication failure on connect fails the stream", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({ rejectWith: 401 })
      const { fiber } = yield* startStt(server.port)
      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout(2000))
      assert.isTrue(Exit.isFailure(exit))
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      assert.include(String((error as any)?.message), "HTTP 401")
      assert.strictEqual(server.attempts(), 1)
    }))
})
