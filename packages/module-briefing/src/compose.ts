import { CurrentTurn, type TurnContext } from "@pva/core"
import { speakList, speakNumber } from "@pva/language"
import {
  BRIEFING_LIMITS,
  type BriefingLength,
  type BriefingRequest,
  type BriefingSection,
  type BriefingSectionResult,
  isLine,
  type Language,
  say
} from "@pva/module-contracts"
import { Cause, Clock, Effect } from "effect"
import { texts } from "./texts.ts"

/** The most sections one briefing gathers: the rest of a longer list is not asked (a bound on the fan-out), and said. */
export const MAX_SECTIONS = 20

/** Sentences a section may give, by length (`short` is lead items only: one sentence). */
export const SENTENCES: Readonly<Record<BriefingLength, number>> = { short: 1, normal: 2, long: 4 }

export type Kind = BriefingRequest["kind"]

/** A contributed section id, as the contract bounds it: at most `idChars` of `[a-z0-9.-]`. */
const CONTRIBUTED_ID = new RegExp(`^[a-z0-9.-]{1,${BRIEFING_LIMITS.idChars}}$`)

export interface GatheredSection {
  readonly id: string
  readonly title: string
  readonly sentences: ReadonlyArray<string>
  readonly priority: "lead" | "normal" | "filler"
  readonly owner?: string
  readonly withheld: number
}

/** Why a briefing has no section to ask; each has its own sentence. */
export type NoneAsked =
  /** No module of the turn's assistant offers a section. */
  | "noSources"
  /** `only` named sections, and none of them is on now. */
  | "noneMatched"
  /** There are sections, and the person's or the household's skips (after `only`) leave out every one. */
  | "allSkipped"

export interface Briefing {
  readonly kind: Kind
  readonly length: BriefingLength
  /** In the order they are spoken. */
  readonly sections: ReadonlyArray<GatheredSection>
  /** Labels of sections that failed, ran past the time limit, or broke the contract's bounds (a safe label then). */
  readonly failed: ReadonlyArray<string>
  /** Set when no section was asked at all, and why. */
  readonly none?: NoneAsked
  /** Sections that applied but were not asked because of `MAX_SECTIONS`. */
  readonly notAsked: number
  /** Personal items left out or reduced, summed over the sections spoken (never worded with a name). */
  readonly withheld: number
  /** The asking person, when any spoken section holds their personal content (the only personal content kept). */
  readonly owner?: string
  /** The person's preferences could not be read, so the defaults were used (said, never silent). */
  readonly prefsUnread: boolean
}

const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const PRIORITY_RANK = { lead: 0, normal: 1, filler: 2 } as const

/** A section id is matched by itself or by the module it belongs to: `weather` matches `weather.warnings` too. */
export const matchesId = (id: string, wanted: string): boolean => id === wanted || id.startsWith(`${wanted}.`)

/** Whether any of `ids` matches `id` (itself or a broader id). */
export const mentioned = (ids: ReadonlyArray<string>, id: string): boolean => ids.some((w) => matchesId(id, w))

/** Whether a contribution keeps the contract's bounds for its metadata: its id, its one-line title, its `gather`. */
export const wellFormed = (s: unknown): s is BriefingSection => {
  if (typeof s !== "object" || s === null) return false
  const { id, title, gather } = s as Partial<BriefingSection>
  return typeof id === "string" && CONTRIBUTED_ID.test(id) && typeof title === "string" && title.trim() !== "" && isLine(title, BRIEFING_LIMITS.titleChars) &&
    typeof gather === "function"
}

/** What a section answered, if it keeps the contract's bounds; `undefined` when it does not (treated as failed). */
const checked = (result: BriefingSectionResult, maxSentences: number): GatheredSection | "empty" | undefined => {
  if (typeof result !== "object" || result === null) return undefined
  if (result._tag === "empty") return "empty"
  if (result._tag !== "section") return undefined
  const { sentences, priority, owner, withheld } = result
  if (!Array.isArray(sentences) || sentences.length > maxSentences) return undefined
  if (!sentences.every((s) => typeof s === "string" && s.trim() !== "" && isLine(s, BRIEFING_LIMITS.sentenceChars))) return undefined
  if (priority !== "lead" && priority !== "normal" && priority !== "filler") return undefined
  if (!Number.isInteger(withheld) || withheld < 0 || withheld > BRIEFING_LIMITS.maxWithheld) return undefined
  if (owner !== undefined && (typeof owner !== "string" || !PERSON_ID.test(owner))) return undefined
  if (sentences.length === 0 && withheld === 0) return "empty"
  return { id: "", title: "", sentences: sentences.map((s) => s.trim()), priority, withheld, ...(owner !== undefined ? { owner } : {}) }
}

/** One section's answer, within its time. Anything but a section or "empty" is a failure; interruption passes through. */
const gatherOne = (section: BriefingSection, request: BriefingRequest) =>
  Effect.suspend(() => section.gather(request)).pipe(
    Effect.timeoutOption(BRIEFING_LIMITS.gatherMs),
    Effect.map((answer) => (answer._tag === "None" ? undefined : checked(answer.value, request.maxSentences))),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        // A typed failure, a defect, a provider stopping mid-call (`ModuleStopped`): the section is named as failed, once.
        : Effect.succeed(undefined)
    ),
    Effect.map((answer) => ({ section, answer }))
  )

/** The place of an id in the owner's order: its first matching entry, else after every listed one. */
const placeOf = (order: ReadonlyArray<string>) => (id: string): number => {
  const at = order.findIndex((w) => matchesId(id, w))
  return at === -1 ? order.length : at
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export interface Selection {
  /** The sections to ask, in the owner's order, at most `MAX_SECTIONS`. */
  readonly asked: ReadonlyArray<BriefingSection>
  /** How many more applied and were not asked (the cap). */
  readonly notAsked: number
  /** Contributions whose metadata breaks the contract and that would otherwise apply: counted as failed. */
  readonly malformed: number
  readonly none?: NoneAsked
}

/**
 * The sections that apply (well formed, not skipped, inside `only`), ordered by the owner's order and then by id, and
 * only then cut to `MAX_SECTIONS`: the cap never decides which of the owner's sections are left out by contribution
 * order, and what it leaves out is counted.
 */
export const select = (all: ReadonlyArray<BriefingSection>, skip: ReadonlyArray<string>, only: ReadonlyArray<string> | undefined, order: ReadonlyArray<string>): Selection => {
  if (all.length === 0) return { asked: [], notAsked: 0, malformed: 0, none: "noSources" }
  const seen = new Set<string>()
  const inOnly: Array<BriefingSection> = []
  let malformed = 0
  for (const s of all) {
    if (!wellFormed(s)) {
      // It cannot be named, skipped or chosen by id: with `only` it is not among those asked for; otherwise it is a failure.
      if (only === undefined) malformed++
      continue
    }
    if (seen.has(s.id)) continue // a repeated id (two modules claiming one): the first only
    seen.add(s.id)
    if (only !== undefined && !mentioned(only, s.id)) continue
    inOnly.push(s)
  }
  const kept = inOnly.filter((s) => !mentioned(skip, s.id))
  const place = placeOf(order)
  const sorted = [...kept].sort((a, b) => place(a.id) - place(b.id) || byId(a.id, b.id))
  const asked = sorted.slice(0, MAX_SECTIONS)
  const none: NoneAsked | undefined = asked.length > 0 || malformed > 0 ? undefined : only !== undefined && inOnly.length === 0 ? "noneMatched" : "allSkipped"
  return { asked, notAsked: sorted.length - asked.length, malformed, ...(none !== undefined ? { none } : {}) }
}

/** Lead first, then normal, filler last; within each, the owner's order, then by id. */
const ordered = (sections: ReadonlyArray<GatheredSection>, order: ReadonlyArray<string>): ReadonlyArray<GatheredSection> => {
  const place = placeOf(order)
  return [...sections].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || place(a.id) - place(b.id) || byId(a.id, b.id))
}

export interface ComposeInput {
  readonly kind: Kind
  readonly length: BriefingLength
  readonly skip: ReadonlyArray<string>
  /** Absent: every section. Present: only these (an empty list matches nothing). */
  readonly only?: ReadonlyArray<string> | undefined
  readonly order: ReadonlyArray<string>
  readonly language: Language
  readonly turn: TurnContext | undefined
  readonly sections: ReadonlyArray<BriefingSection>
  readonly prefsUnread?: boolean
}

/**
 * Gather every section at once, each within `BRIEFING_LIMITS.gatherMs`: the total is about one section's limit, never
 * the sum. A section that fails, is late or answers outside the contract's bounds is named once; an empty one is
 * dropped without a word.
 *
 * **Whose briefing it is.** A briefing is the asking person's: it keeps household content and personal content whose
 * owner is the turn's person, as each section returned it after its own privacy check for the asking device (a count
 * the section reduced to included). A section's result owned by anyone else, or any owned result when the turn has no
 * person, is left out without a word: not counted, not mentioned.
 */
export const compose = (input: ComposeInput): Effect.Effect<Briefing> =>
  Effect.gen(function*() {
    const turn = input.turn ?? (yield* CurrentTurn)
    const prefsUnread = input.prefsUnread === true
    const base = { kind: input.kind, length: input.length, prefsUnread }
    const selection = select(input.sections, input.skip, input.only, input.order)
    const unnamed = say(texts, input.language, "unnamedSource")
    const malformed = Array.from({ length: selection.malformed }, () => unnamed)
    if (selection.none !== undefined) return { ...base, sections: [], failed: [], none: selection.none, notAsked: 0, withheld: 0 }
    // No turn (nothing to ask for, and no device to decide privacy on): nothing is gathered.
    if (turn === undefined) return { ...base, sections: [], failed: [], notAsked: 0, withheld: 0 }
    const now = yield* Clock.currentTimeMillis
    const request: BriefingRequest = { turn, kind: input.kind, length: input.length, maxSentences: SENTENCES[input.length], language: input.language, now }
    const answers = yield* Effect.forEach(selection.asked, (s) => gatherOne(s, request), { concurrency: "unbounded" })
    const asker = turn.person?.id
    const failed: Array<string> = [...malformed]
    const kept: Array<GatheredSection> = []
    for (const { section, answer } of answers) {
      if (answer === undefined) {
        failed.push(section.title.trim())
        continue
      }
      if (answer === "empty") continue
      // Someone else's personal content, or anyone's when nobody is asking: not this person's briefing. Left out quietly.
      if (answer.owner !== undefined && answer.owner !== asker) continue
      kept.push({ ...answer, id: section.id, title: section.title.trim() })
    }
    // Filler is for when there is time: only the long briefing has it.
    let sections = ordered(kept, input.order).filter((s) => input.length === "long" || s.priority !== "filler")
    // `short` is lead items only; with none, the first section that has a sentence, so a short briefing is never silent.
    if (input.length === "short") {
      const leads = sections.filter((s) => s.priority === "lead")
      const speaking = sections.find((s) => s.sentences.length > 0)
      sections = leads.length > 0 ? leads : speaking !== undefined ? [speaking] : sections.slice(0, 1)
    }
    const withheld = sections.reduce((n, s) => n + s.withheld, 0)
    const owner = sections.some((s) => s.owner !== undefined) ? asker : undefined
    return { ...base, sections, failed, notAsked: selection.notAsked, withheld, ...(owner !== undefined ? { owner } : {}) }
  })

/** A list of labels as the language says it, every one named (no "and two more"). */
export const allOf = (items: ReadonlyArray<string>, language: Language): string => speakList(items, language, { max: Math.max(2, items.length) }) ?? items.join(", ")

/** The sentences the module itself adds: the preferences that could not be read, what failed, the cap, what was held back. */
export const notes = (briefing: Briefing, language: Language) => {
  const failed = briefing.failed.length > 0 ? say(texts, language, "failed", { titles: allOf(briefing.failed.map((t) => t.toLocaleLowerCase(language)), language) }) : undefined
  const notAsked = briefing.notAsked === 0
    ? undefined
    : say(texts, language, briefing.notAsked === 1 ? "notAskedOne" : "notAsked", { count: speakNumber(briefing.notAsked, language, { words: true }) ?? String(briefing.notAsked), max: speakNumber(MAX_SECTIONS, language, { words: true }) ?? String(MAX_SECTIONS) })
  return {
    prefsUnread: briefing.prefsUnread ? say(texts, language, "prefsUnread") : undefined,
    failed,
    notAsked,
    withheld: briefing.withheld > 0 ? say(texts, language, "withheld") : undefined
  }
}

/** The one sentence for a briefing with nothing to say, or `undefined` when it has something. */
export const emptyLine = (briefing: Briefing, language: Language): string | undefined => {
  if (briefing.none !== undefined) return say(texts, language, briefing.none)
  return briefing.sections.length === 0 && briefing.failed.length === 0 && briefing.withheld === 0 && briefing.notAsked === 0 ? say(texts, language, "nothing") : undefined
}

/** The template join: no model. Greeting for morning and evening, the sections' sentences, what failed, what was held back. */
export const join = (briefing: Briefing, language: Language): string => {
  const n = notes(briefing, language)
  const parts: Array<string> = []
  if (n.prefsUnread !== undefined) parts.push(n.prefsUnread)
  const empty = emptyLine(briefing, language)
  if (briefing.none !== undefined && empty !== undefined) return [...parts, empty].join(" ")
  if (briefing.kind === "morning") parts.push(say(texts, language, "morning"))
  if (briefing.kind === "evening") parts.push(say(texts, language, "evening"))
  for (const s of briefing.sections) parts.push(...s.sentences)
  for (const line of [n.failed, n.notAsked, n.withheld]) if (line !== undefined) parts.push(line)
  if (empty !== undefined) parts.push(empty)
  return parts.join(" ")
}
