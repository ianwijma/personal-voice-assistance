/**
 * A network that has no network, for module tests (docs/MODULES.md, "The network" and "Testing"): a resolver and a
 * connector for `@pva/net`'s `safeFetch` and `fetchOwnerConfiguredLan` (their `resolver` and `connector` options) that
 * serve fixtures by URL and fail every other host: the resolver as a lookup failure, and the connector refuses any
 * host that is not listed too, a literal address included (`safeFetch` does not look a literal address up). The types are `@pva/net`'s, written out here so
 * the core does not depend on it; `packages/module-contracts/test` passes them to the real `safeFetch`.
 *
 * Every host of a fixture resolves to an address of its own in a public range (`93.184.216.<n>`), so `safeFetch`'s
 * address check passes as it would on the internet; a host given in `lan` resolves to the LAN address given, which only
 * `fetchOwnerConfiguredLan` accepts. `requests` records every request the connector was asked to make.
 */

/** `@pva/net`'s `Resolver`. */
export type OfflineResolver = (host: string, signal: AbortSignal) => Promise<ReadonlyArray<string>>

/** `@pva/net`'s `ConnectRequest` and `ConnectResponse`. */
export interface OfflineConnectRequest {
  readonly url: URL
  readonly address: string
  readonly method: "GET" | "HEAD"
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
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

export const makeOfflineNet = (fixtures: OfflineFixtures, options: { readonly lan?: Readonly<Record<string, string>> } = {}) => {
  const hosts = new Map<string, string>()
  for (const key of Object.keys(fixtures)) {
    const host = new URL(key).hostname
    if (!hosts.has(host) && options.lan?.[host] === undefined) hosts.set(host, `93.184.216.${(hosts.size % 250) + 1}`)
  }
  for (const [host, address] of Object.entries(options.lan ?? {})) hosts.set(host.toLowerCase(), address)
  const requests: Array<{ readonly url: string; readonly method: string; readonly address: string; readonly headers: Readonly<Record<string, string>> }> = []
  const resolver: OfflineResolver = (host) => {
    const address = hosts.get(host.toLowerCase())
    if (address === undefined) return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (the test network has no such host)`), { code: "ENOTFOUND" }))
    return Promise.resolve([address])
  }
  const connector: OfflineConnector = (request) => {
    requests.push({ url: request.url.href, method: request.method, address: request.address, headers: request.headers })
    // A literal address never reaches the resolver: the connector refuses every host that is not listed itself.
    const host = request.url.hostname.toLowerCase()
    if (!hosts.has(host)) {
      return Promise.reject(Object.assign(new Error(`connect ECONNREFUSED ${host} (the test network has no such host)`), { code: "ECONNREFUSED" }))
    }
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
