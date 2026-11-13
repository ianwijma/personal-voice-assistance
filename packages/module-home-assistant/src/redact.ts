/**
 * Keeping configured credentials out of error text and logs.
 *
 * IDENTICAL COPIES of this file live in the six adapters that hold a credential
 * (`llm-openai-compatible`, `llm-anthropic`, `decide-typesafe`,
 * `module-home-assistant`, `stt-deepgram`, `tts-cartesia`, each as
 * `src/redact.ts`); sharing it would mean a new export of `@pva/core`. A test in
 * `llm-openai-compatible` (`redact.test.ts`) fails when the copies differ.
 *
 * The rule in every adapter: each error it returns or logs is built through
 * `sanitize` (usually via a small constructor that already holds the
 * credentials), so a new error path cannot forget it. `sanitize` redacts every
 * string field and replaces the cause by a plain `Error` carrying a redacted
 * copy of its message: raw upstream or SDK error objects (response bodies,
 * headers, request options with the key) are never attached. Upstream text that
 * is shown as a value (a `Retry-After`, a request id) is validated into a safe
 * form (`safeSeconds`, `safeId`) rather than displayed as received.
 *
 * Upstream text may echo a credential as received (`Invalid API key: <key>`),
 * URL-encoded (a gateway logging the query string), JSON-escaped, or base64
 * (a `Basic` header echoed back). `redact` masks each configured credential in
 * all of those forms, at any length, before anything is shortened (half a key
 * is still a leak).
 *
 * The edges (third review, 2026-11-14):
 * - **Text from outside enters through `fromUpstream` only** (a response body,
 *   a header, a WebSocket close reason, a thrown error's message): redacted as
 *   a whole before anything may trim, parse or shorten it. `clip` goes through
 *   it too, so shortening for display is always redact-then-shorten.
 * - **Credentials in a configured address**: `checkAddress` refuses user-info
 *   (and, where the adapter does not need it, a query) without echoing the
 *   value, and gives the credential-free `display` form, the only form any
 *   message may contain. `secretList` turns every secret-typed setting and every
 *   user-info or query value of a configured address (`addressSecrets`, also
 *   for an address too malformed to parse) into the redaction list.
 * - **Nothing raw escapes**: `safeCause` keeps only a redacted message and a
 *   plain, redacted name; `sanitize` redacts nested strings too.
 * - **A value that is not text becomes log text through `logText` only**
 *   (fourth review, 2026-11-14): `inspect` cuts every string at 10 000
 *   characters, so inspecting first and redacting after left a credential that
 *   straddled the cut as an unrecognisable prefix. `logText` redacts every
 *   string leaf whole first (nested objects, arrays, errors and their causes),
 *   then inspects with no string limit, then redacts the whole line again.
 * - **Never quote a runtime's own error message about upstream text**: V8's
 *   `JSON.parse` error quotes the first 10 characters of its input
 *   (`Unexpected token 'K', "KEYQQQQQQQ"... is not valid JSON`), already cut,
 *   so no later redaction can recognise a credential in it. Parse failures are
 *   described in fixed words, and a catch-all keeps only the error's name.
 * - **Only diagnostics are redacted, never content**: a model's reply, tool
 *   arguments, a transcript, a model list, entity names pass through untouched
 *   (generic token patterns would rewrite a room called "Basic Bedroom"); errors,
 *   logs, status lines and info fields shown in the settings are redacted.
 */
import { inspect } from "node:util"

export const MASK = "[redacted]"

export type Secrets = ReadonlyArray<string | undefined>

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One hex digit, either case. */
const hexDigit = (d: string): string => (/[a-f]/i.test(d) ? `[${d.toUpperCase()}${d.toLowerCase()}]` : d)
const hex = (n: number, width: number): string => Array.from(n.toString(16).padStart(width, "0"), hexDigit).join("")

const encoder = new TextEncoder()

/**
 * `ch` as received, percent-encoded (any case, also double-encoded, `+` for a
 * space) or JSON-escaped (also JSON inside JSON: any number of backslashes).
 */
const charPattern = (ch: string): string => {
  const bytes = Array.from(encoder.encode(ch))
  const alternatives = [
    escapeRegExp(ch),
    bytes.map((b) => `%${hex(b, 2)}`).join(""),
    bytes.map((b) => `%25${hex(b, 2)}`).join(""),
    Array.from({ length: ch.length }, (_, i) => `\\\\+u${hex(ch.charCodeAt(i), 4)}`).join("")
  ]
  if (ch === "\"" || ch === "/" || ch === "\\") alternatives.push(`\\\\+${escapeRegExp(ch)}`)
  if (ch === " ") alternatives.push("\\+")
  return `(?:${alternatives.join("|")})`
}

/**
 * Base64 (standard and URL alphabets) of the secret wherever it sits inside a
 * longer encoded value: the secret starts at byte offset 0, 1 or 2 of a 3-byte
 * group, so three encodings, each without the leading characters that also
 * depend on the bytes before it and the trailing one that depends on the bytes
 * after it.
 */
const base64Forms = (secret: string): ReadonlyArray<string> => {
  const bytes = encoder.encode(secret)
  const forms = new Set<string>()
  const whole = Buffer.from(bytes).toString("base64")
  forms.add(whole)
  for (let offset = 0; offset < 3; offset++) {
    const padded = new Uint8Array(offset + bytes.length)
    padded.set(bytes, offset)
    let text = Buffer.from(padded).toString("base64").replace(/=+$/, "")
    if (padded.length % 3 !== 0) text = text.slice(0, -1)
    text = text.slice(Math.ceil((offset * 4) / 3))
    // Fragments this short match ordinary text by chance; the whole encoding above still covers a short secret.
    if (text.length >= 4) forms.add(text)
  }
  for (const form of [...forms]) forms.add(form.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))
  return [...forms].filter((f) => f.length > 0).sort((a, b) => b.length - a.length)
}

/**
 * Below this length a credential is a placeholder ("x", "no"): it is still
 * masked, in every form, but only where it stands alone, so it cannot eat the
 * letters of ordinary words and leave the message unreadable.
 */
const SHORT = 4

const patterns = new Map<string, RegExp>()

const patternFor = (secret: string): RegExp => {
  let pattern = patterns.get(secret)
  if (pattern === undefined) {
    const literal = Array.from(secret, charPattern).join("")
    const body = [literal, ...base64Forms(secret).map(escapeRegExp)].join("|")
    pattern = secret.length < SHORT
      ? new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`, "g")
      : new RegExp(body, "g")
    if (patterns.size > 64) patterns.clear()
    patterns.set(secret, pattern)
  }
  pattern.lastIndex = 0
  return pattern
}

/** Mask every configured credential (in every supported form), then anything shaped like a token or key. */
export const redact = (text: string, secrets: Secrets): string => {
  let out = text
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) out = out.replace(patternFor(secret), MASK)
  }
  return out
    .replace(/\b(Bearer|Token|Basic)(\s+|%20|\+)[A-Za-z0-9._~+/=%-]{6,}/gi, `$1$2${MASK}`)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, MASK)
    .replace(/([?&](?:api[_-]?key|key|token|access_token|auth)=)[^&\s"'<>]+/gi, `$1${MASK}`)
}

/** The longest text one credential can become in a supported form (percent-encoded twice: up to 15 characters per character). */
const longestForm = (secret: string): number => secret.length * 15 + 16

/** Above this many characters, upstream text is cut before it is redacted (bounded work on a huge body). */
export const UPSTREAM_WINDOW = 65_536

/**
 * THE way text from outside enters an adapter: a response body, a header, a
 * WebSocket close reason, the message of a thrown error. Redacted as a whole
 * before anything may trim, parse or shorten it. Text longer than `window` is
 * cut first, and after redaction as much of the end as one credential could
 * fill in any form is dropped too, so a credential cut by the window cannot
 * survive as an unrecognisable prefix.
 */
export const fromUpstream = (raw: unknown, secrets: Secrets, window: number = UPSTREAM_WINDOW): string => {
  const text = typeof raw === "string" ? raw : messageOf(raw)
  if (text.length <= window) return redact(text, secrets)
  let margin = 64
  for (const secret of secrets) if (secret !== undefined) margin = Math.max(margin, longestForm(secret))
  const safe = redact(text.slice(0, window), secrets)
  return `${safe.slice(0, Math.max(0, safe.length - margin))}…`
}

/** Redact (the whole text, through `fromUpstream`), then shorten to `max` characters (in that order). */
export const clip = (text: string, secrets: Secrets, max: number): string => {
  const safe = fromUpstream(text, secrets)
  return safe.length > max ? `${safe.slice(0, max)}…` : safe
}

/**
 * The redaction list: each value as given and trimmed (a credential pasted with
 * a space must still be recognised after a peer or parser trimmed it), empty
 * values left out.
 */
export const secretList = (...values: ReadonlyArray<string | undefined | ReadonlyArray<string | undefined>>): Array<string> => {
  const out = new Set<string>()
  for (const value of values.flat()) {
    if (value === undefined) continue
    for (const v of [value, value.trim()]) if (v.length > 0) out.add(v)
  }
  return [...out]
}

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "))
  } catch {
    return s
  }
}

/**
 * Every credential-bearing part of a configured address, as written and
 * decoded: the user name, the password and each query value. Also for an
 * address too malformed to parse (read with a pattern instead), so its parts
 * are still masked in whatever error mentions it.
 */
export const addressSecrets = (address: string | undefined): Array<string> => {
  if (address === undefined || address.trim() === "") return []
  const parts: Array<string> = []
  const userInfo = /^[^:/?#\s]*:\/\/([^/?#@]*)@/.exec(address.trim())?.[1]
  if (userInfo !== undefined) parts.push(userInfo, ...userInfo.split(":"))
  const query = /\?([^#]*)/.exec(address)?.[1]
  if (query !== undefined) for (const pair of query.split("&")) parts.push(pair.slice(pair.indexOf("=") + 1))
  try {
    const url = new URL(address.trim())
    parts.push(url.username, url.password)
    for (const value of url.searchParams.values()) parts.push(value)
  } catch {
    // malformed: the pattern above found what there is
  }
  return secretList(parts.flatMap((p) => [p, decoded(p)]))
}

export interface AddressRules {
  /** Allowed schemes, with the colon: `["http:", "https:"]`. */
  readonly protocols: ReadonlyArray<string>
  /** The service takes parameters in the address (their values are treated as secrets and never displayed). */
  readonly query: boolean
}

export type CheckedAddress =
  | { readonly ok: true; readonly url: URL; readonly display: string }
  | { readonly ok: false; readonly problem: string }

/**
 * A configured address, checked: the parsed URL and its credential-free
 * `display` form (scheme, host, port and path), or why it is refused, in words
 * that never repeat the value.
 */
export const checkAddress = (address: string, rules: AddressRules): CheckedAddress => {
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    return { ok: false, problem: "is not a valid address" }
  }
  if (!rules.protocols.includes(url.protocol)) {
    return { ok: false, problem: `must start with ${rules.protocols.map((p) => `${p}//`).join(" or ")}` }
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, problem: "must not contain a user name or password (put the key in its own setting)" }
  }
  if (!rules.query && (url.search !== "" || url.hash !== "")) {
    return { ok: false, problem: "must not contain a query (?…) or a fragment (#…)" }
  }
  if (url.hash !== "") return { ok: false, problem: "must not contain a fragment (#…)" }
  return { ok: true, url, display: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}` }
}

/**
 * What a `SyntaxError` becomes instead of its message: V8's `JSON.parse` error quotes the first 10
 * characters of the input it refused, already cut, so a credential at its start would survive any
 * redaction as a prefix. The text it refers to is never needed: callers say what was not JSON.
 */
export const SYNTAX_ERROR_TEXT = "SyntaxError: input that is not valid JSON (the runtime's message, which quotes the input already cut short, is not kept)"

const messageOf = (u: unknown): string => {
  if (u instanceof SyntaxError) return SYNTAX_ERROR_TEXT
  if (u instanceof Error) return u.message
  if (typeof u === "string") return u
  try {
    return JSON.stringify(u) ?? String(u)
  } catch {
    return String(u)
  }
}

/** An error's name when it is a plain identifier (`TypeError`), else "error": for catch-alls that must not quote a message. */
export const errorName = (e: unknown): string => {
  const name = e instanceof Error ? e.name : undefined
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "error"
}

/**
 * A cause safe to attach: a plain `Error` with the redacted message (and, for
 * an `Error`, its name when that is a plain identifier). Nothing else of the
 * original survives: no nested cause, no response, no request options.
 */
export const safeCause = (cause: unknown, secrets: Secrets): Error => {
  const error = new Error(fromUpstream(messageOf(cause), secrets))
  const name = cause instanceof Error ? cause.name : undefined
  // A name is kept only when it is a plain identifier that redaction leaves alone (a name can be a credential too).
  if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && redact(name, secrets) === name) error.name = name
  return error
}

/** Strings redacted at any depth of plain objects and arrays; errors replaced by `safeCause`. */
const scrub = (value: unknown, secrets: Secrets, depth = 0): unknown => {
  if (typeof value === "string") return redact(value, secrets)
  if (value instanceof Error) return safeCause(value, secrets)
  if (depth > 8 || typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, depth + 1))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return redact(messageOf(value), secrets)
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets, depth + 1)]))
}

/**
 * The fields of an error, made safe: every string field redacted (also inside
 * plain objects and arrays), `cause` replaced by `safeCause` (or dropped when
 * absent). Every error an adapter returns or logs is built from fields that
 * went through here.
 */
export const sanitize = <F extends { readonly message: string; readonly cause?: unknown }>(secrets: Secrets, fields: F): F => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === "cause") {
      if (value !== undefined) out[key] = safeCause(value, secrets)
    } else out[key] = scrub(value, secrets)
  }
  return out as F
}

/** Containers deeper than this, and arrays beyond this many items, are summarised in log text (never a part of a string). */
const LOG_DEPTH = 6
const LOG_ITEMS = 100

/** `value` as plain data whose every string is already redacted whole: what `logText` inspects. */
const forLog = (value: unknown, secrets: Secrets, depth: number, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") return redact(value, secrets)
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value
  if (typeof value !== "object") return `[${typeof value}]` // a function or symbol: its source or description is not log text
  if (seen.has(value)) return "[circular]"
  if (depth >= LOG_DEPTH) return "[…]"
  seen.add(value)
  const next = (v: unknown) => forLog(v, secrets, depth + 1, seen)
  if (Array.isArray(value)) {
    const items = value.slice(0, LOG_ITEMS).map(next)
    return value.length > LOG_ITEMS ? [...items, `[${value.length - LOG_ITEMS} more]`] : items
  }
  const out: Record<string, unknown> = {}
  if (value instanceof Error) {
    out.name = next(value.name)
    out.message = value instanceof SyntaxError ? SYNTAX_ERROR_TEXT : next(value.message)
    if (value.cause !== undefined) out.cause = next(value.cause)
  }
  let entries: Array<[string, unknown]>
  try {
    entries = typeof (value as { entries?: unknown }).entries === "function" && (value instanceof Map || (typeof Headers === "function" && value instanceof Headers))
      ? [...(value as Map<unknown, unknown>).entries()].map(([k, v]) => [String(k), v])
      : Object.entries(value)
  } catch {
    entries = []
  }
  if (entries.length === 0 && !(value instanceof Error) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return redact(messageOf(value), secrets) // a class instance with nothing enumerable (a URL): its whole text, redacted
  }
  for (const [k, v] of entries.slice(0, LOG_ITEMS)) out[redact(k, secrets)] = next(v)
  return out
}

/**
 * THE way values that are not text become a log line (an SDK logger's arguments, structured details):
 * every string leaf redacted whole first, then inspected with no string limit, then the whole line
 * redacted again through `fromUpstream` (which bounds its length after redaction). Strings among `parts`
 * are kept as they are and redacted with the line.
 */
export const logText = (parts: ReadonlyArray<unknown>, secrets: Secrets): string =>
  fromUpstream(
    parts.map((p) =>
      typeof p === "string"
        ? p
        : inspect(forLog(p, secrets, 0, new WeakSet()), { depth: Infinity, maxStringLength: Infinity, maxArrayLength: Infinity, breakLength: Infinity })
    ).join(" "),
    secrets
  )

/** An upstream identifier (request id), only when it is short, plain and not a credential; otherwise undefined. */
export const safeId = (value: string | null | undefined, secrets: Secrets): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return undefined
  return redact(value, secrets) === value ? value : undefined
}

/** `Retry-After` as whole seconds (delta-seconds or an HTTP date, at most a day); anything else is undefined. */
export const safeSeconds = (value: string | null | undefined, now: number = Date.now()): number | undefined => {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (/^\d{1,6}$/.test(text)) {
    const seconds = Number(text)
    return seconds <= 86_400 ? seconds : undefined
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined
  const at = Date.parse(text)
  if (Number.isNaN(at)) return undefined
  const seconds = Math.max(0, Math.round((at - now) / 1000))
  return seconds <= 86_400 ? seconds : undefined
}
