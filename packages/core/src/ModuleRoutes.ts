import {
  DEFAULT_ROUTE_BODY_BYTES,
  MAX_ROUTE_BODY_BYTES,
  MAX_ROUTE_PATH,
  MAX_ROUTES_PER_MODULE,
  MODULE_ROUTES_PREFIX,
  type ModuleRouteInfo,
  type RouteGuard,
  type RouteMethod,
  type RouteTokenInfo
} from "@pva/protocol"
import { type Effect, Schema, type Scope } from "effect"

/**
 * Module HTTP routes (docs/MODULES-PLAN.md §4 P3, docs/UI-AND-MODULES.md §1.11): what a version 2 module's `shared`
 * part may return under `routes`, and the route tokens it may mint. No Node dependency: the app's HTTP server
 * (`apps/assistant/src/serve/moduleRoutes.ts`) parses requests, checks guards, body and rate limits, runs the handler
 * in its own fiber with a time limit, and writes the answer.
 *
 * ```ts
 * shared: () => Effect.succeed({
 *   value: undefined,
 *   routes: [{
 *     method: "POST", path: "hook/:name", guards: ["token", "lan"], token: "hook",
 *     handler: (req) => Effect.succeed({ status: 202, body: { accepted: req.params.name } })
 *   }]
 * })
 * ```
 */

export type { RouteGuard, RouteMethod, RouteTokenInfo }

/** A parsed request, as a route's handler gets it. */
export interface RouteRequest {
  readonly method: RouteMethod
  /** The path after `/api/modules/<id>/` (decoded segments joined by "/"). */
  readonly path: string
  /**
   * The `:name` segments of the route's path. `params`, `query`, `queryAll` and `headers` are dictionaries without a
   * prototype: `query.constructor` is `undefined` unless the caller sent a `constructor` parameter.
   */
  readonly params: Readonly<Record<string, string>>
  /** Query parameters; a repeated one keeps its first value (`queryAll` has them all). */
  readonly query: Readonly<Record<string, string>>
  readonly queryAll: Readonly<Record<string, ReadonlyArray<string>>>
  /** Request headers, lower-case names (`authorization` is removed). */
  readonly headers: Readonly<Record<string, string>>
  /** `json`: the parsed JSON (`undefined` for an empty body); `bytes`: the raw body; `none`: always `undefined`. */
  readonly body: unknown
  /** The caller's address as the socket saw it (forwarding headers are never read). */
  readonly address: string
  /** The token that passed a `token` guard (its label says who the caller is). */
  readonly token?: { readonly id: string; readonly name: string; readonly label: string }
}

export interface RouteResponse {
  /**
   * A final status, 200–599 (one response per request: an informational 1xx would leave the caller without one).
   * Anything else is answered 500, logged.
   */
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  /** A string (text/plain unless `content-type` says otherwise), bytes, or anything else as JSON. Absent: no body. */
  readonly body?: unknown
}

export interface ModuleRoute {
  readonly method: RouteMethod
  /**
   * The path under `/api/modules/<moduleId>/`: segments of `[A-Za-z0-9._~-]` (not `.` or `..`, which a URL
   * resolves away), or `:name` for a parameter; "" is the module's root. Example: `hook/:name`.
   */
  readonly path: string
  /**
   * Every one of them must pass: `admin` (the admin session token, `Authorization: Bearer`), `token` (a route token of
   * this module named `token`, `Authorization: Bearer`), `lan` (a private or loopback caller, no forwarding header;
   * refused for every caller when the server is declared to be behind a reverse proxy, `SERVE_BEHIND_PROXY`).
   * `admin` and `token` both read the one `Authorization` header, so a route declares at most one of them.
   */
  readonly guards?: ReadonlyArray<RouteGuard>
  /**
   * Required, and only allowed, when there is no guard: anyone may call it (the browser arriving on an OAuth
   * callback). A public route is a `GET` and reads no body. Every route that is not public also refuses a request a
   * browser marks as coming from another site (`Sec-Fetch-Site`, `Origin`), before the guards.
   */
  readonly public?: boolean
  /** The token name a `token` guard accepts (`RouteTokens.mint(name, …)`). */
  readonly token?: string
  /** How the body is read. Default `json` for POST, PUT and PATCH, `none` for GET and DELETE (a body is refused, 413). */
  readonly body?: "json" | "bytes" | "none"
  /** Default `DEFAULT_ROUTE_BODY_BYTES` (8 KB); at most `MAX_ROUTE_BODY_BYTES` (1 MB). */
  readonly bodyLimitBytes?: number
  /** Requests per minute per caller address (default 30) and from all callers together (default 120); 429 beyond. */
  readonly rateLimit?: { readonly perAddress?: number; readonly total?: number }
  /** Time the handler may take; default 5 s, at most 30 s (then 504). */
  readonly timeoutMs?: number
  /** One line for the admin view. */
  readonly description?: string
  /**
   * Runs in its own fiber, never on a turn's path, and only while the shared part that declared it is published: a
   * request admitted before a restart is answered 503 instead; a handler running when its shared part closes (after
   * the grace period) is interrupted (503). A failure or defect answers 500 (logged, not sent). At its time limit the
   * caller gets 504 at once, while the handler's interruption and finalizers finish in the background.
   */
  readonly handler: (request: RouteRequest) => Effect.Effect<RouteResponse, unknown>
}

export const DEFAULT_ROUTE_RATE = { perAddress: 30, total: 120 } as const
export const DEFAULT_ROUTE_TIMEOUT_MS = 5_000
export const MAX_ROUTE_TIMEOUT_MS = 30_000

const SEGMENT = /^(?::[A-Za-z][A-Za-z0-9_]{0,31}|[A-Za-z0-9._~-]{1,64})$/
const TOKEN_NAME = /^[a-z][a-z0-9-]{0,31}$/

const segmentsOf = (path: string): ReadonlyArray<string> => (path === "" ? [] : path.split("/"))

/** The body mode of a route (its declared one, else by method). */
export const bodyModeOf = (route: ModuleRoute): "json" | "bytes" | "none" =>
  route.body ?? (route.method === "GET" || route.method === "DELETE" ? "none" : "json")

/** What is wrong with a module's routes (checked when its shared part starts: a problem is a start error). */
export const routeProblem = (routes: ReadonlyArray<ModuleRoute> | undefined): string | undefined => {
  const seen = new Set<string>()
  if ((routes ?? []).length > MAX_ROUTES_PER_MODULE) return `A module may declare at most ${MAX_ROUTES_PER_MODULE} routes`
  for (const route of routes ?? []) {
    if (typeof route !== "object" || route === null || typeof route.path !== "string" || typeof route.handler !== "function") return "A route is not a route (it needs a method, a path and a handler)"
    if (route.path.length > MAX_ROUTE_PATH) return `A route path may have at most ${MAX_ROUTE_PATH} characters`
    const name = `${route.method} ${route.path === "" ? "/" : route.path}`
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(route.method)) return `The route ${name} has an unknown method`
    if (route.body !== undefined && route.body !== "json" && route.body !== "bytes" && route.body !== "none") {
      return `The route ${name} has an unknown body mode (json, bytes or none)`
    }
    if (route.path.startsWith("/") || route.path.endsWith("/") || !segmentsOf(route.path).every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) {
      return `The route path "${route.path}" is not valid: segments of letters, digits and ._~- (not "." or "..") or :name, no leading or trailing "/"`
    }
    const params = segmentsOf(route.path).filter((s) => s.startsWith(":"))
    if (new Set(params).size !== params.length) return `The route ${name} names a parameter twice`
    // Two routes that would match the same requests: compare with parameters made equal.
    const shape = `${route.method} ${segmentsOf(route.path).map((s) => (s.startsWith(":") ? ":" : s)).join("/")}`
    if (seen.has(shape)) return `The route ${name} is declared twice`
    seen.add(shape)
    const guards = route.guards ?? []
    if (new Set(guards).size !== guards.length) return `The route ${name} names a guard twice`
    if (guards.some((g) => g !== "admin" && g !== "token" && g !== "lan")) return `The route ${name} has an unknown guard`
    if (guards.length === 0 && route.public !== true) return `The route ${name} has no guard: declare its guards, or public: true`
    if (guards.length > 0 && route.public === true) return `The route ${name} is public but declares guards`
    if (guards.includes("admin") && guards.includes("token")) return `The route ${name} cannot need both the admin token and a route token (one Authorization header)`
    if (guards.includes("token") !== (route.token !== undefined)) return `The route ${name}: a token guard needs a token name, and a token name needs the token guard`
    if (route.token !== undefined && !TOKEN_NAME.test(route.token)) return `The route ${name}: token name "${route.token}" must match ${TOKEN_NAME}`
    if (route.public === true && route.method !== "GET") return `The public route ${name} must be a GET (a browser arriving on a callback)`
    if (route.public === true && bodyModeOf(route) !== "none") return `The public route ${name} may not read a body (body: "none")`
    const limit = route.bodyLimitBytes ?? DEFAULT_ROUTE_BODY_BYTES
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_ROUTE_BODY_BYTES) return `The route ${name}: bodyLimitBytes must be 0 to ${MAX_ROUTE_BODY_BYTES}`
    const rate = { ...DEFAULT_ROUTE_RATE, ...route.rateLimit }
    if (![rate.perAddress, rate.total].every((n) => Number.isInteger(n) && n >= 1 && n <= 10_000)) return `The route ${name}: rate limits must be 1 to 10000 per minute`
    const timeout = route.timeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS
    if (!Number.isFinite(timeout) || timeout < 100 || timeout > MAX_ROUTE_TIMEOUT_MS) return `The route ${name}: timeoutMs must be 100 to ${MAX_ROUTE_TIMEOUT_MS}`
  }
  return undefined
}

/** The admin view of a route (`ModuleInfo.routes`). */
export const routeInfo = (moduleId: string, route: ModuleRoute): ModuleRouteInfo => ({
  method: route.method,
  path: `${MODULE_ROUTES_PREFIX}${moduleId}${route.path === "" ? "" : `/${route.path}`}`,
  guards: [...(route.guards ?? [])],
  public: route.public === true,
  ...(route.token !== undefined ? { token: route.token } : {}),
  bodyLimitBytes: bodyModeOf(route) === "none" ? 0 : route.bodyLimitBytes ?? DEFAULT_ROUTE_BODY_BYTES,
  ratePerMinute: { ...DEFAULT_ROUTE_RATE, ...route.rateLimit },
  ...(route.description !== undefined ? { description: route.description } : {})
})

/** A route of a published shared part (`ModuleHost.routes`): the "route" registration kind's live table. */
export interface PublishedRoute {
  readonly moduleId: string
  readonly route: ModuleRoute
  /**
   * The scope of the shared part that declared it: it closes when that part is closed (after the grace period of a
   * restart or a stop). The app runs the route's handler in it (`Effect.forkIn`), so no handler outlives its part.
   */
  readonly scope: Scope.Scope
  /**
   * Completes when the host's grace period for this part's calls is over (the module is stopping or restarting, or
   * the host closes), and at once when the part is no longer the published one: the app answers 503 then, without
   * waiting for the handler's cleanup (`ModuleSlots`). Evaluate it when the handler starts.
   */
  readonly stopped: Effect.Effect<void>
}

/** The parameters of `path` (segments after the module id) if `route` matches it, else `undefined`. */
export const matchRoutePath = (route: ModuleRoute, segments: ReadonlyArray<string>): Readonly<Record<string, string>> | undefined => {
  const pattern = segmentsOf(route.path)
  if (pattern.length !== segments.length) return undefined
  // A dictionary without a prototype: a parameter named `constructor` is just a parameter.
  const params: Record<string, string> = Object.create(null)
  for (const [i, p] of pattern.entries()) {
    const s = segments[i]!
    if (p.startsWith(":")) {
      if (s.length === 0) return undefined
      params[p.slice(1)] = s
    } else if (p !== s) return undefined
  }
  return params
}

// ---------------------------------------------------------------------------------------------------------------------
// Route tokens

/** Why a token operation could not be done. */
export class RouteTokenError extends Schema.TaggedError<RouteTokenError>()("RouteTokenError", {
  /**
   * `unknown_module`: the admin API named a module that is not installed. `blocked`: the settings files are damaged
   * and wait for the owner to save them (a token change never counts as that).
   */
  reason: Schema.Literals(["locked", "unavailable", "limit", "invalid", "failed", "unknown_module", "blocked"]),
  /** One sentence for the owner. */
  message: Schema.String
}) {}

/**
 * A module's route tokens (`host.routeTokens`): bearer tokens for its `token` routes, one per caller, kept in the key
 * vault (only a hash; the secret is returned once by `mint`). Revoking one stops it at once.
 */
export interface RouteTokens {
  /** Make a token named `name` for the caller `label`; the secret is shown once. */
  readonly mint: (name: string, label: string) => Effect.Effect<{ readonly token: RouteTokenInfo; readonly secret: string }, RouteTokenError>
  readonly list: Effect.Effect<ReadonlyArray<RouteTokenInfo>, RouteTokenError>
  /** True when it existed. */
  readonly revoke: (id: string) => Effect.Effect<boolean, RouteTokenError>
}

/** Where the app keeps route tokens (`ModuleHostOptions.routeTokens`): one view per module. */
export interface RouteTokenStore {
  readonly forModule: (moduleId: string) => RouteTokens
}
