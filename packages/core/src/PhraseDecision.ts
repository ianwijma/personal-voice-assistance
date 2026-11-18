import type { SttEvent } from "./Domain.ts"
import { type CommandSet, matchCommand, matchRinging, type PhraseLanguage, type PhraseMatch, type RingingCard, type RingingMatch } from "./Phrases.ts"
import type { RouteResult, RouteTarget } from "./RouteGate.ts"

/**
 * The one decision per utterance (docs/MODULES-PLAN.md §4 P7, "How one utterance is routed" and "One decision per
 * utterance", first version; docs/PHRASES.md): whether an utterance is **taken** (by the host's ringing window, by a host
 * control, or by a module's phrase command) or **not taken**. It is made once, at the utterance's final transcript
 * (`EndOfTurn`), by `decideUtterance`, and nothing else routes an utterance to a command.
 *
 * What it covers: every event of the utterance. The events before the final (speech start, interims, eager transcripts,
 * resumed) are passed on as before, since nobody can know earlier that they are a command: the start of speech may
 * interrupt a reply (barge-in) and an eager transcript may start a speculative turn. The final of a taken utterance
 * reaches the conversations with no words (`EndOfTurn ""`, the "utterance over, nothing to answer" of the `SttEvent`
 * contract), so it closes the utterance, discards that speculative turn and starts nothing: the utterance never becomes
 * a turn, nothing of it enters a conversation's history, and no tool that is not speculative runs for it (a speculative
 * turn holds such a call until it is promoted, which a blank final never does). The final of an utterance that is not
 * taken goes through the gates exactly as before; what the decision adds to it is a bounded, synchronous match.
 *
 * The route, in order (the windows of the plan's later text that are not built are left out):
 * 1. a wake phrase at the start leaves every window (step 5 then decides);
 * 2. the **ringing window** (the host's only window): while something rings on the device (the caller reads it now,
 *    from the notification service), unless the device's own spoken line was audible during the utterance or the
 *    device's setting is off (the caller passes `ringing: undefined` then), the whole utterance is "stop" or the label
 *    of a ringing notification's button → taken, before the echo gate (one word is not lost to its two-word rule); the
 *    gates then see a final with no words;
 * 3. otherwise the echo gate and the route gate run on the final (`gates`, once), as before;
 * 4. an `after-wake` command: when the route gate gave the final to an assistant (by its wake phrase, an armed or a
 *    follow-up window, or as the device's assistant without a phrase) or to TypeSafe (`decide`: the host's controls
 *    only, since its assistant is not known yet), and its words (the wake phrase removed) are one of that set's phrases →
 *    taken, its final passed on with no words; an utterance the route gate dropped (asleep, an assistant switched off) is
 *    never taken.
 */

/** What took an utterance. */
export type Taken =
  /** The ringing window: "stop" (what rings on the device) or a button of a ringing notification. */
  | { readonly by: "ringing"; readonly match: RingingMatch }
  /**
   * A host control or a module's command, after the wake phrase or in a follow-up window. `assistant`: the one the route
   * gate gave the utterance to (`undefined` for a `decide` target: the device's answering assistant speaks).
   */
  | { readonly by: "phrase"; readonly assistant: string | undefined; readonly route: RouteTarget; readonly match: PhraseMatch; readonly text: string }

export interface UtteranceFacts {
  /** The utterance's final transcript, as the recogniser sent it. */
  readonly final: Extract<SttEvent, { readonly _tag: "EndOfTurn" }>
  /** The household's language now (which phrases are matched). */
  readonly language: PhraseLanguage
  /**
   * The ringing window for this utterance, read now: what rings on the device (oldest first), or `undefined` when the
   * window is closed (nothing rings, the device's "while ringing" setting is off, or the device was audible during the
   * utterance: its own spoken line may be what was heard).
   */
  readonly ringing: ReadonlyArray<RingingCard> | undefined
  /** Whether a wake phrase of the device starts the text (it leaves every window). Called only while something rings. */
  readonly wakeAtStart: (text: string) => boolean
  /** The echo gate and then the route gate on one event: called exactly once, with the final or with a blank one. */
  readonly gates: (final: SttEvent) => ReadonlyArray<RouteResult>
  /** The commands of `assistant` now (`undefined`: the host's controls alone). Called at most once. */
  readonly commandsFor: (assistant: string | undefined) => CommandSet
}

export interface UtteranceDecision {
  /** The route gate's results to dispatch, in order: the final with no words when the utterance was taken. */
  readonly results: ReadonlyArray<RouteResult>
  /** What took it; absent: not taken (the results are exactly the gates' own). */
  readonly taken?: Taken
}

const blankFinal = (final: Extract<SttEvent, { readonly _tag: "EndOfTurn" }>): SttEvent => (final.text === "" ? final : { _tag: "EndOfTurn", text: "" })

/** THE decision (see the module comment). Pure but for the two callbacks, each called at most once. */
export const decideUtterance = (facts: UtteranceFacts): UtteranceDecision => {
  const text = facts.final.text
  if (text.trim().length === 0) return { results: facts.gates(facts.final) }
  if (facts.ringing !== undefined && facts.ringing.length > 0 && !facts.wakeAtStart(text)) {
    const match = matchRinging(facts.language, text, facts.ringing)
    if (match !== undefined) return { results: facts.gates(blankFinal(facts.final)), taken: { by: "ringing", match } }
  }
  const results = facts.gates(facts.final)
  // The result that carries the final (the last one with an `EndOfTurn`).
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]!
    const at = r.events.findIndex((e) => e._tag === "EndOfTurn")
    if (at < 0) continue
    const final = r.events[at] as Extract<SttEvent, { readonly _tag: "EndOfTurn" }>
    const route = r.target
    if (route === undefined || route.by === "dropped" || final.text.trim().length === 0) return { results }
    const assistant = route.by === "decide" ? undefined : route.assistant
    const match = matchCommand(facts.commandsFor(assistant), final.text)
    if (match === undefined) return { results }
    const blanked: RouteResult = { ...r, events: r.events.map((e, j) => (j === at ? { _tag: "EndOfTurn", text: "" } : e)) }
    return { results: results.map((x, j) => (j === i ? blanked : x)), taken: { by: "phrase", assistant, route, match, text: final.text } }
  }
  return { results }
}
