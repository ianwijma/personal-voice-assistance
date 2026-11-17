import { Effect } from "effect"
import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import { classifyAddress, type AddressClass } from "./Address.ts"
import {
  NetAborted, NetFailure, NetRefused, NetTimeout, NetTooLarge, type RefusedRule, type SafeFetchError
} from "./Errors.ts"

/** Resolves a host name to its addresses (as text). Must not be called for IP literals. */
export type Resolver = (host: string, signal: AbortSignal) => Promise<ReadonlyArray<string>>

/** What the connector is asked: connect to exactly `address` (never resolve `url.hostname` again). */
export interface ConnectRequest {
  readonly url: URL
  readonly address: string
  readonly method: "GET" | "HEAD"
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}
export interface ConnectResponse {
  readonly status: number
  /** Lower-case names; repeated headers joined with ", ". */
  readonly headers: Readonly<Record<string, string>>
  readonly body: AsyncIterable<Uint8Array>
}
/** Opens one connection to `address`, sends the request, returns status, headers and a body stream. Must honour `signal`. */
export type Connector = (request: ConnectRequest) => Promise<ConnectResponse>

export interface SafeFetchOptions {
  readonly method?: "GET" | "HEAD"
  readonly headers?: Readonly<Record<string, string>>
  /** Owner switch: also allow private (RFC 1918), unique-local and CGNAT addresses, local names and any port. Loopback, link-local (cloud metadata), multicast and the like stay refused. */
  readonly allowLan?: boolean
  /** Default 2 MiB. */
  readonly maxBytes?: number
  /** Total, redirects and body included. Default 6000. */
  readonly timeoutMs?: number
  /** Default 3. */
  readonly maxRedirects?: number
  readonly signal?: AbortSignal
  readonly resolver?: Resolver
  readonly connector?: Connector
}

export interface SafeResponse {
  /** The URL that finally answered (after redirects). */
  readonly url: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly redirects: ReadonlyArray<string>
  readonly text: () => string
}

export const defaultMaxBytes = 2 * 1024 * 1024
export const defaultTimeoutMs = 6_000
export const defaultMaxRedirects = 3

const allowedOnLan: ReadonlySet<AddressClass> = new Set(["private", "unique-local", "carrier-grade-nat"])
const localSuffixes = [".local", ".lan", ".home.arpa", ".internal", ".localhost", ".localdomain"]

/** The resolver of `node:dns`: every A and AAAA record, in the order the system prefers. */
export const nodeResolver: Resolver = async (host, signal) => {
  const lookup = dns.promises.lookup(host, { all: true, verbatim: true })
  const found = await raceAbort(lookup, signal)
  return found.map((a) => a.address)
}

/** The connector of `node:http(s)`: dials the checked IP; TLS SNI, certificate name and Host header stay the URL's host. */
export const nodeConnector: Connector = ({ url, address, method, headers, signal }) =>
  new Promise<ConnectResponse>((resolve, reject) => {
    const secure = url.protocol === "https:"
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
    const isIp = classifyAddress(hostname) !== undefined
    const options: https.RequestOptions = {
      host: address,
      port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
      method,
      path: `${url.pathname}${url.search}`,
      headers: { host: url.host, "accept-encoding": "identity", ...headers },
      agent: false,
      signal,
      ...(secure && !isIp ? { servername: hostname } : {})
    }
    const req = (secure ? https : http).request(options, (res) => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v
      resolve({ status: res.statusCode ?? 0, headers: out, body: res })
    })
    req.on("error", reject)
    req.end()
  })

/** Race a promise against an abort signal (the promise's own work is not cancelled; the caller aborts what it can). */
const raceAbort = <A>(promise: Promise<A>, signal: AbortSignal): Promise<A> => {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v) },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e) }
    )
  })
}

const refuse = (rule: RefusedRule, url: string, detail: string, extra?: { address: string; addressClass: string }) =>
  new NetRefused({ rule, url, detail, ...(extra ?? {}) })

/** The rules that need no network: scheme, credentials, port, name. Returns the URL parsed, or the refusal. */
export const checkUrl = (input: string | URL, allowLan: boolean): URL | NetRefused => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return refuse("scheme", String(input), "Not a valid URL")
  }
  const shown = `${url.protocol}//${url.host}${url.pathname}`
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse("scheme", shown, `Only http and https, not ${url.protocol}`)
  if (url.username !== "" || url.password !== "") return refuse("credentials", shown, "No credentials in the URL")
  if (!allowLan && url.port !== "" && url.port !== "80" && url.port !== "443") return refuse("port", shown, `Port ${url.port} is not allowed`)
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (host === "") return refuse("host-name", shown, "No host")
  if (classifyAddress(host) === undefined && !allowLan) {
    if (!host.includes(".")) return refuse("host-name", shown, `"${host}" is a local name`)
    if (localSuffixes.some((s) => host.endsWith(s))) return refuse("host-name", shown, `"${host}" is a local name`)
  }
  return url
}

const addressRefusal = (url: URL, address: string, allowLan: boolean): NetRefused | undefined => {
  const parsed = classifyAddress(address)
  if (parsed === undefined) return refuse("address", url.href, `"${address}" is not an IP address`, { address, addressClass: "invalid" })
  if (parsed.class === "public" || (allowLan && allowedOnLan.has(parsed.class))) return undefined
  return refuse("address", `${url.protocol}//${url.host}${url.pathname}`, `${address} is a ${parsed.class} address`, { address, addressClass: parsed.class })
}

const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

interface Hop {
  readonly url: URL
  readonly addresses: ReadonlyArray<string>
}

const resolveHop = async (url: URL, allowLan: boolean, resolver: Resolver, signal: AbortSignal): Promise<Hop | NetRefused | NetFailure> => {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
  if (classifyAddress(host) !== undefined) {
    return addressRefusal(url, host, allowLan) ?? { url, addresses: [host] }
  }
  let addresses: ReadonlyArray<string>
  try {
    addresses = await raceAbort(Promise.resolve().then(() => resolver(host, signal)), signal)
  } catch (e) {
    if (signal.aborted) throw signal.reason
    return new NetFailure({ url: url.href, stage: "dns", detail: e instanceof Error ? e.message : String(e) })
  }
  if (addresses.length === 0) return new NetFailure({ url: url.href, stage: "dns", detail: `No address for ${host}` })
  // Every answer must be public: a name that also points inside is refused, so a mixed answer cannot be used to probe.
  for (const a of addresses) {
    const refusal = addressRefusal(url, a, allowLan)
    if (refusal !== undefined) return refusal
  }
  return { url, addresses }
}

const readBody = async (body: AsyncIterable<Uint8Array>, limit: number, url: string, signal: AbortSignal): Promise<Uint8Array> => {
  const iterator = body[Symbol.asyncIterator]()
  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    for (;;) {
      const next = await raceAbort(iterator.next(), signal)
      if (next.done === true) break
      total += next.value.byteLength
      if (total > limit) throw new NetTooLarge({ url, limit })
      chunks.push(next.value)
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const sameOrigin = (a: URL, b: URL) => a.origin === b.origin

const run = async (input: string | URL, options: SafeFetchOptions, signal: AbortSignal): Promise<SafeResponse> => {
  const allowLan = options.allowLan === true
  const limit = options.maxBytes ?? defaultMaxBytes
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects
  const resolver = options.resolver ?? nodeResolver
  const connector = options.connector ?? nodeConnector
  const method = options.method ?? "GET"
  let headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = v
  const redirects: Array<string> = []
  let current = checkUrl(input, allowLan)
  if (current instanceof NetRefused) throw current
  for (let hop = 0; ; hop++) {
    const url: URL = current
    const resolved = await resolveHop(url, allowLan, resolver, signal)
    if (resolved instanceof NetRefused || resolved instanceof NetFailure) throw resolved
    // Connect to an address we checked; try the next one only when a connection cannot be made.
    let response: ConnectResponse | undefined
    let lastError = "no address"
    for (const address of resolved.addresses) {
      try {
        response = await raceAbort(connector({ url, address, method, headers, signal }), signal)
        break
      } catch (e) {
        if (signal.aborted) throw signal.reason
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    if (response === undefined) throw new NetFailure({ url: url.href, stage: "connect", detail: lastError })
    if (redirectStatuses.has(response.status)) {
      void Promise.resolve(response.body[Symbol.asyncIterator]().return?.()).catch(() => undefined)
      const location = response.headers["location"]
      if (location === undefined || location === "") throw refuse("redirect-target", url.href, "Redirect without a Location")
      if (hop >= maxRedirects) throw refuse("redirect-limit", url.href, `More than ${maxRedirects} redirects`)
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw refuse("redirect-target", url.href, "Redirect to an invalid address")
      }
      const checked = checkUrl(next, allowLan)
      if (checked instanceof NetRefused) throw checked
      if (!sameOrigin(url, checked)) {
        const { authorization: _a, cookie: _c, ...rest } = headers
        headers = rest
      }
      redirects.push(checked.href)
      current = checked
      continue
    }
    const declared = Number(response.headers["content-length"])
    if (Number.isFinite(declared) && declared > limit) {
      void Promise.resolve(response.body[Symbol.asyncIterator]().return?.()).catch(() => undefined)
      throw new NetTooLarge({ url: url.href, limit })
    }
    const bytes = method === "HEAD" ? new Uint8Array(0) : await readBody(response.body, limit, url.href, signal)
    return {
      url: url.href,
      status: response.status,
      headers: response.headers,
      body: bytes,
      redirects,
      text: () => new TextDecoder().decode(bytes)
    }
  }
}

/**
 * Fetch a URL a model or a user chose. Resolves the host itself and refuses private, loopback, link-local,
 * unique-local and other non-public addresses (IPv4, IPv6, IPv4-mapped); connects to the address it checked; checks
 * every redirect again; http and https only; no credentials; ports 80 and 443 (any with `allowLan`); size and total
 * time limits; honours `options.signal` and Effect interruption. Errors say which rule refused (`NetRefused.rule`).
 */
export const safeFetch = (url: string | URL, options: SafeFetchOptions = {}): Effect.Effect<SafeResponse, SafeFetchError> =>
  Effect.tryPromise({
    try: (effectSignal) => {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
      const shown = String(url)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new NetTimeout({ url: shown, timeoutMs })), timeoutMs)
      const abort = () => controller.abort(new NetAborted({ url: shown }))
      const outside = [effectSignal, options.signal].filter((s): s is AbortSignal => s !== undefined)
      for (const s of outside) {
        if (s.aborted) abort()
        else s.addEventListener("abort", abort, { once: true })
      }
      return run(url, options, controller.signal).finally(() => {
        clearTimeout(timer)
        for (const s of outside) s.removeEventListener("abort", abort)
        // Stop whatever connection is still open.
        if (!controller.signal.aborted) controller.abort(new NetAborted({ url: shown }))
      })
    },
    catch: (e): SafeFetchError =>
      e instanceof NetRefused || e instanceof NetTooLarge || e instanceof NetTimeout || e instanceof NetAborted || e instanceof NetFailure
        ? e
        : new NetFailure({ url: String(url), stage: "response", detail: e instanceof Error ? e.message : String(e) })
  })
