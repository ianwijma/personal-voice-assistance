// readArticle.task.ts: an article page read into its text. It runs in a fresh worker thread for each call (`offThread`
// in index.ts): one pure function, plain data in and out; nothing shared, no network, no store.
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import { cleanArticle } from "./text.ts"

export interface ArticleInput {
  readonly html: string
  /** The most characters of text returned (cut at a word, with a marker). */
  readonly maxChars: number
}

export type ArticleOutput =
  | {
    readonly ok: true
    /** The article's plain text, at most `maxChars`, ending in `CUT_MARKER` when it was cut. */
    readonly text: string
    readonly cut: boolean
    /** Words of the whole article, not only of `text`. */
    readonly words: number
  }
  | { readonly ok: false }

export default (input: ArticleInput): ArticleOutput => {
  const { document } = parseHTML(input.html)
  const article = new Readability(document as never).parse()
  const read = cleanArticle(article?.textContent ?? "", input.maxChars)
  return read.text === "" ? { ok: false } : { ok: true, ...read }
}
