import {
  bodyModeOf,
  DEFAULT_ROUTE_RATE,
  DEFAULT_ROUTE_TIMEOUT_MS,
  matchRoutePath,
  type ModuleHost,
  outsideTurns,
  type ModuleRoute,
  type PublishedRoute,
  type RouteRequest,
  type RouteResponse,
  routeInfo,
  RouteTokenError
} from "@pva/core"
import {
  DEFAULT_ROUTE_BODY_BYTES,
  MODULE_ROUTES_PREFIX,
  type ModuleRoutesResponse,
  type RouteCall,
  ROUTE_CALL_LOG_SIZE,
  type RouteTokenInfo
} from "@pva/protocol"
import { Cause, type Context, Effect, Exit, Fiber, Option } from "effect"
import type * as http from "node:http"
import * as net from "node:net"
import type { AdminSessions } from "./AdminSessions.ts"
import type { RouteTokenKeeper } from "./RouteTokens.ts"

/**
 * Module HTTP routes (docs/UI-AND-MODULES.md §1.11): requests under `/api/modules/<moduleId>/…`, answered by the
 * routes of the module's published `shared` part (`ModuleHost.routes`, read per request, so a module that stops takes
 * its paths with it: 404).
 *
 * Order of checks: path (404) → method (405) → another site (403: a route that is not public refuses what a browser
 * marks as cross-site, `Sec-Fetch-Site` or a foreign `Origin`; no CORS header is ever sent) → rate limit (429, per
 * caller address and per route) → guards, every declared one must pass: `lan` (403), `admin` (401), `token` (503
 * while the vault is locked, else 401) → body (413 over the limit or on a route that takes none, 415 not JSON, 400 bad
 * JSON) → the route is still its module's published one (503 after a restart or stop) → the handler, in its own fiber
 * in the shared part's scope with its time limit (504 at the deadline; the handler is interrupted and its cleanup
 * runs on in the background, bounded and logged), a failure answering 500 (logged; nothing of it is sent). Nothing
 * here runs on a turn's path or the WebSocket's.
 *
 * **Reverse proxies.** The caller's address is the socket's, and forwarding headers (`Forwarded`, `X-Forwarded-For`,
 * `X-Real-IP`, …) are never read for it. The server cannot tell a proxied request from a local one by itself (a proxy
 * on the same host that adds no header looks like a loopback caller), so the owner says so: `SERVE_BEHIND_PROXY`
 * (`behindProxy`). Declared, the `lan` guard refuses every request (a `lan` route is unreachable by design; callers
 * from outside use a `token` route). Not declared (the default), the socket's address is trusted, and the presence of
 * a forwarding header still fails `lan`.
 */

export interface ModuleRouterOptions {
  readonly host: Pick<ModuleHost, "routes" | "modules">
  readonly admin: Pick<AdminSessions, "enabled" | "check" | "touch">
  readonly tokens: RouteTokenKeeper
  /** The server's services (logging), to run handlers with. */
  readonly services: Context.Context<never>
  /** The server's scheme: its own origin is `<scheme>://<Host>`. Default `http`. */
  readonly scheme?: "http" | "https"
  /** A reverse proxy is in front (`SERVE_BEHIND_PROXY`): no caller counts as on the home network. Default false. */
  readonly behindProxy?: boolean
  /** How long a timed-out handler's cleanup may take in the background before it is logged. Default 10 s. */
  readonly cleanupMs?: number
  readonly now?: () => number
  /** The caller's address. Default: the socket's (`req.socket.remoteAddress`); tests give others. */
  readonly remoteAddress?: (req: http.IncomingMessage) => string | undefined
}

export interface ModuleRouter {
  /** Handle a request whose path starts with `MODULE_ROUTES_PREFIX`. */
  readonly handle: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** The admin view: routes, recent calls and tokens of one module or all (`GET /api/module-routes`). */
  readonly view: (moduleId?: string) => Effect.Effect<ModuleRoutesResponse>
  /** Mint a token for an installed module (running or not); an unknown module fails `unknown_module`. */
  readonly mint: (moduleId: string, name: string, label: string) => Effect.Effect<{ readonly token: RouteTokenInfo; readonly secret: string }, RouteTokenError>
  readonly revoke: (moduleId: string, id: string) => Effect.Effect<boolean, RouteTokenError>
}

/** Does a request path belong to module routes? */
export const isModuleRoutePath = (url: string | undefined): boolean => (url ?? "").startsWith(MODULE_ROUTES_PREFIX)

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"]

/** How long a timed-out handler's interruption may take before it is logged (`ModuleRouterOptions.cleanupMs`). */
export const ROUTE_CLEANUP_MS = 10_000
/** Per-address rate windows kept at once (the oldest goes first); route totals are kept apart and never evicted. */
const MAX_ADDRESS_WINDOWS = 4096
/** Routes whose call log is kept (the least recently called goes first), live or retired. */
const MAX_LOGGED_ROUTES = 256

/** A dictionary without a prototype: request keys such as `constructor` or `__proto__` are ordinary keys. */
const dict = <V>(): Record<string, V> => Object.create(null) as Record<string, V>

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

/**
 * The key a caller's per-address rate window is counted under: an IPv4 address (IPv4-mapped IPv6 as IPv4), or the
 * /64 of an IPv6 address (one home or one host holds a whole /64, so rotating within it gains nothing).
 */
export const rateKeyOf = (address: string): string => {
  const plain = address.startsWith("::ffff:") && net.isIPv4(address.slice(7)) ? address.slice(7) : address
  if (!net.isIPv6(plain)) return plain
  let text = plain.toLowerCase().split("%")[0]!
  // An embedded IPv4 tail (`::1.2.3.4`) as two groups.
  if (text.includes(".")) {
    const at = text.lastIndexOf(":")
    const [a = 0, b = 0, c = 0, d = 0] = text.slice(at + 1).split(".").map(Number)
    text = `${text.slice(0, at + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = "", tail] = text.split("::")
  const left = head === "" ? [] : head.split(":")
  const right = tail === undefined || tail === "" ? [] : tail.split(":")
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
  return `${groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":")}::/64`
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

const unsendable = () => plain(500, "The module gave an answer that cannot be sent")

/** RFC 9110 token characters (a header name), and a field value without control characters but tab. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/
/** The server's own headers: framing, and CORS (module routes never send any). */
const RESERVED_HEADER = (name: string) => ["content-length", "transfer-encoding", "connection"].includes(name) || name.startsWith("access-control-")

/**
 * A handler's response as bytes and headers. A final status (200–599) only; a header with an invalid name or value
 * makes the whole answer a 500 (so the log says what was sent); framing and CORS headers are the server's and dropped.
 */
export const encodeResponse = (r: RouteResponse): Answer => {
  if (typeof r !== "object" || r === null || !Number.isInteger(r.status) || r.status < 200 || r.status > 599) return unsendable()
  const headers = dict<string>()
  const given: unknown = r.headers ?? {}
  if (typeof given !== "object" || given === null) return unsendable()
  for (const [k, raw] of Object.entries(given)) {
    if (typeof raw !== "string" && typeof raw !== "number") return unsendable()
    const v = String(raw)
    if (!HEADER_NAME.test(k) || !HEADER_VALUE.test(v)) return unsendable()
    if (RESERVED_HEADER(k.toLowerCase())) continue
    headers[k] = v
  }
  const typed = Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
  const withType = (type: string) => (typed ? headers : { ...headers, "Content-Type": type })
  if (r.body === undefined) return { status: r.status, headers }
  if (r.body instanceof Uint8Array) return { status: r.status, headers: withType("application/octet-stream"), body: r.body }
  if (typeof r.body === "string") return { status: r.status, headers: withType("text/plain; charset=utf-8"), body: r.body }
  let text: string | undefined
  try {
    text = JSON.stringify(r.body)
  } catch {
    text = undefined
  }
  if (text === undefined) return unsendable()
  return { status: r.status, headers: withType("application/json; charset=utf-8"), body: text }
}

interface Window {
  start: number
  count: number
}

/**
 * Fixed one-minute windows. Route totals have a map of their own, one entry per route, never evicted while their
 * window lasts (so many caller addresses cannot push a route's total out); per-address windows keep at most
 * `MAX_ADDRESS_WINDOWS` (the oldest goes first: that address starts again, the route's total still holds).
 */
const makeLimiter = (now: () => number) => {
  const totals = new Map<string, Window>()
  const addresses = new Map<string, Window>()
  const current = (map: Map<string, Window>, key: string, t: number): Window | undefined => {
    const w = map.get(key)
    return w !== undefined && t - w.start < 60_000 ? w : undefined
  }
  const open = (map: Map<string, Window>, key: string, t: number, max: number): Window => {
    map.delete(key)
    // Expired windows go first; then (per-address windows only) the oldest.
    if (map.size >= Math.min(max, 1024)) for (const [k, w] of map) if (t - w.start >= 60_000) map.delete(k)
    if (map.size >= max) map.delete(map.keys().next().value!)
    const w = { start: t, count: 0 }
    map.set(key, w)
    return w
  }
  return {
    /** Counts one request against the route's total and the caller's window; false (nothing counted) when either is full. */
    take: (route: string, address: string, rate: { readonly perAddress: number; readonly total: number }): { readonly ok: boolean; readonly retryMs: number } => {
      const t = now()
      const total = current(totals, route, t)
      if (total !== undefined && total.count >= rate.total) return { ok: false, retryMs: total.start + 60_000 - t }
      const key = `${route}\u0000${address}`
      const mine = current(addresses, key, t)
      if (mine !== undefined && mine.count >= rate.perAddress) return { ok: false, retryMs: mine.start + 60_000 - t }
      const routeWindow = total ?? open(totals, route, t, Number.MAX_SAFE_INTEGER)
      const addressWindow = mine ?? open(addresses, key, t, MAX_ADDRESS_WINDOWS)
      routeWindow.count++
      addressWindow.count++
      return { ok: true, retryMs: 0 }
    },
    /** Forget the totals of routes that are gone (their windows are over anyway). */
    prune: (live: ReadonlySet<string>) => {
      const t = now()
      for (const [k, w] of totals) if (!live.has(k) && t - w.start >= 60_000) totals.delete(k)
    },
    sizes: () => ({ totals: totals.size, addresses: addresses.size })
  }
}

/** Read the body up to `limit` bytes, counting as it arrives (a chunked body has no length up front). */
const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer | "too-large" | "error"> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = []
    let size = 0
    let done = false
    const finish = (v: Buffer | "too-large" | "error") => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on("data", (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        finish("too-large")
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on("error", () => finish("error"))
    req.on("aborted", () => finish("error"))
    req.on("end", () => finish(Buffer.concat(chunks)))
  })

/** The body's declared length: a number, `unknown` (chunked: counted while read), or `invalid`. */
const declaredLength = (req: http.IncomingMessage): number | "unknown" | "none" | "invalid" => {
  const raw = req.headers["content-length"]
  if (raw === undefined) return req.headers["transfer-encoding"] !== undefined ? "unknown" : "none"
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : "invalid"
}

/**
 * Why a browser request from another site is refused, or `undefined`. `Sec-Fetch-Site` other than `same-origin`,
 * `same-site` or `none`, or an `Origin` that is not this server's own (`<scheme>://<Host>`, the Host already passed
 * the allowed-hosts check). A request with neither header (a script, a webhook sender) is judged by the guards.
 */
export const crossSiteReason = (req: http.IncomingMessage, scheme: "http" | "https"): string | undefined => {
  const site = req.headers["sec-fetch-site"]
  if (typeof site === "string" && !["same-origin", "same-site", "none"].includes(site.trim().toLowerCase())) return "Requests from another site are refused"
  const origin = req.headers.origin
  if (typeof origin === "string" && origin.toLowerCase() !== `${scheme}://${req.headers.host ?? ""}`.toLowerCase()) return "Requests from another site are refused"
  return undefined
}

type Admitted =
  | { readonly refused: Answer; readonly route?: ModuleRoute }
  | {
    readonly route: ModuleRoute
    readonly published: PublishedRoute
    readonly params: Readonly<Record<string, string>>
    readonly token?: { readonly id: string; readonly name: string; readonly label: string }
  }

export const makeModuleRouter = (options: ModuleRouterOptions): ModuleRouter => {
  const now = options.now ?? Date.now
  const scheme = options.scheme ?? "http"
  const behindProxy = options.behindProxy === true
  const cleanupMs = options.cleanupMs ?? ROUTE_CLEANUP_MS
  const limiter = makeLimiter(now)
  // The last calls per route (`moduleId method path`); at most `MAX_LOGGED_ROUTES` routes, least recently called first out.
  const logs = new Map<string, Array<RouteCall>>()
  const routeKey = (moduleId: string, route: ModuleRoute) => `${moduleId} ${route.method} ${route.path}`
  const record = (moduleId: string, route: ModuleRoute, call: RouteCall) => {
    const key = routeKey(moduleId, route)
    const list = logs.get(key) ?? []
    list.unshift(call)
    if (list.length > ROUTE_CALL_LOG_SIZE) list.length = ROUTE_CALL_LOG_SIZE
    logs.delete(key)
    logs.set(key, list)
    while (logs.size > MAX_LOGGED_ROUTES) logs.delete(logs.keys().next().value!)
  }
  const log = (effect: Effect.Effect<void>) => void Effect.runForkWith(options.services)(effect)

  /** Write the answer; returns the status that was really sent (500 when the answer could not be written). */
  const send = (res: http.ServerResponse, answer: Answer): number => {
    if (res.writableEnded || res.destroyed) return answer.status
    const body = answer.body === undefined ? undefined : typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : Buffer.from(answer.body)
    try {
      res.writeHead(answer.status, {
        ...answer.headers,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(body !== undefined ? { "Content-Length": String(body.length) } : {})
      })
      res.end(body)
      return answer.status
    } catch {
      if (!res.headersSent) res.writeHead(500, { "Cache-Control": "no-store" }).end()
      else res.destroy()
      return 500
    }
  }

  /** Everything before the body: which route, another site, the limits and the guards. An `Answer` refuses the request. */
  const admit = (req: http.IncomingMessage, moduleId: string, segments: ReadonlyArray<string>, address: string): Admitted => {
    const mine = options.host.routes().filter((r) => r.moduleId === moduleId)
    const matching = mine.flatMap((published) => {
      const params = matchRoutePath(published.route, segments)
      return params === undefined ? [] : [{ published, route: published.route, params }]
    })
    if (matching.length === 0) return { refused: plain(404, "Not found") }
    const method = (req.method ?? "GET").toUpperCase()
    // A literal segment wins over a parameter (`hook/test` before `hook/:name`).
    const literal = (r: ModuleRoute) => r.path.split("/").filter((s) => !s.startsWith(":")).length
    const found = matching.filter((m) => m.route.method === method).sort((a, b) => literal(b.route) - literal(a.route))[0]
    if (found === undefined) {
      return { refused: plain(405, "Method not allowed", { Allow: [...new Set(matching.map((m) => m.route.method))].join(", ") }) }
    }
    const { route, params, published } = found
    // A page on another site may make a browser send a simple request (no preflight) with the browser's own address:
    // refused before anything of the route runs. A public route (a GET without a body) is a browser's to arrive on.
    if (route.public !== true) {
      const reason = crossSiteReason(req, scheme)
      if (reason !== undefined) return { route, refused: plain(403, reason) }
    }
    const rate = { ...DEFAULT_ROUTE_RATE, ...route.rateLimit }
    const taken = limiter.take(routeKey(moduleId, route), rateKeyOf(address), rate)
    if (!taken.ok) {
      return { route, refused: plain(429, "Too many requests; try again later", { "Retry-After": String(Math.max(1, Math.ceil(taken.retryMs / 1000))) }) }
    }
    const guards = route.guards ?? []
    if (guards.includes("lan")) {
      if (behindProxy) return { route, refused: plain(403, "Not reachable: the server is declared to be behind a reverse proxy (SERVE_BEHIND_PROXY), so no caller counts as on the home network") }
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
      return { route, published, params, token: checked.token }
    }
    return { route, published, params }
  }

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const started = now()
    const address = (options.remoteAddress ?? ((r) => r.socket.remoteAddress))(req) ?? ""
    let route: ModuleRoute | undefined
    let moduleId = ""
    let token: string | undefined
    let answered = false
    const finish = (answer: Answer) => {
      if (answered) return
      answered = true
      const status = send(res, answer)
      if (!req.complete) req.resume()
      if (route !== undefined) {
        record(moduleId, route, {
          at: started,
          address,
          status,
          ms: Math.max(0, now() - started),
          ...(token !== undefined ? { token } : {}),
          ...(answer.note !== undefined && status >= 400 ? { note: answer.note.slice(0, 120) } : status !== answer.status ? { note: "The answer could not be written" } : {})
        })
      }
    }
    // Everything of a request, admission to answer: whatever goes wrong is a 500 for this request, never the process's.
    const run = async (): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://x")
      // `..` segments are resolved by the URL: what is left must still be a module route.
      if (!url.pathname.startsWith(MODULE_ROUTES_PREFIX)) return finish(plain(404, "Not found"))
      let segments: Array<string>
      try {
        segments = url.pathname.slice(MODULE_ROUTES_PREFIX.length).split("/").map((s) => decodeURIComponent(s))
      } catch {
        return finish(plain(400, "The address is not valid"))
      }
      moduleId = segments.shift() ?? ""
      if (segments.length > 0 && segments[segments.length - 1] === "") segments.pop()
      const admitted = admit(req, moduleId, segments, address)
      route = admitted.route
      if ("refused" in admitted) return finish(admitted.refused)
      token = admitted.token?.label
      const { params, published } = admitted
      const current = published.route
      const mode = bodyModeOf(current)
      const limit = mode === "none" ? 0 : current.bodyLimitBytes ?? DEFAULT_ROUTE_BODY_BYTES
      const length = declaredLength(req)
      if (mode === "none" && (length === "unknown" || length === "invalid" || (typeof length === "number" && length > 0))) {
        return finish(plain(413, "This address takes no body"))
      }
      if (length === "invalid") return finish(plain(400, "The Content-Length is not valid"))
      if (typeof length === "number" && length > limit) return finish(plain(413, `The body is larger than ${limit} bytes`))
      let body: unknown
      if (mode !== "none") {
        const raw = await readBody(req, limit)
        if (raw === "error") return finish(plain(400, "The body could not be read"))
        if (raw === "too-large") return finish(plain(413, `The body is larger than ${limit} bytes`))
        if (mode === "bytes") body = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        else if (raw.length > 0) {
          const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase()
          if (type !== "application/json") return finish(plain(415, "Send JSON (Content-Type: application/json)"))
          try {
            body = JSON.parse(raw.toString("utf8"))
          } catch {
            return finish(plain(400, "The body is not valid JSON"))
          }
        }
      }
      // The body took its time: the route must still be its module's published one (not a part replaced or stopped
      // meanwhile, whose resources may be closing).
      // The same shared part (its scope), not only an equal route: a restarted part may declare the same objects.
      const live = options.host.routes().find((r) => r.moduleId === moduleId && r.route === current && r.scope === published.scope)
      if (live === undefined) return finish(plain(503, "The module restarted or stopped meanwhile; try again"))
      const query = dict<string>()
      const queryAll = dict<Array<string>>()
      for (const [k, v] of url.searchParams) {
        if (!Object.hasOwn(query, k)) query[k] = v
        ;(Object.hasOwn(queryAll, k) ? queryAll[k]! : (queryAll[k] = [])).push(v)
      }
      const headers = dict<string>()
      for (const [k, v] of Object.entries(req.headers)) if (k !== "authorization" && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v
      const request: RouteRequest = {
        method: current.method,
        path: segments.join("/"),
        params,
        query,
        queryAll,
        headers,
        body,
        address,
        ...(admitted.token !== undefined ? { token: admitted.token } : {})
      }
      const timeoutMs = current.timeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS
      const label = `module route ${moduleId} ${current.method} ${current.path}`
      const answer = Effect.gen(function*() {
        // In the shared part's scope: when that part is closed (after a restart's grace period) the handler is
        // interrupted (503), so it never runs on with its resources gone.
        // Outside any turn or job, whatever the serving fiber carries (module code the host starts never sees one).
        const fiber = yield* Effect.forkIn(outsideTurns(Effect.suspend(() => current.handler(request))), live.scope)
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe()))
        )
        if (Option.isNone(exit)) {
          // The caller gets its 504 now; the interruption and the handler's finalizers run on, bounded and logged.
          fiber.interruptUnsafe()
          yield* Effect.forkDetach(
            Fiber.await(fiber).pipe(
              Effect.timeoutOption(cleanupMs),
              Effect.flatMap((done) => (Option.isSome(done) ? Effect.void : Effect.logWarning(`${label}: still cleaning up ${cleanupMs} ms after its time limit`)))
            )
          )
          return plain(504, "The module did not answer in time")
        }
        if (Exit.isSuccess(exit.value)) {
          const encoded = encodeResponse(exit.value.value)
          if (encoded.status === 500 && encoded.note !== undefined) yield* Effect.logError(`${label}: ${encoded.note}`)
          return encoded
        }
        if (Cause.hasInterruptsOnly(exit.value.cause)) return plain(503, "The module stopped while answering; try again")
        yield* Effect.logError(`${label} failed`, exit.value.cause)
        return plain(500, "The module could not answer (see the server's log)")
      })
      const fiber = Effect.runForkWith(options.services)(answer)
      // The caller went away: stop the handler.
      res.on("close", () => {
        if (!res.writableEnded) fiber.interruptUnsafe()
      })
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) finish(exit.value)
        else if (!res.writableEnded) res.destroy()
      })
    }
    run().catch((error: unknown) => {
      log(Effect.logError(`module route ${moduleId}: the request failed`, error))
      finish(plain(500, "The module could not answer (see the server's log)"))
    })
  }

  const known = (id: string) => options.host.modules().some((m) => m.id === id)
  const unknown = (id: string) => new RouteTokenError({ reason: "unknown_module", message: `There is no module "${id}"` })

  const view = (moduleId?: string): Effect.Effect<ModuleRoutesResponse> =>
    Effect.gen(function*() {
      const running = options.host.routes()
      limiter.prune(new Set(running.map((r) => routeKey(r.moduleId, r.route))))
      const ids = new Set(running.map((r) => r.moduleId))
      const installed = options.host.modules().map((m) => m.id).filter((id) => moduleId === undefined || id === moduleId)
      const readable = options.tokens.readable()
      const modules: Array<ModuleRoutesResponse["modules"][number]> = []
      for (const id of installed) {
        // Tokens are listed whether or not the module runs (a stopped module's tokens can be revoked).
        const tokens = readable ? yield* options.tokens.forModule(id).list.pipe(Effect.orElseSucceed(() => [])) : []
        const routes = running.filter((r) => r.moduleId === id).map((r) => ({ ...routeInfo(id, r.route), calls: [...(logs.get(routeKey(id, r.route)) ?? [])] }))
        if (routes.length === 0 && tokens.length === 0) continue
        modules.push({ moduleId: id, running: ids.has(id), routes, tokens })
      }
      return { modules, tokensLocked: !readable, behindProxy }
    })

  return {
    handle,
    view,
    mint: (moduleId, name, label) => (known(moduleId) ? options.tokens.forModule(moduleId).mint(name, label) : Effect.fail(unknown(moduleId))),
    revoke: (moduleId, id) => (known(moduleId) ? options.tokens.forModule(moduleId).revoke(id) : Effect.fail(unknown(moduleId)))
  }
}

/** Test seam: the rate limiter on its own. */
export const makeRouteLimiterForTests = makeLimiter
