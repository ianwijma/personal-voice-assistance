import { ActionError, CurrentTurn, defineAction, makeTool, Param, type Row, type Sensitivity, ToolError } from "@pva/core"
import { speakList, speakMoment } from "@pva/language"
import { isLine, say, StoredText } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { capital, FIND_ROWS, isSpoken, NEXT_ROWS, type Reader } from "./read.ts"
import { WINDOW_DAYS } from "./refresh.ts"
import type { Occurrence } from "./store.ts"
import { texts } from "./texts.ts"
import { addDays, dateOf, daysBetween, instantOf, parseClock, startOfDay, wallTimeOf } from "./time.ts"

/**
 * The tools and typed actions (docs/modules/calendar.md, "Tools"). Every one is a plain read of the store's cache:
 * `speculative`, risk `read`, latency `instant`, no network on the turn. Results are small: the answer first, at most a
 * dozen events and "more", and the calendars' own text marked as data (`untrusted`).
 */

/** The most events an agenda result lists (the rest are counted). */
export const AGENDA_ITEMS = 12
const FIND_ITEMS = 10
const REDUCED_ITEMS = 6

const line = (max: number, description: string) =>
  StoredText(max).check(Schema.makeFilter((t: string) => isLine(t, max) || "one line, without line breaks")).annotate({ description })

const WHO = line(60, "Whose calendar: \"me\" (the person asking), \"household\", or a member's name. Leave it out for everyone's.")

/** Whose personal content a result holds: the first owner of a personal event it shows (household otherwise). */
const sensitivity = (result: unknown): Sensitivity => {
  const owner = (result as { readonly owner?: unknown } | undefined)?.owner
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

export const makeTools = (reader: Reader) => {
  const failedTool = () => Effect.map(reader.moment(undefined), (m) => new ToolError({ message: say(texts, m.lang, "unreadable") }))
  const asToolError = <A, E, R>(e: Effect.Effect<A, E, R>) => e.pipe(Effect.catch(() => Effect.flatMap(failedTool(), Effect.fail)))

  /** The first personal owner among shown rows. */
  const ownerAmong = (rows: ReadonlyArray<Row<Occurrence>>) => rows.find((r) => r.value.owner !== undefined)?.value.owner

  /** The calendar's answer for some days, for the model. */
  const agenda = (input: { readonly day?: string; readonly days?: number; readonly who?: string }) =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const m = yield* reader.moment(turn)
      const pre = yield* reader.precheck(m)
      if (pre !== undefined) return pre
      const who = reader.resolveWho(m, input.who)
      if (isSpoken(who)) return who
      const first = reader.resolveDay(m, input.day)
      if (isSpoken(first)) return first
      const count = Math.max(1, Math.min(input.days ?? 1, WINDOW_DAYS - daysBetween(m.today, first) + 1))
      const days: Array<{ day: string; events: Array<unknown> }> = []
      const busy: Array<unknown> = []
      const seen = new Set<string>()
      const withheldKeys = new Set<string>()
      const shownRows: Array<Row<Occurrence>> = []
      let listed = 0
      let more = 0
      let cut = false
      for (let k = 0; k < count; k++) {
        const d = addDays(first, k)
        const ev = yield* reader.dayEvents(m, d, who)
        cut ||= ev.cut
        const events: Array<unknown> = []
        for (const r of ev.show) {
          // An event of several days is listed on its first day in the range only.
          if (seen.has(reader.keyOf(r))) continue
          seen.add(reader.keyOf(r))
          shownRows.push(r)
          if (listed < AGENDA_ITEMS) {
            events.push(reader.shown(m, d, r))
            listed++
          } else more++
        }
        for (const r of ev.reduce) {
          if (seen.has(reader.keyOf(r))) continue
          seen.add(reader.keyOf(r))
          if (busy.length < REDUCED_ITEMS) busy.push({ day: reader.dayWords(m, d), ...reader.reduced(m, d, r) })
          else more++
        }
        for (const key of ev.withheldKeys) withheldKeys.add(key)
        if (events.length > 0) days.push({ day: reader.dayWords(m, d), events })
      }
      const stale = yield* reader.staleNote(m)
      const notes = {
        ...(withheldKeys.size > 0 ? { withheld: say(texts, m.lang, "withheld", { count: withheldKeys.size }) } : {}),
        ...(stale !== undefined ? { stale } : {}),
        ...(cut ? { cut: say(texts, m.lang, "cut") } : {})
      }
      if (days.length === 0 && busy.length === 0) {
        const when = count === 1 ? reader.dayWords(m, first) : `${reader.dayWords(m, first)} – ${reader.dayWords(m, addDays(first, count - 1))}`
        const nothing = who.kind === "person" ? say(texts, m.lang, "nothingOnFor", { name: who.name, Day: capital(when) }) : say(texts, m.lang, "nothingOn", { Day: capital(when) })
        return { spoken: [nothing, notes.withheld, notes.stale].filter((s) => s !== undefined).join(" ") }
      }
      const owner = ownerAmong(shownRows)
      return {
        ...(count === 1 ? { day: reader.dayWords(m, first), events: days[0]?.events ?? [] } : { days }),
        ...(busy.length > 0 ? { busy } : {}),
        ...(more > 0 ? { more } : {}),
        ...notes,
        untrusted: say(texts, m.lang, "untrusted"),
        ...(owner !== undefined ? { owner } : {})
      }
    })

  /** The first event from now (or, with `match`, the first that matches and has not ended). */
  const next = (input: { readonly match?: string; readonly who?: string }) =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const m = yield* reader.moment(turn)
      const pre = yield* reader.precheck(m)
      if (pre !== undefined) return { pre }
      const who = reader.resolveWho(m, input.who)
      if (isSpoken(who)) return { pre: who }
      let read = 0
      for (let k = 0; k <= WINDOW_DAYS && read < NEXT_ROWS; k++) {
        const d = addDays(m.today, k)
        const ev = yield* reader.dayEvents(m, d, who, { fromNow: true })
        read += ev.show.length + ev.reduce.length + ev.withheld
        const candidates = [
          ...ev.show.map((r) => ({ r, reduced: false })),
          // A reduced event is never matched by its title: a match would tell what it is called.
          ...(input.match === undefined ? ev.reduce.map((r) => ({ r, reduced: true })) : [])
        ]
          .filter(({ r }) => (input.match === undefined ? r.value.start >= m.now : matches(input.match, r)))
          .sort((a, b) => a.r.value.start - b.r.value.start)
        const hit = candidates[0]
        if (hit !== undefined) return { m, d, hit }
      }
      // Past the bound without a hit, it says so: a partial read is never "nothing in the next 62 days".
      return { m, none: true as const, cut: read >= NEXT_ROWS }
    })

  const nextResult = (input: { readonly match?: string; readonly who?: string }) =>
    Effect.gen(function*() {
      const found = yield* next(input)
      if ("pre" in found) return found.pre
      const m = found.m
      if ("none" in found) {
        if (found.cut) return { spoken: say(texts, m.lang, "nextCut", { count: NEXT_ROWS }) }
        return input.match === undefined
          ? { spoken: say(texts, m.lang, "nextNone", { days: WINDOW_DAYS }) }
          : { spoken: say(texts, m.lang, "nextNoneMatching", { match: input.match, days: WINDOW_DAYS }) }
      }
      const { d, hit } = found
      if (hit.reduced) {
        const red = reader.reduced(m, d, hit.r)
        return { busy: { day: reader.dayWords(m, d), ...red } }
      }
      const v = hit.r.value
      const w = wallTimeOf(v.start, m.zone)
      const startDay = dateOf(v.start, m.zone)
      const when = v.allDay ? `${reader.dayWords(m, startDay)}, ${say(texts, m.lang, "allDayBusy")}` : speakMoment({ date: startDay, time: { hour: w.hour, minute: w.minute } }, m.lang, m.today) ?? reader.dayWords(m, startDay)
      return {
        next: { title: reader.titleOf(m, hit.r), when, calendar: reader.calendarOf(m, hit.r), ...(v.location !== undefined ? { place: v.location } : {}) },
        untrusted: say(texts, m.lang, "untrusted"),
        ...(v.owner !== undefined ? { owner: v.owner } : {})
      }
    })

  const find = (input: { readonly text: string; readonly who?: string }) =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const m = yield* reader.moment(turn)
      const pre = yield* reader.precheck(m)
      if (pre !== undefined) return pre
      const who = reader.resolveWho(m, input.who)
      if (isSpoken(who)) return who
      const found: Array<unknown> = []
      const shownRows: Array<Row<Occurrence>> = []
      const seen = new Set<string>()
      let more = 0
      let hidden = false
      let read = 0
      let cut = false
      let after: Row<Occurrence> | undefined
      for (;;) {
        const page = yield* reader.rows.list({ orderBy: { field: "start" }, limit: 20, ...(after !== undefined ? { after } : {}) })
        read += page.length
        for (const r of page) {
          if (r.value.end <= m.now || !m.valid(r) || !reader.meant(who, r) || seen.has(reader.keyOf(r))) continue
          seen.add(reader.keyOf(r))
          // Only events that may be shown here are searched.
          if (m.visibility(r) !== "show" || (who.kind === "person" && who.reduced)) {
            hidden = true
            continue
          }
          if (!matches(input.text, r)) continue
          shownRows.push(r)
          if (found.length >= FIND_ITEMS) {
            more++
            continue
          }
          const d = dateOf(r.value.start, m.zone)
          const w = wallTimeOf(r.value.start, m.zone)
          found.push({
            title: reader.titleOf(m, r),
            when: r.value.allDay ? reader.dayWords(m, d) : speakMoment({ date: d, time: { hour: w.hour, minute: w.minute } }, m.lang, m.today) ?? reader.dayWords(m, d),
            calendar: reader.calendarOf(m, r),
            ...(r.value.location !== undefined ? { place: r.value.location } : {})
          })
        }
        if (page.length < 20) break
        if (read >= FIND_ROWS) {
          cut = (yield* reader.rows.list({ orderBy: { field: "start" }, limit: 1, after: page.at(-1)! })).length > 0
          break
        }
        after = page.at(-1)
      }
      const stale = yield* reader.staleNote(m)
      const notes = [hidden ? say(texts, m.lang, "notSearched") : undefined, stale, cut ? say(texts, m.lang, "cut") : undefined].filter((s): s is string => s !== undefined)
      if (found.length === 0) return { spoken: [say(texts, m.lang, "findNone", { text: input.text }), ...notes].join(" ") }
      const owner = ownerAmong(shownRows)
      return { found, ...(more > 0 ? { more } : {}), ...(notes.length > 0 ? { notes: notes.join(" ") } : {}), untrusted: say(texts, m.lang, "untrusted"), ...(owner !== undefined ? { owner } : {}) }
    })

  const free = (input: { readonly day?: string; readonly from?: string; readonly to?: string; readonly minMinutes?: number; readonly who?: string }) =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const m = yield* reader.moment(turn)
      const pre = yield* reader.precheck(m)
      if (pre !== undefined) return pre
      const who = reader.resolveWho(m, input.who)
      if (isSpoken(who)) return who
      const d = reader.resolveDay(m, input.day)
      if (isSpoken(d)) return d
      const from = parseClock(input.from ?? "08:00")!
      const to = parseClock(input.to ?? "21:00")!
      const at = (c: { hour: number; minute: number }) => (c.hour === 24 ? startOfDay(addDays(d, 1), m.zone) : instantOf({ ...d, hour: c.hour, minute: c.minute }, m.zone))
      const lo = at(from)
      const hi = at(to)
      if (hi <= lo) return { spoken: say(texts, m.lang, "badRange") }
      const ev = yield* reader.dayEvents(m, d, who, { withHousehold: true })
      const busyRows = [...ev.show, ...ev.reduce].filter((r) => r.value.busy)
      const intervals = busyRows.map((r) => [Math.max(lo, r.value.start), Math.min(hi, r.value.end)] as const).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
      const minMs = (input.minMinutes ?? 30) * 60_000
      const slots: Array<readonly [number, number]> = []
      let cursor = lo
      for (const [a, b] of intervals) {
        if (a - cursor >= minMs) slots.push([cursor, a])
        cursor = Math.max(cursor, b)
      }
      if (hi - cursor >= minMs) slots.push([cursor, hi])
      const Day = capital(reader.dayWords(m, d))
      const fromW = reader.timeOf(m, lo)
      const toW = reader.timeOf(m, hi)
      const sentence = slots.length === 0
        ? say(texts, m.lang, "freeNone", { Day, from: fromW, to: toW, minutes: input.minMinutes ?? 30 })
        : slots.length === 1 && slots[0]![0] === lo && slots[0]![1] === hi
        ? say(texts, m.lang, "freeAll", { Day, from: fromW, to: toW })
        : say(texts, m.lang, "freeList", { Day, list: speakList(slots.map(([a, b]) => say(texts, m.lang, "freeSlot", { from: reader.timeOf(m, a), to: reader.timeOf(m, b) })), m.lang, { max: 6 }) ?? "" })
      const stale = yield* reader.staleNote(m)
      // Only the events in the range that would have counted are left out of this answer.
      const left = ev.withheldRows.filter((r) => r.value.busy && r.value.start < hi && r.value.end > lo).length
      const withheld = left > 0 ? say(texts, m.lang, "withheld", { count: left }) : undefined
      // Whose busy time the answer is made of: only the events inside the range count.
      const owner = ownerAmong(ev.show.filter((r) => r.value.busy && r.value.start < hi && r.value.end > lo))
      return { spoken: [sentence, withheld, stale, ev.cut ? say(texts, m.lang, "cut") : undefined].filter((s) => s !== undefined).join(" "), ...(owner !== undefined ? { owner } : {}) }
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
      description: "The next event on the calendars, or the next one whose title or place has some words: \"when is the dentist\", \"what's next\".",
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

  /** A day's events as one or a few sentences: the events, who is busy when, what is not read out, what is stale. */
  const daySentence = (offset: number) =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      const m = yield* reader.moment(turn)
      const pre = yield* reader.precheck(m)
      if (pre !== undefined) return pre.spoken
      const d = addDays(m.today, offset)
      const ev = yield* reader.dayEvents(m, d, { kind: "all" })
      const parts: Array<string> = []
      const items = ev.show.slice(0, 100).map((r) => reader.item(m, d, r))
      const Day = capital(reader.dayWords(m, d))
      if (items.length > 0) parts.push(say(texts, m.lang, "dayList", { Day, list: speakList(items, m.lang, { max: 5 }) ?? "" }))
      for (const r of ev.reduce.slice(0, 3)) {
        const red = reader.reduced(m, d, r)
        parts.push(say(texts, m.lang, "busy", { name: red.busy, when: say(texts, m.lang, "busyFromTo", { from: red.from, to: red.to }) }))
      }
      if (parts.length === 0) parts.push(say(texts, m.lang, "nothingOn", { Day }))
      if (ev.withheld > 0) parts.push(say(texts, m.lang, "withheld", { count: ev.withheld }))
      const stale = yield* reader.staleNote(m)
      if (stale !== undefined) parts.push(stale)
      return parts.join(" ")
    })

  const failedAction = () => Effect.map(reader.moment(undefined), (m) => new ActionError({ message: say(texts, m.lang, "unreadable") }))
  const asAction = (e: Effect.Effect<string, unknown>) => e.pipe(Effect.map((s) => ({ say: s })), Effect.catch(() => Effect.flatMap(failedAction(), Effect.fail)))

  const nextSentence = (match: string | undefined) =>
    Effect.gen(function*() {
      const r = yield* nextResult(match !== undefined && match.trim() !== "" ? { match } : {})
      const lang = (yield* reader.moment(undefined)).lang
      if ("spoken" in r) return r.spoken
      if ("busy" in r) return say(texts, lang, "busy", { name: r.busy.busy, when: `${r.busy.day} ${say(texts, lang, "busyFromTo", { from: r.busy.from, to: r.busy.to })}` })
      return say(texts, lang, "nextIs", { title: r.next.title, when: r.next.when })
    })

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
      description: "Say the next event on the calendars. Not for a named event (\"when is the dentist\"): that is when_is.",
      examples: ["what's next on the calendar", "when is my next appointment", "what is my next appointment", "wat is mijn volgende afspraak", "wat staat er hierna in de agenda"],
      params: {},
      speculative: true,
      offerAsTool: false,
      run: () => asAction(nextSentence(undefined))
    }),
    defineAction({
      id: "when_is",
      label: "When is an event",
      description: "Say when the next event with some words in its title or place is (\"when is the dentist\").",
      examples: ["when is the dentist", "when is swimming", "wanneer is de tandarts", "wanneer is zwemmen"],
      params: { match: Param.text({ label: "Words of the title", after: ["when is", "when's", "wanneer is"], maxWords: 6 }) },
      speculative: true,
      offerAsTool: false,
      run: ({ match }) => asAction(nextSentence(match))
    })
  ]

  return { tools, actions, daySentence }
}

