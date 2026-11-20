// The sources of a search as a transient list on the asking device's screen (docs/modules/web-search.md "Sources on screen").
// Pure and free of Effect: what is shown is built here from the results the tool already returns, bounded, as plain text.
import { speakNumber } from "@pva/language"
import { say } from "@pva/module-contracts"
import type { RawResult } from "./providers.ts"
import { texts } from "./texts.ts"

/** The bounds of a `list` presentation (docs/PRESENTING.md): the title, an item's text, the spoken fallback. */
export const SOURCES_TITLE_MAX = 60
export const SOURCES_ITEM_MAX = 80
export const SOURCES_SPOKEN_MAX = 300
const SEPARATOR = " — "

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
// A word of a title that is an address in any form: `scheme:` (http://, mailto:, tel:), `www.`, a bracketed IPv6 host, a mail
// address, or a host followed by a path, query, fragment or port. Such a title is never shown; the site's name stands instead.
const ADDRESS_WORD = [
  /^[a-z][a-z0-9+.-]*:[^\s]/i,
  /^www\./i,
  /\[[0-9a-f:.]*:[0-9a-f:.]*\]/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)+[/?#:]/i
]
const looksLikeAddress = (title: string): boolean => title.split(/\s+/).some((word) => ADDRESS_WORD.some((re) => re.test(word)))

/**
 * `text` cut to at most `max` UTF-16 units at a code point boundary (a pair is never split), with `…` when something was cut
 * (which counts inside `max`). The one cut used for everything this module shows.
 */
export const cutText = (text: string, max: number): string => {
  if (text.length <= max) return text
  const room = Math.max(0, max - 1)
  let end = room
  const last = text.charCodeAt(end - 1)
  // The cut would fall between the halves of a pair: step back before the pair.
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end).trimEnd()}…`
}

/** Text from the web as one plain line for a screen: markup characters, lone surrogates and blanks gone. */
export const screenText = (value: string): string => value.replace(LONE_SURROGATE, "").replace(/<[^<>]*>/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim()

/** One source as an item's text: "Title — site", the title cut so the whole fits; the site alone when the title is empty or an address. */
export const sourceLine = (result: Pick<RawResult, "title" | "site">): string => {
  // The site's name is never cut (the module bounds it to 60): a long title gives way to it.
  const site = screenText(result.site)
  const title = screenText(result.title)
  if (site === "") return cutText(title, SOURCES_ITEM_MAX)
  if (title === "" || title === site || looksLikeAddress(title)) return site
  const room = SOURCES_ITEM_MAX - site.length - SEPARATOR.length
  return room < 4 ? site : `${cutText(title, room)}${SEPARATOR}${site}`
}

export interface SourcesList {
  readonly kind: "list"
  readonly title: string
  readonly style: "bullets"
  readonly items: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly spoken: string
  readonly sensitivity?: { readonly personal: string }
}

/**
 * What the model says where nothing can be shown: the sites, as many whole names as fit, then an honest "and two more". The
 * names are plain site names (never an address).
 */
export const spokenSources = (sites: ReadonlyArray<string>, lang: "en" | "nl"): string => {
  const names = sites.map(screenText).filter((n) => n !== "")
  const build = (shown: number): string => {
    const list = names.slice(0, shown).join(", ")
    const more = names.length - shown
    if (more <= 0) return say(texts, lang, "sourcesSpoken", { list })
    return say(texts, lang, "sourcesSpokenMore", { list, more: speakNumber(more, lang) ?? String(more) })
  }
  // Whole names only, in order: the most that keep the sentence within its bound; the rest are counted, never cut.
  for (let shown = names.length; shown > 0; shown--) {
    const sentence = build(shown)
    if (sentence.length <= SOURCES_SPOKEN_MAX) return sentence
  }
  return say(texts, lang, "sourcesSpokenCount", { count: speakNumber(names.length, lang) ?? String(names.length) })
}

/** The list of sources for the results of one answer; `undefined` when there is nothing to list. `owner`: whose search it was. */
export const sourcesList = (results: ReadonlyArray<Pick<RawResult, "title" | "site">>, lang: "en" | "nl", owner?: string): SourcesList | undefined => {
  const items = results.map((r, i) => ({ id: `s${i + 1}`, text: sourceLine(r) })).filter((i) => i.text !== "")
  if (items.length === 0) return undefined
  return {
    kind: "list",
    title: cutText(say(texts, lang, "sourcesTitle"), SOURCES_TITLE_MAX),
    style: "bullets",
    items,
    spoken: spokenSources(results.map((r) => r.site), lang),
    ...(owner !== undefined ? { sensitivity: { personal: owner } } : {})
  }
}
