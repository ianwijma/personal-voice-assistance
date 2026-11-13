import { CloseCode, FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, MAX_TEXT_FRAME_BYTES, WS_PATH } from "@pva/protocol"
import { Effect, Schema, type Scope } from "effect"
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import type { AddressInfo } from "node:net"
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
  readonly tls?: { readonly certFile: string; readonly keyFile: string } | undefined
  readonly hub: SessionHub
  /** Server → client WebSocket ping interval; a socket with no pong for twice this long is terminated. Default 15 s. */
  readonly pingIntervalMs?: number
}

export interface HttpServer {
  readonly port: number
  /** e.g. `http://127.0.0.1:8787` */
  readonly url: string
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

const serveStatic = (webDir: string, req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end()
    return
  }
  if (!existsSync(webDir)) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(req.method === "HEAD" ? undefined : notBuiltPage)
    return
  }
  const urlPath = req.url ?? "/"
  let file = resolveStatic(webDir, urlPath)
  let status = 200
  if (file === undefined) {
    status = 404
    file = resolveStatic(webDir, "/404.html")
    if (file === undefined) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found")
      return
    }
  }
  const immutable = urlPath.startsWith("/_next/static/")
  res.writeHead(status, {
    "Content-Type": contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff"
  })
  if (req.method === "HEAD") {
    res.end()
    return
  }
  createReadStream(file).on("error", () => res.destroy()).pipe(res)
}

let connectionCounter = 0

export const startHttp = (options: HttpOptions): Effect.Effect<HttpServer, HttpError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ server: http.Server; wss: WebSocketServer; timer: ReturnType<typeof setInterval>; port: number }, HttpError>((resume) => {
      let server: http.Server
      try {
        server = options.tls === undefined
          ? http.createServer()
          : https.createServer({ cert: readFileSync(options.tls.certFile), key: readFileSync(options.tls.keyFile) })
      } catch (error) {
        resume(Effect.fail(new HttpError({ message: `Cannot read SERVE_TLS_CERT / SERVE_TLS_KEY: ${(error as Error).message}` })))
        return
      }
      const scheme = options.tls === undefined ? "http" : "https"
      const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(MAX_TEXT_FRAME_BYTES, FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES) + 1024 })
      const alive = new WeakMap<WebSocket, number>()
      const pingIntervalMs = options.pingIntervalMs ?? 15_000

      server.on("request", (req, res) => serveStatic(options.webDir, req, res))

      server.on("upgrade", (req, socket, head) => {
        const path = (req.url ?? "").split("?")[0]
        if (path !== WS_PATH) {
          socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
          return
        }
        const origin = req.headers.origin
        const own = `${scheme}://${req.headers.host ?? ""}`
        // Browsers always send Origin; a missing one is a non-browser client (scripts, tests).
        if (origin !== undefined && origin !== own && !options.allowedOrigins.includes(origin)) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
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
          if (handlers === undefined) return
          ws.on("message", (data, isBinary) => {
            const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
            if (isBinary) handlers.onBinary(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
            else handlers.onText(buffer.toString("utf8"))
          })
          ws.on("close", () => handlers.onClose())
          ws.on("error", () => ws.terminate())
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
        resume(Effect.succeed({ server, wss, timer, port: (server.address() as AddressInfo).port }))
      })
    }),
    ({ server, timer, wss }) =>
      Effect.callback<void>((resume) => {
        clearInterval(timer)
        options.hub.closeAll(CloseCode.serverShutdown, "the assistant is shutting down")
        for (const ws of wss.clients) ws.terminate()
        wss.close()
        server.closeAllConnections?.()
        server.close(() => resume(Effect.void))
      })
  ).pipe(Effect.map(({ port }) => {
    const scheme = options.tls === undefined ? "http" : "https"
    const host = options.host.includes(":") ? `[${options.host}]` : options.host
    return { port, url: `${scheme}://${host}:${port}` }
  }))

export const webDirExists = (dir: string) => existsSync(join(dir, "index.html"))
