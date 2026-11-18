import { Effect } from "effect"
import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import zlib from "node:zlib"
import { classifyAddress, parseIPv4, parseIPv6, type AddressClass } from "./Address.ts"
import {
  NetAborted, NetFailure, NetRefused, NetTimeout, NetTooLarge, type RefusedRule, type SafeFetchError
} from "./Errors.ts"

/** Resolves a host name to its addresses (as text). Must not be called for IP literals. */
export type Resolver = (host: string, signal: AbortSignal) => Promise<ReadonlyArray<string>>

/**
 * What the connector is asked: connect to exactly `address` (never resolve `url.hostname` again). `POST` comes only from
 * `fetchOwnerConfiguredLan`, always with `body`.
 */
export interface ConnectRequest {
  readonly url: URL
  readonly address: string
  readonly method: "GET" | "HEAD" | "POST"
  /**
   * Lower-case names, already checked. They never hold `Host` or `Accept-Encoding`: the connector derives the Host header and the TLS
   * name from `url` alone and asks for `identity`. For a POST they hold `content-type: application/json` and the body's
   * `content-length`, both set by the helper.
   */
  readonly headers: Readonly<Record<string, string>>
  /** POST only: the serialised body, sent once on this connection and never again. */
  readonly body?: Uint8Array
  /**
   * POST only: called by the connector when the connection is made, before it writes a byte of the request. From then on the attempt
   * has no time share of its own (only the total limit), because a POST that was written is never moved to another address.
   */
  readonly onConnect?: () => void
  readonly signal: AbortSignal
}
export interface ConnectResponse {
  readonly status: number
  /** Lower-case names; repeated headers joined with ", ". */
  readonly headers: Readonly<Record<string, string>>
  /**
   * The raw `Content-Type` field lines, one string per line, never joined (the Node connector fills it from the raw headers). Absent:
   * the single value of `headers["content-type"]` if there is one, else no line.
   */
  readonly contentTypeLines?: ReadonlyArray<string>
  readonly body: AsyncIterable<Uint8Array>
}
/**
 * Opens one connection to `address`, sends the request, returns status, headers and a body stream. Must honour `signal`. A connector
 * that fails before it wrote any byte of the request (the connection was refused, could not be made, or was cancelled before it was
 * made) rejects with an error that has `notSent: true` (`requestNotSent`); only such a failure lets a POST go on to the host's next
 * address. Any other failure of a POST ends the request.
 */
export type Connector = (request: ConnectRequest) => Promise<ConnectResponse>

/** The connector's failure is certain to have happened before any byte of the request was written (see `Connector`). */
export const requestNotSent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { readonly notSent?: unknown }).notSent === true

/** `error` as an `Error` that says no byte of the request was written, without changing the original. */
const notSentError = (error: unknown): Error =>
  Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { notSent: true })

/**
 * Which response types a caller accepts. `types` are media types ("text/html") or a structured-syntax suffix of a type
 * ("application/*+json"); parameters such as `charset` are ignored when comparing. A response without a Content-Type, or with one
 * not listed, is refused before its body is read (rule `content-type`).
 */
export interface ContentTypePolicy {
  /** For messages: "web page", "JSON". */
  readonly name: string
  readonly types: ReadonlyArray<string>
}

/** The presets. A caller may also pass its own policy (no wildcards other than the `type/*+suffix` form). */
export const contentTypes = {
  /** A page a model asked to read: HTML, plain text, PDF, exactly the list of web-search §13, rule 5. */
  webPage: { name: "web page", types: ["text/html", "text/plain", "application/pdf"] },
  /** An API answer. */
  json: { name: "JSON", types: ["application/json", "application/*+json"] },
  /** RSS, Atom, JSON Feed and the XML types feeds are served as. */
  feed: { name: "feed", types: ["application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/feed+json", "application/json", "application/xml", "text/xml"] },
  /** Raster images, for a media proxy. SVG is not one: it can carry script. */
  image: { name: "image", types: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] }
} as const satisfies Record<string, ContentTypePolicy>

export interface SafeFetchOptions {
  /** The response types this caller accepts: one of `contentTypes` or its own. Required. */
  readonly accept: ContentTypePolicy
  readonly method?: "GET" | "HEAD"
  /**
   * Request headers. Names are compared without case; giving one twice is refused. Refused (rule `header`): `Host` and anything that
   * would change where or how the request goes (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Proxy-Authorization`,
   * `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Content-Length`, `Expect`, `HTTP2-Settings`, pseudo-headers), `Accept-Encoding`
   * (the request always asks for `identity`), and a name or value with a character a header cannot hold. `Accept` defaults to the
   * policy's types.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** After decompression. Default 2 MiB. */
  readonly maxBytes?: number
  /** Total, redirects and body included. Default 6000. */
  readonly timeoutMs?: number
  /** Default 3. */
  readonly maxRedirects?: number
  readonly signal?: AbortSignal
  readonly resolver?: Resolver
  readonly connector?: Connector
}

/** A POST body: `json` is serialised by the helper (`JSON.stringify`) and sent as `application/json` with its length. */
export interface JsonBody {
  readonly json: unknown
}

interface OwnerConfiguredLanBase extends Omit<SafeFetchOptions, "method"> {
  /** POST only: the largest serialised body in bytes, checked before anything is connected. Default 64 KiB, at most 1 MiB. */
  readonly maxRequestBytes?: number
  /**
   * Allow loopback, only for the host the owner typed (default off): when the URL's host is itself a loopback literal (`127.0.0.0/8`,
   * `[::1]`) or exactly `localhost`. `localhost` is connected as `127.0.0.1`, then `::1`, without asking the resolver. A name that
   * resolves to loopback stays refused, and so does a redirect to loopback.
   */
  readonly typedLoopback?: boolean
}

/** `fetchOwnerConfiguredLan`'s options: `safeFetch`'s, plus a POST with a JSON body and `typedLoopback`. */
export type OwnerConfiguredLanOptions = OwnerConfiguredLanBase & (
  | { readonly method?: "GET" | "HEAD"; readonly body?: undefined }
  | { readonly method: "POST"; readonly body: JsonBody }
)

/** What `run` reads at run time: any caller's options, as a cast may have made them. */
type AnyOptions = Omit<SafeFetchOptions, "method"> & {
  readonly method?: unknown
  readonly body?: unknown
  readonly maxRequestBytes?: unknown
  readonly typedLoopback?: unknown
}

export interface SafeResponse {
  /** The URL that finally answered (after redirects). */
  readonly url: string
  readonly status: number
  /**
   * Lower-case names. When the body arrived compressed, `content-encoding` and `content-length` are removed, because `body` is the
   * decompressed content; `encoding` says how it came.
   */
  readonly headers: Readonly<Record<string, string>>
  /**
   * The content, decompressed. Empty for HEAD, for 204 and 304, and for a response outside 200–299 whose type the policy does not
   * accept (its body is not read).
   */
  readonly body: Uint8Array
  /** How the body was compressed on the wire (`deflate` is the zlib format of RFC 9110 §8.4.1.2). */
  readonly encoding: "identity" | "gzip" | "deflate" | "br"
  /** The media type of the response, lower case without parameters ("text/html"); "" when there was none. */
  readonly contentType: string
  readonly redirects: ReadonlyArray<string>
  /** The body as text, in the charset the Content-Type names (UTF-8 when it names none or one this machine does not know). */
  readonly text: () => string
}

export const defaultMaxBytes = 2 * 1024 * 1024
export const defaultTimeoutMs = 6_000
export const defaultMaxRedirects = 3
export const defaultMaxRequestBytes = 64 * 1024
export const maxMaxRequestBytes = 1024 * 1024

const allowedOnLan: ReadonlySet<AddressClass> = new Set(["private", "unique-local", "carrier-grade-nat"])
const localSuffixes = [".local", ".lan", ".home.arpa", ".internal", ".localhost", ".localdomain"]

/** The resolver of `node:dns`: every A and AAAA record, in the order the system prefers. */
export const nodeResolver: Resolver = async (host, signal) => {
  const lookup = dns.promises.lookup(host, { all: true, verbatim: true })
  const found = await raceAbort(lookup, signal)
  return found.map((a) => a.address)
}

export interface NodeConnectorOptions {
  /**
   * Certificates to trust instead of the system's (PEM): for an owner-configured LAN endpoint with its own CA, and for tests. The
   * certificate is always verified, against the URL's host name.
   */
  readonly ca?: string | ReadonlyArray<string>
}

/**
 * The connector of `node:http(s)`: dials the checked IP. The Host header and the TLS name (SNI and the certificate check) come
 * from `url` only, set after the caller's headers so nothing can replace them, and the request asks for `identity`.
 */
export const makeNodeConnector = (connectorOptions: NodeConnectorOptions = {}): Connector => ({ url, address, method, headers, body, onConnect, signal }) =>
  new Promise<ConnectResponse>((resolve, reject) => {
    const secure = url.protocol === "https:"
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
    const isIp = classifyAddress(hostname) !== undefined
    const sent = method === "POST" ? (body ?? new Uint8Array(0)) : undefined
    const outgoing: Record<string, string> = Object.create(null)
    for (const [k, v] of Object.entries(headers)) if (k !== "host" && k !== "accept-encoding" && k !== "content-length") outgoing[k] = v
    outgoing["host"] = url.host
    outgoing["accept-encoding"] = "identity"
    // The length is the body's, whatever the headers say.
    if (sent !== undefined) outgoing["content-length"] = String(sent.byteLength)
    const options: https.RequestOptions = {
      host: address,
      port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
      method,
      path: `${url.pathname}${url.search}`,
      headers: outgoing,
      setHost: false,
      agent: false,
      signal,
      // TLS: SNI and the certificate check use the URL's name (Node checks `servername`); an IP-literal URL is checked against that IP.
      ...(secure && !isIp ? { servername: hostname } : {}),
      ...(secure ? { rejectUnauthorized: true, checkServerIdentity: (_host: string, cert: import("node:tls").PeerCertificate) => tls.checkServerIdentity(hostname, cert) } : {}),
      ...(secure && connectorOptions.ca !== undefined ? { ca: typeof connectorOptions.ca === "string" ? connectorOptions.ca : [...connectorOptions.ca] } : {})
    }
    const req = (secure ? https : http).request(options, (res) => {
      // Errors of the body reach whoever reads it (the async iterator); a body nobody reads any more must not crash the process.
      res.on("error", () => undefined)
      if (signal.aborted) {
        res.destroy()
        reject(signal.reason)
        return
      }
      const out: Record<string, string> = Object.create(null)
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v
      // Node keeps only the first of several Content-Type lines in `res.headers`; the guard must see all of them (as separate lines).
      const typeLines: Array<string> = []
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) if (res.rawHeaders[i]!.toLowerCase() === "content-type") typeLines.push(res.rawHeaders[i + 1]!)
      if (typeLines.length > 1) out["content-type"] = typeLines.join(", ") // for display only: the parser reads `contentTypeLines`
      resolve({ status: res.statusCode ?? 0, headers: out, contentTypeLines: typeLines, body: res })
    })
    // Until the socket has connected, no byte of the request has been written (Node writes it after "connect", for TLS after the
    // handshake): a failure before then says so (`notSent`). A socket that is not connecting when it is handed over counts as connected.
    let connected = false
    req.on("socket", (socket) => {
      if (!socket.connecting) { connected = true; onConnect?.(); return }
      socket.once("connect", () => { connected = true; onConnect?.() })
    })
    req.on("error", (e) => reject(connected ? e : notSentError(e)))
    req.end(sent)
  })

/** `makeNodeConnector()` with the system's certificates. */
export const nodeConnector: Connector = makeNodeConnector()

/**
 * Race a promise against an abort signal (the promise's own work is not cancelled; the caller aborts what it can). The promise's
 * rejection is always handled, also when the signal has already fired: a connector that rejects after the race is lost must not
 * become an unhandled rejection, which ends a Node process (review round 2, finding 1).
 */
const raceAbort = <A>(promise: Promise<A>, signal: AbortSignal): Promise<A> => {
  promise.catch(() => undefined)
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

/** The URL as an error shows it: as given, without the user name and password a URL may carry (they are refused anyway). */
const shownUrl = (input: string | URL): string => {
  try {
    const url = new URL(input)
    if (url.username === "" && url.password === "") return String(input)
    url.username = ""
    url.password = ""
    return url.href
  } catch {
    return String(input)
  }
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
    if (localSuffixes.some((s) => host === s.slice(1) || host.endsWith(s))) return refuse("host-name", shown, `"${host}" is a local name`)
  }
  return url
}

const addressRefusal = (url: URL, address: string, allowLan: boolean): NetRefused | undefined => {
  const parsed = classifyAddress(address)
  if (parsed === undefined) return refuse("address", url.href, `"${address}" is not an IP address`, { address, addressClass: "invalid" })
  if (parsed.class === "public" || (allowLan && allowedOnLan.has(parsed.class))) return undefined
  return refuse("address", `${url.protocol}//${url.host}${url.pathname}`, `${address} is a ${parsed.class} address`, { address, addressClass: parsed.class })
}

// ---- request headers -------------------------------------------------------------------------------------------------------------

/** RFC 9110 §5.6.2 token characters. */
const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Visible ASCII, space and tab: what a field value may hold (RFC 9110 §5.5), without the obsolete octets above 0x7e. */
const valuePattern = /^[\t\x20-\x7e]*$/
/** Headers a caller may not set: the authority, hop-by-hop and framing headers, and the encoding (always `identity`). */
const forbiddenHeaders: ReadonlySet<string> = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "transfer-encoding", "te", "trailer",
  "upgrade", "content-length", "expect", "http2-settings", "accept-encoding"
])
/** What survives a redirect to another origin: nothing that could carry a credential. */
const crossOriginHeaders: ReadonlySet<string> = new Set(["accept", "accept-language", "user-agent"])

/**
 * A header map, checked and with lower-case names: each name a token, not one of the forbidden headers, a value a header can hold,
 * and no name twice whatever its case. The refusal otherwise. `checkHeaders` is this plus the default `Accept`; a caller that merges
 * two maps (defaults and per-request values) canonicalises each with this first, so a difference in case cannot make an override a
 * duplicate (review round 3, finding 3).
 */
export const canonicalHeaders = (url: string, given: Readonly<Record<string, string>> | undefined): Record<string, string> | NetRefused => {
  const out: Record<string, string> = Object.create(null)
  if (given === undefined || given === null) return out
  if (typeof given !== "object") return refuse("header", url, "Headers must be an object of names and values")
  for (const name of Object.keys(given)) {
    const value = given[name]
    const key = name.toLowerCase()
    if (!tokenPattern.test(name)) return refuse("header", url, `"${name}" is not a header name`)
    if (forbiddenHeaders.has(key)) return refuse("header", url, `The ${name} header may not be set`)
    if (typeof value !== "string" || !valuePattern.test(value)) return refuse("header", url, `The ${name} header holds a character a header cannot hold`)
    if (key in out) return refuse("header", url, `The ${name} header is given twice`)
    out[key] = value.trim()
  }
  return out
}

/** The caller's headers, lower-case and checked (`canonicalHeaders`), with `Accept` from the policy when none is given. Review round 1, finding 4. */
export const checkHeaders = (url: string, given: Readonly<Record<string, string>> | undefined, accept: ContentTypePolicy): Record<string, string> | NetRefused => {
  const out = canonicalHeaders(url, given)
  if (out instanceof NetRefused) return out
  if (!("accept" in out)) {
    const listed = accept.types.filter((t) => !t.includes("*"))
    out["accept"] = listed.length > 0 ? listed.join(", ") : "*/*"
  }
  return out
}

/** Headers that make a request conditional on a validator of the requested resource: never carried to another URL by a redirect. */
const conditionalHeaders: ReadonlySet<string> = new Set(["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"])

// ---- response types and encodings ---------------------------------------------------------------------------------------------------

/** A parsed Content-Type: the media type in lower case and its parameters (names lower-cased, the first of a name wins, quoted values unescaped). */
export interface ParsedContentType {
  readonly type: string
  readonly parameters: ReadonlyMap<string, string>
}
/** A Content-Type that is not read: why. */
export interface ContentTypeRefusal {
  readonly refused: string
}

const tokenChars = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/

/**
 * Read the `Content-Type` field lines of a response (each line its own string, never joined) by RFC 9110 §8.3.1:
 * `type "/" subtype *( OWS ";" OWS name "=" ( token / quoted-string ) )`, quoted-pairs unescaped. More than one line, no line, and
 * anything the grammar does not allow (an unterminated quote, a comma or other text after the media type or a parameter, a control
 * character, an empty type, a parameter without a value) is a refusal; only a trailing `;` is tolerated. This is the one place the
 * header is read.
 */
export const parseContentType = (values: ReadonlyArray<string>): ParsedContentType | ContentTypeRefusal => {
  if (values.length === 0) return { refused: "no content type" }
  if (values.length > 1) return { refused: "more than one Content-Type field" }
  const text = values[0]!
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return { refused: "a control character in the content type" }
  }
  let i = 0
  const ows = () => { while (text[i] === " " || text[i] === "\t") i++ }
  const token = (): string | undefined => {
    const m = tokenChars.exec(text.slice(i))
    if (m === null) return undefined
    i += m[0].length
    return m[0]
  }
  ows()
  const main = token()
  if (main === undefined || text[i] !== "/") return { refused: "not a media type" }
  i++
  const sub = token()
  if (sub === undefined) return { refused: "not a media type" }
  const parameters = new Map<string, string>()
  for (;;) {
    ows()
    if (i >= text.length) break
    if (text[i] !== ";") return { refused: "text after the media type that is not a parameter" }
    i++
    ows()
    if (i >= text.length) break // a trailing ";"
    const name = token()
    if (name === undefined || text[i] !== "=") return { refused: "a parameter without a name or a value" }
    i++
    let value: string
    if (text[i] === '"') {
      i++
      value = ""
      for (;;) {
        if (i >= text.length) return { refused: "an unterminated quoted string" }
        const c = text[i++]!
        if (c === '"') break
        if (c === "\\") {
          if (i >= text.length) return { refused: "an unterminated quoted string" }
          value += text[i++]!
        } else value += c
      }
    } else {
      const t = token()
      if (t === undefined) return { refused: "a parameter without a value" }
      value = t
    }
    const key = name.toLowerCase()
    if (!parameters.has(key)) parameters.set(key, value)
  }
  return { type: `${main}/${sub}`.toLowerCase(), parameters }
}

/** "Text/HTML; charset=UTF-8" → "text/html"; "" when there is none or it is not read (a thin wrapper over `parseContentType`). */
export const mediaTypeOf = (header: string | undefined): string => {
  const parsed = parseContentType(header === undefined ? [] : [header])
  return "refused" in parsed ? "" : parsed.type
}

const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

const validPolicy = (policy: ContentTypePolicy | undefined): boolean =>
  policy !== undefined && Array.isArray(policy.types) && policy.types.length > 0 &&
  policy.types.every((t) => typeof t === "string" && (mediaTypePattern.test(t) || /^[a-z0-9!#$&^_.+-]+\/\*\+[a-z0-9!#$&^_.-]+$/.test(t)))

/** The media type is one the policy lists, directly or by its "+suffix". */
export const acceptsType = (policy: ContentTypePolicy, type: string): boolean =>
  type !== "" && policy.types.some((t) => {
    const star = /^([^/]+)\/\*\+(.+)$/.exec(t)
    if (star === null) return t === type
    const [main, sub] = type.split("/") as [string, string]
    return main === star[1] && sub.endsWith(`+${star[2]}`)
  })

type Encoding = SafeResponse["encoding"]
const encodingOf = (header: string | undefined): Encoding | undefined => {
  const v = (header ?? "").trim().toLowerCase()
  if (v === "" || v === "identity") return "identity"
  if (v === "gzip" || v === "x-gzip") return "gzip"
  if (v === "deflate") return "deflate"
  if (v === "br") return "br"
  return undefined // another coding, or several ("gzip, br")
}

/** The decoder for the `charset` parameter of a parsed Content-Type: UTF-8 when it has none or one this machine does not know. */
const decoderFor = (parsed: ParsedContentType | ContentTypeRefusal): InstanceType<typeof TextDecoder> => {
  const label = "refused" in parsed ? undefined : parsed.parameters.get("charset")
  if (label !== undefined) {
    try {
      return new TextDecoder(label)
    } catch {
      // unknown label: UTF-8 below
    }
  }
  return new TextDecoder()
}

// ---- the body ------------------------------------------------------------------------------------------------------------------------

const closeBody = (body: AsyncIterable<Uint8Array>): void => {
  void Promise.resolve(body[Symbol.asyncIterator]().return?.()).catch(() => undefined)
}

/** Read the raw body, counting bytes; a body still arriving past `limit` is refused. */
async function* rawChunks(body: AsyncIterable<Uint8Array>, limit: number, url: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]()
  let total = 0
  try {
    for (;;) {
      const next = await raceAbort(iterator.next(), signal)
      if (next.done === true) return
      total += next.value.byteLength
      if (total > limit) throw new NetTooLarge({ url, limit })
      yield next.value
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}

/**
 * `Content-Encoding: deflate` is the zlib format (RFC 9110 §8.4.1.2, RFC 1950): its first two bytes name the deflate method and are a
 * multiple of 31. Raw deflate without the zlib wrapper is not supported: two bytes cannot tell it apart from zlib for every stream
 * (review round 3, finding 2), so a deflate body that does not start with a zlib header is refused (rule `content-encoding`).
 */
const isZlibHeader = (b: Uint8Array): boolean => b.length >= 2 && (b[0]! & 0x0f) === 8 && (b[0]! >> 4) <= 7 && ((b[0]! << 8) | b[1]!) % 31 === 0

/**
 * The first chunks of a body until they hold `n` bytes (or the body ends), joined, so a decision about the format never rests on a
 * chunk boundary: HTTP chunks and TCP segments may split anywhere, even inside a two-byte header (review round 2, finding 19).
 */
const prefixOf = async (raw: AsyncGenerator<Uint8Array>, n: number): Promise<{ head: Uint8Array; done: boolean }> => {
  const parts: Array<Uint8Array> = []
  let total = 0
  for (;;) {
    if (total >= n) return { head: concat(parts), done: false }
    const next = await raw.next()
    if (next.done === true) return { head: concat(parts), done: true }
    parts.push(next.value)
    total += next.value.byteLength
  }
}

/**
 * Decompress as the chunks arrive and count the decompressed bytes against `limit`, so a small compressed body cannot expand past it
 * (review round 1, finding 3). Compressed bytes are counted too.
 *
 * A failure of the decompressor (an invalid stream, too many decompressed bytes) ends the read at once: the pending read of the raw
 * body is abandoned and the body closed, and the caller gets that failure, not whatever a later deadline would say (review round 4,
 * finding 1). The connection itself is closed by `fetchChecked`, which aborts the request's signal when `run` settles.
 *
 * Deflate (zlib) and brotli are single streams: bytes after the end of the stream are refused (rule `content-encoding`), not ignored
 * (review round 4, finding 3). Gzip may be several members one after the other (RFC 1952 §2.2); bytes after the last member that are
 * not another member are refused by the decompressor itself.
 */
const decodeBody = async (encoding: Exclude<Encoding, "identity">, body: AsyncIterable<Uint8Array>, limit: number, url: string, signal: AbortSignal): Promise<Array<Uint8Array>> => {
  // Aborted when the decompressor fails, so a raw read that is waiting for bytes that may never come gives up at once.
  const stop = new AbortController()
  const raw = rawChunks(body, limit, url, AbortSignal.any([signal, stop.signal]))
  // The first two bytes, whatever the chunk boundaries: for deflate they must be a zlib header.
  const prefix = await prefixOf(raw, 2)
  // No bytes at all: an empty body, whatever the header says (servers label empty answers too).
  if (prefix.done && prefix.head.byteLength === 0) return []
  if (encoding === "deflate" && !isZlibHeader(prefix.head)) {
    void raw.return(undefined).catch(() => undefined)
    throw refuse("content-encoding", url, "The deflate body is not a zlib stream (raw deflate is not supported)")
  }
  let first: IteratorResult<Uint8Array> | undefined = prefix.head.byteLength > 0 ? { done: false, value: prefix.head } : prefix.done ? { done: true, value: undefined } : undefined
  const stream: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress =
    encoding === "gzip" ? zlib.createGunzip() : encoding === "br" ? zlib.createBrotliDecompress() : zlib.createInflate()
  const out: Array<Uint8Array> = []
  let total = 0
  let written = 0
  // The decompressor's own failure: too many bytes out, or an invalid stream.
  let decoderFailure: unknown
  let otherFailure: unknown
  const fail = (e: unknown) => {
    decoderFailure ??= e
    stream.destroy()
    stop.abort(e)
  }
  const done = new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > limit) {
        fail(new NetTooLarge({ url, limit }))
        resolve()
        return
      }
      out.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    })
    stream.on("error", (e) => { fail(e); resolve() })
    stream.on("end", () => resolve())
    stream.on("close", () => resolve())
  })
  const onAbort = () => { otherFailure ??= signal.reason; stream.destroy() }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    for (let k = 0; ; k++) {
      const next: IteratorResult<Uint8Array> = first ?? (prefix.done && k > 0 ? { done: true, value: undefined } : await raw.next())
      first = undefined
      if (decoderFailure !== undefined || otherFailure !== undefined) break
      if (next.done === true) { stream.end(); break }
      written += next.value.byteLength
      // Respect back-pressure, so a stalled consumer cannot make the decompressor buffer without bound. Whichever of drain and close
      // comes first removes the other's listener, so repeated waits do not pile up listeners (review round 3, finding 6).
      if (!stream.write(next.value)) {
        await new Promise<void>((r) => {
          const onDrain = () => { stream.off("close", onClose); r() }
          const onClose = () => { stream.off("drain", onDrain); r() }
          stream.once("drain", onDrain)
          stream.once("close", onClose)
        })
      }
    }
    await done
  } catch (e) {
    // The raw read failed: too many raw bytes, the request's signal, or `stop` (then the decoder's failure is already recorded).
    otherFailure ??= e
    stream.destroy()
  } finally {
    signal.removeEventListener("abort", onAbort)
    void raw.return(undefined).catch(() => undefined)
  }
  if (decoderFailure !== undefined) {
    if (decoderFailure instanceof NetTooLarge) throw decoderFailure
    const detail = decoderFailure instanceof Error ? decoderFailure.message : String(decoderFailure)
    if (encoding === "deflate") throw refuse("content-encoding", url, `The deflate body is not a valid zlib stream: ${detail}`)
    throw new NetFailure({ url, stage: "response", detail: `The ${encoding} body could not be decompressed: ${detail}` })
  }
  if (otherFailure !== undefined) throw otherFailure
  // A single-stream encoding that stopped before the last byte it was given: the rest is not part of the stream. Gzip is exempt: its
  // gunzip reads member after member and fails on a suffix that is not one, except that from a zero byte after the last member on it
  // stops and ignores the rest, as `gzip` does with padding (README; review round 5, finding 2).
  if (encoding !== "gzip" && stream.bytesWritten < written) {
    throw refuse("content-encoding", url, `The ${encoding} body has ${written - stream.bytesWritten} bytes after the end of its stream`)
  }
  return out
}

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const readBody = async (encoding: Encoding, body: AsyncIterable<Uint8Array>, limit: number, url: string, signal: AbortSignal): Promise<Uint8Array> => {
  if (encoding !== "identity") return concat(await decodeBody(encoding, body, limit, url, signal))
  const chunks: Array<Uint8Array> = []
  for await (const c of rawChunks(body, limit, url, signal)) chunks.push(c)
  return concat(chunks)
}

const sameOrigin = (a: URL, b: URL) => a.origin === b.origin
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
  if (!Array.isArray(addresses) || addresses.length === 0) return new NetFailure({ url: url.href, stage: "dns", detail: `No address for ${host}` })
  // Every answer must be public: a name that also points inside is refused, so a mixed answer cannot be used to probe.
  for (const a of addresses) {
    const refusal = addressRefusal(url, a, allowLan)
    if (refusal !== undefined) return refusal
  }
  return { url, addresses }
}

const positive = (v: number | undefined, fallback: number): number | undefined =>
  v === undefined ? fallback : Number.isFinite(v) && v > 0 ? v : undefined

/**
 * `typedLoopback`: the loopback addresses to connect to when the host written in the URL is itself loopback, a literal in
 * `127.0.0.0/8` or `[::1]`, or exactly `localhost` (then `127.0.0.1` and `::1`, no lookup); `undefined` for any other host, which is
 * then resolved and checked as usual (a name that resolves to loopback is refused). IPv4-mapped forms (`[::ffff:127.0.0.1]`) are not
 * a typed loopback literal.
 */
const typedLoopbackAddresses = (url: URL): ReadonlyArray<string> | undefined => {
  const host = url.hostname
  if (host === "localhost") return ["127.0.0.1", "::1"]
  const v4 = parseIPv4(host)
  if (v4 !== undefined) return v4[0] === 127 ? [host] : undefined
  if (host.startsWith("[") && host.endsWith("]")) {
    const v6 = parseIPv6(host.slice(1, -1))
    if (v6 !== undefined && v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return ["::1"]
  }
  return undefined
}

/** The serialised POST body, or the refusal: `{ json }` that `JSON.stringify` turns into text, at most `limit` bytes as UTF-8. */
const serialiseBody = (shown: string, body: unknown, limit: number): Uint8Array => {
  if (typeof body !== "object" || body === null || !("json" in body)) throw refuse("body", shown, "A POST takes a body of the form { json }")
  let text: unknown
  try {
    text = JSON.stringify((body as JsonBody).json)
  } catch (e) {
    // The serialiser's message may quote the value's keys; it is not repeated.
    throw refuse("body", shown, `The body cannot be serialised as JSON (${e instanceof Error ? e.name : "error"})`)
  }
  if (typeof text !== "string") throw refuse("body", shown, "The body cannot be serialised as JSON (no JSON value)")
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > limit) throw refuse("body", shown, `The body is ${bytes.byteLength} bytes, more than the ${limit} allowed`)
  return bytes
}

/**
 * One connection attempt to one checked address, with its own budget inside the total one: when the budget runs out, the attempt is
 * cancelled and the next address gets its turn, so one black-holed address cannot use up the whole deadline (review round 3,
 * finding 7). The attempt's signal follows the request's, so cancelling the request (the total deadline, the caller) still stops a
 * connection that has answered and whose body is being read.
 */
const attempt = async (connector: Connector, request: Omit<ConnectRequest, "signal" | "onConnect">, signal: AbortSignal, budgetMs: number | undefined): Promise<ConnectResponse> => {
  const own = new AbortController()
  const follow = () => own.abort(signal.reason)
  signal.addEventListener("abort", follow, { once: true })
  // Without a budget of its own (the last address) only the request's deadline ends the attempt, so the caller gets a NetTimeout.
  const budgetError = new Error(`No answer from ${request.address} within ${Math.round(budgetMs ?? 0)} ms`)
  const timer = budgetMs === undefined ? undefined : setTimeout(() => own.abort(budgetError), budgetMs)
  // A POST's share of the time is for connecting only: once the connector says it is connected, the request may be written, and a
  // POST that may have been written is never cancelled to try another address.
  const post = request.method === "POST"
  const pending = Promise.resolve().then(() => connector({ ...request, ...(post ? { onConnect: () => clearTimeout(timer) } : {}), signal: own.signal }))
  try {
    const response = await raceAbort(pending, own.signal)
    clearTimeout(timer)
    return response
  } catch (e) {
    clearTimeout(timer)
    signal.removeEventListener("abort", follow)
    if (!own.signal.aborted) own.abort(e)
    const budgetRanOut = own.signal.aborted && !signal.aborted && own.signal.reason === budgetError
    if (budgetRanOut && post) {
      // Only the connector knows whether it wrote anything before it was cancelled: wait for its answer (it honours the signal; the
      // request's own deadline still bounds the wait). An answer that came anyway means the POST was sent.
      const outcome = await raceAbort(pending.then((response) => { closeBody(response.body); return undefined }, (failure: unknown) => failure), signal)
      throw requestNotSent(outcome) ? Object.assign(budgetError, { notSent: true }) : budgetError
    }
    // The attempt's own budget ran out: say so; the request's own abort is the caller's to report.
    throw budgetRanOut ? budgetError : e
  }
}

const run = async (input: string | URL, options: AnyOptions, allowLan: boolean, signal: AbortSignal, deadline: number): Promise<SafeResponse> => {
  const shownInput = shownUrl(input)
  const limit = positive(options.maxBytes, defaultMaxBytes)
  const maxRedirects = options.maxRedirects === undefined ? defaultMaxRedirects : Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0 ? options.maxRedirects : undefined
  const given = options.method ?? "GET"
  if (limit === undefined || maxRedirects === undefined) throw refuse("options", shownInput, "maxBytes must be a positive number and maxRedirects a whole number from 0")
  // safeFetch is GET and HEAD only, whatever a cast says; a POST, its body and loopback are fetchOwnerConfiguredLan's alone.
  if (!allowLan && given !== "GET" && given !== "HEAD") throw refuse("options", shownInput, "Only GET and HEAD")
  if (allowLan && given !== "GET" && given !== "HEAD" && given !== "POST") throw refuse("options", shownInput, "Only GET, HEAD and POST")
  const method = given as ConnectRequest["method"]
  if (!allowLan && (options.body !== undefined || options.maxRequestBytes !== undefined || options.typedLoopback !== undefined)) {
    throw refuse("options", shownInput, "safeFetch takes no body and no loopback option")
  }
  if (options.typedLoopback !== undefined && typeof options.typedLoopback !== "boolean") throw refuse("options", shownInput, "typedLoopback must be true or false")
  const maxRequestBytes = options.maxRequestBytes === undefined ? defaultMaxRequestBytes : options.maxRequestBytes
  if (typeof maxRequestBytes !== "number" || !Number.isInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > maxMaxRequestBytes) {
    throw refuse("options", shownInput, `maxRequestBytes must be a whole number from 1 to ${maxMaxRequestBytes}`)
  }
  if (!validPolicy(options.accept)) throw refuse("options", shownInput, "A content-type policy with at least one media type is required")
  const resolver = options.resolver ?? nodeResolver
  const connector = options.connector ?? nodeConnector
  const checkedHeaders = checkHeaders(shownInput, options.headers, options.accept)
  if (checkedHeaders instanceof NetRefused) throw checkedHeaders
  let headers = checkedHeaders
  // The body: serialised here, inside the error boundary, and refused before anything is looked up or connected. The helper owns its
  // type and length.
  let body: Uint8Array | undefined
  if (method === "POST") {
    if ("content-type" in headers) throw refuse("header", shownInput, "The Content-Type of a POST is set by the helper (application/json)")
    body = serialiseBody(shownInput, options.body, maxRequestBytes)
    headers = { ...headers, "content-type": "application/json", "content-length": String(body.byteLength) }
  } else if (options.body !== undefined) {
    throw refuse("body", shownInput, `A ${method} has no body`)
  }
  const redirects: Array<string> = []
  let current = checkUrl(input, allowLan)
  if (current instanceof NetRefused) throw current
  // Loopback only for the host the owner typed, on the first hop: never after a redirect, never for a name that resolves to it.
  const typedLoopback = allowLan && options.typedLoopback === true ? typedLoopbackAddresses(current) : undefined
  for (let hop = 0; ; hop++) {
    const url: URL = current
    // Nothing is started for a request that is already cancelled.
    if (signal.aborted) throw signal.reason
    const resolved = hop === 0 && typedLoopback !== undefined ? { url, addresses: typedLoopback } : await resolveHop(url, allowLan, resolver, signal)
    if (resolved instanceof NetRefused || resolved instanceof NetFailure) throw resolved
    // Connect to the addresses we checked, in order: each attempt gets an equal share of the time left, and the next address is tried
    // when an attempt fails or runs out of its share. The last address has no share of its own: it has all the time left, and a timer
    // of its own would race the request's deadline, turning a timeout into a connect failure whenever it fired first.
    let response: ConnectResponse | undefined
    let lastError = "no address"
    for (let k = 0; k < resolved.addresses.length; k++) {
      if (signal.aborted) throw signal.reason
      const left = resolved.addresses.length - k
      const budget = left === 1 ? undefined : Math.max(1, (deadline - Date.now()) / left)
      try {
        response = await attempt(connector, { url, address: resolved.addresses[k]!, method, headers, ...(body === undefined ? {} : { body }) }, signal, budget)
        break
      } catch (e) {
        if (signal.aborted) throw signal.reason
        lastError = e instanceof Error ? e.message : String(e)
        // A POST is sent once: another address only when this one is certain to have received nothing.
        if (method === "POST" && !requestNotSent(e)) {
          throw new NetFailure({ url: url.href, stage: "connect", detail: `${lastError} (the POST may or may not have been carried out; it is not sent again)` })
        }
      }
    }
    if (response === undefined) throw new NetFailure({ url: url.href, stage: "connect", detail: lastError })
    const responseHeaders: Record<string, string> = Object.create(null)
    for (const [k, v] of Object.entries(response.headers)) responseHeaders[k.toLowerCase()] = v
    if (redirectStatuses.has(response.status)) {
      closeBody(response.body)
      // A POST is sent to one server once: a redirect is not followed, with the body or without it.
      if (method === "POST") throw refuse("post-redirect", url.href, `A ${response.status} redirect answer to a POST is not followed`)
      const location = responseHeaders["location"]
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
        const kept: Record<string, string> = Object.create(null)
        for (const k of Object.keys(headers)) if (crossOriginHeaders.has(k)) kept[k] = headers[k]!
        headers = kept
      } else {
        // A validator is about the URL it was sent to; the next hop is another resource (review round 3, finding 1).
        const kept: Record<string, string> = Object.create(null)
        for (const k of Object.keys(headers)) if (!conditionalHeaders.has(k)) kept[k] = headers[k]!
        headers = kept
      }
      redirects.push(checked.href)
      current = checked
      continue
    }
    const typeLines = response.contentTypeLines ?? (responseHeaders["content-type"] === undefined ? [] : [responseHeaders["content-type"]])
    const parsedType = parseContentType(typeLines)
    const contentType = "refused" in parsedType ? "" : parsedType.type
    const finish = (body: Uint8Array, encoding: Encoding, decoded: boolean): SafeResponse => {
      const shownHeaders: Record<string, string> = Object.create(null)
      for (const [k, v] of Object.entries(responseHeaders)) if (!(decoded && (k === "content-encoding" || k === "content-length"))) shownHeaders[k] = v
      const decoder = decoderFor(parsedType)
      return { url: url.href, status: response!.status, headers: shownHeaders, body, encoding, contentType, redirects, text: () => decoder.decode(body) }
    }
    // HEAD, 204 and 304 have no body: nothing to limit or to type-check.
    if (method === "HEAD" || response.status === 204 || response.status === 304) {
      closeBody(response.body)
      return finish(new Uint8Array(0), "identity", false)
    }
    const typeOk = !("refused" in parsedType) && acceptsType(options.accept, contentType)
    if (!typeOk) {
      closeBody(response.body)
      // An error page of another type is not read; the status still reaches the caller.
      if (response.status < 200 || response.status > 299) return finish(new Uint8Array(0), "identity", false)
      throw refuse("content-type", url.href, "refused" in parsedType ? `The response has ${parsedType.refused === "no content type" ? "no content type" : `a Content-Type that is not read (${parsedType.refused})`}; a ${options.accept.name} was expected` : `The response is ${contentType}, not a ${options.accept.name}`)
    }
    const encoding = encodingOf(responseHeaders["content-encoding"])
    if (encoding === undefined) {
      closeBody(response.body)
      throw refuse("content-encoding", url.href, `The response is encoded as "${responseHeaders["content-encoding"]}"`)
    }
    const declared = Number(responseHeaders["content-length"])
    if (Number.isFinite(declared) && declared > limit) {
      closeBody(response.body)
      throw new NetTooLarge({ url: url.href, limit })
    }
    const bytes = await readBody(encoding, response.body, limit, url.href, signal)
    return finish(bytes, encoding, encoding !== "identity")
  }
}

/**
 * Fetch a URL a model or a user chose. Resolves the host itself and refuses private, loopback, link-local,
 * unique-local and other non-public addresses (IPv4, IPv6, IPv4-mapped); connects to the address it checked; checks
 * every redirect again; http and https only; no credentials; ports 80 and 443; only the response types `options.accept` lists;
 * size (after decompression) and total time limits; honours `options.signal` and Effect interruption. Errors say which rule refused
 * (`NetRefused.rule`).
 */
const fetchChecked = (url: string | URL, options: AnyOptions, allowLan: boolean): Effect.Effect<SafeResponse, SafeFetchError> =>
  Effect.tryPromise({
    try: (effectSignal) => {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
      const shown = shownUrl(url)
      if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return Promise.reject(refuse("options", shown, "timeoutMs must be a positive number"))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new NetTimeout({ url: shown, timeoutMs })), timeoutMs)
      const abort = () => controller.abort(new NetAborted({ url: shown }))
      const outside = [effectSignal, options.signal].filter((s): s is AbortSignal => s !== undefined)
      for (const s of outside) {
        if (s.aborted) abort()
        else s.addEventListener("abort", abort, { once: true })
      }
      return run(url, options, allowLan, controller.signal, Date.now() + timeoutMs).finally(() => {
        clearTimeout(timer)
        for (const s of outside) s.removeEventListener("abort", abort)
        // Stop whatever connection is still open.
        if (!controller.signal.aborted) controller.abort(new NetAborted({ url: shown }))
      })
    },
    catch: (e): SafeFetchError =>
      e instanceof NetRefused || e instanceof NetTooLarge || e instanceof NetTimeout || e instanceof NetAborted || e instanceof NetFailure
        ? e
        : new NetFailure({ url: shownUrl(url), stage: "response", detail: e instanceof Error ? e.message : String(e) })
  })

export const safeFetch = (url: string | URL, options: SafeFetchOptions): Effect.Effect<SafeResponse, SafeFetchError> =>
  fetchChecked(url, options, false)

/**
 * Fetch an endpoint **the owner configured** on the home network (Home Assistant, a Grocy, a SearXNG on the LAN): like `safeFetch`, but
 * private (RFC 1918), unique-local and CGNAT addresses, local names (`.local`, `.lan`, single labels) and any port are allowed. Loopback,
 * link-local (cloud metadata), multicast and the other classes stay refused, and so do other schemes and credentials in the URL.
 * Never call this with a URL a model or a page produced; use `safeFetch`.
 *
 * **POST** (`method: "POST", body: { json }`): the helper serialises `json` (a value `JSON.stringify` cannot turn into text is
 * `NetRefused(body)`), refuses a body over `maxRequestBytes` (64 KiB; at most 1 MiB) before anything is connected, and sets
 * `Content-Type: application/json` and the length itself (a caller's `Content-Type` or `Content-Length` is `NetRefused(header)`).
 * A POST is **sent once, to one server**: a redirect answer is `NetRefused(post-redirect)` and is not followed; it is never retried,
 * and it goes on to the host's next address only when the connector is certain no byte of it was written (a refused or timed-out
 * connect, `requestNotSent`). **A POST that failed may or may not have been carried out** by the server: a lost connection, a
 * timeout or an interruption after the request was written says nothing about whether it took effect. Every other rule (addresses
 * on every hop, headers, the accepted response types, `maxBytes`, the one total `timeoutMs`, `signal` and interruption) applies
 * to a POST and its answer as to a GET.
 *
 * **Loopback** only with `typedLoopback: true`, and only when the host written in the URL is a loopback literal (`127.0.0.0/8`,
 * `[::1]`) or exactly `localhost` (connected as `127.0.0.1`, then `::1`, without a lookup). A name that resolves to loopback and a
 * redirect to loopback stay refused, with the option or without it.
 */
export const fetchOwnerConfiguredLan = (url: string | URL, options: OwnerConfiguredLanOptions): Effect.Effect<SafeResponse, SafeFetchError> =>
  fetchChecked(url, options, true)
