import { assert, describe, it } from "@effect/vitest"
import { Tts, type TtsAudio, TtsError } from "@pva/core"
import { Cause, Effect, Exit, Fiber, Queue, Redacted, Stream } from "effect"
import { createServer, type IncomingMessage } from "node:http"
import { type WebSocket, WebSocketServer } from "ws"
import { CARTESIA_VERSION, type CartesiaOptions, DEFAULT_MODEL, DEFAULT_VOICE, layer } from "../src/index.ts"

// A local `ws` server standing in for Cartesia.

/** Promise FIFO with a timeout, so a missing message fails the test instead of hanging it. */
class Inbox<A> {
  private items: Array<A> = []
  private waiters: Array<(a: A) => void> = []
  push(a: A) {
    const waiter = this.waiters.shift()
    if (waiter) waiter(a)
    else this.items.push(a)
  }
  get size() {
    return this.items.length
  }
  take(timeoutMs = 2000): Effect.Effect<A> {
    return Effect.promise(() => {
      if (this.items.length > 0) return Promise.resolve(this.items.shift()!)
      return new Promise<A>((resolve, reject) => {
        const waiter = (a: A) => {
          clearTimeout(timer)
          resolve(a)
        }
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(new Error("timed out waiting"))
        }, timeoutMs)
        this.waiters.push(waiter)
      })
    })
  }
}

interface Conn {
  readonly ws: WebSocket
  readonly url: URL
  readonly headers: IncomingMessage["headers"]
}

type Msg = Record<string, any>

const mockServer = Effect.acquireRelease(
  Effect.callback<{ port: number; conns: Inbox<Conn>; messages: Inbox<Msg>; count: () => number; wss: WebSocketServer }>(
    (resume) => {
      const conns = new Inbox<Conn>()
      const messages = new Inbox<Msg>()
      let count = 0
      const wss = new WebSocketServer({ port: 0 })
      wss.on("connection", (ws, req) => {
        count++
        conns.push({ ws, url: new URL(req.url ?? "/", "ws://localhost"), headers: req.headers })
        ws.on("message", (data) => messages.push(JSON.parse(data.toString())))
      })
      wss.on("listening", () => {
        const address = wss.address()
        resume(Effect.succeed({
          port: typeof address === "object" && address !== null ? address.port : 0,
          conns,
          messages,
          count: () => count,
          wss
        }))
      })
    }
  ),
  ({ wss }) =>
    Effect.promise(() =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resolve())
      })
    )
)

const send = (conn: Conn, msg: Msg) => Effect.sync(() => conn.ws.send(JSON.stringify(msg)))
const chunk = (context_id: string, bytes: ReadonlyArray<number>) => ({
  type: "chunk",
  data: Buffer.from(bytes).toString("base64"),
  done: false,
  status_code: 206,
  step_time: 10,
  context_id
})
const flushDone = (context_id: string, flush_id: number) => ({
  type: "flush_done",
  done: false,
  flush_done: true,
  flush_id,
  status_code: 200,
  context_id
})
const done = (context_id: string) => ({ type: "done", done: true, status_code: 200, context_id })

const options = (port: number, extra: Partial<CartesiaOptions> = {}): CartesiaOptions => ({
  apiKey: Redacted.make("test-key"),
  baseUrl: `ws://127.0.0.1:${port}`,
  ...extra
})

/** Clauses fed by the test over time. */
const clauseFeed = Queue.unbounded<string, Cause.Done>()

/** Runs `synthesize` in the background, collecting chunks as they arrive. */
const startTurn = (tts: Tts["Service"], clauses: Stream.Stream<string>) =>
  Effect.gen(function*() {
    const got: Array<{ audio: Array<number>; clause: number }> = []
    const fiber = yield* tts.synthesize(clauses).pipe(
      Stream.runForEach((c: TtsAudio) => Effect.sync(() => got.push({ audio: [...c.audio], clause: c.clause }))),
      Effect.forkChild
    )
    return { got, fiber }
  })

const waitFor = (cond: () => boolean) =>
  Effect.promise(() =>
    new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = () => {
        if (cond()) resolve()
        else if (Date.now() - start > 2000) reject(new Error("condition not met"))
        else setTimeout(tick, 5)
      }
      tick()
    })
  )

describe("Cartesia Tts", () => {
  it.live("connects at build with the API key and version, before any turn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        assert.strictEqual(conn.url.pathname, "/tts/websocket")
        assert.strictEqual(conn.url.searchParams.get("cartesia_version"), CARTESIA_VERSION)
        assert.strictEqual(conn.headers["x-api-key"], "test-key")
        assert.strictEqual(conn.headers["cartesia-version"], CARTESIA_VERSION)
        assert.strictEqual(tts.sampleRate, 24_000)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("streams three clauses as continuations of one context, attributing audio by flush", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const feed = yield* clauseFeed
        const { got, fiber } = yield* startTurn(tts, Stream.fromQueue(feed))

        // Clause 0 goes out (text, then flush) before clause 1 exists.
        yield* Queue.offer(feed, "Hello there.")
        const m1 = yield* server.messages.take()
        const m2 = yield* server.messages.take()
        const id = m1.context_id as string
        assert.deepStrictEqual(m1, {
          model_id: DEFAULT_MODEL,
          voice: { id: DEFAULT_VOICE },
          output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24_000 },
          language: "en",
          max_buffer_delay_ms: 0,
          context_id: id,
          transcript: "Hello there.",
          continue: true
        })
        assert.strictEqual(m2.context_id, id)
        assert.strictEqual(m2.transcript, "")
        assert.strictEqual(m2.continue, true)
        assert.strictEqual(m2.flush, true)
        yield* send(conn, chunk(id, [1, 2, 3, 4]))

        yield* Queue.offer(feed, "How are you?")
        const m3 = yield* server.messages.take()
        const m4 = yield* server.messages.take()
        assert.strictEqual(m3.context_id, id)
        assert.strictEqual(m3.transcript, " How are you?")
        assert.strictEqual(m3.continue, true)
        assert.isUndefined(m3.flush)
        assert.strictEqual(m4.flush, true)
        // Tail of clause 0 arrives after clause 1 was sent but before its flush_done.
        yield* send(conn, chunk(id, [5, 6]))
        yield* send(conn, flushDone(id, 1))
        yield* send(conn, chunk(id, [7, 8]))
        yield* send(conn, flushDone(id, 2))

        yield* Queue.offer(feed, "Bye.")
        const m5 = yield* server.messages.take()
        yield* server.messages.take()
        assert.strictEqual(m5.transcript, " Bye.")
        yield* send(conn, chunk(id, [9, 10]))
        yield* send(conn, flushDone(id, 3))

        yield* Queue.end(feed)
        const end = yield* server.messages.take()
        assert.strictEqual(end.context_id, id)
        assert.strictEqual(end.transcript, "")
        assert.strictEqual(end.continue, false)
        yield* send(conn, done(id))

        yield* Fiber.join(fiber)
        assert.deepStrictEqual(got, [
          { audio: [1, 2, 3, 4], clause: 0 },
          { audio: [5, 6], clause: 0 },
          { audio: [7, 8], clause: 1 },
          { audio: [9, 10], clause: 2 }
        ])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("interruption cancels the context and drops its late audio while the next turn flows", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()

        const turn1 = yield* startTurn(tts, Stream.concat(Stream.make("First turn."), Stream.never))
        const a = (yield* server.messages.take()).context_id as string
        yield* server.messages.take()
        yield* send(conn, chunk(a, [1, 1]))
        yield* waitFor(() => turn1.got.length === 1)
        yield* Fiber.interrupt(turn1.fiber)
        assert.deepStrictEqual(yield* server.messages.take(), { context_id: a, cancel: true })

        const turn2 = yield* startTurn(tts, Stream.make("Second turn."))
        const b = (yield* server.messages.take()).context_id as string
        assert.notStrictEqual(a, b)
        yield* server.messages.take() // flush
        yield* server.messages.take() // end of input
        yield* send(conn, chunk(a, [9, 9])) // late audio of the cancelled context
        yield* send(conn, chunk(b, [2, 2]))
        yield* send(conn, done(a))
        yield* send(conn, done(b))
        yield* Fiber.join(turn2.fiber)
        assert.deepStrictEqual(turn1.got, [{ audio: [1, 1], clause: 0 }])
        assert.deepStrictEqual(turn2.got, [{ audio: [2, 2], clause: 0 }])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("routes two overlapping contexts by id and reuses the socket across turns", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turnA = yield* startTurn(tts, Stream.make("Speculative."))
        const msgsA = [yield* server.messages.take(), yield* server.messages.take(), yield* server.messages.take()]
        const turnB = yield* startTurn(tts, Stream.make("Committed."))
        const msgsB = [yield* server.messages.take(), yield* server.messages.take(), yield* server.messages.take()]
        const a = msgsA[0]!.context_id as string
        const b = msgsB[0]!.context_id as string
        assert.isTrue(msgsA.every((m) => m.context_id === a) && msgsB.every((m) => m.context_id === b))
        yield* send(conn, chunk(b, [2]))
        yield* send(conn, chunk(a, [1]))
        yield* send(conn, chunk(b, [3]))
        yield* send(conn, done(a))
        yield* send(conn, chunk(b, [4]))
        yield* send(conn, done(b))
        yield* Fiber.join(turnA.fiber)
        yield* Fiber.join(turnB.fiber)
        assert.deepStrictEqual(turnA.got.map((c) => c.audio), [[1]])
        assert.deepStrictEqual(turnB.got.map((c) => c.audio), [[2], [3], [4]])

        // A third turn, and an empty one (nothing is sent), on the same socket.
        const empty = yield* startTurn(tts, Stream.empty)
        yield* Fiber.join(empty.fiber)
        assert.deepStrictEqual(empty.got, [])
        const turnC = yield* startTurn(tts, Stream.make("Again."))
        const c = (yield* server.messages.take()).context_id as string
        yield* server.messages.take()
        yield* server.messages.take()
        yield* send(conn, chunk(c, [5]))
        yield* send(conn, done(c))
        yield* Fiber.join(turnC.fiber)
        assert.deepStrictEqual(turnC.got.map((x) => x.audio), [[5]])
        assert.strictEqual(server.count(), 1)
        assert.strictEqual(server.messages.size, 0)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a clause after the context went quiet (tool call) continues on a fresh context", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const feed = yield* clauseFeed
        const { got, fiber } = yield* startTurn(tts, Stream.fromQueue(feed))
        yield* Queue.offer(feed, "Let me check.")
        const a = (yield* server.messages.take()).context_id as string
        yield* server.messages.take()
        yield* send(conn, chunk(a, [1]))
        yield* send(conn, flushDone(a, 1))
        yield* Effect.sleep("800 millis") // past the server's 1 s expiry window, minus margin
        yield* Queue.offer(feed, "It is sunny.")
        const m = yield* server.messages.take()
        yield* server.messages.take()
        const b = m.context_id as string
        assert.notStrictEqual(a, b)
        assert.strictEqual(m.transcript, "It is sunny.")
        yield* send(conn, chunk(b, [2]))
        yield* Queue.end(feed)
        const end = yield* server.messages.take()
        assert.strictEqual(end.context_id, b)
        yield* send(conn, done(b))
        yield* Fiber.join(fiber)
        assert.deepStrictEqual(got, [{ audio: [1], clause: 0 }, { audio: [2], clause: 1 }])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("reopens an idle socket before the server's idle limit", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        yield* Tts
        yield* server.conns.take()
        yield* server.conns.take() // the refreshed connection
      }).pipe(Effect.provide(layer(options(server.port, { pingIntervalMs: 50, idleRefreshMs: 100 }))))
    }))

  it.live("a drop mid-turn fails that turn; the socket reconnects and the next turn works", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn1 = yield* server.conns.take()
        const turn1 = yield* startTurn(tts, Stream.concat(Stream.make("Hello."), Stream.never))
        yield* server.messages.take()
        yield* server.messages.take()
        conn1.ws.terminate()
        const exit = yield* Fiber.await(turn1.fiber)
        assert.isTrue(Exit.isFailure(exit))
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        assert.instanceOf(error, TtsError)
        assert.match((error as TtsError).message, /connection closed/)

        const conn2 = yield* server.conns.take()
        const turn2 = yield* startTurn(tts, Stream.make("Back."))
        const id = (yield* server.messages.take()).context_id as string
        yield* server.messages.take()
        yield* server.messages.take()
        yield* send(conn2, chunk(id, [7]))
        yield* send(conn2, done(id))
        yield* Fiber.join(turn2.fiber)
        assert.deepStrictEqual(turn2.got, [{ audio: [7], clause: 0 }])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a server error message fails the turn with TtsError", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn = yield* startTurn(tts, Stream.make("Hi."))
        const id = (yield* server.messages.take()).context_id as string
        yield* send(conn, {
          type: "error",
          status_code: 400,
          error_code: "model_not_found",
          title: "Invalid model",
          message: "Model sonic-9 not found",
          done: true,
          context_id: id
        })
        const exit = yield* Fiber.await(turn.fiber)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        assert.instanceOf(error, TtsError)
        assert.match((error as TtsError).message, /400.*model_not_found.*Model sonic-9 not found/)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a turn fails with TtsError when no connection comes up in time", () =>
    Effect.gen(function*() {
      // Grab a free port, then close the server so nothing listens there.
      const server = yield* mockServer
      const port = server.port
      yield* Effect.promise(() => new Promise<void>((resolve) => server.wss.close(() => resolve())))
      const exit = yield* Effect.gen(function*() {
        const tts = yield* Tts
        return yield* Stream.runCollect(tts.synthesize(Stream.make("Hello.")))
      }).pipe(Effect.provide(layer(options(port, { connectTimeoutMs: 200 }))), Effect.exit)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      assert.instanceOf(error, TtsError)
      assert.match((error as TtsError).message, /not connected after 200 ms/)
    }))

  it.live("text frames that are valid JSON but not an object, or have odd fields, are dropped; the turn completes", () =>
    Effect.gen(function*() {
      const uncaught: Array<unknown> = []
      const onUncaught = (e: unknown) => uncaught.push(e)
      process.on("uncaughtException", onUncaught)
      yield* Effect.addFinalizer(() => Effect.sync(() => process.off("uncaughtException", onUncaught)))
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn = yield* startTurn(tts, Stream.make("Hi."))
        const id = (yield* server.messages.take()).context_id as string
        yield* server.messages.take()
        yield* server.messages.take()
        for (const frame of ["null", "[1]", "7", "\"x\"", JSON.stringify({ context_id: 5 }), JSON.stringify({ type: "chunk", context_id: id, data: 5 })]) {
          yield* Effect.sync(() => conn.ws.send(frame))
        }
        yield* send(conn, chunk(id, [1, 2]))
        yield* send(conn, done(id))
        yield* Fiber.join(turn.fiber)
        assert.deepStrictEqual(turn.got, [{ audio: [1, 2], clause: 0 }])
        assert.deepStrictEqual(uncaught, [])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("error text that echoes the API key is redacted", () =>
    Effect.gen(function*() {
      const key = "ct-0123456789abcdefSECRET"
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn = yield* startTurn(tts, Stream.make("Hi."))
        const id = (yield* server.messages.take()).context_id as string
        yield* send(conn, { type: "error", status_code: 401, title: "Unauthorized", message: `bad key ${key}`, done: true, context_id: id })
        const exit = yield* Fiber.await(turn.fiber)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        assert.instanceOf(error, TtsError)
        assert.include((error as TtsError).message, "Unauthorized")
        assert.notInclude((error as TtsError).message, key)
      }).pipe(Effect.provide(layer(options(server.port, { apiKey: Redacted.make(key) }))))
    }))

  it.live("a context that never sends audio or done fails the turn and is cancelled", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        yield* server.conns.take()
        const turn = yield* startTurn(tts, Stream.make("Hello."))
        const id = (yield* server.messages.take()).context_id as string
        yield* server.messages.take() // flush
        yield* server.messages.take() // end of input
        const exit = yield* Fiber.await(turn.fiber)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        assert.instanceOf(error, TtsError)
        assert.match((error as TtsError).message, /no audio/)
        assert.deepStrictEqual(yield* server.messages.take(), { context_id: id, cancel: true })
      }).pipe(Effect.provide(layer(options(server.port, { drainTimeoutMs: 200 }))))
    }))

  it.live("a context that stops before its last flush is acknowledged fails the turn (truncated speech)", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn = yield* startTurn(tts, Stream.make("One.", "Two."))
        const id = (yield* server.messages.take()).context_id as string
        for (let i = 0; i < 4; i++) yield* server.messages.take() // flush, clause 2, flush, end of input
        yield* send(conn, chunk(id, [1]))
        yield* send(conn, flushDone(id, 1))
        const exit = yield* Fiber.await(turn.fiber)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        assert.instanceOf(error, TtsError)
        assert.match((error as TtsError).message, /1 of 2/)
        assert.deepStrictEqual(turn.got, [{ audio: [1], clause: 0 }])
        assert.deepStrictEqual(yield* server.messages.take(), { context_id: id, cancel: true })
      }).pipe(Effect.provide(layer(options(server.port, { drainTimeoutMs: 200 }))))
    }))

  it.live("a context whose speech was all generated but whose done never came still ends the turn normally", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn = yield* startTurn(tts, Stream.make("One."))
        const id = (yield* server.messages.take()).context_id as string
        yield* server.messages.take()
        yield* server.messages.take()
        yield* send(conn, chunk(id, [1]))
        yield* send(conn, flushDone(id, 1))
        yield* Fiber.join(turn.fiber)
        assert.deepStrictEqual(turn.got, [{ audio: [1], clause: 0 }])
      }).pipe(Effect.provide(layer(options(server.port, { drainTimeoutMs: 200 }))))
    }))

  it.live("a server that accepts the connection but never completes the upgrade is abandoned and replaced", () =>
    Effect.gen(function*() {
      const wss = new WebSocketServer({ noServer: true })
      const conns = new Inbox<Conn>()
      const messages = new Inbox<Msg>()
      wss.on("connection", (ws, req) => {
        conns.push({ ws, url: new URL(req.url ?? "/", "ws://localhost"), headers: req.headers })
        ws.on("message", (data) => messages.push(JSON.parse(data.toString())))
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
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        // The first turn starts while the first handshake hangs; it gets the replacement socket.
        const turn = yield* startTurn(tts, Stream.make("Hi."))
        const conn = yield* conns.take()
        const id = (yield* messages.take()).context_id as string
        yield* messages.take()
        yield* messages.take()
        yield* send(conn, chunk(id, [4]))
        yield* send(conn, done(id))
        yield* Fiber.join(turn.fiber)
        assert.deepStrictEqual(turn.got, [{ audio: [4], clause: 0 }])
        assert.strictEqual(upgrades, 2)
      }).pipe(Effect.provide(layer(options(port, { handshakeTimeoutMs: 200, connectTimeoutMs: 1500 }))))
    }))
})
