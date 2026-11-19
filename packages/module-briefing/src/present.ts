import type { Presentation } from "@pva/core"
import { speakList, speakNumber } from "@pva/language"
import { type Language, say } from "@pva/module-contracts"
import { type Briefing, MAX_SECTIONS } from "./compose.ts"
import { texts } from "./texts.ts"

/** The most items a list holds, and the most characters of one item (docs/PRESENTING.md). */
const LIST_ITEMS = 12
const ITEM_CHARS = 80
/** What `spoken` may hold. */
const SPOKEN_CHARS = 300

const wording = (n: number, language: Language) => speakNumber(n, language, { words: true }) ?? String(n)

/** A line that fits an item whole: a bullet is never cut mid-sentence. */
const fits = (line: string): boolean => line.length <= ITEM_CHARS

/**
 * What a section puts on the list: its first sentence when that fits an item whole, else its title (a short label of
 * the contract's bounds, never cut). Never more than the section said.
 */
const bulletOf = (sentences: ReadonlyArray<string>, title: string): string => {
  const first = sentences[0]
  return first !== undefined && fits(first) ? first : title
}

/**
 * The transient list of what a briefing covers: one bullet per section that had something to say, in the briefing's
 * order, then short honest notes (failed sources, sections not asked, personal items kept back, preferences that could
 * not be read). `undefined` when no section had anything: there is nothing to show, and whatever an earlier briefing
 * showed no longer applies.
 *
 * Whole items are budgeted before rendering: the notes always fit, the sections take the rest, and the sections left
 * over are counted ("And two more.") rather than cut.
 *
 * Sensitivity is the briefing's: personal with the asker as owner when any personal content is in it, so the Presenter
 * asks `Privacy.mayReveal` for the device that would show it, at the moment of showing.
 */
export const briefingList = (briefing: Briefing, language: Language): Presentation | undefined => {
  const speaking = briefing.sections.filter((s) => s.sentences.length > 0)
  if (speaking.length === 0) return undefined
  const notes: Array<string> = []
  if (briefing.prefsUnread) notes.push(say(texts, language, "listPrefs"))
  if (briefing.failed.length > 0) {
    notes.push(
      briefing.failed.length === 1
        ? say(texts, language, "listFailedOne")
        : say(texts, language, "listFailed", { count: wording(briefing.failed.length, language) })
    )
  }
  if (briefing.notAsked > 0) notes.push(say(texts, language, "listNotAsked", { count: wording(briefing.notAsked, language), max: wording(MAX_SECTIONS, language) }))
  if (briefing.withheld > 0) notes.push(say(texts, language, "listWithheld"))
  const room = LIST_ITEMS - notes.length
  // All of them when they fit; else one place is kept for the count of those not shown.
  const shown = speaking.length <= room ? speaking : speaking.slice(0, room - 1)
  const items = [
    ...shown.map((s, i) => ({ id: `s${i + 1}`, text: bulletOf(s.sentences, s.title) })),
    ...(shown.length < speaking.length ? [{ id: "more", text: say(texts, language, "listMore", { count: wording(speaking.length - shown.length, language) }) }] : []),
    ...notes.map((text, i) => ({ id: `n${i + 1}`, text }))
  ]
  const titles = speakList(speaking.map((s) => s.title.toLocaleLowerCase(language)), language, { max: 4 })
  const covers = titles === undefined ? undefined : say(texts, language, "listCovers", { sections: titles })
  return {
    kind: "list",
    title: say(texts, language, "listTitle"),
    style: "bullets",
    items,
    spoken: covers !== undefined && covers.length <= SPOKEN_CHARS ? covers : say(texts, language, "listTitle"),
    ...(briefing.owner !== undefined ? { sensitivity: { personal: briefing.owner } } : {})
  }
}
