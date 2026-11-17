import { Schema } from "effect"
import { ModuleId, NonNegativeInt } from "./common.ts"

/**
 * Protocol 10: module HTTP routes (docs/MODULES-PLAN.md §4 P3, docs/UI-AND-MODULES.md §1.11).
 *
 * A version 2 module's `shared` part may answer HTTP requests under `/api/modules/<moduleId>/…`: an inbound hook, an
 * OAuth callback. Each route declares its guards, and every declared guard must pass: `admin` (the admin session
 * token), `token` (a bearer token minted for the module and kept in the key vault) and `lan` (the caller's address is
 * private or loopback, no forwarding header is present, and the server is not declared to be behind a reverse proxy).
 * A route without a guard must say `public` (a GET without a body). A route that is not public refuses a request a
 * browser marks as coming from another site; no CORS header is sent for module routes.
 *
 * The admin page reads what is exposed (`ModuleInfo.routes`) and the recent calls and tokens through the admin API
 * (`GET /api/module-routes`, admin token only). A token's secret is shown once, when it is minted.
 */

/** Where module routes live. */
export const MODULE_ROUTES_PREFIX = "/api/modules/"
/** The admin API of module routes (calls and tokens). */
export const MODULE_ROUTES_ADMIN_PATH = "/api/module-routes"
/** A route's body limit when it names none, bytes. */
export const DEFAULT_ROUTE_BODY_BYTES = 8192
/** The largest body limit a route may declare, bytes. */
export const MAX_ROUTE_BODY_BYTES = 1_048_576
/** Calls kept per route for the admin view. */
export const ROUTE_CALL_LOG_SIZE = 20
/** Tokens a module may hold at once. */
export const MAX_ROUTE_TOKENS_PER_MODULE = 20

export const RouteMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"])
export type RouteMethod = typeof RouteMethod.Type

export const RouteGuard = Schema.Literals(["admin", "token", "lan"])
export type RouteGuard = typeof RouteGuard.Type

/** A route token's name (what kind of caller it is for, chosen by the module): "hook", "callback". */
export const RouteTokenName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))

/** What a module's route exposes (no handler, nothing secret). */
export const ModuleRouteInfo = Schema.Struct({
  method: RouteMethod,
  /** The full path pattern, `/api/modules/<id>/hook/:name`. */
  path: Schema.String,
  guards: Schema.Array(RouteGuard),
  /** Declared without any guard (an OAuth callback). */
  public: Schema.Boolean,
  /** For a `token` guard: the token name the route accepts. */
  token: Schema.optionalKey(RouteTokenName),
  bodyLimitBytes: NonNegativeInt,
  /** Requests per minute from one caller address; and from all callers together. */
  ratePerMinute: Schema.Struct({ perAddress: NonNegativeInt, total: NonNegativeInt }),
  description: Schema.optionalKey(Schema.String)
})
export type ModuleRouteInfo = typeof ModuleRouteInfo.Type

/** One call of a route, as the in-memory log keeps it. */
export const RouteCall = Schema.Struct({
  /** Epoch ms. */
  at: Schema.Finite,
  /** The caller's address as the socket saw it (forwarding headers are not read). */
  address: Schema.String,
  status: NonNegativeInt,
  ms: Schema.Finite,
  /** The token's label, when a token guard passed. */
  token: Schema.optionalKey(Schema.String),
  /** Why it was refused, in a few words. */
  note: Schema.optionalKey(Schema.String)
})
export type RouteCall = typeof RouteCall.Type

/** A route token without its secret. */
export const RouteTokenInfo = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8,32}$/)),
  moduleId: ModuleId,
  name: RouteTokenName,
  /** Who it is for: "Home Assistant automations". */
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  createdAt: Schema.Finite,
  /** Since the server started. */
  lastUsedAt: Schema.optionalKey(Schema.Finite)
})
export type RouteTokenInfo = typeof RouteTokenInfo.Type

/** `GET /api/module-routes[?module=<id>]`. */
export const ModuleRoutesResponse = Schema.Struct({
  modules: Schema.Array(Schema.Struct({
    moduleId: ModuleId,
    /** False while the module's shared part does not run: its paths answer 404. */
    running: Schema.Boolean,
    routes: Schema.Array(Schema.Struct({ ...ModuleRouteInfo.fields, calls: Schema.Array(RouteCall) })),
    tokens: Schema.Array(RouteTokenInfo)
  })),
  /** The vault is locked: tokens cannot be listed, minted or checked (token routes answer 503). */
  tokensLocked: Schema.Boolean,
  /**
   * The owner declared a reverse proxy in front of the server (`SERVE_BEHIND_PROXY`): no caller counts as on the
   * home network, so every `lan` route refuses every request (403); callers from outside use a `token` route.
   */
  behindProxy: Schema.Boolean
})
export type ModuleRoutesResponse = typeof ModuleRoutesResponse.Type

/** `POST /api/module-routes/<moduleId>/tokens`. */
export const MintRouteTokenRequest = Schema.Struct({ name: RouteTokenName, label: RouteTokenInfo.fields.label })
export type MintRouteTokenRequest = typeof MintRouteTokenRequest.Type

/** The answer: the token's secret, shown once. */
export const MintRouteTokenResponse = Schema.Struct({ token: RouteTokenInfo, secret: Schema.String })
export type MintRouteTokenResponse = typeof MintRouteTokenResponse.Type
