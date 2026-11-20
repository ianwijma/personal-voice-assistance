import type { Presentation } from "@pva/core"
import { type Language, say } from "@pva/module-contracts"
import type { Area, House, Kind } from "./house.ts"
import { listOf, sentence, texts } from "./texts.ts"

/** The spoken answer is cut at 300 characters by the page boundary: the answer is built to fit, never cut. */
export const SPOKEN_CHARS = 300
/** The presentation protocol counts UTF-16 units (`text.length`): a row is at most 80, a title 60. */
export const ROW_UNITS = 80
export const TITLE_UNITS = 60
/** The names the answer can name at most (the sentence names up to four, "and N more" for the rest). */
const NAMED_AT_MOST = 4
/** A name is shortened to this many UTF-16 units, in the sentence and on the screen alike. */
const NAME_UNITS = 40
const AREA_UNITS = 40

/** Characters a presentation's one-line text refuses: controls, line and paragraph separators, bidirectional controls. */
const notOneLine = (c: number): boolean =>
  c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0x200e || c === 0x200f || c === 0x61c || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)

/**
 * Outside text as one storable line of at most `max` UTF-16 units (the unit the presentation protocol checks):
 * control, separator and bidirectional characters become spaces, a lone surrogate is dropped, spaces are collapsed, and
 * the cut is at a code point boundary (never inside an emoji, never past the bound). The one function every bounded
 * line of this module's answer and list passes through.
 */
export const cutText = (text: string, max: number): string => {
  let out = ""
  let lastSpace = true
  for (const p of text) {
    const c = p.codePointAt(0)!
    if (c >= 0xd800 && c <= 0xdfff) continue
    const q = notOneLine(c) || c === 0x20 ? " " : p
    if (q === " " && lastSpace) continue
    if (out.length + q.length > max) break
    out += q
    lastSpace = q === " "
  }
  return out.trimEnd()
}

/** What a room's lights and switches are, counted over all of them; only the first few on are kept by name. */
export interface RoomNow {
  /** How many are on. */
  readonly onCount: number
  /** The first on (house order), at most `NAMED_AT_MOST`: all the answer can name. */
  readonly firstOn: ReadonlyArray<string>
  /** Lights and switches the room has (of the kinds the assistant uses). */
  readonly total: number
  /** How many are neither on nor off (unavailable, unknown): never counted as off. */
  readonly unread: number
  /** A kind of these was read only in part: there may be more. */
  readonly partial: boolean
}

/** One pass over the house: everything is counted, nothing is cleaned or formatted but what the answer can name. */
export const roomNow = (house: House, area: Area, kinds: ReadonlySet<string>): RoomNow => {
  let total = 0
  let unread = 0
  let onCount = 0
  const firstOn: Array<string> = []
  for (const e of house.entities) {
    if (e.areaId !== area.id || (e.kind !== "light" && e.kind !== "switch") || !kinds.has(e.kind)) continue
    total++
    if (e.state === "on") {
      onCount++
      if (firstOn.length < NAMED_AT_MOST) firstOn.push(e.name)
    } else if (e.state !== "off") unread++
  }
  return { onCount, firstOn, total, unread, partial: [...kinds].some((k) => house.incomplete.has(k as Kind)) }
}

export interface Listing {
  /** What is said: whole sentences, at most `SPOKEN_CHARS`. */
  readonly say: string
  /** The list of exactly the devices the sentence names, in its order (nothing when it names none). */
  readonly present?: Presentation
}

const unreadText = (lang: Language, unread: number): string =>
  unread === 1 ? sentence(lang, "onUnreadOne") : sentence(lang, "onUnreadMany", { count: String(unread) })

/**
 * The answer to "what is on here": the sentence and the list, **from one selection** (the same names, shortened the same
 * way, the same omitted count, the same notes). Only what is known: an unavailable device is counted, never called off;
 * a house read in part says there may be more; a long list is cut by whole names ("and 3 more").
 */
export const listing = (lang: Language, area: Area, now: RoomNow): Listing => {
  const areaName = cutText(area.name, AREA_UNITS)
  if (now.total === 0) {
    const things = say(texts, lang, "kindOnOff")
    return { say: now.partial ? sentence(lang, "unreadThere", { things, area: areaName }) : sentence(lang, "nothingThere", { things, area: areaName }) }
  }
  const notes = [now.unread > 0 ? unreadText(lang, now.unread) : "", now.partial ? say(texts, lang, "houseIncomplete") : ""].filter((t) => t !== "")
  const join = (body: string) => [body, ...notes].join(" ")
  if (now.onCount === 0) return { say: join(sentence(lang, now.unread > 0 || now.partial ? "onNoneRead" : "onNone", { area: areaName })) }
  const names = now.firstOn.map((n) => cutText(n, NAME_UNITS) || "?")
  // Whole names, fewer of them until the sentence fits; else only how many. `named` is what the list shows too.
  for (const max of [NAMED_AT_MOST, 3, 2]) {
    const named = now.onCount <= max ? now.onCount : max - 1
    const shown = names.slice(0, named)
    const candidate = join(sentence(lang, "onSome", { area: areaName, names: listOf(lang, now.onCount <= max ? shown : [...shown, ...Array.from({ length: now.onCount - named }, () => "?")], max) }))
    if (candidate.length > SPOKEN_CHARS) continue
    const more = now.onCount - named
    const rows = [...shown, ...(more > 0 ? [say(texts, lang, "andMore", { count: String(more) })] : []), ...notes].map((t) => cutText(t, ROW_UNITS))
    return {
      say: candidate,
      present: {
        kind: "list",
        title: cutText(say(texts, lang, "onTitle", { area: areaName }), TITLE_UNITS),
        style: "bullets",
        items: rows.map((text, i) => ({ id: `i${i}`, text })),
        spoken: candidate
      }
    }
  }
  return { say: join(sentence(lang, "onCount", { area: areaName, count: String(now.onCount) })) }
}
