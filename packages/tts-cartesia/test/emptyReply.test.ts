/**
 * A reply with words that ends "successfully" without any audio is a failure:
 * otherwise the owner hears nothing and the turn counts as answered. Invalid
 * base64 must not count as audio either.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Redacted, Stream } from "effect"
import { type WebSocket, WebSocketServer } from "ws"
import { make } from "../src/index.ts"

type Msg = Record<string, any>

/** Answers each generation request (the clause, then each flush) through `script`. */
const server = (script: (ws: WebSocket, msg: Msg) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; wss: WebSocketServer }>((resume) => {
      const wss = new WebSocketServer({ port: 0 })
      wss.on("connection", (ws) => ws.on("message", (data) => script(ws, JSON.parse(data.toString()) as Msg)))
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

const turn = (url: string, clauses: ReadonlyArray<string>) =>
  Effect.scoped(Effect.gen(function*() {
    const tts = yield* make({ apiKey: Redacted.make("test-key-0123456789"), baseUrl: url, drainTimeoutMs: 300 })
    return yield* Effect.exit(Stream.runCollect(tts.synthesize(Stream.fromIterable(clauses))))
  }))

/** Acknowledges flushes, and answers the end of input (`continue: false`) with `done`. */
const ackAndDone = (ws: WebSocket, msg: Msg, onClause: (ws: WebSocket, msg: Msg) => void) => {
  if (msg.flush === true) send(ws, { type: "flush_done", done: false, flush_done: true, context_id: msg.context_id })
  else if (msg.continue === false) send(ws, { type: "done", done: true, context_id: msg.context_id })
  else if (typeof msg.transcript === "string" && msg.transcript !== "") onClause(ws, msg)
}

describe("empty replies (tts-cartesia)", () => {
  it.live("a clause with words answered with `done` and no audio fails the turn", () =>
    Effect.gen(function*() {
      const { url } = yield* server((ws, msg) => ackAndDone(ws, msg, () => {}))
      const exit = yield* turn(url, ["Hello there."])
      assert.isTrue(Exit.isFailure(exit), String(exit))
      assert.include(String(exit), "without sending any audio")
    }))

  it.live("invalid base64 is not audio: the turn fails instead of ending as if it had spoken", () =>
    Effect.gen(function*() {
      for (const data of ["!!!", "abc", "ab=c", "a"]) {
        const { url } = yield* server((ws, msg) => ackAndDone(ws, msg, (w, m) => send(w, { type: "chunk", data, context_id: m.context_id })))
        const exit = yield* turn(url, ["Hello there."])
        assert.isTrue(Exit.isFailure(exit), `${data}: ${String(exit)}`)
        assert.include(String(exit), "not valid base64", data)
      }
    }))

  it.live("invalid base64 then silence fails; it does not pass the drain check as 'all audio arrived'", () =>
    Effect.gen(function*() {
      // No `done`: the drain timeout decides. The flush is acknowledged, so only `c.audio` separates the outcomes.
      const script = (data: string | undefined) => (ws: WebSocket, msg: Msg) => {
        if (msg.flush === true) send(ws, { type: "flush_done", done: false, flush_done: true, context_id: msg.context_id })
        else if (data !== undefined && typeof msg.transcript === "string" && msg.transcript !== "") {
          send(ws, { type: "chunk", data, context_id: msg.context_id })
        }
      }
      const invalid = yield* server(script("!!!"))
      const exit = yield* turn(invalid.url, ["Hello there."])
      assert.isTrue(Exit.isFailure(exit), String(exit))
      const silent = yield* server(script(undefined))
      const none = yield* turn(silent.url, ["Hello there."])
      assert.isTrue(Exit.isFailure(none), String(none))
      assert.include(String(none), "sent no audio")
    }))

  it.live("audio, then `done`, still succeeds; a punctuation-only clause may be silent", () =>
    Effect.gen(function*() {
      const pcm = Buffer.from([1, 0, 2, 0]).toString("base64")
      const { url } = yield* server((ws, msg) =>
        ackAndDone(ws, msg, (w, m) => {
          if (/[a-z]/i.test(m.transcript)) send(w, { type: "chunk", data: pcm, context_id: m.context_id })
        })
      )
      const spoken = yield* turn(url, ["Hello there.", "…"])
      assert.isTrue(Exit.isSuccess(spoken), String(spoken))
      const silent = yield* turn(url, ["…"])
      assert.isTrue(Exit.isSuccess(silent), String(silent))
    }))
})
