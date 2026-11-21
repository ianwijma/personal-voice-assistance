import type { ModuleRoute, RouteRequest, RouteResponse } from "@pva/core"
import { type Language, say } from "@pva/module-contracts"
import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { texts, type TextKey } from "../texts.ts"
import { STATE_TTL_MS, type Spotify } from "./client.ts"

/**
 * Signing in to Spotify from the admin page (docs/modules/media.md "Signing in to Spotify"). No address is typed by the owner.
 *
 * 1. A button press on the module's page (a field action) mints a **ticket** (random, single use, ten minutes) and answers
 *    with a link to `GET /api/modules/media/spotify/start?ticket=…`. A browser opening a link cannot send the admin session
 *    token, so the ticket is what ties that route to an admin's press: nobody else can make one.
 * 2. `start` reads the origin it was reached on from the request (`RouteRequest.origin`, which the HTTP layer resolves: the
 *    checked `Host`, and `X-Forwarded-Host` / `X-Forwarded-Proto` only when the server is declared to be behind a proxy),
 *    builds the redirect address from it, and sends the browser to Spotify's authorize page with a random, single-use
 *    `state` kept here (ten minutes), tied to that redirect address and to a random value set in this browser's cookie
 *    (HttpOnly, SameSite=Lax, Secure unless plain loopback http, ten minutes, under this module's sign-in path).
 * 3. Spotify sends the browser back to `GET /api/modules/media/spotify/callback` (public, as a callback must be). It checks the
 *    `state` and the cookie (a callback from another browser is refused), exchanges the code, keeps the refresh token in the key vault and answers a small page. Nothing of the query is
 *    ever echoed.
 * 4. `address` shows the exact redirect address to register in the Spotify app, which is needed before the first sign-in.
 *
 * The scheme is `https`, as the owner decided (docs/modules/media.md §9.3): only a loopback IP address (`127.0.0.1`, `[::1]`)
 * keeps the scheme the request arrived on (`http` is allowed there by Spotify). `localhost` is refused by Spotify, so no address is built for it.
 */

export const CALLBACK_PATH = "/api/modules/media/spotify/callback"
/** The route the field action links to, and the page that shows the address. */
export const START_PATH = "/api/modules/media/spotify/start"
export const ADDRESS_PATH = "/api/modules/media/spotify/address"

const TICKET = /^[A-Za-z0-9_-]{16,64}$/
const CODE = /^[\x21-\x7e]{1,2000}$/
const STATE = /^[A-Za-z0-9_-]{16,100}$/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]{2,45}\])(?::\d{1,5})?$/
const MAX_TICKETS = 16

/** The cookie that ties a sign-in's `start` to its `callback` in the same browser. */
export const BINDING_COOKIE = "pva_media_spotify"
const COOKIE_PATH = "/api/modules/media/spotify/"
const BINDING = /^[A-Za-z0-9_-]{16,64}$/

const first = (v: string | undefined): string | undefined => v?.split(",")[0]?.trim()

/**
 * The origin a request arrived on: what the HTTP layer resolved (`RouteRequest.origin`: the checked `Host` and the server's
 * scheme, or the proxy's forwarded host and scheme only when the server is declared to be behind one). A request without
 * one (a hand-built one in a test) is judged by its `Host` header alone, as plain `http`; a forwarding header is never read here.
 */
export const originOfRequest = (req: Pick<RouteRequest, "headers" | "origin">): { readonly scheme: "http" | "https"; readonly host: string } | undefined => {
  if (req.origin !== undefined) return req.origin
  const host = first(req.headers.host)
  return host === undefined ? undefined : { scheme: "http", host }
}

/** The redirect address for an origin, or `undefined` when its host is not one Spotify accepts. */
export const redirectUriOf = (origin: { readonly scheme: "http" | "https"; readonly host: string } | undefined): string | undefined => {
  const host = origin?.host
  if (origin === undefined || host === undefined || !HOST.test(host)) return undefined
  const name = host.replace(/:\d{1,5}$/, "").toLowerCase()
  if (name === "localhost" || name.endsWith(".localhost")) return undefined
  // Spotify allows plain http only for a loopback address (`127.0.0.1`, `[::1]`): there the scheme the request really came on is used.
  const loopback = name === "127.0.0.1" || name === "[::1]"
  return `${loopback ? origin.scheme : "https"}://${host}${CALLBACK_PATH}`
}

const cookieOf = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  for (const part of (headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"))

const page = (lang: Language, status: number, lines: ReadonlyArray<string>, title = "Spotify"): RouteResponse => ({
  status,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"
  },
  body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}code{word-break:break-all}</style></head><body><h1>${escapeHtml(title)}</h1>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</body></html>`
})

export interface SignIn {
  /** A ticket for the start route, valid once for ten minutes. */
  readonly mintTicket: () => string
  /** The redirect address the last accepted start used (an admin's own browser), for the page's status. */
  readonly lastRedirect: () => string | undefined
  readonly routes: ReadonlyArray<ModuleRoute>
}

export const makeSignIn = (o: { readonly spotify: Spotify; readonly lang: () => Language; readonly now: () => number }): SignIn => {
  const tickets = new Map<string, number>()
  let last: string | undefined

  const mintTicket = (): string => {
    const at = o.now()
    for (const [k, expires] of tickets) if (expires <= at) tickets.delete(k)
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!)
    const ticket = randomBytes(24).toString("base64url")
    tickets.set(ticket, at + STATE_TTL_MS)
    return ticket
  }

  const words = (key: TextKey, values: Readonly<Record<string, string | number>> = {}) => say(texts, o.lang(), key, values)

  const start = (req: RouteRequest): Effect.Effect<RouteResponse> =>
    Effect.sync(() => {
      const lang = o.lang()
      const ticket = req.query.ticket
      const expires = ticket !== undefined && TICKET.test(ticket) ? tickets.get(ticket) : undefined
      // Single use, whatever follows.
      if (ticket !== undefined) tickets.delete(ticket)
      if (expires === undefined || expires <= o.now()) return page(lang, 400, [words("pageExpired")])
      const redirect = redirectUriOf(originOfRequest(req))
      if (redirect === undefined) return page(lang, 400, [words("pageAddressWrong")])
      // The browser that starts the sign-in is the one that must finish it: a random value goes into this browser's cookie
      // and into the state's record; the callback needs both (login CSRF).
      const binding = randomBytes(24).toString("base64url")
      const url = o.spotify.beginSignIn(redirect, binding)
      if (url === undefined) return page(lang, 400, [words("pageNotSet")])
      last = redirect
      const secure = redirect.startsWith("https:") ? "; Secure" : ""
      return {
        status: 302,
        headers: {
          Location: url,
          "Set-Cookie": `${BINDING_COOKIE}=${binding}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=600${secure}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer"
        }
      }
    })

  const callback = (req: RouteRequest): Effect.Effect<RouteResponse> =>
    Effect.gen(function*() {
      const lang = o.lang()
      const { code, state, error } = req.query
      if (error !== undefined) return page(lang, 400, [words("pageDenied")])
      if (code === undefined || state === undefined || !CODE.test(code) || !STATE.test(state)) return page(lang, 400, [words("pageExpired")])
      const sent = cookieOf(req.headers, BINDING_COOKIE)
      const outcome = yield* o.spotify.completeSignIn(code, state, sent !== undefined && BINDING.test(sent) ? sent : undefined)
      // The cookie has done its work (or never will): cleared whatever the outcome.
      const cleared = { "Set-Cookie": `${BINDING_COOKIE}=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0` }
      const withCleared = (r: RouteResponse): RouteResponse => ({ ...r, headers: { ...r.headers, ...cleared } })
      switch (outcome) {
        case "ok":
          return withCleared(page(lang, 200, [words("pageSignedIn")]))
        case "expired":
          return withCleared(page(lang, 400, [words("pageExpired")]))
        case "locked":
          return withCleared(page(lang, 503, [words("pageLocked")]))
        default:
          return withCleared(page(lang, 400, [words("pageRefused")]))
      }
    })

  const address = (req: RouteRequest): Effect.Effect<RouteResponse> =>
    Effect.sync(() => {
      const redirect = redirectUriOf(originOfRequest(req))
      return redirect === undefined
        ? page(o.lang(), 400, [words("pageAddressWrong")], words("pageAddressTitle"))
        : page(o.lang(), 200, [words("pageAddressBody", { address: redirect })], words("pageAddressTitle"))
    })

  // Twenty a minute per address. The route's own total is only a ceiling for many addresses together: kept far above what one
  // address can reach (it was 60, which one unauthenticated caller could use up to lock the owner out of signing in).
  const limits = { perAddress: 20, total: 600 } as const
  const routes: ReadonlyArray<ModuleRoute> = [
    { method: "GET", path: "spotify/start", public: true, rateLimit: limits, description: "Starts the Spotify sign-in (a ticket from the module's button is needed)", handler: start },
    { method: "GET", path: "spotify/callback", public: true, rateLimit: limits, timeoutMs: 15_000, description: "Where Spotify sends the browser back after the sign-in", handler: callback },
    { method: "GET", path: "spotify/address", public: true, rateLimit: limits, description: "Shows the redirect address to register in the Spotify app", handler: address }
  ]
  return { mintTicket, lastRedirect: () => last, routes }
}
