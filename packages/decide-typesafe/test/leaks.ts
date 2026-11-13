/**
 * Helpers for the credential-leak tests. IDENTICAL COPIES live in the test
 * folder of each adapter that holds a credential (next to `src/redact.ts`).
 */
import { Layer, Logger, References } from "effect"
import { inspect } from "node:util"

/**
 * A logger layer for the leak tests: every log line at every level (debug and trace included, which
 * the default minimum level hides), captured in full. The capture must not cut text itself:
 * `inspect`'s default 10 000-character string limit would hide a leak past it (fourth review).
 */
export const captureLogs = (logs: Array<string>) =>
  Layer.mergeAll(
    Logger.layer([
      Logger.make(({ logLevel, message }) =>
        logs.push(`${logLevel} ${inspect(message, { depth: 10, maxStringLength: Infinity, maxArrayLength: Infinity, breakLength: Infinity })}`)
      )
    ]),
    Layer.succeed(References.MinimumLogLevel, "All")
  )

/**
 * A long credential whose punctuation changes under URL, JSON and base64
 * encoding, and a short one (a placeholder-length key must still be masked).
 */
export const KEYS = ["Zq9+/x=K_p.~-7%Ab\"c:Ys0e", "p4ss"] as const

export const b64 = (s: string): string => Buffer.from(s).toString("base64")

/**
 * The base64 characters that depend only on `key` when it starts `offset` bytes
 * into a longer encoded value (`Basic base64("user:" + key)` puts it at offset
 * 2): the characters before mix in the bytes ahead of it, the one after mixes in
 * the bytes behind. Computed here independently of `src/redact.ts`.
 */
export const alignedB64 = (key: string, offset: number): string => {
  const bytes = Buffer.from(key)
  const text = Buffer.concat([Buffer.alloc(offset, 0x40), bytes]).toString("base64")
  return text.slice(Math.ceil((offset * 4) / 3), Math.floor(((offset + bytes.length) * 4) / 3))
}

const urlSafe = (s: string): string => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Every character as a JSON `\u` escape (what an encoder that escapes everything writes). */
export const unicodeEscaped = (key: string): string => Array.from(key, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")

/**
 * Every form a leak could take in error text: as is, URL-encoded, JSON-escaped,
 * base64 (both alphabets, padded or not, and at each of the three alignments
 * inside a longer value).
 */
export const forms = (key: string): ReadonlyArray<string> => {
  const std = b64(key)
  const aligned = [0, 1, 2].map((o) => alignedB64(key, o)).filter((f) => f.length >= 6)
  return [
    ...new Set([
      key,
      encodeURIComponent(key),
      JSON.stringify(key).slice(1, -1),
      std,
      std.replace(/=+$/, ""),
      urlSafe(std),
      unicodeEscaped(key),
      ...aligned,
      ...aligned.map(urlSafe)
    ])
  ]
}

/** The credential in every form, as an upstream would echo it into one field. */
export const planted = (key: string): string =>
  `${key} | ${encodeURIComponent(key)} | ${b64(key)} | Basic ${b64(`user:${key}`)} | ${b64(`x${key}`)} | ${urlSafe(b64(key))} | ${
    unicodeEscaped(key)
  } | ?api_key=${encodeURIComponent(key)} | ${JSON.stringify(key).slice(1, -1)}`

const replacer = () => {
  const seen = new WeakSet<object>()
  return (_k: string, v: unknown) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[circular]"
      seen.add(v)
    }
    if (v instanceof Error) return { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause }
    return v
  }
}

/** An error (or anything) as text: inspected, JSON, and its whole cause chain with stacks. */
export const serialise = (u: unknown): string => {
  const parts = [inspect(u, { depth: 20, showHidden: true })]
  try {
    parts.push(JSON.stringify(u, replacer()) ?? "")
  } catch {
    // circular beyond the replacer: the inspected form is still there
  }
  let c: unknown = u
  for (let i = 0; i < 10 && c !== undefined && c !== null; i++) {
    parts.push(String(c))
    if (c instanceof Error) parts.push(c.stack ?? "")
    c = typeof c === "object" ? (c as { cause?: unknown }).cause : undefined
  }
  return parts.join("\n")
}

/**
 * Which forms of `key` appear in `text` (empty: no leak). For a long key, any
 * half of it counts too: text shortened before it was redacted leaks a prefix.
 */
export const leaksOf = (key: string, text: string): ReadonlyArray<string> => {
  const found = forms(key).filter((f) => text.includes(f))
  if (key.length >= 16) {
    const half = Math.ceil(key.length / 2)
    for (let i = 0; i + half <= key.length; i++) if (text.includes(key.slice(i, i + half))) found.push(`part: ${key.slice(i, i + half)}`)
  }
  return found
}

/**
 * `text` with the credential placed so that a cut at any of the next `span`
 * characters falls inside it; `fill` is what comes before it (spaces: a trim
 * after the cut would move the retained prefix to the front).
 */
export const straddling = (key: string, before: number, span = key.length, fill = "y"): ReadonlyArray<string> =>
  Array.from({ length: span + 1 }, (_, i) => `${fill.repeat(Math.max(0, before - i))}${key}`)

/** A configured address that carries credentials of its own, distinct from the API key. */
export const ADDRESS_SECRETS = { user: "alice", password: "urlPassword987", query: "querySecret654" } as const

/**
 * A thrown value carrying `key` everywhere an error can: its message, its
 * `name`, an enumerable property and its `cause`.
 */
export const loadedError = (key: string): Error => {
  const error = new Error(`boom ${key}`, { cause: new Error(`inner ${key}`) })
  error.name = key.replace(/[^A-Za-z0-9_]/g, "") || "x"
  if (!/^[A-Za-z]/.test(error.name)) error.name = `E${error.name}`
  Object.assign(error, { request: { headers: { authorization: `Bearer ${key}` } }, input: `http://u:${key}@h` })
  return error
}

/**
 * Every truncation and inspection limit found in the adapters (fourth review, finding 1), with the
 * credential straddling it: each case is the text a limit produces from a value carrying `key`. The
 * adapter's leak test asserts none of them holds any part of the key. Run by every adapter against
 * its own copy of `src/redact.ts`.
 *
 * - `logText`: `inspect`'s 10 000-character string limit (switched off; strings redacted first), its
 *   array and depth limits, and the `fromUpstream` window (65 536) the whole line goes through.
 * - `fromUpstream` / `clip`: the window, and each display length the adapters clip to.
 * - V8's `JSON.parse` error, which quotes the input's first 10 characters already cut: through
 *   `safeCause`, `sanitize`, `fromUpstream` and `logText`.
 */
export const limitCases = async (key: string): Promise<ReadonlyArray<readonly [string, string]>> => {
  const { clip, fromUpstream, logText, safeCause, sanitize, UPSTREAM_WINDOW } = await import("../src/redact.ts")
  const secrets = [key]
  const out: Array<readonly [string, string]> = []
  const around = (limit: number) => Array.from({ length: key.length + 3 }, (_, i) => Math.max(0, limit - key.length - 1 + i))
  for (const at of around(10_000)) {
    const s = `${"f".repeat(at)}${key}`
    out.push([`logText string leaf at ${at}`, logText(["details", { body: { error: { message: s } }, list: [s], error: Object.assign(new Error(s), { body: s, cause: new Error(s) }) }], secrets)])
  }
  for (const at of around(UPSTREAM_WINDOW)) {
    const s = `${"w".repeat(at)}${key}`
    out.push([`fromUpstream window at ${at}`, fromUpstream(s, secrets)])
    out.push([`logText line window at ${at}`, logText(["x", { s }], secrets)])
  }
  out.push(["logText array limit", logText([Array.from({ length: 150 }, (_, i) => (i === 120 ? key : "a"))], secrets)])
  out.push(["logText depth limit", logText([{ a: { b: { c: { d: { e: { f: { g: key } } } } } } }], secrets)])
  for (const max of [40, 64, 119, 120, 200, 300, 400, 500]) {
    for (const at of around(max)) out.push([`clip ${max} at ${at}`, clip(`${"c".repeat(at)}${key}`, secrets, max)])
  }
  for (const input of [key, `${key}x`, `<${key}`, `"${key}`]) {
    let error: unknown
    try {
      JSON.parse(input)
    } catch (e) {
      error = e
    }
    out.push([`JSON.parse error of ${JSON.stringify(input.slice(0, 2))}…`, [
      safeCause(error, secrets).message,
      String(safeCause(error, secrets)),
      safeCause(error, secrets).stack ?? "",
      fromUpstream(error, secrets),
      sanitize(secrets, { message: "m", cause: error }).cause?.toString() ?? "",
      logText(["parse failed", error], secrets)
    ].join("\n")])
  }
  return out
}

/** Every part of `key` of `n` characters found in `text` (a prefix cut short is a leak too). */
export const partsOf = (key: string, text: string, n = 8): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (let i = 0; i + n <= key.length; i++) if (text.includes(key.slice(i, i + n))) found.push(key.slice(i, i + n))
  return found
}
