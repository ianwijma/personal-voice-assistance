// A fetched page as bounded plain text for the model: the bounds and the pure text steps. Free of dependencies, so the page
// task (`page.task.ts`, which runs in a worker thread through `offThread`) and the tests can import it; the main thread only
// uses the constants and types (docs/MODULES.md §15: nothing proportional to a page's size runs there).

/** The most bytes of a page read (safeFetch's own limit; a bigger page is refused, not cut). */
export const PAGE_MAX_BYTES = 1024 * 1024
/** The most characters of markup or text that are parsed; the rest is dropped first. */
export const HTML_PARSE_CHARS = 400_000
/** A document with more elements than this is not run through Readability (its body text is taken). */
export const MAX_ELEMENTS = 6_000
/** The most characters of text that leave. */
export const PAGE_TEXT_MAX = 6_000
/** The real-time limit of the page task, worker start-up included (about 0.3 s of it); past it the worker is terminated. */
export const PAGE_TASK_TIMEOUT_MS = 3_000
/** The worker's heap. */
export const PAGE_TASK_MEMORY_MB = 256
/** The largest answer the task may give (its text is at most `PAGE_TEXT_MAX` characters, a title 150). */
export const PAGE_TASK_RESULT_BYTES = 64 * 1024

/** What the page task is given: the fetched bytes as they came, their charset, and what kind of page it is. */
export interface PageInput {
  readonly bytes: Uint8Array
  /** The `charset` of the Content-Type; absent or unknown: UTF-8. */
  readonly charset?: string
  readonly kind: "html" | "text"
  readonly focus?: string
}

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
export const cutAt = (text: string, max: number): { readonly text: string; readonly truncated: boolean } => {
  if (text.length <= max) return { text, truncated: false }
  const head = text.slice(0, max)
  const stop = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf(". "))
  const kept = stop > max * 0.6 ? head.slice(0, stop + 1) : head
  return { text: `${kept.trimEnd()}…`, truncated: true }
}

const UNWANTED = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g")

export const clean = (text: string): string =>
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

/** The `charset` parameter of a Content-Type header value (`text/html; charset="ISO-8859-1"` → `ISO-8859-1`). */
export const charsetOf = (contentType: string | undefined): string | undefined => {
  const m = /;\s*charset\s*=\s*"?([^";\s]{1,40})/i.exec(contentType ?? "")
  return m?.[1]
}
