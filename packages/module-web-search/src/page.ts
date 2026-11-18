// A fetched page as bounded plain text for the model. Pure: no network, no store.
//
// The bound (docs/MODULES.md §14, "never block the event loop"): the body is read at most `PAGE_MAX_BYTES` (by safeFetch), the
// markup that is parsed is cut at `HTML_PARSE_CHARS`, a document with more than `MAX_ELEMENTS` elements is not run through
// Readability (its body text is taken instead), and the text that leaves is at most `PAGE_TEXT_MAX` characters. The libraries are
// imported where they are used, so an installation with the module off never loads them.
import { cleanText } from "./providers.ts"

/** The most bytes of a page read (safeFetch's own limit; a bigger page is refused, not cut). */
export const PAGE_MAX_BYTES = 1024 * 1024
/** The most characters of markup that are parsed; the rest is dropped before parsing. */
export const HTML_PARSE_CHARS = 400_000
/** A document with more elements than this is not run through Readability. */
export const MAX_ELEMENTS = 6_000
/** The most characters of text that leave. */
export const PAGE_TEXT_MAX = 6_000

export interface PageText {
  readonly title: string
  readonly text: string
  readonly truncated: boolean
}

const paragraphsOf = (text: string): ReadonlyArray<string> => text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== "")

/** `focus` first: paragraphs that mention a word of it come first (in their order), then the rest. */
export const focusOrder = (text: string, focus: string | undefined): string => {
  const words = (focus ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3).slice(0, 10)
  if (words.length === 0) return text
  const paragraphs = paragraphsOf(text)
  const hit = (p: string) => {
    const lower = p.toLowerCase()
    return words.some((w) => lower.includes(w))
  }
  return [...paragraphs.filter(hit), ...paragraphs.filter((p) => !hit(p))].join("\n\n")
}

/** Cut at a paragraph or sentence end when one is near the limit. */
const cutAt = (text: string, max: number): { readonly text: string; readonly truncated: boolean } => {
  if (text.length <= max) return { text, truncated: false }
  const head = text.slice(0, max)
  const stop = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf(". "))
  const kept = stop > max * 0.6 ? head.slice(0, stop + 1) : head
  return { text: `${kept.trimEnd()}…`, truncated: true }
}

const UNWANTED = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g")

const clean = (text: string): string =>
  text
    .replace(UNWANTED, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

/** Plain text answers need no parsing. */
export const plainPage = (body: string, focus: string | undefined): PageText => {
  const cut = cutAt(focusOrder(clean(body.slice(0, HTML_PARSE_CHARS)), focus), PAGE_TEXT_MAX)
  return { title: "", text: cut.text, truncated: cut.truncated || body.length > HTML_PARSE_CHARS }
}

/**
 * HTML to Markdown text: the article Readability finds (links reduced to their text, images dropped), else the body's text. Throws
 * when the markup cannot be parsed at all; the caller says so in a sentence.
 */
export const htmlPage = async (html: string, focus: string | undefined): Promise<PageText> => {
  const [{ parseHTML }, { Readability }, { default: Turndown }] = await Promise.all([import("linkedom"), import("@mozilla/readability"), import("turndown")])
  const cutHtml = html.length > HTML_PARSE_CHARS
  const { document } = parseHTML(html.slice(0, HTML_PARSE_CHARS))
  // Give the event loop a turn between the stages: the parse and the extraction are two separate short pieces of work.
  await new Promise<void>((resolve) => setImmediate(resolve))
  const title = cleanText(document.title ?? "", 150)
  let articleHtml: string | undefined
  let articleTitle = ""
  if (document.querySelectorAll("*").length <= MAX_ELEMENTS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const article = new Readability(document as any, { charThreshold: 200 }).parse()
      if (article !== null && typeof article.content === "string" && (article.textContent ?? "").trim().length >= 200) {
        articleHtml = article.content
        articleTitle = cleanText(article.title ?? "", 150)
      }
    } catch {
      articleHtml = undefined
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  const turndown = new Turndown({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" })
  // Addresses are never read out and are a way for a page to steer the model: a link is its text, an image is nothing.
  turndown.addRule("links-as-text", { filter: "a", replacement: (content: string) => content })
  turndown.addRule("no-images", { filter: ["img", "picture", "video", "audio", "iframe", "svg", "canvas", "script", "style", "noscript"], replacement: () => "" })
  const source = articleHtml ?? document.body?.innerHTML ?? ""
  const markdown = clean(turndown.turndown(source.slice(0, HTML_PARSE_CHARS)))
  const cut = cutAt(focusOrder(markdown, focus), PAGE_TEXT_MAX)
  return { title: articleTitle !== "" ? articleTitle : title, text: cut.text, truncated: cut.truncated || cutHtml }
}
