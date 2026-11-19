import type { Presentation } from "@pva/core"
import type { Area, House } from "./house.ts"
import { type Language, say } from "@pva/module-contracts"
import { listOf, sentence, texts } from "./texts.ts"

/** The spoken answer is cut at 300 characters by the page boundary: the answer is built to fit, never cut. */
export const SPOKEN_CHARS = 300
/** Rows of a `list` presentation (`MAX_PRESENT_ITEMS`) and the characters of one row and of the title. */
export const LIST_ROWS = 12
export const ROW_CHARS = 80
export const TITLE_CHARS = 60
/** Names are cut here in the spoken sentence, and the room's name in every sentence. */
const SPOKEN_NAME_CHARS = 40
const AREA_CHARS = 40

/** Characters a presentation's one-line text refuses: controls, line and paragraph separators, bidirectional controls. */
const notOneLine = (c: number): boolean =>
  c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0x200e || c === 0x200f || c === 0x61c || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)

/**
 * Outside text as one storable line of at most `max` code points: control and separator characters become spaces, a
 * lone surrogate is dropped, spaces are collapsed, and the cut is at a code point boundary (never inside an emoji).
 * The one function every text of this module's presentation and its spoken answer passes through.
 */
export const cutText = (text: string, max: number): string => {
  const line = Array.from(text)
    // A lone surrogate is dropped; a control, separator or bidirectional character is a space.
    .flatMap((p) => {
      const c = p.codePointAt(0)!
      return c >= 0xd800 && c <= 0xdfff ? [] : [notOneLine(c) ? " " : p]
    })
    .join("")
    .replace(/ +/g, " ")
    .trim()
  const all = Array.from(line)
  return all.length <= max ? line : all.slice(0, max).join("").trim()
}

/** What a room's lights and switches are, as the last read of the house said. */
export interface RoomNow {
  /** Names of what is on, in name order. */
  readonly on: ReadonlyArray<string>
  /** Lights and switches the room has (of the kinds the assistant uses). */
  readonly total: number
  /** How many are neither on nor off (unavailable, unknown): never counted as off. */
  readonly unread: number
  /** A kind of these was read only in part: there may be more. */
  readonly partial: boolean
}

/** The room's lights and switches of the kinds the assistant uses, from a house. */
export const roomNow = (house: House, area: Area, kinds: ReadonlySet<string>): RoomNow => {
  const here = house.entities.filter((e) => e.areaId === area.id && (e.kind === "light" || e.kind === "switch") && kinds.has(e.kind))
  const on = here.filter((e) => e.state === "on").map((e) => e.name).sort((a, b) => a.localeCompare(b))
  return {
    on,
    total: here.length,
    unread: here.filter((e) => e.state !== "on" && e.state !== "off").length,
    partial: [...kinds].some((k) => (k === "light" || k === "switch") && house.incomplete.has(k as "light" | "switch"))
  }
}

export interface Listing {
  /** What is said, whole sentences, at most `SPOKEN_CHARS`. */
  readonly say: string
  /** What is shown: nothing when nothing is known to be on (an empty answer shows no list). */
  readonly present?: Presentation
}

const unreadText = (lang: Language, unread: number): string =>
  unread === 1 ? sentence(lang, "onUnreadOne") : sentence(lang, "onUnreadMany", { count: String(unread) })

/**
 * The answer to "what is on in this room": the sentence and, when something is on, the list. Only what is known: an
 * unavailable device is counted, never called off; a house read in part says there may be more; a long list is cut by
 * whole items ("and 3 more"), never in the middle of one.
 */
export const listing = (lang: Language, area: Area, now: RoomNow): Listing => {
  const areaName = cutText(area.name, AREA_CHARS)
  if (now.total === 0) {
    const things = say(texts, lang, "kindOnOff")
    return { say: now.partial ? sentence(lang, "unreadThere", { things, area: areaName }) : sentence(lang, "nothingThere", { things, area: areaName }) }
  }
  const tail = [now.unread > 0 ? unreadText(lang, now.unread) : "", now.partial ? say(texts, lang, "houseIncomplete") : ""].filter((t) => t !== "")
  const join = (body: string) => [body, ...tail].join(" ")
  if (now.on.length === 0) return { say: join(sentence(lang, now.unread > 0 || now.partial ? "onNoneRead" : "onNone", { area: areaName })) }
  const names = now.on.map((n) => cutText(n, SPOKEN_NAME_CHARS)).filter((n) => n !== "")
  // Whole names, fewer of them until the sentence fits; else only how many.
  let spoken: string | undefined
  for (const max of [4, 3, 2]) {
    const candidate = join(sentence(lang, "onSome", { area: areaName, names: listOf(lang, names, max) }))
    if (candidate.length <= SPOKEN_CHARS) {
      spoken = candidate
      break
    }
  }
  spoken ??= join(sentence(lang, "onCount", { area: areaName, count: String(now.on.length) }))
  // The list: the names, then one row for what was cut, then the notes; at most twelve rows in all.
  const notes = tail.map((t) => cutText(t, ROW_CHARS))
  const room = LIST_ROWS - notes.length
  const shown = now.on.length > room ? room - 1 : now.on.length
  const rows = [
    ...now.on.slice(0, shown).map((n) => cutText(n, ROW_CHARS)),
    ...(shown < now.on.length ? [cutText(say(texts, lang, "andMore", { count: String(now.on.length - shown) }), ROW_CHARS)] : []),
    ...notes
  ]
  return {
    say: spoken,
    present: {
      kind: "list",
      title: cutText(say(texts, lang, "onTitle", { area: areaName }), TITLE_CHARS),
      style: "bullets",
      items: rows.map((text, i) => ({ id: `i${i}`, text: text === "" ? "-" : text })),
      spoken
    }
  }
}
