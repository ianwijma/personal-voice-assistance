import { ContributionKey, type TurnContext } from "@pva/core"
import { Data, type Effect } from "effect"
import type { Language } from "./common.ts"

/**
 * `BriefingSections`: one part of a spoken briefing ("rain from three", "two things on the calendar"), contributed by
 * the module that knows it (docs/MODULES-PLAN.md §5.2 and §5.1 row 17; docs/research/modules/briefing.md §5.1, §13).
 * Contributed by `weather` (in `packages/modules-builtin`), `bin-day`, `calendar`, `news`, `reminders` and later
 * `google`; collected by `briefing`, its only consumer. Six module PRs write against this at the same time.
 *
 * **How the briefing calls it.** Its tool, typed action or phrase command runs as the asking turn, so
 * `host.contributions(BriefingSections)` holds only the sections of modules **that turn's assistant has on**. It calls
 * every section's `gather` at once, each within `BRIEFING_LIMITS.gatherMs` (a section still running then is left out
 * and named once: "I couldn't get the news"), orders the results (the owner's order, then `lead` first), drops
 * `empty` ones without a word, and either joins the sentences itself (no model) or hands them to the model to word.
 *
 * **What a section must do in `gather`.**
 *
 * - **Use the asking turn** (`request.turn`; `gather` also runs with it as `CurrentTurn`): its assistant for
 *   `settingsFor(request.turn.assistantId)` (the weather of *this* assistant's place and units), asked at this call,
 *   never cached from an earlier one; its device for privacy.
 * - **Decide privacy at the moment of revealing**: personal content (an event in Sam's calendar, Sam's reminder) goes
 *   into a sentence only when `Privacy.mayReveal(owner, request.turn)` says yes now, on the turn's device; otherwise
 *   it is reduced ("Sam has two things today") or left out and counted in `withheld`. A result with personal content
 *   says whose (`owner`): one person's at most; a section never mixes two people's personal content in one result.
 * - **Be fast and local**: answer from the module's own cache or store (its job keeps it fresh); no network call on
 *   this path unless the cache is empty, and then within the budget. A section that has nothing to say returns
 *   `{ _tag: "empty" }`; one whose data is unavailable fails with `BriefingSectionError` (one spoken-safe sentence).
 * - **Speak in sentences**: at most `request.maxSentences` sentences (each at most `BRIEFING_LIMITS.sentenceChars`,
 *   one line, a complete sentence that reads well after another section's) in `request.language`, with numbers,
 *   times and dates worded by `@pva/language` (`speakTime`, `speakDate`, …) so every section sounds the same.
 *
 * **Lengths.** `short` is lead items only (one sentence), `normal` one or two sentences, `long` up to four; the
 * briefing passes the number as `maxSentences`.
 *
 * **Ids.** A section's `id` is its module's id, or the module's id, a dot and a name ("calendar", "weather.warnings"),
 * so two modules can never take the same one; `title` is a short label (at most `BRIEFING_LIMITS.titleChars`) for the
 * owner's ordering and for "skip the news".
 *
 * **When a module is off or stops**, its sections are not in the list; a `gather` that dies with `ModuleStopped`
 * (its module stopped during the briefing) is treated like one that failed.
 */
export const BRIEFING_LIMITS = { gatherMs: 800, sentenceChars: 300, titleChars: 40, maxSentences: 4 } as const

export type BriefingLength = "short" | "normal" | "long"

export interface BriefingRequest {
  /** The asking turn (its assistant, device, room and person). */
  readonly turn: TurnContext
  /** `morning` and `evening` from what was asked ("good morning"), else `on-request`. */
  readonly kind: "morning" | "evening" | "on-request"
  readonly length: BriefingLength
  /** 1 to `BRIEFING_LIMITS.maxSentences`. */
  readonly maxSentences: number
  readonly language: Language
  /** Epoch ms: the briefing's "now", the same for every section. */
  readonly now: number
}

export type BriefingSectionResult =
  | { readonly _tag: "empty" }
  | {
    readonly _tag: "section"
    readonly sentences: ReadonlyArray<string>
    /** `lead` items come first ("rain from three"); `filler` goes when time is short. */
    readonly priority: "lead" | "normal" | "filler"
    /** The person whose personal content the sentences hold, revealed by `Privacy.mayReveal`; absent: household only. */
    readonly owner?: string
    /** Personal items left out or reduced because they could not be revealed here. */
    readonly withheld: number
  }

/** The section could not be gathered; `message` is one sentence that can be spoken ("I couldn't check the bins."). */
export class BriefingSectionError extends Data.TaggedError("BriefingSectionError")<{
  readonly reason: "unavailable" | "failed"
  readonly message: string
}> {}

export interface BriefingSection {
  readonly id: string
  readonly title: string
  readonly gather: (request: BriefingRequest) => Effect.Effect<BriefingSectionResult, BriefingSectionError>
}

export const BriefingSections = ContributionKey<BriefingSection>("briefing.sections")
