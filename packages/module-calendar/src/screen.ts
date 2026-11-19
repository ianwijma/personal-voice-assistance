import { CurrentTurn, type ModulePresent, type Presentation, presentationProblem, type PresentHandle, type Row } from "@pva/core"
import { say } from "@pva/module-contracts"
import { Clock, Effect } from "effect"
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
 *   `Privacy.mayReveal` for the device again at every moment it would show it. A list holds the events of one member
 *   at most (the first one the answer shows); the events of another are counted on it, never listed.
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
  readonly counted: number
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
  // One member's events at most: the first one a shown event has; another's are only counted.
  const owner = a.lines.find((l) => l.how === "show" && l.row.value.owner !== undefined)?.row.value.owner
  const listed = a.lines.filter((l) => l.how === "reduce" || l.row.value.owner === undefined || l.row.value.owner === owner)
  const others = a.lines.filter((l) => l.how === "show" && l.row.value.owner !== undefined && l.row.value.owner !== owner).length
  const lineText = (l: AgendaLine): string => {
    const day = many ? v.dayWords(l.day) : undefined
    const body = (titleMax: number) => {
      const r = l.row
      if (l.how === "show") return v.item(l.day, r, titleMax, true)
      const red = v.reduced(l.day, r)
      return say(texts, lang, "screenBusy", { name: cutPoints(oneLine(red.busy), 30, true), when: say(texts, lang, "busyFromTo", { from: red.from, to: red.to }) })
    }
    const build = (titleMax: number) => {
      const t = oneLine(body(titleMax))
      return day === undefined ? t : say(texts, lang, "screenDayItem", { day, item: t })
    }
    return fitItem(build, l.row.value.title.length)
  }
  const texts80 = listed.map(lineText)
  const notes = [...v.screenNotes(a.covered, { cut: a.cut, withheld: a.withheld, ...(a.continuesAfter !== undefined ? { continuesAfter: a.continuesAfter } : {}) })]
  if (others > 0) notes.push(say(texts, lang, "screenOthers", { count: others }))
  const noteLines = notes.map((n) => cutPoints(n, ITEM_CHARS, true))
  const total = texts80.length + a.counted
  const when = many ? `${v.dayWords(a.first)} – ${v.dayWords(addDays(a.first, a.count - 1))}` : v.dayWords(a.first)
  const Day = when.length === 0 ? when : when[0]!.toUpperCase() + when.slice(1)
  const title = cutPoints(oneLine(total === 0 ? a.nothing : Day), TITLE_CHARS, true)

  // Whole lines before rendering: the notes keep their places, the events share the rest with "and N more".
  const slots = Math.max(1, LIST_ITEMS - noteLines.length)
  const moreLine = (count: number) => say(texts, lang, a.cut ? "screenMoreAtLeast" : "screenMore", { count })
  const content: Array<string> = total <= slots ? [...texts80, ...(a.counted > 0 ? [moreLine(a.counted)] : [])] : [...texts80.slice(0, slots - 1), moreLine(total - (slots - 1))]
  const items = [...content, ...noteLines].slice(0, LIST_ITEMS).map((text, i) => ({ id: `${i < content.length ? "e" : "n"}${i + 1}`, text }))

  const sentence = (n: number) => say(texts, lang, "dayList", { Day, list: v.listOf(texts80.slice(0, n), total, n) })
  const spoken = total === 0
    ? [a.nothing, ...budgetNotes(notes, SPOKEN_CHARS - a.nothing.length - 1, say(texts, lang, "screenMoreNotes"), 1)].join(" ")
    : fitSpoken(sentence, Math.min(SPOKEN_ITEMS, texts80.length), Math.min(2, texts80.length), notes, say(texts, lang, "screenMoreNotes"), say(texts, lang, a.cut ? "screenCountAtLeast" : "screenCount", { Day, count: total }))
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
      facts: []
    }
  }
  const r = a.row
  const val = r.value
  const title = cutPoints(oneLine(v.titleOf(r, 120)), TITLE_CHARS, true)
  const when = a.when!.length <= FACT_VALUE_CHARS ? a.when! : a.whenShort!
  const facts = [
    { label: say(texts, lang, "screenWhen"), value: cutPoints(oneLine(when), FACT_VALUE_CHARS, true) },
    ...(val.location !== undefined && oneLine(val.location) !== "" ? [{ label: say(texts, lang, "screenWhere"), value: cutPoints(oneLine(val.location), FACT_VALUE_CHARS, true) }] : []),
    { label: say(texts, lang, "screenCalendar"), value: cutPoints(oneLine(v.calendarOf(r)), FACT_VALUE_CHARS, true) }
  ]
  const head = say(texts, lang, "nextIs", { title: cutPoints(oneLine(v.titleOf(r, 120)), 80, true), when: a.when! })
  return {
    kind: "card",
    title,
    ...(notes.length > 0 ? { text: notes.join("\n") } : {}),
    facts,
    spoken: cutPoints(spokenNotes(head.length <= SPOKEN_CHARS - 60 ? head : say(texts, lang, "nextIs", { title, when: a.whenShort! })), SPOKEN_CHARS),
    ...(val.owner !== undefined ? { sensitivity: { personal: val.owner } } : {})
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Showing, and taking down when the calendars change

/**
 * The presentations of this run that are on a screen, the newest of each device (a device shows one transient at a time,
 * so an older one of the same device is gone already). Kept in `shared`, so a refresh that changes what the calendars say
 * takes them down; bounded by `MAX_DEVICES`. After a restart there are none: no transient presentation survives one.
 */
const MAX_DEVICES = 64

export interface Screen {
  /** Show `presentation` on the device the turn came from; a screen that cannot show it changes nothing. */
  readonly show: (present: ModulePresent, presentation: Presentation) => Effect.Effect<void>
  /** Take down everything shown by this module (the calendars changed). */
  readonly dismissAll: Effect.Effect<void>
}

export const makeScreen = (): Screen => {
  const live = new Map<string, PresentHandle>()
  return {
    show: (present, presentation) =>
      Effect.gen(function*() {
        const turn = yield* CurrentTurn
        if (turn?.deviceId === undefined) return
        const now = yield* Clock.currentTimeMillis
        // Never a presentation the Presenter would refuse; what is shown is what the checks allow.
        if (presentationProblem(presentation, now) !== undefined) return
        const handle = yield* present.show("origin", presentation)
        live.delete(turn.deviceId)
        live.set(turn.deviceId, handle)
        while (live.size > MAX_DEVICES) live.delete(live.keys().next().value!)
      }).pipe(Effect.catchTag("PresentError", () => Effect.void)),
    dismissAll: Effect.gen(function*() {
      const handles = [...live.values()]
      live.clear()
      for (const h of handles) yield* h.dismiss.pipe(Effect.catchCause(() => Effect.void))
    })
  }
}
