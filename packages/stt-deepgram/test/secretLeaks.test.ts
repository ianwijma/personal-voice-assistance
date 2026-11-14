/**
 * No configured key leaks into an error or a log line, whatever the server at
 * the Deepgram address sends: every failure of a Flux connection (rejected or
 * malformed upgrade, Error and Warning messages early and late, close reasons,
 * malformed frames, dropped sockets), with the key planted in every position
 * the server controls.
 */
import { assert, describe, it } from "@effect/vitest"
import type { SttError } from "@pva/core"
import { Effect } from "effect"
import { createServer as createTcpServer, type Server as TcpServer } from "node:net"
import { type WebSocket, WebSocketServer } from "ws"
import { type ConnectionOptions, FluxConnection } from "../src/FluxConnection.ts"
import { b64, KEYS, leaksOf, planted, serialise } from "./leaks.ts"

const options = (url: string, apiKey: string, extra: Partial<ConnectionOptions> = {}): ConnectionOptions => ({
  url,
  apiKey,
  chunkMs: 80,
  reconnectBufferMs: 480,
  backoffInitialMs: 30,
  backoffMaxMs: 60,
  keepAliveMs: 3000,
  stableMs: 10_000,
  closeTimeoutMs: 300,
  handshakeTimeoutMs: 300,
  ...extra
})

/** A ws server; `reject` refuses the upgrade with that status, message and headers. */
const wsServer = (
  onConnection: (ws: WebSocket) => void,
  reject?: { readonly status: number; readonly message: string; readonly headers: Record<string, string> }
) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; wss: WebSocketServer }>((resume) => {
      const wss = new WebSocketServer({
        port: 0,
        verifyClient: (_info, cb) => (reject ? cb(false, reject.status, reject.message, reject.headers) : cb(true))
      })
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

/** A TCP server that answers the upgrade request with `raw` and closes. */
const rawServer = (raw: string) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; server: TcpServer }>((resume) => {
      const server = createTcpServer((socket) => {
        socket.once("data", () => socket.end(raw))
        socket.on("error", () => {})
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resume(Effect.succeed({ url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v2/listen`, server }))
      })
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
      })
  )

/** Runs one connection for `ms` against `url`; everything it logged and every error it failed with. */
const run = (url: string, key: string, ms: number, extra: Partial<ConnectionOptions> = {}) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const failures: Array<SttError> = []
    const flux = new FluxConnection(options(url, key, extra), {
      emit: () => {},
      fail: (e) => failures.push(e),
      end: () => {},
      log: (_level, message) => logs.push(message)
    })
    flux.start()
    yield* Effect.sleep(ms)
    flux.stop()
    return { logs, failures }
  })

const assertNoLeak = (key: string, what: string, text: string) =>
  assert.deepStrictEqual(leaksOf(key, text), [], `${what} leaked the key: ${text.slice(0, 2000)}`)

describe("credentials never leak (stt-deepgram)", () => {
  for (const key of KEYS) {
    it.live(`every failure of a Flux connection, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        const cases: Array<{ what: string; url: string; extra?: Partial<ConnectionOptions> }> = []
        const add = (what: string, server: { url: string }, extra?: Partial<ConnectionOptions>) => {
          cases.push(extra === undefined ? { what, url: server.url } : { what, url: server.url, extra })
        }
        const send = (message: object) => (ws: WebSocket) => ws.send(JSON.stringify(message))
        add("early Error (fatal)", yield* wsServer(send({ type: "Error", code: p, description: p })))
        add("late Error (logged)", yield* wsServer(send({ type: "Error", code: p, description: p })), { stableMs: 0 })
        add("Warning", yield* wsServer(send({ type: "Warning", code: p, description: p })))
        add("Error with object fields", yield* wsServer(send({ type: "Error", code: { p }, description: [p] })))
        add("non-JSON frame", yield* wsServer((ws) => ws.send(`not json ${p}`)))
        add("frame that is not an object", yield* wsServer((ws) => ws.send(JSON.stringify([p]))))
        // Close reasons are at most 123 bytes: one form per close.
        for (const form of [key, encodeURIComponent(key), b64(key), `Basic ${b64(`u:${key}`)}`]) {
          add(`close reason ${form.slice(0, 8)}`, yield* wsServer((ws) => ws.close(4000, form.slice(0, 120))))
        }
        add("dropped socket", yield* wsServer((ws) => ws.terminate()))
        for (const status of [400, 401, 403, 429, 500, 503]) {
          add(`upgrade refused ${status}`, yield* wsServer(() => {}, { status, message: p.replace(/[^\x20-\x7e]/g, ""), headers: { "x-dg-error": p } }))
        }
        add("upgrade answered with garbage", yield* rawServer(`${p}\r\n\r\n${p}`))
        add("upgrade answered with a bad status line", yield* rawServer(`HTTP/1.1 401 ${p}\r\nx-key: ${p}\r\ncontent-length: 4\r\n\r\n${p}`))
        add("upgrade answered 101 without the handshake", yield* rawServer(`HTTP/1.1 101 ${p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${b64(key)}\r\n\r\n`))
        for (const { what, url, extra } of cases) {
          const { logs, failures } = yield* run(url, key, 250, extra)
          assertNoLeak(key, what, `${serialise(failures)}\n${logs.join("\n")}`)
          assert.isTrue(logs.length + failures.length > 0, `${what}: nothing was reported`)
        }
      }), 60_000)
  }
})
