import {
  bodyModeOf,
  DEFAULT_ROUTE_RATE,
  DEFAULT_ROUTE_TIMEOUT_MS,
  matchRoutePath,
  type ModuleHost,
  type ModuleRoute,
  type RouteRequest,
  type RouteResponse,
  routeInfo,
  type RouteTokenError
} from "@pva/core"
import {
  DEFAULT_ROUTE_BODY_BYTES,
  MODULE_ROUTES_PREFIX,
  type ModuleRoutesResponse,
  type RouteCall,
  ROUTE_CALL_LOG_SIZE,
  type RouteTokenInfo
} from "@pva/protocol"
import { Cause, type Context, Effect, Exit, Fiber } from "effect"
import type * as http from "node:http"
import * as net from "node:net"
import type { AdminSessions } from "./AdminSessions.ts"
import type { RouteTokenKeeper } from "./RouteTokens.ts"

/**
 * Module HTTP routes (docs/UI-AND-MODULES.md §1.11): requests under `/api/modules/<moduleId>/…`, answered by the
 * routes of the module's published `shared` part (`ModuleHost.routes`, read per request, so a module that stops takes
 * its paths with it: 404).
 *
 * Order of checks: path (404) → method (405) → rate limit (429, per caller address and per route) → guards, every
 * declared one must pass: `lan` (403), `admin` (401), `token` (503 while the vault is locked, else 401) → body (413
 * over the limit or on a route that takes none, 415 not JSON, 400 bad JSON) → the handler, in its own fiber with its
 * time limit (504), a failure answering 500 (logged; nothing of it is sent). Nothing here runs on a turn's path or
 * the WebSocket's.
 *
 * **Reverse proxies.** The caller's address is the socket's. Forwarding headers (`Forwarded`, `X-Forwarded-For`,
 * `X-Real-IP`) are never read for the address; their presence fails the `lan` guard, because behind a proxy the
 * socket's address is the proxy's and says nothing about the caller. A `lan` route is therefore not reachable through
 * a proxy (use a `token` route for callers outside the home network).
 */

export interface ModuleRouterOptions {
  readonly host: Pick<ModuleHost, "routes" | "modules">
  readonly admin: Pick<AdminSessions, "enabled" | "check" | "touch">
  readonly tokens: RouteTokenKeeper
  /** The server's services (logging), to run handlers with. */
  readonly services: Context.Context<never>
  readonly now?: () => number
  /** The caller's address. Default: the socket's (`req.socket.remoteAddress`); tests give others. */
  readonly remoteAddress?: (req: http.IncomingMessage) => string | undefined
}

export interface ModuleRouter {
  /** Handle a request whose path starts with `MODULE_ROUTES_PREFIX`. */
  readonly handle: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** The admin view: routes, recent calls and tokens of one module or all (`GET /api/module-routes`). */
  readonly view: (moduleId?: string) => Effect.Effect<ModuleRoutesResponse>
  readonly mint: (moduleId: string, name: string, label: string) => Effect.Effect<{ readonly token: RouteTokenInfo; readonly secret: string }, RouteTokenError>
  readonly revoke: (moduleId: string, id: string) => Effect.Effect<boolean, RouteTokenError>
}

/** Does a request path belong to module routes? */
export const isModuleRoutePath = (url: string | undefined): boolean => (url ?? "").startsWith(MODULE_ROUTES_PREFIX)

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"]

/**
 * A private or loopback address (IPv4 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16; IPv6 ::1, fc00::/7, fe80::/10;
 * IPv4-mapped IPv6 judged as IPv4). Carrier-grade NAT (100.64/10) is not the home network and is refused.
 */
export const isLanAddress = (address: string | undefined): boolean => {
  if (address === undefined) return false
  const plain = address.startsWith("::ffff:") && net.isIPv4(address.slice(7)) ? address.slice(7) : address
  if (net.isIPv4(plain)) {
    const [a, b] = plain.split(".").map(Number) as [number, number]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (net.isIPv6(plain)) {
    const lower = plain.toLowerCase()
    if (lower === "::1") return true
    const first = parseInt(lower.split(":")[0] || "0", 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  return false
}

const bearer = (header: string | undefined): string | undefined => /^Bearer\s+([A-Za-z0-9._~+/=-]{16,256})\s*$/.exec(header ?? "")?.[1]

interface Answer {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array | string
  readonly note?: string
}

const plain = (status: number, message: string, headers: Readonly<Record<string, string>> = {}): Answer => ({
  status,
  headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  body: message,
  note: message
})

/** A handler's response as bytes and headers; a response that cannot be sent is a 500. */
const encodeResponse = (r: RouteResponse): Answer => {
  if (!Number.isInteger(r.status) || r.status < 100 || r.status > 599) return plain(500, "The module gave an answer that cannot be sent")
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    // Header injection and framing are the server's: no line breaks, no hop-by-hop or length headers.
    if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) continue
    if (["content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) continue
    headers[k] = String(v)
  }
  const typed = Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
  if (r.body === undefined) return { status: r.status, headers }
  if (r.body instanceof Uint8Array) return { status: r.status, headers: typed ? headers : { ...headers, "Content-Type": "application/octet-stream" }, body: r.body }
  if (typeof r.body === "string") return { status: r.status, headers: typed ? headers : { ...headers, "Content-Type": "text/plain; charset=utf-8" }, body: r.body }
  let text: string | undefined
  try {
    text = JSON.stringify(r.body)
  } catch {
    text = undefined
  }
  if (text === undefined) return plain(500, "The module gave an answer that cannot be sent")
  return { status: r.status, headers: typed ? headers : { ...headers, "Content-Type": "application/json; charset=utf-8" }, body: text }
}

/** A fixed one-minute window per key, with at most `maxKeys` keys (the oldest window goes first). */
const makeWindows = (now: () => number, maxKeys = 2048) => {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    /** Counts one request; false (and nothing counted) when `limit` is reached. Returns the ms until the window ends. */
    take: (key: string, limit: number): { readonly ok: boolean; readonly retryMs: number } => {
      const t = now()
      let w = windows.get(key)
      if (w === undefined || t - w.start >= 60_000) {
        windows.delete(key)
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value!)
        w = { start: t, count: 0 }
        windows.set(key, w)
      }
      const retryMs = Math.max(0, w.start + 60_000 - t)
      if (w.count >= limit) return { ok: false, retryMs }
      w.count++
      return { ok: true, retryMs }
    }
  }
}

/** Read the body up to `limit` bytes; `undefined` = over the limit (the rest is drained). */
const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer | undefined | "error"> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = []
    let size = 0
    let done = false
    const finish = (v: Buffer | undefined | "error") => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on("data", (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on("error", () => finish("error"))
    req.on("end", () => finish(Buffer.concat(chunks)))
  })

const declaredLength = (req: http.IncomingMessage): number | undefined => {
  const raw = req.headers["content-length"]
  if (raw === undefined) return req.headers["transfer-encoding"] !== undefined ? Number.POSITIVE_INFINITY : undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY
}

export const makeModuleRouter = (options: ModuleRouterOptions): ModuleRouter => {
  const now = options.now ?? Date.now
  const windows = makeWindows(now)
  const logs = new Map<string, Array<RouteCall>>()
  const routeKey = (moduleId: string, route: ModuleRoute) => `${moduleId} ${route.method} ${route.path}`
  const record = (moduleId: string, route: ModuleRoute, call: RouteCall) => {
    const key = routeKey(moduleId, route)
    const list = logs.get(key) ?? []
    list.unshift(call)
    if (list.length > ROUTE_CALL_LOG_SIZE) list.length = ROUTE_CALL_LOG_SIZE
    logs.set(key, list)
  }

  const send = (res: http.ServerResponse, answer: Answer) => {
    if (res.writableEnded || res.destroyed) return
    const body = answer.body === undefined ? undefined : typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : Buffer.from(answer.body)
    try {
      res.writeHead(answer.status, {
        ...answer.headers,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(body !== undefined ? { "Content-Length": String(body.length) } : {})
      })
      res.end(body)
    } catch {
      if (!res.headersSent) res.writeHead(500).end()
      else res.destroy()
    }
  }

  /** Everything before the handler: which route, the limits and the guards. An `Answer` refuses the request. */
  const admit = (req: http.IncomingMessage, moduleId: string, segments: ReadonlyArray<string>, address: string):
    | { readonly refused: Answer; readonly route?: ModuleRoute }
    | { readonly route: ModuleRoute; readonly params: Readonly<Record<string, string>>; readonly token?: { readonly id: string; readonly name: string; readonly label: string } } => {
    const mine = options.host.routes().filter((r) => r.moduleId === moduleId).map((r) => r.route)
    const matching = mine.flatMap((route) => {
      const params = matchRoutePath(route, segments)
      return params === undefined ? [] : [{ route, params }]
    })
    if (matching.length === 0) return { refused: plain(404, "Not found") }
    const method = (req.method ?? "GET").toUpperCase()
    // A literal segment wins over a parameter (`hook/test` before `hook/:name`).
    const literal = (r: ModuleRoute) => r.path.split("/").filter((s) => !s.startsWith(":")).length
    const found = matching.filter((m) => m.route.method === method).sort((a, b) => literal(b.route) - literal(a.route))[0]
    if (found === undefined) {
      return { refused: plain(405, "Method not allowed", { Allow: [...new Set(matching.map((m) => m.route.method))].join(", ") }) }
    }
    const { route, params } = found
    const rate = { ...DEFAULT_ROUTE_RATE, ...route.rateLimit }
    const key = routeKey(moduleId, route)
    const perAddress = windows.take(`${key}\u0000${address}`, rate.perAddress)
    const total = perAddress.ok ? windows.take(key, rate.total) : perAddress
    if (!perAddress.ok || !total.ok) {
      return { route, refused: plain(429, "Too many requests; try again later", { "Retry-After": String(Math.max(1, Math.ceil(total.retryMs / 1000))) }) }
    }
    const guards = route.guards ?? []
    if (guards.includes("lan")) {
      if (FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) return { route, refused: plain(403, "Only callers on the home network, not through a proxy") }
      if (!isLanAddress(address)) return { route, refused: plain(403, "Only callers on the home network") }
    }
    const presented = bearer(req.headers.authorization)
    if (guards.includes("admin")) {
      if (!options.admin.enabled || presented === undefined || options.admin.check(presented) === undefined || !options.admin.touch(presented)) {
        return { route, refused: plain(401, "Log in to admin first", { "WWW-Authenticate": "Bearer" }) }
      }
    }
    if (guards.includes("token")) {
      if (!options.tokens.readable()) return { route, refused: plain(503, "The key vault is locked, so tokens cannot be checked; unlock it in admin") }
      if (presented === undefined) return { route, refused: plain(401, "A token is needed (Authorization: Bearer <token>)", { "WWW-Authenticate": "Bearer" }) }
      const checked = options.tokens.check(moduleId, route.token ?? "", presented)
      if (!checked.ok) {
        return checked.reason === "locked"
          ? { route, refused: plain(503, "The key vault is locked, so tokens cannot be checked; unlock it in admin") }
          : { route, refused: plain(401, "The token is not valid (it may have been revoked)", { "WWW-Authenticate": "Bearer" }) }
      }
      return { route, params, token: checked.token }
    }
    return { route, params }
  }

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const started = now()
    const address = (options.remoteAddress ?? ((r) => r.socket.remoteAddress))(req) ?? ""
    const url = new URL(req.url ?? "/", "http://x")
    let segments: Array<string>
    try {
      segments = url.pathname.slice(MODULE_ROUTES_PREFIX.length).split("/").map((s) => decodeURIComponent(s))
    } catch {
      send(res, plain(400, "The address is not valid"))
      req.resume()
      return
    }
    const moduleId = segments.shift() ?? ""
    if (segments.length > 0 && segments[segments.length - 1] === "") segments.pop()
    const admitted = admit(req, moduleId, segments, address)
    const finish = (answer: Answer, route: ModuleRoute | undefined, token?: string) => {
      send(res, answer)
      if (!req.complete) req.resume()
      if (route !== undefined) {
        record(moduleId, route, {
          at: started,
          address,
          status: answer.status,
          ms: Math.max(0, now() - started),
          ...(token !== undefined ? { token } : {}),
          ...(answer.note !== undefined && answer.status >= 400 ? { note: answer.note.slice(0, 120) } : {})
        })
      }
    }
    if ("refused" in admitted) return finish(admitted.refused, admitted.route)
    const { route, params } = admitted
    const mode = bodyModeOf(route)
    const limit = mode === "none" ? 0 : route.bodyLimitBytes ?? DEFAULT_ROUTE_BODY_BYTES
    const length = declaredLength(req)
    if (length !== undefined && length > limit) {
      return finish(plain(413, mode === "none" ? "This address takes no body" : `The body is larger than ${limit} bytes`), route, admitted.token?.label)
    }
    const run = async () => {
      let body: unknown
      if (mode !== "none") {
        const raw = await readBody(req, limit)
        if (raw === "error") return finish(plain(400, "The body could not be read"), route, admitted.token?.label)
        if (raw === undefined) return finish(plain(413, `The body is larger than ${limit} bytes`), route, admitted.token?.label)
        if (mode === "bytes") body = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        else if (raw.length > 0) {
          const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase()
          if (type !== "application/json") return finish(plain(415, "Send JSON (Content-Type: application/json)"), route, admitted.token?.label)
          try {
            body = JSON.parse(raw.toString("utf8"))
          } catch {
            return finish(plain(400, "The body is not valid JSON"), route, admitted.token?.label)
          }
        }
      }
      const query: Record<string, string> = {}
      const queryAll: Record<string, Array<string>> = {}
      for (const [k, v] of url.searchParams) {
        if (!Object.hasOwn(query, k)) query[k] = v
        ;(queryAll[k] ??= []).push(v)
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) if (k !== "authorization" && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v
      const request: RouteRequest = {
        method: route.method,
        path: segments.join("/"),
        params,
        query,
        queryAll,
        headers,
        body,
        address,
        ...(admitted.token !== undefined ? { token: admitted.token } : {})
      }
      const timeoutMs = route.timeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS
      const fiber = Effect.runForkWith(options.services)(
        Effect.suspend(() => route.handler(request)).pipe(
          Effect.map(encodeResponse),
          Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(plain(504, "The module did not answer in time")) }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.as(Effect.logError(`module route ${moduleId} ${route.method} ${route.path} failed`, cause), plain(500, "The module could not answer (see the server's log)"))
          )
        )
      )
      // The caller went away: stop the handler.
      res.on("close", () => {
        if (!res.writableEnded) void Effect.runForkWith(options.services)(Fiber.interrupt(fiber))
      })
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) finish(exit.value, route, admitted.token?.label)
        else if (!res.writableEnded) res.destroy()
      })
    }
    void run()
  }

  const view = (moduleId?: string): Effect.Effect<ModuleRoutesResponse> =>
    Effect.gen(function*() {
      const running = options.host.routes()
      const ids = new Set(running.map((r) => r.moduleId))
      const known = options.host.modules().map((m) => m.id).filter((id) => moduleId === undefined || id === moduleId)
      const readable = options.tokens.readable()
      const modules: Array<ModuleRoutesResponse["modules"][number]> = []
      for (const id of known) {
        const tokens = readable ? yield* options.tokens.forModule(id).list.pipe(Effect.orElseSucceed(() => [])) : []
        const routes = running.filter((r) => r.moduleId === id).map((r) => ({ ...routeInfo(id, r.route), calls: [...(logs.get(routeKey(id, r.route)) ?? [])] }))
        if (routes.length === 0 && tokens.length === 0) continue
        modules.push({ moduleId: id, running: ids.has(id), routes, tokens })
      }
      return { modules, tokensLocked: !readable }
    })

  return {
    handle,
    view,
    mint: (moduleId, name, label) => options.tokens.forModule(moduleId).mint(name, label),
    revoke: (moduleId, id) => options.tokens.forModule(moduleId).revoke(id)
  }
}
