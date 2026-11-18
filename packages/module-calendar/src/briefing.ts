import { BRIEFING_LIMITS, type BriefingRequest, type BriefingSection, BriefingSectionError, type BriefingSectionResult, say } from "@pva/module-contracts"
import { speakList } from "@pva/language"
import { Effect } from "effect"
import { capital, type Reader } from "./read.ts"
import { texts } from "./texts.ts"
import { addDays, dateOf } from "./time.ts"

/**
 * The calendar's part of a briefing (`packages/module-contracts/src/briefing.ts`): today's events (tomorrow's in the
 * evening), in one sentence of at most `BRIEFING_LIMITS.sentenceChars`, from the store's cache.
 *
 * Privacy, the conservative reading of the contract: the household's events, and the asking person's own events when
 * `Privacy.mayReveal(person, request.turn)` says yes now (`owner` then names them). Every other member's event is only
 * counted in `withheld`, never reduced to "Robin has two things": a result holds one person's content at most, and the
 * asking person's comes first. A turn without a person gets the household's events only.
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
      const pre = yield* reader.precheck(m)
      if (pre !== undefined) return yield* Effect.fail(new BriefingSectionError({ reason: "unavailable", detail: "no calendar has been read yet" }))
      const evening = request.kind === "evening"
      const today = dateOf(request.now, m.zone)
      const d = evening ? addDays(today, 1) : today
      const person = request.turn.person?.id
      const own = person !== undefined && m.mayReveal(person) ? person : undefined
      const read = yield* reader.readDay(d)
      const seen = new Set<string>()
      const listed: Array<(typeof read.rows)[number]> = []
      const withheld = new Set<string>()
      for (const r of read.rows) {
        if (!m.valid(r) || (!evening && r.value.end <= request.now)) continue
        const key = reader.keyOf(r)
        if (seen.has(key)) continue
        seen.add(key)
        if (r.value.owner === undefined || r.value.owner === own) listed.push(r)
        else withheld.add(key)
      }
      if (listed.length === 0 && withheld.size === 0) return { _tag: "empty" } satisfies BriefingSectionResult
      const sentences: Array<string> = []
      if (listed.length > 0) {
        const Day = capital(reader.dayWords(m, d))
        // Shorter titles, then fewer items, until the sentence fits the bound (titles of 30 and two items always fit).
        fit: for (const max of [ITEMS[request.length], 2]) {
          for (const titleChars of [60, 30]) {
            const items = listed.slice(0, 100).map((r) => reader.item(m, d, r, titleChars))
            const list = speakList(items, m.lang, { max }) ?? ""
            const s = evening ? say(texts, m.lang, "briefingTomorrow", { list }) : say(texts, m.lang, "briefingDay", { Day, list })
            if (s.length <= BRIEFING_LIMITS.sentenceChars) {
              sentences.push(s)
              break fit
            }
          }
        }
        if (sentences.length === 0) return yield* Effect.fail(new BriefingSectionError({ reason: "failed", detail: "no sentence fits the bound" }))
      }
      const stale = yield* reader.staleNote(m)
      if (stale !== undefined && sentences.length < request.maxSentences && stale.length <= BRIEFING_LIMITS.sentenceChars) sentences.push(stale)
      const shownOwn = own !== undefined && listed.some((r) => r.value.owner === own)
      return {
        _tag: "section",
        sentences: sentences.slice(0, request.maxSentences),
        priority: "normal",
        withheld: Math.min(withheld.size, BRIEFING_LIMITS.maxWithheld),
        ...(shownOwn ? { owner: own } : {})
      } satisfies BriefingSectionResult
    }).pipe(
      Effect.catch((e) => (e instanceof BriefingSectionError ? Effect.fail(e) : Effect.fail(new BriefingSectionError({ reason: "failed", detail: "the calendar cache could not be read" }))))
    )
})
