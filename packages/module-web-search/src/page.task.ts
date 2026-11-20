// page.task.ts: a fetched page into bounded plain text. It runs in a fresh worker thread for each call (`offThread` in
// `index.ts`, with a real time limit, a heap limit and a bounded answer), never on the main thread: parsing, Readability and
// Turndown take time proportional to the page (and far worse for deep nesting), and cannot be sliced. One pure function,
// plain data in and out; no network, no store, nothing shared between calls.
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import Turndown from "turndown"
import { cleanText } from "./clean.ts"
import { clean, cutAt, focusOrder, HTML_PARSE_CHARS, MAX_ELEMENTS, PAGE_TEXT_MAX, type PageInput, type PageText, plainPage } from "./page.ts"

const decode = (bytes: Uint8Array, charset: string | undefined): string => {
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      // an unknown label: UTF-8 below, as safeFetch reads it
    }
  }
  return new TextDecoder().decode(bytes)
}

/** Elements that belong in the head while no body content has been seen (the HTML parsing rules' "in head" mode, simplified). */
const HEAD_TAGS: ReadonlySet<string> = new Set(["title", "meta", "link", "base", "style", "script", "noscript", "template"])

/**
 * The markup as a complete document: `<html>`, `<head>` and `<body>` are optional in HTML, and linkedom does not supply the
 * ones a page left out (a page without `<body>` has an empty `document.body`, and one without `<html>` none at all). Every node
 * of the parse is moved into a fresh skeleton: head elements before any content go to its head, everything else to its body,
 * in order. Only the top level is walked (and the children of `html`, `head` and `body`); deeper nodes move with their parent.
 */
const documentOf = (html: string) => {
  const parsed = parseHTML(html).document
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>")
  const head = document.head
  const body = document.body
  let inBody = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const place = (node: any, depth: number): void => {
    if (node.nodeType === 1) {
      const tag = String(node.localName ?? "").toLowerCase()
      if (depth < 3 && (tag === "html" || tag === "head" || tag === "body")) {
        if (tag === "body") inBody = true
        for (const child of [...node.childNodes]) place(child, depth + 1)
        return
      }
      if (!inBody && HEAD_TAGS.has(tag)) {
        head.appendChild(node)
        return
      }
      inBody = true
      body.appendChild(node)
      return
    }
    if (node.nodeType === 3) {
      if (!inBody && String(node.textContent ?? "").trim() === "") return
      inBody = true
      body.appendChild(node)
    }
    // Comments, the doctype and anything else: dropped.
  }
  for (const child of [...parsed.childNodes]) place(child, 0)
  return document
}

/**
 * HTML to Markdown text: the article Readability finds (links reduced to their text, images dropped), else the body's text.
 * Throws when the markup cannot be read at all; the tool says so in a sentence.
 */
export const htmlPage = (html: string, focus: string | undefined): PageText => {
  const cutHtml = html.length > HTML_PARSE_CHARS
  const document = documentOf(html.slice(0, HTML_PARSE_CHARS))
  const title = cleanText(document.title ?? "", 150)
  let articleHtml: string | undefined
  let articleTitle = ""
  if (document.querySelectorAll("*").length <= MAX_ELEMENTS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const article = new Readability(document.cloneNode(true) as any, { charThreshold: 200 }).parse()
      if (article !== null && typeof article.content === "string" && (article.textContent ?? "").trim().length >= 200) {
        articleHtml = article.content
        articleTitle = cleanText(article.title ?? "", 150)
      }
    } catch {
      articleHtml = undefined
    }
  }
  const turndown = new Turndown({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" })
  // Addresses are never read out and are a way for a page to steer the model: a link is its text, an image is nothing.
  turndown.addRule("links-as-text", { filter: "a", replacement: (content: string) => content })
  turndown.addRule("no-images", { filter: ["img", "picture", "video", "audio", "iframe", "svg", "canvas", "script", "style", "noscript"], replacement: () => "" })
  const source = articleHtml ?? document.body?.innerHTML ?? ""
  const markdown = clean(turndown.turndown(source.slice(0, HTML_PARSE_CHARS)))
  const cut = cutAt(focusOrder(markdown, focus), PAGE_TEXT_MAX)
  return { title: articleTitle !== "" ? articleTitle : title, text: cut.text, truncated: cut.truncated || cutHtml }
}

/** The task: bytes in, bounded text out. An empty `text` is a page with nothing to read. */
export default (input: PageInput): PageText => {
  const body = decode(input.bytes, input.charset)
  return input.kind === "text" ? plainPage(body, input.focus) : htmlPage(body, input.focus)
}
