import { type Connector, contentTypes, type Resolver, safeFetch, type SafeFetchError, type SafeResponse } from "@pva/net"
import { Data, Effect } from "effect"
import { cleanLine, cleanText, cutAt } from "./clean.ts"

/** What a module that fetches takes from its tests: the resolver and connector (absent: the real ones). */
export interface NetDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

/** The most one API answer may be: parsed on the main thread, so bounded (the latency test states what it costs). */
export const API_MAX_BYTES = 96 * 1024
/** The most candidates one search reads, and the most a question names. */
export const MAX_CANDIDATES = 6
export const MAX_ASKED = 3
/** The picture's width asked of Commons; the image itself is fetched by the server's media route, never by the module. */
export const THUMB_WIDTH = 800

export type LookupFailure = "timeout" | "unreachable" | "rate-limited" | "invalid" | "failed"
/** Why a read failed, in the module's terms; `detail` is for the log and holds no outside text beyond a status. */
export class LookupError extends Data.TaggedError("LookupError")<{ readonly reason: LookupFailure; readonly detail: string }> {}

const failureOf = (e: SafeFetchError): LookupError => {
  switch (e._tag) {
    case "NetTimeout": return new LookupError({ reason: "timeout", detail: "timed out" })
    case "NetTooLarge": return new LookupError({ reason: "invalid", detail: "the answer was too large" })
    case "NetRefused": return new LookupError({ reason: e.rule === "content-type" ? "invalid" : "failed", detail: `refused (${e.rule})` })
    case "NetAborted": return new LookupError({ reason: "failed", detail: "aborted" })
    case "NetFailure": return new LookupError({ reason: "unreachable", detail: "could not connect" })
  }
}

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined

/** The first `limit` items of an array (anything else is no items): what comes from outside is never walked whole. */
const itemsOf = (value: unknown, limit: number): ReadonlyArray<unknown> => (Array.isArray(value) ? value.slice(0, limit) : [])

const apiUrl = (host: string, params: Readonly<Record<string, string>>): string => {
  const url = new URL(`https://${host}/w/api.php`)
  for (const [k, v] of Object.entries({ action: "query", format: "json", formatversion: "2", ...params })) url.searchParams.set(k, v)
  return url.href
}

/** One API read: `safeFetch` (JSON only, size and time limit, redirects checked), the status checked, the body parsed. */
const getJson = (deps: NetDeps, url: string, agent: string, timeoutMs: number): Effect.Effect<Readonly<Record<string, unknown>>, LookupError> =>
  safeFetch(url, { accept: contentTypes.json, maxBytes: API_MAX_BYTES, timeoutMs, headers: { "user-agent": agent }, ...deps }).pipe(
    Effect.mapError(failureOf),
    Effect.flatMap((response: SafeResponse) => {
      if (response.status === 429) return Effect.fail(new LookupError({ reason: "rate-limited", detail: "status 429" }))
      if (response.status !== 200) return Effect.fail(new LookupError({ reason: "failed", detail: `status ${response.status}` }))
      return Effect.try({
        try: () => objectOf(JSON.parse(response.text())),
        catch: () => new LookupError({ reason: "invalid", detail: "the answer is not JSON" })
      })
    }),
    Effect.flatMap((json) => {
      // The API reports its own errors (a bad parameter, a throttle) with status 200 and an `error` member.
      if (json === undefined) return Effect.fail(new LookupError({ reason: "invalid", detail: "the answer is not an object" }))
      if ("error" in json) return Effect.fail(new LookupError({ reason: "failed", detail: "the API reported an error" }))
      return Effect.succeed(json)
    })
  )

// ---------------------------------------------------------------------------------------------------------------------
// Pages

export interface Candidate {
  readonly title: string
  readonly description: string
  readonly disambiguation: boolean
  /** The name of the page's lead image on Commons (free licence only), without `File:`. */
  readonly imageFile?: string
  readonly index: number
}

/** A page title or file name as text: plain, one line, bounded; `undefined` when nothing is left. */
const nameOf = (value: unknown, max: number): string | undefined => {
  const text = cleanText(value, max)
  return text === "" ? undefined : text
}

/** What a search of pages answers, read defensively: at most `MAX_CANDIDATES`, in the search's order. */
export const candidatesOf = (json: Readonly<Record<string, unknown>>): ReadonlyArray<Candidate> => {
  const pages = itemsOf(objectOf(json.query)?.pages, MAX_CANDIDATES)
  const out: Array<Candidate> = []
  for (const page of pages) {
    const p = objectOf(page)
    if (p === undefined || p.missing === true || p.invalid === true) continue
    const title = nameOf(p.title, 120)
    if (title === undefined) continue
    const file = nameOf(p.pageimage, 200)
    const index = typeof p.index === "number" && Number.isFinite(p.index) ? p.index : out.length + 1
    out.push({
      title,
      description: cleanText(p.description, 160),
      disambiguation: objectOf(p.pageprops) !== undefined && "disambiguation" in objectOf(p.pageprops)!,
      ...(file !== undefined ? { imageFile: file } : {}),
      index
    })
  }
  return out.sort((a, b) => a.index - b.index)
}

/** Pages matching `query` on one Wikipedia, with their lead image's file name, description and whether they are disambiguation pages. */
export const searchPages = (deps: NetDeps, wiki: "en" | "nl", query: string, agent: string, timeoutMs: number): Effect.Effect<ReadonlyArray<Candidate>, LookupError> =>
  getJson(deps, apiUrl(`${wiki}.wikipedia.org`, {
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "0",
    gsrlimit: String(MAX_CANDIDATES),
    prop: "pageimages|description|pageprops",
    piprop: "name",
    pilicense: "free",
    pilimit: String(MAX_CANDIDATES),
    ppprop: "disambiguation"
  }), agent, timeoutMs).pipe(Effect.map(candidatesOf))

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim()
const withoutQualifier = (title: string): string => title.replace(/\s*\([^)]*\)\s*$/, "")

export type Decision =
  | { readonly kind: "page"; readonly page: Candidate }
  | { readonly kind: "ambiguous"; readonly options: ReadonlyArray<Candidate> }
  | { readonly kind: "none" }

/**
 * Which page the words mean. A page whose title is the words (a qualifier like "(bird)" aside) is the page; when that page is
 * a disambiguation page, or the best match is one, the word is ambiguous and the pages that are not disambiguation pages
 * are the options (at most three). The first match otherwise. Never the first of several meanings.
 */
export const decide = (query: string, candidates: ReadonlyArray<Candidate>): Decision => {
  if (candidates.length === 0) return { kind: "none" }
  const q = normalise(query)
  const exact = candidates.find((c) => normalise(c.title) === q) ?? candidates.find((c) => normalise(withoutQualifier(c.title)) === q && !c.disambiguation)
  const best = exact ?? candidates[0]!
  if (!best.disambiguation) return { kind: "page", page: best }
  const options = candidates.filter((c) => !c.disambiguation).slice(0, MAX_ASKED)
  // One meaning left is the meaning; none left leaves the asker to say more.
  if (options.length === 1) return { kind: "page", page: options[0]! }
  return { kind: "ambiguous", options }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pictures

export interface Picture {
  /** `https://upload.wikimedia.org/…`, printable ASCII, at most 2,000 characters. */
  readonly url: string
  readonly licence: string
  /** Plain text, one line, cut when it was longer than a line (`artistCut`). */
  readonly artist: string
  readonly artistCut: boolean
  readonly file: string
}

const URL_MAX = 2_000
const ARTIST_MAX = 200
const LICENCE_MAX = 40

/** The address of an image the module hands the server: `https` on Wikimedia's own upload host, nothing else. */
export const imageUrlOf = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > URL_MAX) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.hostname !== "upload.wikimedia.org" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined
  return /^[\x21-\x7e]+$/.test(url.href) && url.href.length <= URL_MAX ? url.href : undefined
}

const metaValue = (meta: Readonly<Record<string, unknown>> | undefined, key: string): unknown => objectOf(meta?.[key])?.value

/** One file's imageinfo, read defensively; `undefined` when it is not a picture the module may show with a credit. */
export const pictureOf = (page: unknown): Picture | undefined => {
  const p = objectOf(page)
  if (p === undefined || p.missing === true || p.invalid === true) return undefined
  const info = objectOf(itemsOf(p.imageinfo, 1)[0])
  if (info === undefined) return undefined
  const mime = typeof info.mime === "string" ? info.mime.toLowerCase() : ""
  if (!mime.startsWith("image/")) return undefined
  const url = imageUrlOf(info.thumburl ?? info.url)
  if (url === undefined) return undefined
  const meta = objectOf(info.extmetadata)
  // A non-free file is never shown; a file with no licence line cannot be credited honestly.
  const nonFree = metaValue(meta, "NonFree")
  if (nonFree === true || (typeof nonFree === "string" && nonFree.toLowerCase() === "true")) return undefined
  const licence = cleanText(metaValue(meta, "LicenseShortName"), LICENCE_MAX)
  if (licence === "") return undefined
  const artist = cleanLine(metaValue(meta, "Artist"), ARTIST_MAX)
  const file = nameOf(p.title, 200) ?? ""
  return { url, licence, artist: artist.text, artistCut: artist.cut, file }
}

/** The credit line, at most `max` characters, whose licence and source are never cut: the author is, with an ellipsis. */
export const creditLine = (picture: Picture, template: { readonly withAuthor: string; readonly noAuthor: string }, max: number): { readonly line: string; readonly cut: boolean } => {
  const fill = (t: string, who: string): string => t.replace("{who}", who).replace("{licence}", picture.licence)
  if (picture.artist === "") return { line: cutAt(fill(template.noAuthor, ""), max), cut: false }
  const whole = fill(template.withAuthor, picture.artist)
  if (whole.length <= max) return { line: whole, cut: picture.artistCut }
  const room = max - fill(template.withAuthor, "").length
  if (room < 4) return { line: cutAt(fill(template.noAuthor, ""), max), cut: true }
  return { line: fill(template.withAuthor, cutAt(picture.artist, room)), cut: true }
}

const IMAGEINFO = {
  prop: "imageinfo",
  iiprop: "url|extmetadata|mime",
  iiurlwidth: String(THUMB_WIDTH),
  iiextmetadatafilter: "LicenseShortName|Artist|NonFree"
} as const

/** A named file on Commons: its thumbnail address, licence and author. `undefined` when it is not usable as a credited picture. */
export const fileInfo = (deps: NetDeps, file: string, agent: string, timeoutMs: number): Effect.Effect<Picture | undefined, LookupError> =>
  getJson(deps, apiUrl("commons.wikimedia.org", { ...IMAGEINFO, titles: `File:${file}` }), agent, timeoutMs).pipe(
    Effect.map((json) => pictureOf(itemsOf(objectOf(json.query)?.pages, 1)[0]))
  )

/** Files on Commons matching `query`, best first: the first one usable as a credited picture. */
export const searchFiles = (deps: NetDeps, query: string, agent: string, timeoutMs: number): Effect.Effect<Picture | undefined, LookupError> =>
  getJson(deps, apiUrl("commons.wikimedia.org", { ...IMAGEINFO, generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: "5" }), agent, timeoutMs).pipe(
    Effect.map((json) => {
      const pages = itemsOf(objectOf(json.query)?.pages, 5).map((p) => ({ p, index: typeof objectOf(p)?.index === "number" ? (objectOf(p)!.index as number) : 99 }))
      pages.sort((a, b) => a.index - b.index)
      for (const { p } of pages) {
        const picture = pictureOf(p)
        if (picture !== undefined) return picture
      }
      return undefined
    })
  )
