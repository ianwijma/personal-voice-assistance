import { type Connector, type ConnectRequest, contentTypes, nodeConnector, nodeResolver, type Resolver, safeFetch, type SafeFetchError, type SafeResponse } from "@pva/net"
import { Data, Effect } from "effect"
import { cleanLine, cutAt, identityOf } from "./clean.ts"

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
/** The longest page title or file name used as an identifier (MediaWiki's own limit is 255 bytes). */
export const NAME_MAX = 255
/** The longest title or description shown. */
export const LABEL_MAX = 120
export const DESCRIPTION_MAX = 160
/** A licence short name is kept whole or the file is not used; with the credit's other words it must leave room for an author. */
export const LICENCE_MAX = 70
const ARTIST_MAX = 200
const URL_MAX = 2_000

export type Source = "wikipedia" | "commons"
export type LookupFailure = "timeout" | "unreachable" | "rate-limited" | "invalid" | "failed"
/** Why a read failed, and in which source; `detail` is for the log and holds no outside text. */
export class LookupError extends Data.TaggedError("LookupError")<{ readonly reason: LookupFailure; readonly source: Source | "both"; readonly detail: string }> {}

const failureOf = (source: Source, e: SafeFetchError): LookupError => {
  switch (e._tag) {
    case "NetTimeout": return new LookupError({ reason: "timeout", source, detail: "timed out" })
    case "NetTooLarge": return new LookupError({ reason: "invalid", source, detail: "the answer was too large" })
    case "NetRefused": return new LookupError({ reason: e.rule === "content-type" ? "invalid" : "failed", source, detail: `refused (${e.rule})` })
    case "NetAborted": return new LookupError({ reason: "failed", source, detail: "aborted" })
    case "NetFailure": return new LookupError({ reason: "unreachable", source, detail: "could not connect" })
  }
}

const invalid = (source: Source, detail: string) => new LookupError({ reason: "invalid", source, detail })

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined

const apiUrl = (host: string, params: Readonly<Record<string, string>>): string => {
  const url = new URL(`https://${host}/w/api.php`)
  for (const [k, v] of Object.entries({ action: "query", format: "json", formatversion: "2", ...params })) url.searchParams.set(k, v)
  return url.href
}

/**
 * One API read: `safeFetch` (JSON only, size and time limit), the status checked, the body parsed. A request goes to one host and
 * stays there: a redirect to any other host is refused before it is looked up or connected to, and is a failed read ("could not
 * connect"); a redirect within the same host is followed.
 */
const getJson = (deps: NetDeps, source: Source, url: string, agent: string, timeoutMs: number): Effect.Effect<Readonly<Record<string, unknown>>, LookupError> => {
  const host = new URL(url).hostname.toLowerCase()
  const resolve: Resolver = deps.resolver ?? nodeResolver
  const connect: Connector = deps.connector ?? nodeConnector
  const resolver: Resolver = (h, signal) => (h.toLowerCase() === host ? resolve(h, signal) : Promise.reject(new Error("another host")))
  const connector: Connector = (request: ConnectRequest) =>
    request.url.hostname.toLowerCase() === host ? connect(request) : Promise.reject(Object.assign(new Error("another host"), { notSent: true }))
  return safeFetch(url, { accept: contentTypes.json, maxBytes: API_MAX_BYTES, timeoutMs, headers: { "user-agent": agent }, resolver, connector }).pipe(
    Effect.mapError((e) => failureOf(source, e)),
    Effect.flatMap((response: SafeResponse) => {
      if (response.status === 429) return Effect.fail(new LookupError({ reason: "rate-limited", source, detail: "status 429" }))
      if (response.status !== 200) return Effect.fail(new LookupError({ reason: "failed", source, detail: `status ${response.status}` }))
      return Effect.try({
        try: () => objectOf(JSON.parse(response.text())),
        catch: () => invalid(source, "the answer is not JSON")
      })
    }),
    Effect.flatMap((json) => {
      if (json === undefined) return Effect.fail(invalid(source, "the answer is not an object"))
      // The API reports its own errors (a bad parameter, a throttle) with status 200 and an `error` member.
      if ("error" in json) return Effect.fail(new LookupError({ reason: "failed", source, detail: "the API reported an error" }))
      return Effect.succeed(json)
    })
  )
}

/**
 * The pages of an answer: an array (possibly empty); `undefined` when the answer does not have the shape of a query answer. An
 * answer with no `query` at all is an empty result only when it says it is complete (`batchcomplete`), which is what the API
 * answers for a search with no hits.
 */
const pagesOf = (json: Readonly<Record<string, unknown>>): ReadonlyArray<unknown> | undefined => {
  if (!("query" in json)) return json.batchcomplete === undefined ? undefined : []
  const query = objectOf(json.query)
  if (query === undefined) return undefined
  if (!("pages" in query)) return json.batchcomplete === undefined ? undefined : []
  return Array.isArray(query.pages) ? query.pages : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Pages

export interface Candidate {
  /** The page's title as the API gave it: the identity of the next request, never cut. */
  readonly title: string
  /** The title as shown and said: cleaned, bounded. */
  readonly label: string
  readonly description: string
  readonly disambiguation: boolean
  /** The name of the page's lead image on Commons (free licence only), without `File:`, as given. */
  readonly imageFile?: string
  readonly index: number
}

/**
 * What an answer to a search of pages says, read strictly: `undefined` when it is malformed (not the shape of a query answer, an
 * entry that is not an object, a field of the wrong type); a page that is missing, or whose title cannot be a page's name, is
 * left out. At most `MAX_CANDIDATES`, in the search's order.
 */
export const candidatesOf = (json: Readonly<Record<string, unknown>>): ReadonlyArray<Candidate> | undefined => {
  const pages = pagesOf(json)
  if (pages === undefined || pages.length > 50) return undefined
  const out: Array<Candidate> = []
  for (const page of pages) {
    const p = objectOf(page)
    if (p === undefined) return undefined
    if (p.missing === true || p.invalid === true) continue
    if (typeof p.title !== "string") return undefined
    if (p.description !== undefined && typeof p.description !== "string") return undefined
    if (p.pageimage !== undefined && typeof p.pageimage !== "string") return undefined
    if (p.pageprops !== undefined && objectOf(p.pageprops) === undefined) return undefined
    if (p.index !== undefined && (typeof p.index !== "number" || !Number.isFinite(p.index))) return undefined
    const title = identityOf(p.title, NAME_MAX)
    if (title === undefined) continue
    const label = cleanLine(title, LABEL_MAX).text
    if (label === "") continue
    const file = identityOf(p.pageimage, NAME_MAX)
    out.push({
      title,
      label,
      description: cleanLine(p.description, DESCRIPTION_MAX).text,
      disambiguation: p.pageprops !== undefined && "disambiguation" in (p.pageprops as object),
      ...(file !== undefined ? { imageFile: file } : {}),
      index: typeof p.index === "number" ? p.index : out.length + 1
    })
  }
  return out.sort((a, b) => a.index - b.index).slice(0, MAX_CANDIDATES)
}

const PAGE_PROPS = { prop: "pageimages|description|pageprops", piprop: "name", pilicense: "free", pilimit: String(MAX_CANDIDATES), ppprop: "disambiguation" } as const

const candidates = (deps: NetDeps, url: string, agent: string, timeoutMs: number): Effect.Effect<ReadonlyArray<Candidate>, LookupError> =>
  getJson(deps, "wikipedia", url, agent, timeoutMs).pipe(
    Effect.flatMap((json) => {
      const found = candidatesOf(json)
      return found === undefined ? Effect.fail(invalid("wikipedia", "the answer is not a list of pages")) : Effect.succeed(found)
    })
  )

/** Pages matching `query` on one Wikipedia, with their lead image's file name, description and whether they are disambiguation pages. */
export const searchPages = (deps: NetDeps, wiki: "en" | "nl", query: string, agent: string, timeoutMs: number) =>
  candidates(deps, apiUrl(`${wiki}.wikipedia.org`, { generator: "search", gsrsearch: query, gsrnamespace: "0", gsrlimit: String(MAX_CANDIDATES), ...PAGE_PROPS }), agent, timeoutMs)

/** The one page of exactly this title (a redirect followed): what a chosen candidate resolves to, not a new search. */
export const pageByTitle = (deps: NetDeps, wiki: "en" | "nl", title: string, agent: string, timeoutMs: number) =>
  candidates(deps, apiUrl(`${wiki}.wikipedia.org`, { titles: title, redirects: "1", ...PAGE_PROPS }), agent, timeoutMs)

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim()
const withoutQualifier = (title: string): string => title.replace(/\s*\([^)]*\)\s*$/, "")

export type Decision =
  | { readonly kind: "page"; readonly page: Candidate }
  | { readonly kind: "ambiguous"; readonly options: ReadonlyArray<Candidate> }
  | { readonly kind: "none" }

/**
 * Which page the words mean. A page whose title is the words wins; when that page is a disambiguation page, or the best match
 * is one, the word is ambiguous whatever else was returned (one alternative does not prove one meaning): the options are the
 * pages that are not disambiguation pages, at most three. Several qualified titles ("Crane (bird)", "Crane (machine)") for
 * words with no page of their own are ambiguous too. Never the first of several meanings.
 */
export const decide = (query: string, found: ReadonlyArray<Candidate>): Decision => {
  if (found.length === 0) return { kind: "none" }
  const q = normalise(query)
  const ordinary = found.filter((c) => !c.disambiguation)
  const exact = found.find((c) => normalise(c.title) === q)
  if (exact !== undefined) return exact.disambiguation ? { kind: "ambiguous", options: ordinary.slice(0, MAX_ASKED) } : { kind: "page", page: exact }
  const best = found[0]!
  if (best.disambiguation) return { kind: "ambiguous", options: ordinary.slice(0, MAX_ASKED) }
  const qualified = ordinary.filter((c) => normalise(withoutQualifier(c.title)) === q)
  if (qualified.length >= 2) return { kind: "ambiguous", options: qualified.slice(0, MAX_ASKED) }
  if (qualified.length === 1) return { kind: "page", page: qualified[0]! }
  return { kind: "page", page: best }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pictures

export interface Picture {
  /** `https://upload.wikimedia.org/…`, printable ASCII, at most 2,000 characters. */
  readonly url: string
  /** The licence short name, whole (a longer one makes the file unusable). */
  readonly licence: string
  /** Plain text, one line, cut when it was longer than a line (`artistCut`). */
  readonly artist: string
  readonly artistCut: boolean
}

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

export type FileOutcome =
  | { readonly kind: "picture"; readonly picture: Picture }
  /** A real answer that says there is nothing here (the file is missing, has no image information). */
  | { readonly kind: "absent" }
  /** A real file the module may not use: not an image, not on Wikimedia's host, non-free, no licence or one too long to credit whole. */
  | { readonly kind: "unusable" }

/** One file's imageinfo, read strictly: `undefined` when malformed. */
export const fileOutcome = (page: unknown): FileOutcome | undefined => {
  const p = objectOf(page)
  if (p === undefined) return undefined
  if (p.missing === true || p.invalid === true) return { kind: "absent" }
  if (typeof p.title !== "string") return undefined
  if (p.imageinfo === undefined) return { kind: "absent" }
  if (!Array.isArray(p.imageinfo)) return undefined
  if (p.imageinfo.length === 0) return { kind: "absent" }
  const info = objectOf(p.imageinfo[0])
  if (info === undefined) return undefined
  if (typeof info.mime !== "string") return undefined
  if (info.thumburl !== undefined && typeof info.thumburl !== "string") return undefined
  if (info.url !== undefined && typeof info.url !== "string") return undefined
  if (info.extmetadata !== undefined && objectOf(info.extmetadata) === undefined) return undefined
  if (!info.mime.toLowerCase().startsWith("image/")) return { kind: "unusable" }
  const url = imageUrlOf(info.thumburl ?? info.url)
  if (url === undefined) return { kind: "unusable" }
  const meta = objectOf(info.extmetadata)
  const nonFree = metaValue(meta, "NonFree")
  if (nonFree === true || (typeof nonFree === "string" && nonFree.toLowerCase() === "true")) return { kind: "unusable" }
  // A file with no licence line cannot be credited honestly, and a licence is never shortened: one too long is not used.
  const licence = cleanLine(metaValue(meta, "LicenseShortName"), LICENCE_MAX)
  if (licence.text === "" || licence.cut) return { kind: "unusable" }
  const artist = cleanLine(metaValue(meta, "Artist"), ARTIST_MAX)
  return { kind: "picture", picture: { url, licence: licence.text, artist: artist.text, artistCut: artist.cut } }
}

/**
 * The credit line, at most `max` characters, by plain concatenation (nothing in an outside text is read as syntax): the author,
 * the licence and "via Wikimedia Commons". The licence and the source are never cut: when all do not fit, the author is, with an
 * ellipsis; with no author the line says so. `undefined` when the licence and the source alone leave no room for an author.
 */
export const creditLine = (picture: Picture, labels: { readonly noAuthor: string; readonly tail: string }, max: number): { readonly line: string; readonly cut: boolean } | undefined => {
  const tail = `${picture.licence}, ${labels.tail}`
  if (picture.artist === "") {
    const line = `${labels.noAuthor}, ${tail}`
    return line.length <= max ? { line, cut: false } : undefined
  }
  const whole = `${picture.artist}, ${tail}`
  if (whole.length <= max) return { line: whole, cut: picture.artistCut }
  const room = max - tail.length - 2
  if (room < 4) return undefined
  return { line: `${cutAt(picture.artist, room)}, ${tail}`, cut: true }
}

const IMAGEINFO = {
  prop: "imageinfo",
  iiprop: "url|extmetadata|mime",
  iiurlwidth: String(THUMB_WIDTH),
  iiextmetadatafilter: "LicenseShortName|Artist|NonFree"
} as const

/** A named file on Commons, by the name as given: its thumbnail address, licence and author, or why there is none. */
export const fileInfo = (deps: NetDeps, file: string, agent: string, timeoutMs: number): Effect.Effect<FileOutcome, LookupError> =>
  getJson(deps, "commons", apiUrl("commons.wikimedia.org", { ...IMAGEINFO, titles: `File:${file}` }), agent, timeoutMs).pipe(
    Effect.flatMap((json) => {
      const pages = pagesOf(json)
      if (pages === undefined) return Effect.fail(invalid("commons", "the answer is not a list of files"))
      if (pages.length === 0) return Effect.succeed({ kind: "absent" } as FileOutcome)
      const outcome = fileOutcome(pages[0])
      return outcome === undefined ? Effect.fail(invalid("commons", "the file is not described as expected")) : Effect.succeed(outcome)
    })
  )

/** Files on Commons matching `query`, best first: the first usable as a credited picture. */
export const searchFiles = (deps: NetDeps, query: string, agent: string, timeoutMs: number): Effect.Effect<FileOutcome, LookupError> =>
  getJson(deps, "commons", apiUrl("commons.wikimedia.org", { ...IMAGEINFO, generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: "5" }), agent, timeoutMs).pipe(
    Effect.flatMap((json) => {
      const pages = pagesOf(json)
      if (pages === undefined || pages.length > 50) return Effect.fail(invalid("commons", "the answer is not a list of files"))
      const ranked: Array<{ readonly outcome: FileOutcome; readonly index: number }> = []
      for (const page of pages.slice(0, 5)) {
        const outcome = fileOutcome(page)
        if (outcome === undefined) return Effect.fail(invalid("commons", "a file is not described as expected"))
        const index = objectOf(page)?.index
        ranked.push({ outcome, index: typeof index === "number" ? index : 99 })
      }
      ranked.sort((a, b) => a.index - b.index)
      const best = ranked.find((r) => r.outcome.kind === "picture")
      return Effect.succeed(best?.outcome ?? (ranked.length > 0 ? ({ kind: "unusable" } as FileOutcome) : ({ kind: "absent" } as FileOutcome)))
    })
  )
