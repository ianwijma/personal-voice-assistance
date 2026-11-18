import { BRIEFING_LIMITS, type BriefingRequest, type BriefingSection, BriefingSectionError, type BriefingSectionResult, say } from "@pva/module-contracts"
import { Effect } from "effect"
import { capital, identityOf, noteList, type Reader, type Who } from "./read.ts"
import type { Occurrence } from "./store.ts"
import { texts } from "./texts.ts"
import { addDays, dateOf, type LocalDate } from "./time.ts"
import type { Row } from "@pva/core"

/**
 * The calendar's part of a briefing (`packages/module-contracts/src/briefing.ts`): today's events (tomorrow's in the
 * evening), from the store's cache, in at most `request.maxSentences` sentences of at most
 * `BRIEFING_LIMITS.sentenceChars`.
 *
 * Privacy, decided after the read for the asking turn: the household's events, and the asking person's own when
 * `Privacy.mayReveal(person, request.turn)` says yes (`owner` then names them); the asking person's events that may
 * not be revealed on this device (a public screen whose default person is known) are only counted in `withheld`.
 * Other members' events are not gathered at all. A turn without a person gets the household's events only.
 *
 * What `coverage` says must be said (a calendar that could not be refreshed, one read only in part, one not read,
 * a day read only in part, an event going on after the days kept) is part of the section, never left over: with room
 * for one sentence it is in that sentence, and when it cannot be said within the bounds the section fails.
 */

/** Events listed by length; the rest are "and N more". */
const ITEMS = { short: 2, normal: 3, long: 5 } as const

export const makeBriefingSection = (reader: Reader): BriefingSection => ({
  id: "calendar",
  title: "Calendar",
  gather: (request: BriefingRequest) =>
    Effect.gen(function*() {
      const m = yield* reader.moment(request.turn, request.language)
      if (m.configs.length === 0) return { _tag: "empty" } satisfies BriefingSectionResult
      const evening = request.kind === "evening"
      const today = dateOf(request.now, m.zone)
      const d: LocalDate = evening ? addDays(today, 1) : today
      const { states, value: day } = yield* reader.consistent(() => reader.readDay(d))
      // Every read is done: who may hear what is decided now, for the asking turn.
      const v = reader.view(m, states)
      const person = request.turn.person?.id
      const who: Who = person !== undefined ? { kind: "person", id: person, name: v.nameOf(person) } : { kind: "household" }
      const covered = v.relevant(who, true)
      if (v.precheck(covered) !== undefined) return yield* Effect.fail(new BriefingSectionError({ reason: "unavailable", detail: "no calendar of the briefing has been read yet" }))
      const own = person !== undefined && v.mayReveal(person) ? person : undefined
      const seen = new Set<string>()
      const listed: Array<Row<Occurrence>> = []
      const withheld = new Set<string>()
      for (const r of day.rows) {
        if (!v.ok(r) || (!evening && r.value.end <= request.now)) continue
        const id = identityOf(r)
        if (seen.has(id)) continue
        seen.add(id)
        if (r.value.owner === undefined || r.value.owner === own) listed.push(r)
        else if (person !== undefined && r.value.owner === person) withheld.add(id)
        // Anyone else's: not this briefing's.
      }
      const max = ITEMS[request.length]
      const continuesAfter = listed.slice(0, max).map((r) => v.beyondDay(r)).find((x) => x !== undefined)
      const caveats = noteList(v.coverage(covered, { cut: day.cut, ...(continuesAfter !== undefined ? { continuesAfter } : {}) }))
      if (listed.length === 0 && caveats.length === 0) {
        // Only the asking person's own events, which cannot be read out here: counted, nothing said.
        if (withheld.size > 0) return { _tag: "section", sentences: [], priority: "normal", withheld: Math.min(withheld.size, BRIEFING_LIMITS.maxWithheld) } satisfies BriefingSectionResult
        return { _tag: "empty" } satisfies BriefingSectionResult
      }
      const Day = capital(v.dayWords(d))
      /** The events in one sentence, with titles of at most `titleChars` and at most `n` items. */
      const eventsSentence = (n: number, titleChars: number) => {
        if (listed.length === 0) return `${say(texts, m.lang, "briefingNothing", { Day })}.`
        const list = v.listOf(listed.slice(0, n).map((r) => v.item(d, r, titleChars)), listed.length, n)
        return evening ? say(texts, m.lang, "briefingTomorrow", { list }) : say(texts, m.lang, "briefingDay", { Day, list })
      }
      const fits = (s: string) => s.length <= BRIEFING_LIMITS.sentenceChars
      /** Sentences as one: "Today on the calendar: Dentist at two o'clock; Family could not be refreshed since …". */
      const joined = (list: ReadonlyArray<string>) => `${list.map((s) => s.replace(/\.$/, "")).join("; ")}.`
      // Fewer items and shorter titles until it fits; the caveats are never dropped.
      const tries = [...new Set([max, 2, 1])].flatMap((n) => [60, 30].map((t) => [n, t] as const))
      let sentences: Array<string> | undefined
      for (const [n, t] of tries) {
        const all = [eventsSentence(n, t), ...caveats]
        const keep = request.maxSentences - 1
        const shaped = all.length <= request.maxSentences ? all : [...all.slice(0, keep), joined(all.slice(keep))]
        if (shaped.every(fits)) {
          sentences = shaped
          break
        }
      }
      // What must be said cannot be said in the room given: the section is unavailable rather than said without it.
      if (sentences === undefined) return yield* Effect.fail(new BriefingSectionError({ reason: "unavailable", detail: "the events and what must be said with them do not fit the sentences given" }))
      const shownOwn = own !== undefined && listed.some((r) => r.value.owner === own)
      return {
        _tag: "section",
        sentences,
        priority: "normal",
        withheld: Math.min(withheld.size, BRIEFING_LIMITS.maxWithheld),
        ...(shownOwn ? { owner: own } : {})
      } satisfies BriefingSectionResult
    }).pipe(
      Effect.catch((e) => (e instanceof BriefingSectionError ? Effect.fail(e) : Effect.fail(new BriefingSectionError({ reason: "failed", detail: "the calendar cache could not be read" }))))
    )
})
