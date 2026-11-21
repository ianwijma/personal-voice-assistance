import type { WebImage, WebImagesError } from "@pva/module-contracts"
import { cleanLine } from "./clean.ts"
import { LABEL_MAX, LookupError } from "./wiki.ts"

/** A picture from the web search, as the module shows it: one address, and the cleaned texts of its result. */
export interface WebPicture {
  /** The address the server's media route fetches: `https`, printable ASCII, at most 2,000 characters. */
  readonly url: string
  /** The result's title, cleaned and bounded (may be empty). */
  readonly title: string
  /** The host of the page it is on, cleaned (what the credit names). */
  readonly site: string
}

const URL_MAX = 2_000
const SITE_MAX = 60
/** What the presentation's address may hold: printable ASCII without a space, a quote or a backslash. */
const ADDRESS = /^https:\/\/[\x21\x23-\x5b\x5d-\x7e]+$/
/** The formats the server's image cache keeps (PNG, JPEG, GIF, WebP), as SearXNG names them. */
const KEPT_FORMATS: ReadonlySet<string> = new Set(["jpeg", "jpg", "png", "gif", "webp", "image/jpeg", "image/png", "image/gif", "image/webp"])
/** File endings of formats the cache refuses (SVG can carry script; the others no browser or the cache shows reliably). */
const REFUSED_ENDING = /\.(?:svgz?|tiff?|bmp|ico|heic|heif|avif|jxl|psd|raw|pdf)$/i

/** An address the server can be given: `https`, within bounds, and not obviously a format the image cache refuses. */
export const webAddressOf = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > URL_MAX || !ADDRESS.test(value)) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || url.href.length > URL_MAX) return undefined
  if (REFUSED_ENDING.test(url.pathname)) return undefined
  return url.href
}

/**
 * The picture to show from a web search's results (SearXNG's order, best first): the first result with a usable address
 * and a page to credit. Of a result, the search engine's own thumbnail is preferred: it is made to be fetched by others,
 * small, and always a format the cache keeps, where an original is often refused by its host, larger than the cache
 * allows (2 MiB), or a format it does not keep. The original is used when there is no usable thumbnail and its stated
 * format, when there is one, is kept. `undefined`: no result can be shown.
 */
export const pickWebPicture = (results: ReadonlyArray<WebImage>): WebPicture | undefined => {
  for (const r of results.slice(0, 20)) {
    const site = cleanLine(r.site, SITE_MAX)
    if (site.text === "" || site.cut) continue
    const formatKept = r.format === undefined || KEPT_FORMATS.has(r.format.toLowerCase())
    const url = webAddressOf(r.thumbnailUrl) ?? (formatKept ? webAddressOf(r.imageUrl) : undefined)
    if (url === undefined) continue
    return { url, title: cleanLine(r.title, LABEL_MAX).text, site: site.text }
  }
  return undefined
}

/** A failed web search, in the module's terms (the source is the web search, never Wikipedia's fault). */
export const webFailure = (e: WebImagesError): LookupError => {
  switch (e.reason) {
    case "timeout": return new LookupError({ reason: "timeout", source: "web", detail: "timed out" })
    case "unreachable": return new LookupError({ reason: "unreachable", source: "web", detail: "could not connect" })
    case "rate-limited": return new LookupError({ reason: "rate-limited", source: "web", detail: "status 429" })
    case "invalid":
    case "json-off": return new LookupError({ reason: "invalid", source: "web", detail: e.reason })
    case "failed": return new LookupError({ reason: "failed", source: "web", detail: "failed" })
  }
}
