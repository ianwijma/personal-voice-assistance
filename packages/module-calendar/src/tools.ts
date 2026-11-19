import { ActionError, CurrentTurn, defineAction, isPresentResult, makeTool, Param, type Presentation, type Row, type Sensitivity, ToolError } from "@pva/core"
import { speakList } from "@pva/language"
import { isLine, say, StoredText } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { yieldToLoop } from "./answer.ts"
import { capital, FIND_ROWS, identityOf, isMe, type Moment, NEXT_ROWS, type Notes, noteList, type Reader, resolveDay, type Spoken, type View, type Who } from "./read.ts"
import { WINDOW_DAYS } from "./refresh.ts"
import { type AgendaLine, agendaPresentation, nextPresentation } from "./screen.ts"
import { type Occurrence, ROWS_PAGE } from "./store.ts"
import { texts } from "./texts.ts"
import { addDays, dateOf, daysBetween, instantOf, type LocalDate, parseClock, startOfDay } from "./time.ts"

/**
 * The tools and typed actions (docs/modules/calendar.md, "Tools"). Every one is a plain read of the store's cache:
 * `speculative`, risk `read`, no network on the turn. Each reads first (`reader.consistent`: one generation per
 * calendar), then decides who may hear what for the asking turn (`reader.view`, after the last read), then words the
 * answer, always with what `coverage` says must be said beside it. Results are small: the answer first, at most a dozen
 * events and "more", and the calendars' own text marked as data (`untrusted`).
 */

/** The most events an agenda result lists (the rest are counted). */
export const AGENDA_ITEMS = 12
const FIND_ITEMS = 10
const REDUCED_ITEMS = 6
/** Items a spoken day lists, busy times a spoken day lists (the rest counted: "and 196 more"). */
const SPOKEN_ITEMS = 5
const SPOKEN_BUSY = 3

const line = (max: number, description: string) =>
  StoredText(max).check(Schema.makeFilter((t: string) => isLine(t, max) || "one line, without line breaks")).annotate({ description })

const WHO = line(60, "Whose calendar: \"me\" (the person asking), \"household\", or a member's name. Leave it out for everyone's.")

/** Whose personal content a result holds: the first owner of a personal event it shows (household otherwise). */
const sensitivity = (result: unknown): Sensitivity => {
  // A result that asks to show something carries the answer as `forModel`.
  const answer = isPresentResult(result) ? result.forModel : result
  const owner = (answer as { readonly owner?: unknown } | undefined)?.owner
  return typeof owner === "string" ? { kind: "personal", owner } : { kind: "household" }
}

const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** Words a question adds that no title needs to have ("the dentist", "mijn afspraak"). */
const STOP_WORDS = new Set(["the", "a", "an", "my", "our", "de", "het", "een", "mijn", "onze", "ons"])

/** Every word of `query` is in the event's title or place. */
const matches = (query: string, r: Row<Occurrence>) => {
  const words = normalize(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0 && !STOP_WORDS.has(w))
  const hay = normalize(`${r.value.title} ${r.value.location ?? ""}`)
  return words.length > 0 && words.every((w) => hay.includes(w))
}

/** The first personal owner among shown rows. */
const ownerAmong = (rows: ReadonlyArray<Row<Occurrence>>) => rows.find((r) => r.value.owner !== undefined)?.value.owner

const spokenWith = (first: string, notes: Notes): Spoken => ({ spoken: [first, ...noteList(notes)].join(" ") })

/** The answer of "next": an event shown, one reduced to busy time, none, or a question; with its notes. */
type NextAnswer =
  | { readonly kind: "spoken"; readonly spoken: Spoken }
  | { readonly kind: "shown"; readonly v: View; readonly r: Row<Occurrence>; readonly notes: Notes; readonly screen: ReadonlyArray<string>; readonly owner?: string }
  | { readonly kind: "reduced"; readonly v: View; readonly r: Row<Occurrence>; readonly notes: Notes; readonly screen: ReadonlyArray<string> }
  /** None found: `cut` when the scan stopped short; `through`, the last day it read whole (none: not even today). */
  | { readonly kind: "none"; readonly v: View; readonly cut: boolean; readonly through?: LocalDate; readonly notes: Notes; readonly screen: ReadonlyArray<string>; readonly owner?: string }

export const makeTools = (reader: Reader) => {
  const failedTool = () => Effect.map(reader.moment(undefined), (m) => new ToolError({ message: say(texts, m.lang, "unreadable") }))
  const asToolError = <A, E, R>(e: Effect.Effect<A, E, R>) => e.pipe(Effect.catch(() => Effect.flatMap(failedTool(), Effect.fail)))

  const noCalendars = (m: Moment): Spoken | undefined => (m.configs.length === 0 ? { spoken: say(texts, m.lang, "noCalendars") } : undefined)

  /** The calendar's answer for some days, for the model. */
  const agenda = (input: { readonly day?: string; readonly days?: number; readonly who?: string }) =>
    Effect.gen(function*() {
      const m = yield* reader.moment(yield* CurrentTurn)
      const none = noCalendars(m)
      if (none !== undefined) return none
      const first = resolveDay(m, input.day)
      if ("spoken" in first) return first
      const count = Math.max(1, Math.min(input.days ?? 1, WINDOW_DAYS - daysBetween(m.today, first) + 1))
      const dates = Array.from({ length: count }, (_, k) => addDays(first, k))
      const { states, value: reads } = yield* reader.consistent(() => Effect.forEach(dates, (d) => reader.readDay(d)))
      // Every read is done: who may hear what is decided now.
      const v = reader.view(m, states)
      const who = v.who(input.who)
      if ("spoken" in who) return who
      const covered = v.relevant(who)
      const pre = v.precheck(covered)
      if (pre !== undefined) return pre
      const days: Array<{ day: string; events: Array<unknown> }> = []
      const busy: Array<unknown> = []
      const seen = new Set<string>()
      const withheld = new Set<string>()
      const shownRows: Array<Row<Occurrence>> = []
      const onScreen: Array<AgendaLine> = []
      let continuesAfter: LocalDate | undefined
      let more = 0
      let moreBusy = 0
      for (let k = 0; k < count; k++) {
        const d = dates[k]!
        const events: Array<unknown> = []
        for (const r of reads[k]!.rows) {
          if (!v.ok(r) || !v.meant(who, r)) continue
          const id = identityOf(r)
          // An event of several days is listed once, on its first day in the range, with its real start and end.
          if (seen.has(id)) continue
          seen.add(id)
          const vis = v.visibility(r)
          if (vis === "withhold") {
            withheld.add(id)
            continue
          }
          if (vis === "show") {
            shownRows.push(r)
            if (shownRows.length > AGENDA_ITEMS) {
              more++
              continue
            }
            events.push(v.shown(r))
            onScreen.push({ day: d, row: r, how: "show" })
          } else if (busy.length < REDUCED_ITEMS) {
            busy.push({ day: v.dayWords(d), ...v.reduced(d, r) })
            onScreen.push({ day: d, row: r, how: "reduce" })
          } else {
            moreBusy++
            continue
          }
          continuesAfter ??= v.beyondDay(r)
        }
        if (events.length > 0) days.push({ day: v.dayWords(d), events })
      }
      const extra = { cut: reads.some((r) => r.cut), withheld: withheld.size, ...(continuesAfter !== undefined ? { continuesAfter } : {}) }
      const notes = v.coverage(covered, extra)
      // What the answer says, as a list for the screen of the device that asked, returned with the answer: shown only
      // when the turn is promoted (never from inside this run). An answer with nothing in it is an empty list.
      const listOf = (nothing: string): Presentation =>
        agendaPresentation(v, {
          first,
          count,
          lines: onScreen,
          more,
          moreBusy,
          cut: extra.cut,
          withheld: extra.withheld,
          nothing,
          covered,
          ...(who.kind === "person" ? { owner: who.id } : {}),
          ...(continuesAfter !== undefined ? { continuesAfter } : {})
        })
      if (days.length === 0 && busy.length === 0) {
        const when = count === 1 ? v.dayWords(first) : `${v.dayWords(first)} – ${v.dayWords(addDays(first, count - 1))}`
        const nothing = who.kind === "person" ? say(texts, m.lang, "nothingOnFor", { name: who.name, Day: capital(when) }) : say(texts, m.lang, "nothingOn", { Day: capital(when) })
        return { forModel: spokenWith(nothing, notes), present: listOf(nothing) }
      }
      const owner = ownerAmong(shownRows)
      const answer = {
        ...(count === 1 ? { day: v.dayWords(first), events: days[0]?.events ?? [] } : { days }),
        ...(busy.length > 0 ? { busy } : {}),
        ...(more > 0 ? { more } : {}),
        ...(moreBusy > 0 ? { moreBusy } : {}),
        ...notes,
        untrusted: say(texts, m.lang, "untrusted"),
        ...(owner !== undefined ? { owner } : {})
      }
      return { forModel: answer, present: listOf("") }
    })

  /** The first event from now (or, with `match`, the first that matches and has not ended), with its notes. */
  const decideNext = (v: View, rows: ReadonlyArray<Row<Occurrence>>, who: Who, match: string | undefined) => {
    const seen = new Set<string>()
    const withheld = new Set<string>()
    for (const r of rows) {
      if (!v.ok(r) || !v.meant(who, r) || r.value.end <= v.m.now) continue
      const id = identityOf(r)
      if (seen.has(id)) continue
      seen.add(id)
      const vis = v.visibility(r)
      if (match !== undefined) {
        // Only events shown here are searched: whether a hidden title matches changes nothing in the answer.
        if (vis === "show" && matches(match, r)) return { hit: r, reduced: false, withheld: 0 }
        continue
      }
      if (r.value.start < v.m.now) continue
      if (vis === "withhold") withheld.add(id)
      else return { hit: r, reduced: vis === "reduce", withheld: withheld.size }
    }
    return { hit: undefined, reduced: false, withheld: match !== undefined ? 0 : withheld.size }
  }

  const nextAnswer = (input: { readonly match?: string; readonly who?: string }) =>
    Effect.gen(function*() {
      const m = yield* reader.moment(yield* CurrentTurn)
      const none = noCalendars(m)
      if (none !== undefined) return { kind: "spoken", spoken: none } as NextAnswer
      // Day by day from today, until an event is found or `NEXT_ROWS` rows have been read; every row read counts.
      const { states, value: scan } = yield* reader.consistent((st) =>
        Effect.gen(function*() {
          const rows: Array<Row<Occurrence>> = []
          let read = 0
          for (let k = 0; k <= WINDOW_DAYS; k++) {
            const through = k > 0 ? addDays(m.today, k - 1) : undefined
            if (read >= NEXT_ROWS) return { rows, cut: true, stopped: false, through }
            const d = addDays(m.today, k)
            const day = yield* reader.readDay(d, k === 0 ? m.now : undefined)
            read += day.read
            rows.push(...day.rows)
            const v = reader.view(m, st)
            const who = v.who(input.who)
            if ("spoken" in who) return { rows, cut: false, stopped: true, through: undefined }
            // Only this day's rows can hold the first event not found before: a day's rows include every event still
            // going on from an earlier day, and those were looked at then.
            const found = decideNext(v, day.rows, who, input.match)
            if (day.cut) {
              // A day read only in part: an event found in what was read is next only if nothing unread starts before it.
              const last = day.rows.at(-1)?.value.start
              const sure = k > 0 && found.hit !== undefined && last !== undefined && found.hit.value.start <= last
              return { rows, cut: !sure, stopped: sure, through }
            }
            if (found.hit !== undefined) return { rows, cut: false, stopped: true, through: undefined }
            // A real turn of the event loop between days.
            yield* yieldToLoop
          }
          return { rows, cut: false, stopped: false, through: undefined }
        })
      )
      // Decided again now, after the last read, for this turn, over every row read in start order.
      const rows = [...scan.rows].sort((a, b) => a.value.start - b.value.start || a.value.end - b.value.end)
      const v = reader.view(m, states)
      const who = v.who(input.who)
      if ("spoken" in who) return { kind: "spoken", spoken: who } as NextAnswer
      const covered = v.relevant(who)
      const pre = v.precheck(covered)
      if (pre !== undefined) return { kind: "spoken", spoken: pre } as NextAnswer
      const found = decideNext(v, rows, who, input.match)
      const owner = who.kind === "person" ? { owner: who.id } : {}
      const notSearched = input.match !== undefined && v.unsearched(covered)
      // Read only in part where it stopped: an unread event may come first, so no event is called the next one.
      if (scan.cut) {
        return { kind: "none", v, cut: true, ...(scan.through !== undefined ? { through: scan.through } : {}), notes: v.coverage(covered, { withheld: found.withheld, notSearched }), screen: v.screenNotes(covered, { withheld: found.withheld }), ...owner } as NextAnswer
      }
      if (found.hit === undefined) {
        // Stopped at an event that is not one now (it changed while reading): the read was not complete either.
        const cut = scan.cut || scan.stopped
        return { kind: "none", v, cut, notes: v.coverage(covered, { withheld: found.withheld, notSearched }), screen: v.screenNotes(covered, { withheld: found.withheld }), ...owner } as NextAnswer
      }
      const beyond = v.beyondDay(found.hit)
      const notes = v.coverage(covered, { withheld: found.withheld, notSearched, ...(beyond !== undefined ? { continuesAfter: beyond } : {}) })
      const screen = v.screenNotes(covered, { withheld: found.withheld, ...(beyond !== undefined ? { continuesAfter: beyond } : {}) })
      return { kind: found.reduced ? "reduced" : "shown", v, r: found.hit, notes, screen, ...owner } as NextAnswer
    })

  /** When the next event is, as a phrase: its start, and its end when that is on another day or after the days kept. */
  const nextStart = (v: View, r: Row<Occurrence>) => {
    const val = r.value
    return val.allDay ? `${v.dayWords(dateOf(val.start, v.m.zone))}, ${say(texts, v.m.lang, "allDayBusy")}` : v.momentWords(val.start)
  }
  const nextWhen = (v: View, r: Row<Occurrence>) => {
    const val = r.value
    const first = dateOf(val.start, v.m.zone)
    const last = dateOf(val.end > val.start ? val.end - 1 : val.start, v.m.zone)
    const start = nextStart(v, r)
    const beyond = v.beyondDay(r)
    if (beyond !== undefined) return say(texts, v.m.lang, "untilAfter", { when: start, day: v.dayWords(beyond) })
    if (daysBetween(first, last) === 0) return start
    return say(texts, v.m.lang, "untilTo", { when: start, to: val.allDay ? v.dayWords(last) : v.momentWords(val.end) })
  }

  /**
   * What "none found" says. A scan cut short never claims a number or "nothing": it says up to which day it found
   * nothing, and when it could not read even today whole, that there are too many events around now to tell which is
   * next (and offers today's agenda).
   */
  const noneSentence = (a: Extract<NextAnswer, { kind: "none" }>, match: string | undefined) => {
    const lang = a.v.m.lang
    if (a.cut) {
      if (a.through === undefined) return say(texts, lang, "nextUnsure")
      const day = a.v.dayWords(a.through)
      return match === undefined ? say(texts, lang, "nextNoneThrough", { day }) : say(texts, lang, "nextNoneMatchingThrough", { match, day })
    }
    return match === undefined ? say(texts, lang, "nextNone", { days: WINDOW_DAYS }) : say(texts, lang, "nextNoneMatching", { match, days: WINDOW_DAYS })
  }

  /**
   * The card for "my next appointment": the asking person's own next event ("me", no words), or that there is none,
   * with the answer's notes, marked as that person's. `detail`: with the place and the calendar (the tool's answer
   * has them; the action's sentence does not, so its card has the title and when only). Never for a busy time, a
   * question or a refusal (nothing of them is shown).
   */
  const cardOf = (a: NextAnswer, input: { readonly match?: string; readonly who?: string }, detail: boolean): Presentation | undefined => {
    if (!isMe(input.who) || input.match !== undefined) return undefined
    if (a.kind === "shown") return nextPresentation(a.v, { row: a.r, when: nextWhen(a.v, a.r), whenShort: nextStart(a.v, a.r), notes: a.screen, detail, ...(a.owner !== undefined ? { owner: a.owner } : {}) })
    if (a.kind === "none") return nextPresentation(a.v, { noneSentence: noneSentence(a, input.match), notes: a.screen, detail, ...(a.owner !== undefined ? { owner: a.owner } : {}) })
    return undefined
  }

  const nextResult = (input: { readonly match?: string; readonly who?: string }) =>
    Effect.map(nextAnswer(input), (a) => {
      if (a.kind === "spoken") return a.spoken
      const lang = a.v.m.lang
      const withCard = (forModel: unknown) => {
        const present = cardOf(a, input, true)
        return present === undefined ? forModel : { forModel, present }
      }
      if (a.kind === "none") return withCard(spokenWith(noneSentence(a, input.match), a.notes))
      const d = dateOf(a.r.value.start, a.v.m.zone)
      if (a.kind === "reduced") return { busy: { day: a.v.dayWords(d), ...a.v.reduced(d, a.r) }, ...a.notes }
      const val = a.r.value
      return withCard({
        next: { title: a.v.titleOf(a.r), when: nextWhen(a.v, a.r), calendar: a.v.calendarOf(a.r), ...(val.location !== undefined ? { place: val.location } : {}) },
        ...a.notes,
        untrusted: say(texts, lang, "untrusted"),
        ...(val.owner !== undefined ? { owner: val.owner } : {})
      })
    })

  const find = (input: { readonly text: string; readonly who?: string }) =>
    Effect.gen(function*() {
      const m = yield* reader.moment(yield* CurrentTurn)
      const none = noCalendars(m)
      if (none !== undefined) return none
      const { states, value: scan } = yield* reader.consistent(() =>
        Effect.gen(function*() {
          const rows: Array<Row<Occurrence>> = []
          let after: Row<Occurrence> | undefined
          for (;;) {
            const page = yield* reader.rows.list({ orderBy: { field: "start" }, limit: ROWS_PAGE, ...(after !== undefined ? { after } : {}) })
            rows.push(...page)
            if (page.length < ROWS_PAGE) return { rows, cut: false }
            if (rows.length >= FIND_ROWS) {
              const beyond = yield* reader.rows.list({ orderBy: { field: "start" }, limit: 1, after: page.at(-1)! })
              return { rows, cut: beyond.length > 0 }
            }
            after = page.at(-1)
            yield* yieldToLoop
          }
        })
      )
      const v = reader.view(m, states)
      const who = v.who(input.who)
      if ("spoken" in who) return who
      const covered = v.relevant(who)
      const pre = v.precheck(covered)
      if (pre !== undefined) return pre
      const found: Array<unknown> = []
      const shownRows: Array<Row<Occurrence>> = []
      const seen = new Set<string>()
      let continuesAfter: LocalDate | undefined
      for (const r of scan.rows) {
        if (r.value.end <= m.now || !v.ok(r) || !v.meant(who, r)) continue
        const id = identityOf(r)
        if (seen.has(id)) continue
        seen.add(id)
        // Only events shown here are searched.
        if (v.visibility(r) !== "show" || !matches(input.text, r)) continue
        shownRows.push(r)
        if (found.length >= FIND_ITEMS) continue
        found.push({ title: v.titleOf(r), when: nextWhen(v, r), calendar: v.calendarOf(r), ...(r.value.location !== undefined ? { place: r.value.location } : {}) })
        continuesAfter ??= v.beyondDay(r)
      }
      const notes = v.coverage(covered, { cut: scan.cut, notSearched: v.unsearched(covered), ...(continuesAfter !== undefined ? { continuesAfter } : {}) })
      if (found.length === 0) return spokenWith(say(texts, m.lang, "findNone", { text: input.text }), notes)
      const owner = ownerAmong(shownRows)
      return {
        found,
        ...(shownRows.length > found.length ? { more: shownRows.length - found.length } : {}),
        ...(noteList(notes).length > 0 ? { notes: noteList(notes).join(" ") } : {}),
        untrusted: say(texts, m.lang, "untrusted"),
        ...(owner !== undefined ? { owner } : {})
      }
    })

  const free = (input: { readonly day?: string; readonly from?: string; readonly to?: string; readonly minMinutes?: number; readonly who?: string }) =>
    Effect.gen(function*() {
      const m = yield* reader.moment(yield* CurrentTurn)
      const none = noCalendars(m)
      if (none !== undefined) return none
      const d = resolveDay(m, input.day)
      if ("spoken" in d) return d
      const from = parseClock(input.from ?? "08:00")!
      const to = parseClock(input.to ?? "21:00")!
      const at = (c: { hour: number; minute: number }) => (c.hour === 24 ? startOfDay(addDays(d, 1), m.zone) : instantOf({ ...d, hour: c.hour, minute: c.minute }, m.zone))
      const lo = at(from)
      const hi = at(to)
      if (hi <= lo) return { spoken: say(texts, m.lang, "badRange") }
      const { states, value: day } = yield* reader.consistent(() => reader.readDay(d))
      const v = reader.view(m, states)
      const who = v.who(input.who)
      if ("spoken" in who) return who
      const covered = v.relevant(who, true)
      const pre = v.precheck(covered)
      if (pre !== undefined) return pre
      const inRange = (r: Row<Occurrence>) => r.value.busy && r.value.start < hi && r.value.end > lo
      const counted: Array<Row<Occurrence>> = []
      const shownBusy: Array<Row<Occurrence>> = []
      const withheld = new Set<string>()
      for (const r of day.rows) {
        if (!v.ok(r) || !v.meant(who, r, true) || !inRange(r)) continue
        const vis = v.visibility(r)
        if (vis === "withhold") withheld.add(identityOf(r))
        else {
          counted.push(r)
          if (vis === "show") shownBusy.push(r)
        }
      }
      const intervals = counted.map((r) => [Math.max(lo, r.value.start), Math.min(hi, r.value.end)] as const).sort((a, b) => a[0] - b[0])
      const minMs = (input.minMinutes ?? 30) * 60_000
      const slots: Array<readonly [number, number]> = []
      let cursor = lo
      for (const [a, b] of intervals) {
        if (a - cursor >= minMs) slots.push([cursor, a])
        cursor = Math.max(cursor, b)
      }
      if (hi - cursor >= minMs) slots.push([cursor, hi])
      const Day = capital(v.dayWords(d))
      const fromW = v.timeOf(lo)
      const toW = v.timeOf(hi)
      const sentence = slots.length === 0
        ? say(texts, m.lang, "freeNone", { Day, from: fromW, to: toW, minutes: input.minMinutes ?? 30 })
        : slots.length === 1 && slots[0]![0] === lo && slots[0]![1] === hi
        ? say(texts, m.lang, "freeAll", { Day, from: fromW, to: toW })
        : say(texts, m.lang, "freeList", { Day, list: speakList(slots.map(([a, b]) => say(texts, m.lang, "freeSlot", { from: v.timeOf(a), to: v.timeOf(b) })), m.lang, { max: 6 }) ?? "" })
      const notes = v.coverage(covered, { cut: day.cut, withheld: withheld.size })
      // Whose busy time the answer is made of: only the events inside the range count.
      const owner = ownerAmong(shownBusy)
      return { ...spokenWith(sentence, notes), ...(owner !== undefined ? { owner } : {}) }
    })

  const tools = [
    makeTool({
      name: "calendar_agenda",
      description: "What is on the calendars on a day or a few days: \"what's on today\", \"what do we have this weekend\". Answers from the calendars as last read.",
      parameters: Schema.Struct({
        day: Schema.optionalKey(line(60, "The first day: a phrase as said (\"today\", \"tomorrow\", \"Friday\", \"vrijdag\") or YYYY-MM-DD. Default today.")),
        days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 14 })).annotate({ description: "How many days from the first, 1 to 14. Default 1." })),
        who: Schema.optionalKey(WHO)
      }),
      speculative: true,
      latency: "instant",
      sensitivity,
      execute: (input) => asToolError(agenda(input))
    }),
    makeTool({
      name: "calendar_next",
      description: "The next event on the calendars, or the next one whose title or place has some words: \"when is the dentist\", \"what's next\". For \"my next appointment\" pass who \"me\".",
      parameters: Schema.Struct({ match: Schema.optionalKey(line(80, "Words of the event's title or place (\"dentist\")")), who: Schema.optionalKey(WHO) }),
      speculative: true,
      latency: "quick",
      sensitivity,
      execute: (input) => asToolError(nextResult(input))
    }),
    makeTool({
      name: "calendar_find",
      description: "Find events whose title or place has some words, from now to two months ahead (up to ten).",
      parameters: Schema.Struct({ text: line(80, "The words to look for (\"swimming\")").check(Schema.isMinLength(1)), who: Schema.optionalKey(WHO) }),
      speculative: true,
      latency: "quick",
      sensitivity,
      execute: (input) => asToolError(find(input))
    }),
    makeTool({
      name: "calendar_free",
      description: "Free time on a day between two times: \"am I free Friday afternoon\" (who \"me\", from 12:00 to 18:00). Events of the household's calendars count as busy too.",
      parameters: Schema.Struct({
        day: Schema.optionalKey(line(60, "The day: a phrase as said or YYYY-MM-DD. Default today.")),
        from: Schema.optionalKey(Schema.String.check(Schema.makeFilter((t: string) => parseClock(t) !== undefined || "HH:MM")).annotate({ description: "Start, HH:MM (24 hours). Default 08:00." })),
        to: Schema.optionalKey(Schema.String.check(Schema.makeFilter((t: string) => parseClock(t) !== undefined || "HH:MM")).annotate({ description: "End, HH:MM (24 hours). Default 21:00." })),
        minMinutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 600 })).annotate({ description: "The shortest free time that counts, in minutes. Default 30." })),
        who: Schema.optionalKey(WHO)
      }),
      speculative: true,
      latency: "instant",
      sensitivity,
      execute: (input) => asToolError(free(input))
    })
  ]

  // ---- typed actions: spoken as they are, with no model ------------------------------------------------------------

  /** A day's events as one or a few sentences: the events, who is busy when, and every note `coverage` gives. */
  const daySentence = (offset: number) =>
    Effect.gen(function*() {
      const m = yield* reader.moment(yield* CurrentTurn)
      const none = noCalendars(m)
      if (none !== undefined) return none.spoken
      const d = addDays(m.today, offset)
      const { states, value: day } = yield* reader.consistent(() => reader.readDay(d))
      const v = reader.view(m, states)
      const covered = v.relevant({ kind: "all" })
      const pre = v.precheck(covered)
      if (pre !== undefined) return pre.spoken
      const seen = new Set<string>()
      const withheld = new Set<string>()
      const shownRows: Array<Row<Occurrence>> = []
      const reducedRows: Array<Row<Occurrence>> = []
      let continuesAfter: LocalDate | undefined
      for (const r of day.rows) {
        if (!v.ok(r)) continue
        const id = identityOf(r)
        if (seen.has(id)) continue
        seen.add(id)
        const vis = v.visibility(r)
        if (vis === "show") shownRows.push(r)
        else if (vis === "reduce") reducedRows.push(r)
        else withheld.add(id)
      }
      const parts: Array<string> = []
      const Day = capital(v.dayWords(d))
      const spokenShown = shownRows.slice(0, SPOKEN_ITEMS)
      const spokenBusy = reducedRows.slice(0, SPOKEN_BUSY)
      for (const r of [...spokenShown, ...spokenBusy]) continuesAfter ??= v.beyondDay(r)
      if (shownRows.length > 0) parts.push(say(texts, m.lang, "dayList", { Day, list: v.listOf(spokenShown.map((r) => v.item(d, r)), shownRows.length, SPOKEN_ITEMS) }))
      const busyWhen = (r: Row<Occurrence>) => {
        const red = v.reduced(d, r)
        return { name: red.busy, when: say(texts, m.lang, "busyFromTo", { from: red.from, to: red.to }) }
      }
      if (reducedRows.length === 1) parts.push(say(texts, m.lang, "busy", busyWhen(reducedRows[0]!)))
      else if (reducedRows.length > 1) parts.push(say(texts, m.lang, "busyList", { list: v.listOf(spokenBusy.map((r) => say(texts, m.lang, "busyItem", busyWhen(r))), reducedRows.length, SPOKEN_BUSY) }))
      if (parts.length === 0) parts.push(say(texts, m.lang, "nothingOn", { Day }))
      parts.push(...noteList(v.coverage(covered, { cut: day.cut, withheld: withheld.size, ...(continuesAfter !== undefined ? { continuesAfter } : {}) })))
      return parts.join(" ")
    })

  const failedAction = () => Effect.map(reader.moment(undefined), (m) => new ActionError({ message: say(texts, m.lang, "unreadable") }))
  const asAction = (e: Effect.Effect<string, unknown>) => e.pipe(Effect.map((s) => ({ say: s })), Effect.catch(() => Effect.flatMap(failedAction(), Effect.fail)))
  /** As `asAction`, with the presentation the answer asks for returned beside the sentence (`{ say, present }`). */
  const asPresenting = (e: Effect.Effect<{ readonly say: string; readonly present?: Presentation }, unknown>) =>
    e.pipe(Effect.map((o) => (o.present === undefined ? { say: o.say } : { say: o.say, present: o.present })), Effect.catch(() => Effect.flatMap(failedAction(), Effect.fail)))

  /** The sentence of a next-event answer, and the card for "my next appointment" where the answer has one. */
  const nextOutcome = (input: { readonly match?: string; readonly who?: string }) =>
    Effect.map(nextAnswer(input), (a) => {
      const present = cardOf(a, input, false)
      return { say: sentenceOfNext(a, input), ...(present !== undefined ? { present } : {}) }
    })

  const nextSentence = (input: { readonly match?: string; readonly who?: string }) => Effect.map(nextAnswer(input), (a) => sentenceOfNext(a, input))

  const sentenceOfNext = (a: NextAnswer, input: { readonly match?: string; readonly who?: string }): string =>
    ((): string => {
      if (a.kind === "spoken") return a.spoken.spoken
      const lang = a.v.m.lang
      if (a.kind === "none") return spokenWith(noneSentence(a, input.match), a.notes).spoken
      if (a.kind === "reduced") {
        const d = dateOf(a.r.value.start, a.v.m.zone)
        const red = a.v.reduced(d, a.r)
        return spokenWith(say(texts, lang, "busy", { name: red.busy, when: `${a.v.dayWords(d)} ${say(texts, lang, "busyFromTo", { from: red.from, to: red.to })}` }), a.notes).spoken
      }
      return spokenWith(say(texts, lang, "nextIs", { title: a.v.titleOf(a.r), when: nextWhen(a.v, a.r) }), a.notes).spoken
    })()

  const actions = [
    defineAction({
      id: "today",
      label: "What's on today",
      description: "Read today's events on the calendars. Not for another day: that is calendar_agenda.",
      examples: ["what's on today", "what's on the calendar today", "what do we have today", "wat staat er vandaag", "wat staat er vandaag in de agenda"],
      params: {},
      speculative: true,
      offerAsTool: false,
      run: () => asAction(daySentence(0))
    }),
    defineAction({
      id: "tomorrow",
      label: "What's on tomorrow",
      description: "Read tomorrow's events on the calendars.",
      examples: ["what's on tomorrow", "what do we have tomorrow", "wat staat er morgen", "wat staat er morgen in de agenda"],
      params: {},
      speculative: true,
      offerAsTool: false,
      run: () => asAction(daySentence(1))
    }),
    defineAction({
      id: "next_event",
      label: "The next event",
      description: "Say the next event on all the calendars. Not for the asker's own (\"my next appointment\"): that is my_next; not for a named event: that is when_is.",
      examples: ["what's next on the calendar", "what's the next thing on the calendar", "wat staat er hierna in de agenda", "wat is het volgende in de agenda"],
      params: {},
      speculative: true,
      offerAsTool: false,
      run: () => asAction(nextSentence({}))
    }),
    defineAction({
      id: "my_next",
      label: "My next appointment",
      description: "Say the next event on the asking person's own calendars; with nobody known asking, it asks whose.",
      examples: ["when is my next appointment", "what is my next appointment", "what's next for me", "wat is mijn volgende afspraak", "wanneer is mijn volgende afspraak"],
      params: {},
      speculative: true,
      offerAsTool: false,
      run: () => asPresenting(nextOutcome({ who: "me" }))
    }),
    defineAction({
      id: "when_is",
      label: "When is an event",
      description: "Say when the next event with some words in its title or place is (\"when is the dentist\").",
      examples: ["when is the dentist", "when is swimming", "wanneer is de tandarts", "wanneer is zwemmen"],
      params: { match: Param.text({ label: "Words of the title", after: ["when is", "when's", "wanneer is"], maxWords: 6 }) },
      speculative: true,
      offerAsTool: false,
      run: ({ match }) => asAction(nextSentence(match.trim() !== "" ? { match } : {}))
    })
  ]

  return { tools, actions, daySentence }
}
