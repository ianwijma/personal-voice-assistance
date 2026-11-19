import { type Presentation, type Row } from "@pva/core"
import { numberToWords, speakList, speakNumber } from "@pva/language"
import { say } from "@pva/module-contracts"
import type { View } from "./read.ts"
import type { Occurrence } from "./store.ts"
import { cutPoints, oneLine } from "./text.ts"
import { texts } from "./texts.ts"
import { addDays, type LocalDate } from "./time.ts"

/**
 * What the calendar shows on a device's screen (docs/modules/calendar.md, "On a screen"; docs/PRESENTING.md): a list of
 * an agenda answer and a card for "my next appointment". Both are transient, shown on the device that asked, and say
 * what the answer said and nothing more.
 *
 * - **The same decision as the answer.** Only rows the asking turn may see are built into it: a title only of an event
 *   shown in full, "Robin is busy from two to three" only where the answer reduces, a count only for what is withheld.
 *   A presentation holding events of a member is marked `personal` for that member, so the Presenter asks
 *   `Privacy.mayReveal` for the device again at every moment it would show it; an answer about one person's calendar
 *   is that person's also when it holds no event. A list holds the events of one member at most (the first one the
 *   answer shows); the events of another, and every event the answer reduced to busy time, are only counted on it
 *   ("2 events of others are not shown here."), never named: a screen has no reduced form.
 * - **The same notes.** What `coverage` says beside an answer (stale, read in part, not read, cut, withheld, goes on
 *   after the last day) is on the presentation as short lines, built from `coverage` itself (`View.screenNotes`).
 * - **Bounds.** Whole lines are budgeted before anything is rendered (events first, then busy times, an honest "and 4
 *   more" or "and at least 4 more" when the scan was cut, then the notes); text is cut only at a code point boundary,
 *   inside the limit, by `cutPoints`; nothing is cut to fit a sentence.
 */

const LIST_ITEMS = 12
const ITEM_CHARS = 80
const TITLE_CHARS = 60
const TEXT_CHARS = 300
const FACT_VALUE_CHARS = 60
const SPOKEN_CHARS = 300
/** Items the spoken fallback names before "and N more". */
const SPOKEN_ITEMS = 5

/** One line of an agenda: what a screen shows and what its owner is (absent: the household's, or a reduced time). */
export interface AgendaLine {
  readonly day: LocalDate
  readonly row: Row<Occurrence>
  /** Shown in full (`show`) or only as busy time (`reduce`). */
  readonly how: "show" | "reduce"
}

export interface AgendaScreen {
  /** The first day and how many days the answer covers. */
  readonly first: LocalDate
  readonly count: number
  /** The events listed by the answer, then its busy times, in the answer's order. */
  readonly lines: ReadonlyArray<AgendaLine>
  /** Events and busy times the answer only counted ("more", "moreBusy"). */
  readonly more: number
  readonly moreBusy: number
  /** Whose calendar the request was about (a Members id), when it named one person: the presentation is theirs even with no event. */
  readonly owner?: string
  readonly cut: boolean
  readonly withheld: number
  /** What the answer says when it holds nothing ("Today: nothing on the calendar."), the same sentence. */
  readonly nothing: string
  readonly continuesAfter?: LocalDate
  readonly covered: Parameters<View["screenNotes"]>[0]
}

/** The longest an item is, with a title that is cut to fit (a code point boundary, "…"). */
const fitItem = (build: (titleMax: number) => string, titleLength: number): string => {
  let text = build(120)
  if (text.length <= ITEM_CHARS) return text
  // The words around the title stay; the title gives way.
  const overshoot = text.length - ITEM_CHARS
  text = build(Math.max(1, Math.min(120, titleLength) - overshoot - 1))
  // A title cut to one character does not help a line that is long anyway: cut it whole, marked.
  return text.length <= ITEM_CHARS ? text : cutPoints(text, ITEM_CHARS, true)
}

/** Notes that fit: whole lines in order; what does not is said once ("There are more notes"). Within `room` units. */
export const budgetNotes = (notes: ReadonlyArray<string>, room: number, more: string, joiner: number): Array<string> => {
  for (let k = notes.length; k >= 0; k--) {
    const kept = notes.slice(0, k)
    const rest = k < notes.length ? [...kept, more] : kept
    const size = rest.reduce((n, s) => n + s.length + joiner, 0) - (rest.length > 0 ? joiner : 0)
    if (size <= room) return rest
  }
  return []
}

/** The most items of the spoken fallback that fit, then as many whole notes as fit after it. */
const fitSpoken = (sentence: (items: number) => string, itemsMax: number, itemsMin: number, notes: ReadonlyArray<string>, more: string, fallback: string): string => {
  for (let n = itemsMax; n >= itemsMin; n--) {
    const head = sentence(n)
    if (head.length > SPOKEN_CHARS) continue
    const kept = budgetNotes(notes, SPOKEN_CHARS - head.length - 1, more, 1)
    // Every note is either kept whole or said to be there: if neither fits, fewer items leave room.
    if (kept.length === notes.length || kept.at(-1) === more) return [head, ...kept].join(" ")
  }
  const kept = budgetNotes(notes, SPOKEN_CHARS - fallback.length - 1, more, 1)
  return [fallback, ...kept].join(" ")
}

/** The list for an agenda answer; an answer that holds nothing is a list with no events (so an earlier list is replaced). */
export const agendaPresentation = (v: View, a: AgendaScreen): Presentation => {
  const lang = v.m.lang
  const many = a.count > 1
  // One member's events at most: the request's person, else the first one a shown event has; another's are only counted.
  const owner = a.owner ?? a.lines.find((l) => l.how === "show" && l.row.value.owner !== undefined)?.row.value.owner
  const shown = a.lines.filter((l) => l.how === "show")
  const kept = shown.filter((l) => l.row.value.owner === undefined || l.row.value.owner === owner)
  // Never named: another member's events, and every busy time the answer reduced (a screen has no reduced form).
  const others = shown.length - kept.length + (a.lines.length - shown.length) + a.moreBusy
  const lineText = (l: AgendaLine): string => {
    const build = (titleMax: number) => {
      const t = oneLine(v.item(l.day, l.row, titleMax, true))
      return many ? say(texts, lang, "screenDayItem", { day: v.dayWords(l.day), item: t }) : t
    }
    return fitItem(build, l.row.value.title.length)
  }
  const eventTexts = kept.map(lineText)
  const notes = [...v.screenNotes(a.covered, { cut: a.cut, withheld: a.withheld, ...(a.continuesAfter !== undefined ? { continuesAfter: a.continuesAfter } : {}) })]
  if (others > 0) notes.push(say(texts, lang, others === 1 ? "screenOthersOne" : "screenOthers", { count: others }))
  const noteLines = notes.map((n) => cutPoints(n, ITEM_CHARS, true))
  // Events the list holds or counts: what it shows, plus what the answer only counted. The filtered ones are separate.
  const total = eventTexts.length + a.more
  const when = many ? `${v.dayWords(a.first)} – ${v.dayWords(addDays(a.first, a.count - 1))}` : v.dayWords(a.first)
  const Day = when.length === 0 ? when : when[0]!.toUpperCase() + when.slice(1)
  const title = cutPoints(oneLine(total === 0 && a.nothing !== "" ? a.nothing : Day), TITLE_CHARS, true)

  // Whole lines before rendering: the notes keep their places, the events share the rest with "and N more", which is
  // the total minus what is actually shown.
  const slots = Math.max(1, LIST_ITEMS - noteLines.length)
  const moreLine = (count: number) => say(texts, lang, a.cut ? "screenMoreAtLeast" : "screenMore", { count })
  const showing = total <= slots ? eventTexts.length : Math.min(eventTexts.length, slots - 1)
  const content: Array<string> = [...eventTexts.slice(0, showing), ...(total > showing ? [moreLine(total - showing)] : [])]
  const items = [...content, ...noteLines].slice(0, LIST_ITEMS).map((text, i) => ({ id: `${i < content.length ? "e" : "n"}${i + 1}`, text }))

  // The spoken fallback is a sentence: "Today: A.", "Today: A and B.", "Today: A, B and 3 more.", "Today: nothing ...".
  const remainderWords = (r: number) => say(texts, lang, "nMore", { count: r <= 20 ? (numberToWords(r, lang) ?? String(r)) : (speakNumber(r, lang) ?? String(r)) })
  const sentence = (n: number): string => {
    const parts = [...eventTexts.slice(0, n), ...(total - n > 0 ? [remainderWords(total - n)] : [])]
    // Never a bound below two for the language's list: one part is said as it is.
    const list = parts.length === 1 ? parts[0]! : (speakList(parts, lang, { max: Math.max(2, parts.length) }) ?? parts.join(", "))
    return say(texts, lang, "dayList", { Day, list })
  }
  const moreNotes = say(texts, lang, "screenMoreNotes")
  const spoken = total === 0
    ? [a.nothing !== "" ? a.nothing : say(texts, lang, "screenNothingToShow", { Day }), ...budgetNotes(notes, SPOKEN_CHARS - 80, moreNotes, 1)].join(" ")
    : eventTexts.length === 0
    ? [say(texts, lang, a.cut ? "screenCountAtLeast" : "screenCount", { Day, count: total }), ...budgetNotes(notes, SPOKEN_CHARS - 80, moreNotes, 1)].join(" ")
    : fitSpoken(sentence, Math.min(SPOKEN_ITEMS, eventTexts.length), 1, notes, moreNotes, say(texts, lang, a.cut ? "screenCountAtLeast" : "screenCount", { Day, count: total }))
  return {
    kind: "list",
    title,
    style: "bullets",
    items,
    spoken: cutPoints(spoken, SPOKEN_CHARS),
    ...(owner !== undefined ? { sensitivity: { personal: owner } } : {})
  }
}

export interface NextScreen {
  /** The event (shown in full: "my next appointment" of the asking person, or the household's), or none. */
  readonly row?: Row<Occurrence>
  /** When the event is, as the answer says it; its first moment alone when that is too long for a fact. */
  readonly when?: string
  readonly whenShort?: string
  /** What the answer says when there is no event. */
  readonly noneSentence?: string
  readonly notes: ReadonlyArray<string>
  /** With the place and the calendar as facts (the tool's answer has them); without: the title and when, as the action says it. */
  readonly detail: boolean
  /** Whose calendar the request was about: the card is theirs also when there is no event. */
  readonly owner?: string
}

/** The card for the next appointment. */
export const nextPresentation = (v: View, a: NextScreen): Presentation => {
  const lang = v.m.lang
  const room = TEXT_CHARS
  const notes = budgetNotes(a.notes, a.row === undefined ? room - (a.noneSentence?.length ?? 0) - 1 : room, say(texts, lang, "screenMoreNotes"), 1)
  const spokenNotes = (head: string) => {
    const kept = budgetNotes(a.notes, SPOKEN_CHARS - head.length - 1, say(texts, lang, "screenMoreNotes"), 1)
    return [head, ...kept].join(" ")
  }
  if (a.row === undefined) {
    const sentence = a.noneSentence ?? ""
    return {
      kind: "card",
      title: say(texts, lang, "screenNextTitle"),
      text: [sentence, ...notes].join("\n"),
      spoken: cutPoints(spokenNotes(sentence), SPOKEN_CHARS),
      facts: [],
      ...(a.owner !== undefined ? { sensitivity: { personal: a.owner } } : {})
    }
  }
  const r = a.row
  const val = r.value
  const title = cutPoints(oneLine(v.titleOf(r, 120)), TITLE_CHARS, true)
  const when = a.when!.length <= FACT_VALUE_CHARS ? a.when! : a.whenShort!
  const facts = [
    { label: say(texts, lang, "screenWhen"), value: cutPoints(oneLine(when), FACT_VALUE_CHARS, true) },
    ...(a.detail && val.location !== undefined && oneLine(val.location) !== "" ? [{ label: say(texts, lang, "screenWhere"), value: cutPoints(oneLine(val.location), FACT_VALUE_CHARS, true) }] : []),
    ...(a.detail ? [{ label: say(texts, lang, "screenCalendar"), value: cutPoints(oneLine(v.calendarOf(r)), FACT_VALUE_CHARS, true) }] : [])
  ]
  const head = say(texts, lang, "nextIs", { title: cutPoints(oneLine(v.titleOf(r, 120)), 80, true), when: a.when! })
  return {
    kind: "card",
    title,
    ...(notes.length > 0 ? { text: notes.join("\n") } : {}),
    facts,
    spoken: cutPoints(spokenNotes(head.length <= SPOKEN_CHARS - 60 ? head : say(texts, lang, "nextIs", { title, when: a.whenShort! })), SPOKEN_CHARS),
    ...(a.owner ?? val.owner) !== undefined ? { sensitivity: { personal: (a.owner ?? val.owner)! } } : {}
  }
}
