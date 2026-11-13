import { CloseCode, FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, MAX_TEXT_FRAME_BYTES, WS_PATH } from "@pva/protocol"
import { Effect, Schema, type Scope } from "effect"
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import * as net from "node:net"
import { type Duplex, pipeline } from "node:stream"
import { extname, join, resolve, sep } from "node:path"
import { type WebSocket, WebSocketServer } from "ws"
import type { SessionHub } from "./SessionHub.ts"

/**
 * One HTTP(S) server on one port (docs/UI-AND-MODULES.md §4.6): the static UI
 * from `PVA_WEB_DIR` and the WebSocket at `/ws`, with an origin check.
 */

export class HttpError extends Schema.TaggedError<HttpError>()("HttpError", { message: Schema.String }) {}

export interface HttpOptions {
  readonly host: string
  /** 0 picks a free port (tests). */
  readonly port: number
  readonly webDir: string
  /** Origins allowed besides the server's own. */
  readonly allowedOrigins: ReadonlyArray<string>
  /**
   * Host names (besides IP literals and `localhost`) the server answers to (`SERVE_ALLOWED_HOSTS`). Requests whose
   * `Host` is any other name are refused, so a web page on a host name rebound to this address cannot use it.
   */
  readonly allowedHosts?: ReadonlyArray<string>
  readonly tls?: { readonly certFile: string; readonly keyFile: string } | undefined
  readonly hub: SessionHub
  /** Server → client WebSocket ping interval; a socket with no pong for twice this long is terminated. Default 15 s. */
  readonly pingIntervalMs?: number
  /** TCP connections open at once (HTTP, WebSocket, refused, closing); more are dropped on arrival. Default 128. */
  readonly maxSockets?: number
  /** With TLS: a connection that has not completed its handshake by then is cut. Default 10 s (Node's is 120 s). */
  readonly handshakeTimeoutMs?: number
  /**
   * Send the cross-origin isolation headers on every static response (`SERVE_CROSS_ORIGIN_ISOLATION`, default on),
   * so the page is `crossOriginIsolated` and its player can share its count with the page (`SharedArrayBuffer`).
   */
  readonly crossOriginIsolation?: boolean
}

export interface HttpServer {
  readonly port: number
  /** e.g. `http://127.0.0.1:8787` */
  readonly url: string
  /** TCP connections currently open (tests, diagnostics). */
  readonly openSockets: () => number
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8"
}

const notBuiltPage = `<!doctype html><meta charset="utf-8"><title>Assistant</title>
<body style="font-family:system-ui;background:#141210;color:#e8e4dc;padding:3rem">
<h1 style="font-weight:500">UI not built</h1>
<p>The assistant is running, but the web UI has not been built. Run <code>pnpm --filter @pva/web build</code>, then reload this page.</p>
</body>`

/**
 * Cross-origin isolation (`SERVE_CROSS_ORIGIN_ISOLATION`). A document is cross-origin isolated when its own response
 * has COOP `same-origin` and COEP `require-corp` (HTML spec, "obtain an embedder policy" / "cross-origin isolation
 * mode"); its same-origin subresources need nothing, and worklets (the audio worklets) take the document's
 * policy. The headers go on every static response anyway, so a page reached at any path (`/x`, `/404.html`, the
 * "UI not built" page) is isolated the same way and a dedicated worker script, if the page ever starts one, carries its
 * own COEP. `Cross-Origin-Resource-Policy: same-origin` keeps other origins from embedding the files (not required
 * for this page, whose files are all same-origin).
 */
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
} as const

/** The file for a URL path, or undefined. Never leaves `root`. */
export const resolveStatic = (root: string, urlPath: string): string | undefined => {
  let path: string
  try {
    path = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!)
  } catch {
    return undefined
  }
  if (path.includes("\0")) return undefined
  const base = resolve(root)
  const candidates = path.endsWith("/") ? [`${path}index.html`] : [path, `${path}.html`, `${path}/index.html`]
  for (const candidate of candidates) {
    const full = resolve(base, `.${candidate}`)
    if (full !== base && !full.startsWith(base + sep)) return undefined
    try {
      if (statSync(full).isFile()) return full
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/** Every static response's headers go through here (`isolate`: the cross-origin isolation headers). */
const serveStatic = (webDir: string, isolate: boolean, req: http.IncomingMessage, res: http.ServerResponse) => {
  const headers = (own: http.OutgoingHttpHeaders): http.OutgoingHttpHeaders => isolate ? { ...own, ...isolationHeaders } : own
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, headers({ Allow: "GET, HEAD" })).end()
    return
  }
  if (!existsSync(webDir)) {
    res.writeHead(503, headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" })).end(req.method === "HEAD" ? undefined : notBuiltPage)
    return
  }
  const urlPath = req.url ?? "/"
  let file = resolveStatic(webDir, urlPath)
  let status = 200
  if (file === undefined) {
    status = 404
    file = resolveStatic(webDir, "/404.html")
    if (file === undefined) {
      res.writeHead(404, headers({ "Content-Type": "text/plain; charset=utf-8" })).end("Not found")
      return
    }
  }
  const immutable = urlPath.startsWith("/_next/static/")
  res.writeHead(status, headers({
    "Content-Type": contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff"
  }))
  if (req.method === "HEAD") {
    res.end()
    return
  }
  // `pipeline`, not `pipe`: when the client goes away mid-download (a reset, or a socket cut while the response
  // was backed up), `pipe` only unpipes, leaving the paused file stream and its descriptor open for good.
  // `pipeline` destroys the file stream whichever side ends first.
  pipeline(createReadStream(file), res, () => {
    // Errors (a vanished client, an unreadable file) end both streams; nothing more to do.
  })
}

let connectionCounter = 0

/**
 * How long a socket may take to finish closing before it is cut: a WebSocket the server closes (refused by
 * the hub, no hello, too slow, shut down) waiting for the peer's close frame, and a refused upgrade waiting
 * for its answer to flush. Without a deadline a peer that never answers holds the socket (and its file
 * descriptor) for as long as it likes: `ws` waits 30 s by default, and a refused upgrade forever.
 */
const CLOSE_DEADLINE_MS = 1_000

/**
 * Refuses an upgrade request with an HTTP status. The socket is destroyed once the answer has been written,
 * or after `CLOSE_DEADLINE_MS` if the peer does not read it: only `end()` would leave it half-open for as
 * long as the peer keeps its side open (Node removed its HTTP timeouts from it when the upgrade began).
 */
const refuseUpgrade = (socket: Duplex, status: string) => {
  const timer = setTimeout(() => socket.destroy(), CLOSE_DEADLINE_MS)
  timer.unref()
  socket.once("close", () => clearTimeout(timer))
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}

/** The host part of a `Host` header (`name:port`, `[v6]:port`), lower case; undefined if malformed. */
const hostName = (header: string): string | undefined => {
  const value = header.trim().toLowerCase()
  if (value.startsWith("[")) {
    const end = value.indexOf("]")
    return end < 0 ? undefined : value.slice(1, end)
  }
  const colon = value.indexOf(":")
  return colon < 0 ? value : value.slice(0, colon)
}

/** The host names allowed: `SERVE_ALLOWED_HOSTS` plus the hosts of `SERVE_ALLOWED_ORIGINS`. */
export const allowedHostsFrom = (hosts: ReadonlyArray<string>, origins: ReadonlyArray<string>): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const h of hosts) {
    const name = hostName(h)
    if (name !== undefined && name.length > 0) names.add(name)
  }
  for (const origin of origins) {
    try {
      names.add(hostName(new URL(origin).host)!)
    } catch {
      // not a URL: ignored
    }
  }
  return names
}

/**
 * DNS rebinding guard: a page on an attacker's host name that resolves to this machine sends that name as
 * `Host` (and as its own origin, so the origin check alone passes). IP literals cannot be rebound and
 * `localhost` never leaves the machine, so those always pass; any other name must be listed.
 */
export const hostAllowed = (header: string | undefined, allowed: ReadonlySet<string>): boolean => {
  if (header === undefined) return false
  const name = hostName(header)
  if (name === undefined || name.length === 0) return false
  return name === "localhost" || net.isIP(name) !== 0 || allowed.has(name)
}

export const startHttp = (options: HttpOptions): Effect.Effect<HttpServer, HttpError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<
      { server: http.Server; wss: WebSocketServer; timer: ReturnType<typeof setInterval>; sockets: Set<net.Socket>; port: number },
      HttpError
    >((resume) => {
      let server: http.Server
      // Idle or slow HTTP connections are found every 5 s (not 30 s) and cut after 10 s without full headers.
      const timeouts = { connectionsCheckingInterval: 5_000, headersTimeout: 10_000, requestTimeout: 30_000 }
      try {
        server = options.tls === undefined
          ? http.createServer(timeouts)
          : https.createServer({
            ...timeouts,
            // Each pending handshake holds one of the `maxSockets` slots: as short as the header deadline.
            handshakeTimeout: options.handshakeTimeoutMs ?? 10_000,
            cert: readFileSync(options.tls.certFile),
            key: readFileSync(options.tls.keyFile)
          })
      } catch (error) {
        resume(Effect.fail(new HttpError({ message: `Cannot read SERVE_TLS_CERT / SERVE_TLS_KEY: ${(error as Error).message}` })))
        return
      }
      const scheme = options.tls === undefined ? "http" : "https"
      // Every TCP connection, whatever became of it (HTTP, upgraded, refused, closing): counted for the
      // limit and destroyed at shutdown (upgraded sockets are no longer the HTTP server's to close).
      const sockets = new Set<net.Socket>()
      server.maxConnections = options.maxSockets ?? 128
      server.on("connection", (socket: net.Socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
      })
      // `closeTimeout` (ws ≥ 8.18, missing from @types/ws) bounds every closing handshake, server- or peer-initiated.
      const closeTimeout = { closeTimeout: CLOSE_DEADLINE_MS } as object
      const wss = new WebSocketServer({ ...closeTimeout, noServer: true, maxPayload: Math.max(MAX_TEXT_FRAME_BYTES, FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES) + 1024 })
      const alive = new WeakMap<WebSocket, number>()
      const pingIntervalMs = options.pingIntervalMs ?? 15_000

      const hosts = allowedHostsFrom(options.allowedHosts ?? [], options.allowedOrigins)
      const refuse = (header: string | undefined) =>
        `This assistant does not answer to the host name "${header ?? ""}". Add it to SERVE_ALLOWED_HOSTS to use it.`

      server.on("request", (req, res) => {
        if (!hostAllowed(req.headers.host, hosts)) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(refuse(req.headers.host))
          return
        }
        serveStatic(options.webDir, options.crossOriginIsolation ?? true, req, res)
      })

      server.on("upgrade", (req, socket, head) => {
        // Node removes its own error listener from upgraded sockets: without one, a peer that resets
        // the connection while we answer would raise an uncaught exception and end the process.
        socket.on("error", () => socket.destroy())
        if (!hostAllowed(req.headers.host, hosts)) return refuseUpgrade(socket, "403 Forbidden")
        const path = (req.url ?? "").split("?")[0]
        if (path !== WS_PATH) return refuseUpgrade(socket, "404 Not Found")
        const origin = req.headers.origin
        const own = `${scheme}://${req.headers.host ?? ""}`
        // Browsers always send Origin; a missing one is a non-browser client (scripts, tests).
        if (origin !== undefined && origin !== own && !options.allowedOrigins.includes(origin)) return refuseUpgrade(socket, "403 Forbidden")
        wss.handleUpgrade(req, socket, head, (ws) => {
          // First, before anything can fail: an unhandled `error` (a malformed frame) would end the process.
          ws.on("error", () => ws.terminate())
          ws.binaryType = "nodebuffer"
          alive.set(ws, Date.now())
          ws.on("pong", () => alive.set(ws, Date.now()))
          const handlers = options.hub.accept({
            id: `c${++connectionCounter}`,
            sendText: (text) => ws.send(text),
            sendBinary: (data) => ws.send(data, { binary: true }),
            close: (code, reason) => ws.close(code, reason),
            bufferedAmount: () => ws.bufferedAmount
          })
          // Refused (connection limit): the close frame is on its way; `closeTimeout` cuts a peer that does not answer.
          if (handlers === undefined) return
          ws.on("message", (data, isBinary) => {
            const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
            if (isBinary) handlers.onBinary(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
            else handlers.onText(buffer.toString("utf8"))
          })
          ws.on("close", () => handlers.onClose())
        })
      })

      const timer = setInterval(() => {
        const now = Date.now()
        for (const ws of wss.clients) {
          if (now - (alive.get(ws) ?? now) > 2 * pingIntervalMs) ws.terminate()
          else ws.ping()
        }
      }, pingIntervalMs)
      timer.unref()

      server.once("error", (error) => {
        clearInterval(timer)
        resume(Effect.fail(new HttpError({ message: `Cannot listen on ${options.host}:${options.port}: ${error.message}` })))
      })
      server.listen(options.port, options.host, () => {
        resume(Effect.succeed({ server, wss, timer, sockets, port: (server.address() as net.AddressInfo).port }))
      })
    }),
    ({ server, sockets, timer, wss }) =>
      Effect.callback<void>((resume) => {
        clearInterval(timer)
        options.hub.closeAll(CloseCode.serverShutdown, "the assistant is shutting down")
        for (const ws of wss.clients) ws.terminate()
        wss.close()
        server.closeAllConnections?.()
        // Refused upgrades still flushing, upgrade requests not yet complete, closing WebSockets.
        for (const socket of sockets) socket.destroy()
        server.close(() => resume(Effect.void))
      })
  ).pipe(Effect.map(({ port, sockets }) => {
    const scheme = options.tls === undefined ? "http" : "https"
    const host = options.host.includes(":") ? `[${options.host}]` : options.host
    return { port, url: `${scheme}://${host}:${port}`, openSockets: () => sockets.size }
  }))

export const webDirExists = (dir: string) => existsSync(join(dir, "index.html"))
