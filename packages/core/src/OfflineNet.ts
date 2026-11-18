/**
 * A network that has no network, for module tests (docs/MODULES.md, "The network" and "Testing"): a resolver and a
 * connector for `@pva/net`'s `safeFetch` and `fetchOwnerConfiguredLan` (their `resolver` and `connector` options) that
 * serve fixtures by URL and fail every other host: the resolver as a lookup failure, and the connector refuses any
 * host that is not listed too, a literal address included (`safeFetch` does not look a literal address up). The types are `@pva/net`'s, written out here so
 * the core does not depend on it; `packages/module-contracts/test` passes them to the real `safeFetch`.
 *
 * Every host of a fixture resolves to an address of its own in a public range (`93.184.216.<n>`), so `safeFetch`'s
 * address check passes as it would on the internet; a host given in `lan` resolves to the LAN address given, which only
 * `fetchOwnerConfiguredLan` accepts. `localhost` and the names under it resolve to loopback, as on a real machine (a `lan` entry for
 * one is ignored), so `@pva/net` refuses them unless the URL is a typed `localhost` with `typedLoopback`. `requests` records every request the connector was asked to make, with its method and, for a
 * POST, the body as sent (`body`, the text, which a test can `JSON.parse`). A POST is answered by the fixture of its URL as a GET is;
 * a fixture function sees the request, its `method` and `body` included.
 */

/** `@pva/net`'s `Resolver`. */
export type OfflineResolver = (host: string, signal: AbortSignal) => Promise<ReadonlyArray<string>>

/** `@pva/net`'s `ConnectRequest` and `ConnectResponse`. */
export interface OfflineConnectRequest {
  readonly url: URL
  readonly address: string
  readonly method: "GET" | "HEAD" | "POST"
  readonly headers: Readonly<Record<string, string>>
  /** A POST's serialised body. */
  readonly body?: Uint8Array
  /** Called once the (pretend) connection is made, before the request is written. */
  readonly onConnect?: () => void
  readonly signal: AbortSignal
}

/** One request the offline connector was asked to make. */
export interface OfflineRequest {
  readonly url: string
  readonly method: "GET" | "HEAD" | "POST"
  readonly address: string
  readonly headers: Readonly<Record<string, string>>
  /** A POST's body as UTF-8 text, exactly as it was sent; absent for GET and HEAD. */
  readonly body?: string
}
export interface OfflineConnectResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly contentTypeLines?: ReadonlyArray<string>
  readonly body: AsyncIterable<Uint8Array>
}
export type OfflineConnector = (request: OfflineConnectRequest) => Promise<OfflineConnectResponse>

/** One fixture: a status (default 200), headers, and a body (text, bytes, or anything else as JSON). */
export interface OfflineResponse {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
}

/**
 * Fixtures by URL: an exact `href` ("https://api.example.org/v1/x?q=1"), or a URL without a query, which then answers
 * that path whatever the query. A function answers per request. A listed host (of a fixture, or `lan`) with no fixture
 * for the path answers 404; that is the only answer made up. Any other host, a name or a literal address, is refused.
 */
export type OfflineFixtures = Readonly<Record<string, OfflineResponse | ((request: OfflineConnectRequest) => OfflineResponse)>>

/**
 * `localhost` and the names under it (`x.localhost`, with or without a trailing dot) answer loopback, as on a real machine, never a
 * made-up public address: so the real helper's own loopback rule decides (review round 1 of the POST change, finding 5), and a test
 * passes only where serve mode would. This is how the names resolve, not a copy of that rule.
 */
const isLoopbackName = (host: string): boolean => {
  const name = host.toLowerCase().replace(/\.$/, "")
  return name === "localhost" || name.endsWith(".localhost")
}

export const makeOfflineNet = (fixtures: OfflineFixtures, options: { readonly lan?: Readonly<Record<string, string>> } = {}) => {
  const hosts = new Map<string, string>()
  for (const key of Object.keys(fixtures)) {
    const host = new URL(key).hostname
    if (!hosts.has(host) && options.lan?.[host] === undefined && !isLoopbackName(host)) hosts.set(host, `93.184.216.${(hosts.size % 250) + 1}`)
    if (isLoopbackName(host)) hosts.set(host, "127.0.0.1")
  }
  for (const [host, address] of Object.entries(options.lan ?? {})) if (!isLoopbackName(host)) hosts.set(host.toLowerCase(), address)
  const requests: Array<OfflineRequest> = []
  const resolver: OfflineResolver = (host) => {
    // As a system resolver does (RFC 6761 §6.3), whether a fixture names it or not; `@pva/net` then refuses it, except for the
    // `localhost` the owner typed with `typedLoopback`, which it connects without asking.
    if (isLoopbackName(host)) return Promise.resolve(["127.0.0.1", "::1"])
    const address = hosts.get(host.toLowerCase())
    if (address === undefined) return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (the test network has no such host)`), { code: "ENOTFOUND" }))
    return Promise.resolve([address])
  }
  const connector: OfflineConnector = (request) => {
    requests.push({
      url: request.url.href, method: request.method, address: request.address, headers: request.headers,
      ...(request.body === undefined ? {} : { body: new TextDecoder().decode(request.body) })
    })
    // A literal address never reaches the resolver: the connector refuses every host that is not listed itself, as a refused connect
    // (nothing was sent: `notSent`, as `@pva/net`'s connector says it).
    const host = request.url.hostname.toLowerCase()
    if (!hosts.has(host)) {
      return Promise.reject(Object.assign(new Error(`connect ECONNREFUSED ${host} (the test network has no such host)`), { code: "ECONNREFUSED", notSent: true }))
    }
    request.onConnect?.()
    const url = new URL(request.url.href)
    url.hash = ""
    const exact = fixtures[url.href]
    const withoutQuery = fixtures[`${url.origin}${url.pathname}`]
    const fixture = exact ?? withoutQuery
    const answer: OfflineResponse = fixture === undefined ? { status: 404, body: "Not found (no fixture)" } : typeof fixture === "function" ? fixture(request) : fixture
    const body = answer.body
    const bytes = body === undefined ? new Uint8Array() : body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body))
    const headers: Record<string, string> = Object.fromEntries(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    if (headers["content-type"] === undefined && body !== undefined) {
      headers["content-type"] = typeof body === "string" ? "text/plain; charset=utf-8" : body instanceof Uint8Array ? "application/octet-stream" : "application/json"
    }
    headers["content-length"] = String(bytes.length)
    return Promise.resolve({
      status: answer.status ?? 200,
      headers,
      contentTypeLines: headers["content-type"] === undefined ? [] : [headers["content-type"]],
      body: (async function*() {
        if (request.method !== "HEAD" && bytes.length > 0) yield bytes
      })()
    })
  }
  return { resolver, connector, requests }
}
