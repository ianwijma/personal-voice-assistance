import { assert, describe, it } from "@effect/vitest"
import { Tts, type TtsAudio, TtsError } from "@pva/core"
import { Cause, Effect, Exit, Fiber, Queue, Redacted, Stream } from "effect"
import type { IncomingMessage } from "node:http"
import { type WebSocket, WebSocketServer } from "ws"
import { DEFAULT_MODEL, DEFAULT_VOICE, type ElevenLabsOptions, layer, make, MAX_CONTEXTS_PER_SOCKET } from "../src/index.ts"

// A local `ws` server standing in for ElevenLabs.

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
  readonly messages: Inbox<Msg>
}

type Msg = Record<string, any>

const mockServer = Effect.acquireRelease(
  Effect.callback<{ port: number; conns: Inbox<Conn>; count: () => number; wss: WebSocketServer }>((resume) => {
    const conns = new Inbox<Conn>()
    let count = 0
    const wss = new WebSocketServer({ port: 0 })
    wss.on("connection", (ws, req) => {
      count++
      const messages = new Inbox<Msg>()
      conns.push({ ws, url: new URL(req.url ?? "/", "ws://localhost"), headers: req.headers, messages })
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())))
    })
    wss.on("listening", () => {
      const address = wss.address()
      resume(Effect.succeed({ port: typeof address === "object" && address !== null ? address.port : 0, conns, count: () => count, wss }))
    })
  }),
  ({ wss }) =>
    Effect.promise(() =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resolve())
      })
    )
)

const send = (conn: Conn, msg: Msg) => Effect.sync(() => conn.ws.send(JSON.stringify(msg)))
/** An audio chunk speaking `text` (its alignment, as ElevenLabs sends it with `sync_alignment`). */
const audio = (contextId: string, bytes: ReadonlyArray<number>, text?: string) => ({
  audio: Buffer.from(bytes).toString("base64"),
  contextId,
  ...(text !== undefined
    ? { alignment: { chars: [...text], charStartTimesMs: [...text].map((_, i) => i * 10), charDurationsMs: [...text].map(() => 10) } }
    : {}),
  normalizedAlignment: null
})
const final = (contextId: string) => ({ isFinal: true, contextId })

const options = (port: number, extra: Partial<ElevenLabsOptions> = {}): ElevenLabsOptions => ({
  apiKey: Redacted.make("test-key"),
  baseUrl: `ws://127.0.0.1:${port}`,
  ...extra
})

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

/** Takes the opening message of a new context and returns its id. */
const takeInit = (conn: Conn) =>
  Effect.gen(function*() {
    const init = yield* conn.messages.take()
    assert.strictEqual(init.text, " ")
    assert.isString(init.context_id)
    return init.context_id as string
  })

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  assert.isTrue(Exit.isFailure(exit), String(exit))
  if (!Exit.isFailure(exit)) return ""
  const error = Cause.squash(exit.cause)
  assert.instanceOf(error, TtsError)
  return (error as TtsError).message
}

describe("ElevenLabs Tts", () => {
  it.live("connects at build with the key in a header and the settings in the query, before any turn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        assert.strictEqual(conn.url.pathname, `/v1/text-to-speech/${DEFAULT_VOICE}/multi-stream-input`)
        assert.strictEqual(conn.url.searchParams.get("model_id"), DEFAULT_MODEL)
        assert.strictEqual(conn.url.searchParams.get("output_format"), "pcm_24000")
        assert.strictEqual(conn.url.searchParams.get("sync_alignment"), "true")
        assert.strictEqual(conn.url.searchParams.get("auto_mode"), "true")
        assert.strictEqual(conn.url.searchParams.get("inactivity_timeout"), "180")
        assert.isNull(conn.url.searchParams.get("language_code"))
        assert.strictEqual(conn.headers["xi-api-key"], "test-key")
        assert.isFalse(conn.url.search.includes("test-key"))
        assert.strictEqual(tts.sampleRate, 24_000)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("voice, model, rate, language and voice settings reach the server", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        assert.strictEqual(conn.url.pathname, "/v1/text-to-speech/voice%2F1/multi-stream-input")
        assert.strictEqual(conn.url.searchParams.get("model_id"), "eleven_multilingual_v2")
        assert.strictEqual(conn.url.searchParams.get("output_format"), "pcm_16000")
        assert.strictEqual(conn.url.searchParams.get("language_code"), "nl")
        assert.strictEqual(tts.sampleRate, 16_000)
        const { fiber } = yield* startTurn(tts, Stream.make("Hallo."))
        const init = yield* conn.messages.take()
        assert.deepStrictEqual(init, { text: " ", context_id: init.context_id, voice_settings: { speed: 1.1, stability: 0.4 } })
        yield* conn.messages.take() // the clause
        yield* conn.messages.take() // close_context
        yield* send(conn, audio(init.context_id, [1, 2], "Hallo."))
        yield* send(conn, final(init.context_id))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
      }).pipe(Effect.provide(layer(options(server.port, {
        voice: "voice/1",
        model: "eleven_multilingual_v2",
        sampleRate: 16_000,
        language: "nl",
        speed: 1.1,
        stability: 0.4
      }))))
    }))

  it.live("streams clauses into one context, flushing each, and attributes audio by its alignment", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const feed = yield* Queue.unbounded<string, Cause.Done>()
        const { got, fiber } = yield* startTurn(tts, Stream.fromQueue(feed))

        // Clause 0 goes out (flushed) before clause 1 exists.
        yield* Queue.offer(feed, "Hello there.")
        const id = yield* takeInit(conn)
        assert.deepStrictEqual(yield* conn.messages.take(), { text: "Hello there. ", context_id: id, flush: true })
        yield* send(conn, audio(id, [1, 2, 3, 4], "Hello "))

        yield* Queue.offer(feed, "How are you?")
        assert.deepStrictEqual(yield* conn.messages.take(), { text: "How are you? ", context_id: id, flush: true })
        // The tail of clause 0, then a chunk that starts in clause 1.
        yield* send(conn, audio(id, [5, 6], "there. "))
        yield* send(conn, audio(id, [7, 8], "How are you? "))

        yield* Queue.offer(feed, "Bye.")
        yield* conn.messages.take()
        yield* send(conn, audio(id, [9, 10], "Bye."))

        yield* Queue.end(feed)
        assert.deepStrictEqual(yield* conn.messages.take(), { context_id: id, close_context: true })
        yield* send(conn, final(id))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
        assert.deepStrictEqual(got, [
          { audio: [1, 2, 3, 4], clause: 0 },
          { audio: [5, 6], clause: 0 },
          { audio: [7, 8], clause: 1 },
          { audio: [9, 10], clause: 2 }
        ])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a chunk without an alignment keeps the previous clause; tags never decrease", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const { got, fiber } = yield* startTurn(tts, Stream.make("One.", "Two."))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* conn.messages.take()
        yield* conn.messages.take() // close_context
        yield* send(conn, audio(id, [1, 2]))
        yield* send(conn, audio(id, [3, 4], "One. Tw"))
        yield* send(conn, audio(id, [5, 6]))
        yield* send(conn, audio(id, [7, 8], "o."))
        yield* send(conn, { is_final: true, contextId: id }) // the spelling the guide's examples use
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
        assert.deepStrictEqual(got.map((c) => c.clause), [0, 0, 0, 1])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a sample split across two chunks is joined", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const { got, fiber } = yield* startTurn(tts, Stream.make("Hi."))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* conn.messages.take()
        yield* send(conn, audio(id, [1, 2, 3], "H"))
        yield* send(conn, audio(id, [4, 5, 6, 7, 8], "i."))
        yield* send(conn, final(id))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
        assert.deepStrictEqual(got.map((c) => c.audio), [[1, 2], [3, 4, 5, 6, 7, 8]])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("interruption closes the context and drops its late audio while the next turn flows", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn1 = yield* startTurn(tts, Stream.concat(Stream.make("A long story."), Stream.never))
        const id1 = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* send(conn, audio(id1, [1, 2], "A "))
        yield* waitFor(() => turn1.got.length === 1)
        yield* Fiber.interrupt(turn1.fiber)
        assert.deepStrictEqual(yield* conn.messages.take(), { context_id: id1, close_context: true })

        const turn2 = yield* startTurn(tts, Stream.make("Yes?"))
        const id2 = yield* takeInit(conn)
        assert.notStrictEqual(id1, id2)
        yield* conn.messages.take()
        yield* conn.messages.take()
        yield* send(conn, audio(id1, [9, 9], "long ")) // late audio of the interrupted turn
        yield* send(conn, audio(id2, [3, 4], "Yes?"))
        yield* send(conn, final(id2))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(turn2.fiber)))
        assert.deepStrictEqual(turn2.got, [{ audio: [3, 4], clause: 0 }])
        assert.strictEqual(server.count(), 1)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("an empty reply sends nothing and ends at once", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const chunks = yield* Stream.runCollect(tts.synthesize(Stream.empty))
        assert.strictEqual(chunks.length, 0)
        yield* Effect.sleep(50)
        assert.strictEqual(conn.messages.size, 0)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a reply with words that finishes without audio fails the turn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const { fiber } = yield* startTurn(tts, Stream.make("Hello there."))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* conn.messages.take()
        yield* send(conn, final(id))
        assert.include(failureMessage(yield* Fiber.await(fiber)), "without sending any audio")
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a reply of punctuation only needs no audio", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const { fiber } = yield* startTurn(tts, Stream.make("…"))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* conn.messages.take()
        yield* send(conn, final(id))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("invalid base64 fails the turn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const { fiber } = yield* startTurn(tts, Stream.make("Hello."))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* send(conn, { audio: "!!!", contextId: id })
        assert.include(failureMessage(yield* Fiber.await(fiber)), "not valid base64")
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("an error message, for the context or for the connection, fails the turn", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn1 = yield* startTurn(tts, Stream.concat(Stream.make("Hello."), Stream.never))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* send(conn, { contextId: id, error: "quota_exceeded", message: "You have run out of credits" })
        const m1 = failureMessage(yield* Fiber.await(turn1.fiber))
        assert.include(m1, "quota_exceeded")
        assert.include(m1, "run out of credits")

        const turn2 = yield* startTurn(tts, Stream.concat(Stream.make("Hello."), Stream.never))
        yield* takeInit(conn)
        yield* conn.messages.take()
        yield* send(conn, { message: "Invalid API key", error: "invalid_api_key", code: 1008 })
        assert.include(failureMessage(yield* Fiber.await(turn2.fiber)), "invalid_api_key")
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a drop mid-turn fails that turn; the socket reconnects and the next turn works", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn1 = yield* server.conns.take()
        const turn1 = yield* startTurn(tts, Stream.concat(Stream.make("Hello."), Stream.never))
        yield* takeInit(conn1)
        conn1.ws.terminate()
        assert.include(failureMessage(yield* Fiber.await(turn1.fiber)), "connection closed")

        const conn2 = yield* server.conns.take()
        const turn2 = yield* startTurn(tts, Stream.make("Again."))
        const id = yield* takeInit(conn2)
        yield* conn2.messages.take()
        yield* conn2.messages.take()
        yield* send(conn2, audio(id, [1, 2], "Again."))
        yield* send(conn2, final(id))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(turn2.fiber)))
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a turn fails with TtsError when no connection comes up in time", () =>
    Effect.gen(function*() {
      const tts = yield* make({ apiKey: Redacted.make("k"), baseUrl: "ws://127.0.0.1:9", connectTimeoutMs: 200 })
      const exit = yield* Effect.exit(Stream.runCollect(tts.synthesize(Stream.make("Hello."))))
      assert.include(failureMessage(exit), "not connected after 200 ms")
    }).pipe(Effect.scoped))

  it.live("settings the server would refuse fail every turn with a message naming the setting", () =>
    Effect.gen(function*() {
      for (
        const [extra, name] of [
          [{ sampleRate: 11_025 }, "ELEVENLABS_SAMPLE_RATE"],
          [{ speed: 2 }, "ELEVENLABS_SPEED"],
          [{ stability: -1 }, "ELEVENLABS_STABILITY"],
          [{ voice: " " }, "ELEVENLABS_VOICE"],
          [{ baseUrl: "https://user:pw@example.com" }, "ELEVENLABS_URL"]
        ] as const
      ) {
        const tts = yield* make({ apiKey: Redacted.make("k"), ...extra })
        const exit = yield* Effect.exit(Stream.runCollect(tts.synthesize(Stream.make("Hello."))))
        assert.include(failureMessage(exit), name)
      }
    }).pipe(Effect.scoped))

  it.live("silence after the end of input: with audio the turn ends, without it fails", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn1 = yield* startTurn(tts, Stream.make("Hello."))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* conn.messages.take()
        yield* send(conn, audio(id, [1, 2], "Hello."))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(turn1.fiber)))

        const turn2 = yield* startTurn(tts, Stream.make("Hello."))
        yield* takeInit(conn)
        yield* conn.messages.take()
        yield* conn.messages.take()
        assert.include(failureMessage(yield* Fiber.await(turn2.fiber)), "no audio for this reply")
      }).pipe(Effect.provide(layer(options(server.port, { drainTimeoutMs: 150 }))))
    }))

  it.live("a context the server ends early continues on a fresh one", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const feed = yield* Queue.unbounded<string, Cause.Done>()
        const { got, fiber } = yield* startTurn(tts, Stream.fromQueue(feed))
        yield* Queue.offer(feed, "Let me check.")
        const id1 = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* send(conn, audio(id1, [1, 2], "Let me check."))
        yield* send(conn, final(id1)) // e.g. its inactivity timeout during a tool call
        yield* waitFor(() => got.length === 1)
        yield* Effect.sleep(20)
        yield* Queue.offer(feed, "It is sunny.")
        const id2 = yield* takeInit(conn)
        assert.notStrictEqual(id1, id2)
        assert.deepStrictEqual(yield* conn.messages.take(), { text: "It is sunny. ", context_id: id2, flush: true })
        yield* Queue.end(feed)
        assert.deepStrictEqual(yield* conn.messages.take(), { context_id: id2, close_context: true })
        yield* send(conn, audio(id2, [3, 4], "It is sunny."))
        yield* send(conn, final(id2))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
        assert.deepStrictEqual(got, [{ audio: [1, 2], clause: 0 }, { audio: [3, 4], clause: 1 }])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("a quiet turn keeps its context alive", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const turn = yield* startTurn(tts, Stream.concat(Stream.make("Let me check."), Stream.never))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        assert.deepStrictEqual(yield* conn.messages.take(), { text: "", context_id: id })
        yield* Fiber.interrupt(turn.fiber)
      }).pipe(Effect.provide(layer(options(server.port, { keepAliveMs: 100 }))))
    }))

  it.live(`more than ${MAX_CONTEXTS_PER_SOCKET} turns at once open a second socket, closed when its turn ends`, () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn1 = yield* server.conns.take()
        const turns = []
        for (let i = 0; i < MAX_CONTEXTS_PER_SOCKET; i++) {
          turns.push(yield* startTurn(tts, Stream.concat(Stream.make(`Turn ${i}.`), Stream.never)))
          yield* takeInit(conn1)
          yield* conn1.messages.take()
        }
        const extra = yield* startTurn(tts, Stream.make("One more."))
        const conn2 = yield* server.conns.take()
        const id = yield* takeInit(conn2)
        yield* conn2.messages.take()
        yield* conn2.messages.take()
        yield* send(conn2, audio(id, [1, 2], "One more."))
        yield* send(conn2, final(id))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(extra.fiber)))
        yield* waitFor(() => conn2.ws.readyState === conn2.ws.CLOSED)
        assert.strictEqual(conn1.ws.readyState, conn1.ws.OPEN)
        for (const t of turns) yield* Fiber.interrupt(t.fiber)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live(`${MAX_CONTEXTS_PER_SOCKET + 1} turns that start together use two sockets`, () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn1 = yield* server.conns.take()
        const turns = yield* Effect.forEach(
          Array.from({ length: MAX_CONTEXTS_PER_SOCKET + 1 }, (_, i) => i),
          (i) => startTurn(tts, Stream.concat(Stream.make(`Turn ${i}.`), Stream.never))
        )
        const conn2 = yield* server.conns.take()
        yield* takeInit(conn2)
        yield* waitFor(() => conn1.messages.size === 2 * MAX_CONTEXTS_PER_SOCKET)
        for (const t of turns) yield* Fiber.interrupt(t.fiber)
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("frames that are not JSON objects, and messages for unknown contexts, are dropped; the turn completes", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const { got, fiber } = yield* startTurn(tts, Stream.make("Hello."))
        const id = yield* takeInit(conn)
        yield* conn.messages.take()
        yield* conn.messages.take()
        yield* Effect.sync(() => conn.ws.send("not json"))
        yield* send(conn, [1, 2] as never)
        yield* send(conn, audio("someone-else", [9, 9], "x"))
        yield* send(conn, { contextId: id, audio: null, alignment: "odd" })
        yield* send(conn, audio(id, [1, 2], "Hello."))
        yield* send(conn, final(id))
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
        assert.deepStrictEqual(got, [{ audio: [1, 2], clause: 0 }])
      }).pipe(Effect.provide(layer(options(server.port))))
    }))

  it.live("error text that echoes the API key is redacted", () =>
    Effect.gen(function*() {
      const server = yield* mockServer
      yield* Effect.gen(function*() {
        const tts = yield* Tts
        const conn = yield* server.conns.take()
        const { fiber } = yield* startTurn(tts, Stream.concat(Stream.make("Hello."), Stream.never))
        const id = yield* takeInit(conn)
        yield* send(conn, { contextId: id, error: "invalid_api_key", message: "Invalid API key: test-key-secret-123" })
        const message = failureMessage(yield* Fiber.await(fiber))
        assert.notInclude(message, "test-key-secret-123")
        assert.include(message, "[redacted]")
      }).pipe(Effect.provide(layer(options(server.port, { apiKey: Redacted.make("test-key-secret-123") }))))
    }))
})
