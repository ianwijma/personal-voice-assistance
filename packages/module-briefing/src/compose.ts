import { CurrentTurn, type TurnContext } from "@pva/core"
import { speakList } from "@pva/language"
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

/** The most sections one briefing gathers: the rest of a longer list is not asked (a bound on the fan-out). */
export const MAX_SECTIONS = 20

/** Sentences a section may give, by length (`short` is lead items only: one sentence). */
export const SENTENCES: Readonly<Record<BriefingLength, number>> = { short: 1, normal: 2, long: 4 }

export type Kind = BriefingRequest["kind"]

export interface GatheredSection {
  readonly id: string
  readonly title: string
  readonly sentences: ReadonlyArray<string>
  readonly priority: "lead" | "normal" | "filler"
  readonly owner?: string
  readonly withheld: number
}

export interface Briefing {
  readonly kind: Kind
  readonly length: BriefingLength
  /** In the order they are spoken. */
  readonly sections: ReadonlyArray<GatheredSection>
  /** The titles of sections that failed, ran past the time limit, or answered outside the contract's bounds. */
  readonly failed: ReadonlyArray<string>
  /** True when there was no section to ask at all (every source module is off, or the person skipped them all). */
  readonly noSources: boolean
  /** Personal items left out or reduced, summed over the sections spoken (never worded with a name). */
  readonly withheld: number
  /** The member whose personal content the sections hold (the turn's person), when any does. */
  readonly owner?: string
}

const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
const PRIORITY_RANK = { lead: 0, normal: 1, filler: 2 } as const

/** A section id is skipped by itself or by the module it belongs to: skipping `weather` skips `weather.warnings` too. */
export const matchesId = (id: string, wanted: string): boolean => id === wanted || id.startsWith(`${wanted}.`)

const mentioned = (ids: ReadonlyArray<string>, id: string): boolean => ids.some((w) => matchesId(id, w))

/** What a section answered, if it keeps the contract's bounds; `undefined` when it does not (treated as failed). */
const checked = (result: BriefingSectionResult, maxSentences: number): GatheredSection | "empty" | undefined => {
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

/** The sections that apply (not skipped, not outside `only`), at most `MAX_SECTIONS`, in the order they are gathered. */
const chosen = (all: ReadonlyArray<BriefingSection>, skip: ReadonlyArray<string>, only: ReadonlyArray<string>): ReadonlyArray<BriefingSection> => {
  const seen = new Set<string>()
  const out: Array<BriefingSection> = []
  for (const s of all) {
    if (typeof s?.id !== "string" || seen.has(s.id)) continue // a repeated id (two modules claiming one): the first only
    seen.add(s.id)
    if (mentioned(skip, s.id)) continue
    if (only.length > 0 && !mentioned(only, s.id)) continue
    out.push(s)
    if (out.length === MAX_SECTIONS) break
  }
  return out
}

/** The owner's order first (listed ids, then the rest by id), lead sections before the others, filler last. */
const ordered = (sections: ReadonlyArray<GatheredSection>, order: ReadonlyArray<string>): ReadonlyArray<GatheredSection> => {
  const place = (id: string): number => {
    const at = order.findIndex((w) => matchesId(id, w))
    return at === -1 ? order.length : at
  }
  return [...sections].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || place(a.id) - place(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export interface ComposeInput {
  readonly kind: Kind
  readonly length: BriefingLength
  readonly skip: ReadonlyArray<string>
  readonly only: ReadonlyArray<string>
  readonly order: ReadonlyArray<string>
  readonly language: Language
  readonly turn: TurnContext | undefined
  readonly sections: ReadonlyArray<BriefingSection>
}

/**
 * Gather every section at once, each within `BRIEFING_LIMITS.gatherMs`: the total is about one section's limit, never
 * the sum. A section that fails, is late or answers outside the contract's bounds is named once; an empty one is
 * dropped without a word. The sections of another person than the turn's are never kept (conservative reading, see the
 * module's page): their items count as withheld.
 */
export const compose = (input: ComposeInput): Effect.Effect<Briefing> =>
  Effect.gen(function*() {
    const turn = input.turn ?? (yield* CurrentTurn)
    const asked = chosen(input.sections, input.skip, input.only)
    if (turn === undefined || asked.length === 0) return { kind: input.kind, length: input.length, sections: [], failed: [], noSources: true, withheld: 0 }
    const now = yield* Clock.currentTimeMillis
    const request: BriefingRequest = { turn, kind: input.kind, length: input.length, maxSentences: SENTENCES[input.length], language: input.language, now }
    const answers = yield* Effect.forEach(asked, (s) => gatherOne(s, request), { concurrency: "unbounded" })
    const failed: Array<string> = []
    const kept: Array<GatheredSection> = []
    let strangers = 0
    for (const { section, answer } of answers) {
      if (answer === undefined) {
        failed.push(String(section.title).slice(0, BRIEFING_LIMITS.titleChars))
        continue
      }
      if (answer === "empty") continue
      if (answer.owner !== undefined && answer.owner !== turn.person?.id) {
        strangers += Math.max(1, answer.withheld)
        continue
      }
      kept.push({ ...answer, id: section.id, title: String(section.title).slice(0, BRIEFING_LIMITS.titleChars) })
    }
    let sections = ordered(kept, input.order)
    // `short` is lead items only; with none, the first section alone, so a short briefing is never silent.
    if (input.length === "short") {
      const leads = sections.filter((s) => s.priority === "lead")
      sections = leads.length > 0 ? leads : sections.slice(0, 1)
    }
    // Filler is for when there is time: only the long briefing has it.
    if (input.length !== "long") sections = sections.filter((s) => s.priority !== "filler")
    const withheld = sections.reduce((n, s) => n + s.withheld, 0) + strangers
    const owner = sections.find((s) => s.owner !== undefined)?.owner
    return { kind: input.kind, length: input.length, sections, failed, noSources: false, withheld, ...(owner !== undefined ? { owner } : {}) }
  })

/** The template join: no model. Greeting for morning and evening, the sections' sentences, what failed, what was held back. */
export const join = (briefing: Briefing, language: Language): string => {
  if (briefing.noSources) return say(texts, language, "noSources")
  const parts: Array<string> = []
  if (briefing.kind === "morning") parts.push(say(texts, language, "morning"))
  if (briefing.kind === "evening") parts.push(say(texts, language, "evening"))
  for (const s of briefing.sections) parts.push(...s.sentences)
  if (briefing.failed.length > 0) {
    const titles = speakList(briefing.failed.map((t) => t.toLocaleLowerCase(language)), language, { max: 6 }) ?? ""
    parts.push(say(texts, language, "failed", { titles }))
  }
  if (briefing.withheld > 0) parts.push(say(texts, language, "withheld"))
  const spoken = briefing.sections.length === 0 && briefing.failed.length === 0 && briefing.withheld === 0
  if (spoken) parts.push(say(texts, language, "nothing"))
  return parts.join(" ")
}
