import { assert, describe, it } from "@effect/vitest"
import type { AudioError, SttEvent } from "@pva/core"
import { Cause, Effect, Exit, Fiber, Queue, Redacted, Stream } from "effect"
import { createServer, type IncomingMessage } from "node:http"
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
const startStt = (port: number, options: { backoffInitialMs?: number; handshakeTimeoutMs?: number; apiKey?: string } = {}) =>
  Effect.gen(function*() {
    const audio = yield* Queue.unbounded<Uint8Array, AudioError | Cause.Done>()
    const events: Array<SttEvent> = []
    const stt = make({
      apiKey: Redacted.make(options.apiKey ?? "test-key"),
      url: `ws://127.0.0.1:${port}/v2/listen`,
      backoffInitialMs: options.backoffInitialMs ?? 20,
      ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {})
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

  it.live("every utterance that started ends with EndOfTurn, with empty text when no words were recognised; never an empty EagerEndOfTurn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({
        onConnection: (conn) => {
          // A cough: speech started, no words, then the turn ended.
          turnInfo(conn, "StartOfTurn", "")
          turnInfo(conn, "EagerEndOfTurn", "") // nothing to speculate on: not emitted
          turnInfo(conn, "TurnResumed", "") // nothing was eager: not emitted
          turnInfo(conn, "EndOfTurn", "", { trigger: "timeout" })
          // No StartOfTurn, no words: no utterance, nothing to close.
          turnInfo(conn, "Update", "", { turn_index: 1 })
          turnInfo(conn, "EndOfTurn", "", { turn_index: 1 })
          // Words without a StartOfTurn, for a turn index that has not ended, are delivered as an
          // utterance of their own, opened by a synthesised SpeechStarted (the conversation ignores
          // transcripts of an utterance that never sent one).
          turnInfo(conn, "Update", "stray words", { turn_index: 2 })
          turnInfo(conn, "EndOfTurn", "", { turn_index: 2 })
          // The same for an eager and a final transcript with no StartOfTurn (after a reconnect).
          turnInfo(conn, "EagerEndOfTurn", "lights on", { turn_index: 3 })
          turnInfo(conn, "EndOfTurn", "lights on", { turn_index: 3 })
          // A final alone, for a NEW turn index (4): a turn of its own, so a start is synthesised.
          turnInfo(conn, "EndOfTurn", "only final", { turn_index: 4 })
          // The same final again, for the turn that just ended (4): a duplicate, dropped (round 7).
          turnInfo(conn, "EndOfTurn", "only final", { turn_index: 4 })
          turnInfo(conn, "StartOfTurn", "done", { turn_index: 5 })
        }
      })
      const { events } = yield* startStt(server.port)
      yield* waitUntil(() => events.length === 12)
      yield* Effect.sleep(30)
      assert.deepStrictEqual(events, [
        { _tag: "SpeechStarted" },
        { _tag: "EndOfTurn", text: "" },
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "stray words" },
        { _tag: "EndOfTurn", text: "stray words" },
        { _tag: "SpeechStarted" },
        { _tag: "EagerEndOfTurn", text: "lights on" },
        { _tag: "EndOfTurn", text: "lights on" },
        { _tag: "SpeechStarted" },
        { _tag: "EndOfTurn", text: "only final" },
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "done" }
      ])
    }))

  it.live("a connection that drops after SpeechStarted with no words closes the utterance with an empty EndOfTurn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({
        onConnection: (conn, index) => {
          if (index === 0) {
            turnInfo(conn, "StartOfTurn", "")
            setTimeout(() => conn.ws.terminate(), 30)
          } else turnInfo(conn, "StartOfTurn", "hello")
        }
      })
      const { events } = yield* startStt(server.port, { backoffInitialMs: 50 })
      yield* waitUntil(() => events.length === 4)
      assert.deepStrictEqual(events, [
        { _tag: "SpeechStarted" },
        { _tag: "EndOfTurn", text: "" }, // synthesised for the dropped utterance
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "hello" }
      ])
    }))

  it.live("audio that ends with an utterance open and no words: ForceEndTurn's empty EndOfTurn is delivered", () =>
    Effect.gen(function*() {
      const server = yield* mockServer({
        onConnection: (conn) => {
          turnInfo(conn, "StartOfTurn", "")
          conn.ws.on("message", (data, isBinary) => {
            if (!isBinary && JSON.parse(data.toString()).type === "ForceEndTurn") turnInfo(conn, "EndOfTurn", "", { trigger: "manual" })
          })
        }
      })
      const { audio, events, fiber } = yield* startStt(server.port)
      yield* waitUntil(() => events.length === 1)
      yield* Queue.end(audio)
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
      assert.deepStrictEqual(events, [{ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "" }])
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

  it.live("text frames that are valid JSON but not an object are dropped; the session keeps working", () =>
    Effect.gen(function*() {
      const uncaught: Array<unknown> = []
      const onUncaught = (e: unknown) => uncaught.push(e)
      process.on("uncaughtException", onUncaught)
      yield* Effect.addFinalizer(() => Effect.sync(() => process.off("uncaughtException", onUncaught)))
      const server = yield* mockServer({
        onConnection: (conn) => {
          for (const frame of ["null", "[1,2]", "42", "\"text\"", "{\"type\":\"TurnInfo\",\"event\":null,\"transcript\":7}"]) {
            conn.ws.send(frame)
          }
          turnInfo(conn, "StartOfTurn", "hello")
          turnInfo(conn, "EndOfTurn", "hello there")
        }
      })
      const { events, fiber } = yield* startStt(server.port)
      yield* waitUntil(() => events.length === 3)
      assert.deepStrictEqual(events, [
        { _tag: "SpeechStarted" },
        { _tag: "Interim", text: "hello" },
        { _tag: "EndOfTurn", text: "hello there" }
      ])
      assert.deepStrictEqual(uncaught, [])
      assert.isUndefined(fiber.pollUnsafe())
      assert.strictEqual(server.conns.length, 1)
    }))

  it.live("an Error message that echoes the API key is redacted", () =>
    Effect.gen(function*() {
      const key = "dg-0123456789abcdefSECRET"
      const server = yield* mockServer({
        onConnection: (conn) => {
          send(conn, { type: "Error", code: "INVALID_AUTH", description: `bad key ${key}` })
          conn.ws.close()
        }
      })
      const { fiber } = yield* startStt(server.port, { apiKey: key })
      const exit = yield* Fiber.await(fiber)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      assert.include(String((error as any)?.message), "INVALID_AUTH")
      assert.notInclude(String((error as any)?.message), key)
    }))

  it.live("a server that accepts the connection but never completes the upgrade is abandoned and retried", () =>
    Effect.gen(function*() {
      // First upgrade request hangs forever; later ones are real WebSocket connections.
      const wss = new WebSocketServer({ noServer: true })
      const conns: Array<{ ws: WebSocket; audio: Array<Buffer> }> = []
      wss.on("connection", (ws) => {
        const conn = { ws, audio: [] as Array<Buffer> }
        conns.push(conn)
        ws.on("message", (data, isBinary) => {
          if (isBinary) conn.audio.push(data as Buffer)
        })
      })
      let upgrades = 0
      const hung: Array<import("node:net").Socket> = []
      const http = yield* Effect.acquireRelease(
        Effect.callback<import("node:http").Server>((resume) => {
          const server = createServer()
          server.on("upgrade", (req, socket, head) => {
            if (upgrades++ === 0) hung.push(socket as import("node:net").Socket)
            else wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
          })
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
        }),
        (server) =>
          Effect.sync(() => {
            for (const s of hung) s.destroy()
            for (const c of wss.clients) c.terminate()
            server.closeAllConnections()
            server.close()
          })
      )
      const port = (http.address() as import("node:net").AddressInfo).port
      const { audio, fiber } = yield* startStt(port, { handshakeTimeoutMs: 200 })
      yield* Queue.offer(audio, pcm(2560, 3)) // one 80 ms frame while the first handshake hangs
      yield* waitUntil(() => conns.length === 1)
      yield* waitUntil(() => conns[0]!.audio.length === 1)
      assert.deepStrictEqual(new Uint8Array(conns[0]!.audio[0]!), pcm(2560, 3))
      assert.strictEqual(upgrades, 2)
      assert.isUndefined(fiber.pollUnsafe())
    }))

  // Review round 7, finding 4: a repeated final must not open a second utterance. Flux's turn index
  // tells a duplicate (a turn that already ended on this connection) from a continuation after a
  // reconnect (an index this connection has not seen end).
  describe("duplicate turn messages", () => {
    const run = (onConnection: (conn: Conn, index: number) => void, count: number) =>
      Effect.gen(function*() {
        const server = yield* mockServer({ onConnection })
        const { events } = yield* startStt(server.port, { backoffInitialMs: 20 })
        yield* waitUntil(() => events.length >= count)
        yield* Effect.sleep(40)
        return events
      })

    it.live("the reviewer's sequence: StartOfTurn, EndOfTurn, the same EndOfTurn again → one utterance", () =>
      Effect.gen(function*() {
        const events = yield* run((conn) => {
          turnInfo(conn, "StartOfTurn", "")
          turnInfo(conn, "EndOfTurn", "turn on the kitchen lights")
          turnInfo(conn, "EndOfTurn", "turn on the kitchen lights")
          turnInfo(conn, "StartOfTurn", "done", { turn_index: 1 })
        }, 4)
        assert.deepStrictEqual(events, [
          { _tag: "SpeechStarted" },
          { _tag: "EndOfTurn", text: "turn on the kitchen lights" },
          { _tag: "SpeechStarted" },
          { _tag: "Interim", text: "done" }
        ])
      }))

    it.live("every turn message for a turn index that already ended is dropped (Update, EagerEndOfTurn, TurnResumed, StartOfTurn, EndOfTurn)", () =>
      Effect.gen(function*() {
        const events = yield* run((conn) => {
          turnInfo(conn, "StartOfTurn", "lights")
          turnInfo(conn, "EndOfTurn", "lights on")
          turnInfo(conn, "Update", "lights on again")
          turnInfo(conn, "EagerEndOfTurn", "lights on again")
          turnInfo(conn, "TurnResumed", "lights on again")
          turnInfo(conn, "StartOfTurn", "lights on again")
          turnInfo(conn, "EndOfTurn", "lights on again")
          turnInfo(conn, "EndOfTurn", "other words", { turn_index: 1 }) // a new index: a turn of its own
          turnInfo(conn, "StartOfTurn", "done", { turn_index: 2 })
        }, 7)
        assert.deepStrictEqual(events, [
          { _tag: "SpeechStarted" },
          { _tag: "Interim", text: "lights" },
          { _tag: "EndOfTurn", text: "lights on" },
          { _tag: "SpeechStarted" },
          { _tag: "EndOfTurn", text: "other words" },
          { _tag: "SpeechStarted" },
          { _tag: "Interim", text: "done" }
        ])
      }))

    it.live("without a turn index: a final right after another final, with no start or interim between, is dropped", () =>
      Effect.gen(function*() {
        const none = { turn_index: undefined }
        const events = yield* run((conn) => {
          turnInfo(conn, "StartOfTurn", "", none)
          turnInfo(conn, "EndOfTurn", "turn on the kitchen lights", none)
          turnInfo(conn, "EndOfTurn", "turn on the kitchen lights", none) // duplicate
          turnInfo(conn, "EagerEndOfTurn", "turn on the kitchen lights", none) // nothing between: dropped too
          turnInfo(conn, "Update", "next words", none) // an interim: a new turn
          turnInfo(conn, "EndOfTurn", "next words", none)
          turnInfo(conn, "StartOfTurn", "done", none)
        }, 7)
        assert.deepStrictEqual(events, [
          { _tag: "SpeechStarted" },
          { _tag: "EndOfTurn", text: "turn on the kitchen lights" },
          { _tag: "SpeechStarted" },
          { _tag: "Interim", text: "next words" },
          { _tag: "EndOfTurn", text: "next words" },
          { _tag: "SpeechStarted" },
          { _tag: "Interim", text: "done" }
        ])
      }))

    it.live("a new connection starts its turn indexes afresh: index 0 after a reconnect is a new turn, its final without a start is delivered", () =>
      Effect.gen(function*() {
        const events = yield* run((conn, index) => {
          if (index === 0) {
            turnInfo(conn, "StartOfTurn", "")
            turnInfo(conn, "EndOfTurn", "hello")
            setTimeout(() => conn.ws.terminate(), 30)
          } else {
            turnInfo(conn, "EndOfTurn", "again") // index 0 again, never opened on this connection
            turnInfo(conn, "EndOfTurn", "again") // a duplicate of it
            turnInfo(conn, "StartOfTurn", "done", { turn_index: 1 })
          }
        }, 6)
        assert.deepStrictEqual(events, [
          { _tag: "SpeechStarted" },
          { _tag: "EndOfTurn", text: "hello" },
          { _tag: "SpeechStarted" },
          { _tag: "EndOfTurn", text: "again" },
          { _tag: "SpeechStarted" },
          { _tag: "Interim", text: "done" }
        ])
      }))
  })
})
