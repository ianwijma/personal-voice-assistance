// Text from the web as one short plain line, and hosts in one canonical form. Pure and free of dependencies: the page task
// (`page.task.ts`, run in a worker thread) imports this file too, so it must not pull in `@pva/net`, `@pva/core` or Effect.

const TAG = /<[^>]*>/g
const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
// Control characters, lone surrogates, line and paragraph separators and bidirectional controls: never kept.
const UNWANTED_SOURCE = "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ud800-\\udfff]"
const UNWANTED = new RegExp(UNWANTED_SOURCE, "gu")
/** Whether a string holds a character `cleanText` would remove. */
export const HAS_UNWANTED = new RegExp(UNWANTED_SOURCE, "u")

const decodeEntities = (s: string): string =>
  s.replace(ENTITY, (_, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1]!.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isInteger(code) && code > 31 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " "
    }
    return NAMED[e.toLowerCase()] ?? " "
  })

/** Text from the web as one short plain line: markup and control characters gone, spaces collapsed, cut at `max`. */
export const cleanText = (value: unknown, max: number): string => {
  if (typeof value !== "string") return ""
  // Bounded before the work: nothing here costs more than a few thousand characters.
  const bounded = value.slice(0, max * 6 + 200)
  const plain = decodeEntities(bounded.replace(TAG, " ")).replace(UNWANTED, " ").replace(/\s+/g, " ").trim()
  return plain.length <= max ? plain : `${plain.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

// ---------------------------------------------------------------------------------------------------------------------
// Hosts

/**
 * A host in the one form every comparison uses (block entries, page requests and every redirect hop, search results): what the
 * URL parser gives (lower case, IDNA as punycode, an IPv4 address in its dotted form), without the terminal DNS dot. `www.` is
 * kept: `www.example.com` is a subdomain of `example.com`, so a block entry covers it anyway.
 */
export const canonicalHost = (hostname: string): string => hostname.toLowerCase().replace(/\.+$/, "")

/** The canonical host of an http(s) address; `undefined` for anything else. */
export const hostOf = (url: string | URL): string | undefined => {
  try {
    const u = typeof url === "string" ? new URL(url) : url
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
    const host = canonicalHost(u.hostname)
    return host === "" ? undefined : host
  } catch {
    return undefined
  }
}

/** The site of an address as it is shown and said: its canonical host without `www.`. */
export const siteOf = (url: string | URL): string | undefined => hostOf(url)?.replace(/^www\./, "")

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/**
 * A block entry as the owner typed it ("Example.COM", "www.example.com.", "bücher.example") in canonical form, without `www.`;
 * `undefined` when it is not a host name (a path, a port, an address with a scheme, spaces, a single label): that is a settings
 * error, refused when the owner saves it.
 */
export const blockEntry = (entry: string): string | undefined => {
  const t = entry.trim()
  if (t === "" || /[/\\?#@:\s%]/.test(t)) return undefined
  let host: string
  try {
    host = canonicalHost(new URL(`http://${t}/`).hostname)
  } catch {
    return undefined
  }
  return DOMAIN.test(host) ? host.replace(/^www\./, "") : undefined
}

/** Whether canonical `host` is the canonical `domain` or a subdomain of it. */
export const inDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/** Whether canonical `host` is on the block list (entries already canonical). */
export const isBlocked = (host: string, blocked: ReadonlyArray<string>): boolean => blocked.some((d) => inDomain(host, d))
