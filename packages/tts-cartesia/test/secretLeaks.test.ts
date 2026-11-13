/**
 * No configured key leaks into an error or a log line, whatever the server at
 * the Cartesia address sends: every failure of the shared socket and of a turn
 * (context and connection errors, close reasons, refused or malformed upgrades,
 * malformed messages, invalid audio, empty replies, drain timeouts), with the
 * key planted in every position the server controls.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Redacted, Stream } from "effect"
import { createServer as createTcpServer } from "node:net"
import { type WebSocket, WebSocketServer } from "ws"
import { make } from "../src/index.ts"
import { b64, captureLogs, KEYS, leaksOf, planted, serialise } from "./leaks.ts"

type Msg = Record<string, any>

/** A ws server that answers each generation request through `onRequest`; `reject` refuses every upgrade. */
const wsServer = (
  onRequest: (ws: WebSocket, msg: Msg) => void,
  onConnection: (ws: WebSocket) => void = () => {},
  reject?: { readonly status: number; readonly message: string; readonly headers: Record<string, string> }
) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; wss: WebSocketServer }>((resume) => {
      const wss = new WebSocketServer({
        port: 0,
        verifyClient: (_info, cb) => (reject ? cb(false, reject.status, reject.message, reject.headers) : cb(true))
      })
      wss.on("connection", (ws) => {
        onConnection(ws)
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString()) as Msg
          if (typeof msg.transcript === "string" && msg.transcript.trim() !== "") onRequest(ws, msg)
        })
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

const rawServer = (raw: string) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; close: () => void }>((resume) => {
      const server = createTcpServer((socket) => {
        socket.once("data", () => socket.end(raw))
        socket.on("error", () => {})
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resume(Effect.succeed({ url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, close: () => server.close() }))
      })
    }),
    ({ close }) => Effect.sync(close)
  )

/** One turn of one clause against `url`; the exit, and everything logged meanwhile (socket logs included). */
const turn = (url: string, key: string) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const exit = yield* Effect.scoped(Effect.gen(function*() {
      const tts = yield* make({
        apiKey: Redacted.make(key),
        baseUrl: url,
        connectTimeoutMs: 300,
        handshakeTimeoutMs: 200,
        drainTimeoutMs: 200
      })
      const result = yield* Effect.exit(Stream.runCollect(tts.synthesize(Stream.make("Hello there."))))
      yield* Effect.sleep(50) // let late socket logs arrive
      return result
    })).pipe(Effect.provide(captureLogs(logs)))
    return { exit, logs }
  })

const assertNoLeak = (key: string, what: string, text: string) =>
  assert.deepStrictEqual(leaksOf(key, text), [], `${what} leaked the key: ${text.slice(0, 2000)}`)

describe("credentials never leak (tts-cartesia)", () => {
  for (const key of KEYS) {
    it.live(`every failure of a turn and of the socket, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        const errorFields = { status_code: p, error_code: p, title: p, message: p, error: { detail: p } }
        const send = (ws: WebSocket, msg: Msg) => ws.send(JSON.stringify(msg))
        const cases: Array<readonly [string, { url: string }]> = [
          ["context error", yield* wsServer((ws, m) => send(ws, { type: "error", context_id: m.context_id, ...errorFields }))],
          ["connection-level error", yield* wsServer((ws) => send(ws, { type: "error", ...errorFields }))],
          ["connection-level error without fields", yield* wsServer((ws) => send(ws, { type: "error", extra: p }))],
          ["invalid base64 audio", yield* wsServer((ws, m) => send(ws, { type: "chunk", context_id: m.context_id, data: `!!${p}` }))],
          ["done without audio", yield* wsServer((ws, m) => send(ws, { type: "done", done: true, context_id: m.context_id, note: p }))],
          ["silence (drain timeout)", yield* wsServer(() => {})],
          ["non-JSON message", yield* wsServer((ws) => ws.send(`oops ${p}`))],
          ["message that is not an object", yield* wsServer((ws) => send(ws, [p] as never))],
          ["dropped socket", yield* wsServer((ws) => ws.terminate())]
        ]
        for (const form of [key, encodeURIComponent(key), b64(key), `Basic ${b64(`u:${key}`)}`]) {
          cases.push([`close reason ${form.slice(0, 6)}`, yield* wsServer((ws) => ws.close(4000, form.slice(0, 120)))])
          cases.push([`close reason on open ${form.slice(0, 6)}`, yield* wsServer(() => {}, (ws) => ws.close(4001, form.slice(0, 120)))])
        }
        for (const status of [400, 401, 403, 429, 500]) {
          cases.push([
            `upgrade refused ${status}`,
            yield* wsServer(() => {}, () => {}, { status, message: p.replace(/[^\x20-\x7e]/g, ""), headers: { "x-error": p } })
          ])
        }
        cases.push(["upgrade answered with garbage", yield* rawServer(`${p}\r\n\r\n${p}`)])
        cases.push(["upgrade answered with a bad status line", yield* rawServer(`HTTP/1.1 401 ${p}\r\nx-key: ${p}\r\ncontent-length: 4\r\n\r\n${p}`)])
        for (const [what, server] of cases) {
          const { exit, logs } = yield* turn(server.url, key)
          assert.isTrue(Exit.isFailure(exit), `${what}: expected the turn to fail, got ${String(exit)}`)
          assertNoLeak(key, what, `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs.join("\n")}`)
          assert.match(String(exit), /Cartesia/, what)
        }
      }), 60_000)
  }
})
