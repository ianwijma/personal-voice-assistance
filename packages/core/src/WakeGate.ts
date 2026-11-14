import {
  type Activation,
  CLOSE_MATCH_MIN_LETTERS,
  DEFAULT_DEVICE_PROFILE,
  type DeviceProfile,
  normaliseWakeToken,
  WAKE_ARMED_MS,
  WAKE_TOKEN,
  type WakeMatch,
  wakeWords
} from "@pva/protocol"
import type { SttEvent } from "./Domain.ts"

/**
 * The wake gate (docs/FRONTENDS-AND-ACTIVATION.md §3): sits after the `EchoGate` and before `Conversation` and,
 * in `wake-phrase` mode, lets an utterance through only when it starts with a wake phrase ("Hey Jeff, what time
 * is it?" → "what time is it?") or starts while the device is awake (the armed window after the phrase alone,
 * the follow-up window after a reply, or a reply in progress when follow-up is above zero). Pure and synchronous;
 * time is passed in.
 *
 * It keeps the utterance contract of docs/ARCHITECTURE.md: for input that keeps it, every forwarded utterance
 * begins with `SpeechStarted` and ends with exactly one `EndOfTurn`, and a dropped utterance forwards nothing.
 * The decision is per utterance:
 * - an utterance that starts awake is *accepted* at its `SpeechStarted` and forwarded to its `EndOfTurn` (a leading
 *   wake phrase is still removed), even if the window closes meanwhile;
 * - an utterance that starts asleep is *held*: nothing is forwarded until a transcript matches a phrase with words
 *   after it (then the held `SpeechStarted` is released and the utterance is accepted), and an `EndOfTurn` without
 *   a match drops it whole. The phrase alone on the `EndOfTurn` forwards nothing and opens the armed window.
 * - `always` mode passes every event unchanged (the same object); it only reports `heard` for the tester.
 *
 * `one-shot` (docs/VOICE-NODES.md §3) is `wake-phrase` with four differences: no follow-up window (`followUpMs` and a
 * reply in progress never make the device awake; `replyEnded` returns TAKEN → ASLEEP at once), the phrase alone while
 * TAKEN reports `woke.duringReply` and arms (the session interrupts the reply), `answerWindow` admits one utterance
 * without a phrase for a confirmation question, and the armed window lapses by itself (the session's timers do the
 * rest). TAKEN starts at an accepted non-empty `EndOfTurn`; `taken()` reports it. Choices there: leaving the one-shot
 * mode (`configure`) clears TAKEN and the answer window; the phrase alone leaves TAKEN (the reply is being stopped)
 * and a request accepted inside the answer window enters TAKEN like any other.
 *
 * Choices where §3 left room (recorded in the design's Status section):
 * - An accepted utterance whose transcript is only the phrase: an `Interim` or `EagerEndOfTurn` that is empty after
 *   removal is not forwarded (an `EagerEndOfTurn` is never empty by contract), and a `TurnResumed` that follows a
 *   swallowed `EagerEndOfTurn` is swallowed too. Its `EndOfTurn` is forwarded with `""` (the utterance must close:
 *   `Conversation` saw its `SpeechStarted`) and opens the armed window, as the phrase alone does when asleep.
 * - `configure` while an utterance is held discards it, and the rest of that utterance (to its `EndOfTurn`) is
 *   dropped in every mode, so a switch to `always` never forwards the tail of an utterance whose `SpeechStarted`
 *   was not forwarded. An accepted utterance stays accepted.
 * - Windows are stored as the time they opened, so after `configure` they are measured with the new lengths
 *   (`armedMs`, `followUpMs`): a window is kept exactly when it is still open under the new configuration.
 * - An accepted, non-empty `EndOfTurn` also starts the follow-up window (from that moment), so the device stays
 *   awake while the reply is prepared; `replyStarted` / `replyEnded` then hold it open and restart it.
 * - Events outside any utterance (they break the contract on input) pass unchanged while awake and are dropped
 *   while asleep.
 * - `heard` (for the admin tester) is an addition to `WakeResult`: the design's `dropped` alone cannot show the
 *   matched lines.
 * - `close` matching also compares run together (added after integration with streaming recognisers, which heard
 *   "heyjeff" and "HAY JEFF"): the first k words after the fillers (k = 1 .. phrase words + 1) joined without
 *   spaces may be one edit from the phrase joined without spaces, for joined phrases of 6 letters or more; `rest`
 *   follows those k words. `exact` is unchanged.
 */

/** Words that may come before the phrase ("ok, hey Jeff"), at most `WAKE_MAX_FILLERS` of them. */
export const WAKE_FILLERS: ReadonlySet<string> = new Set(["ok", "okay", "uh", "um", "so", "and", "well"])
export const WAKE_MAX_FILLERS = 2

/**
 * `one-shot` (docs/VOICE-NODES.md §3) is added to protocol's `Activation` in protocol 7; until then core declares it
 * locally. WP-6 replaces this alias with `Activation`.
 */
export type WakeActivation = Activation | "one-shot"

export interface WakeConfig {
  readonly activation: WakeActivation
  /** As configured (shown in the UI and reported back in `woke`). */
  readonly phrases: ReadonlyArray<string>
  readonly match: WakeMatch
  /** After a reply ends, keep reacting without the phrase this long. 0 = asleep right away. Ignored in `one-shot`. */
  readonly followUpMs: number
  /** After the phrase alone, the next utterance starting within this long is accepted. Default `WAKE_ARMED_MS`. */
  readonly armedMs?: number
}

/** The gate's part of a device profile. */
export const wakeConfigFromProfile = (profile: DeviceProfile): WakeConfig => ({
  activation: profile.activation,
  phrases: profile.wakePhrases,
  match: profile.wakeMatch,
  followUpMs: profile.followUpSeconds * 1000
})

/** No audio owner: react to everything. */
export const WAKE_ALWAYS: WakeConfig = { ...wakeConfigFromProfile(DEFAULT_DEVICE_PROFILE), activation: "always" }

export interface WakeResult {
  /** Events to pass on, in order. */
  readonly events: ReadonlyArray<SttEvent>
  /** A whole utterance was dropped (asleep, no phrase). Only for the admin tester; never stored. */
  readonly dropped?: { readonly text: string }
  /** A wake phrase was heard (once per utterance). `armed`: it was the phrase alone. */
  readonly woke?: { readonly phrase: string; readonly armed: boolean; readonly duringReply?: true }
  /**
   * Every non-blank `EndOfTurn` the gate sees (in every mode, also `always`, and also when dropped), before the
   * phrase was removed, with the phrase it matched (if any): what the admin tester shows (`wake.heard`).
   * `accepted`: the utterance was taken (forwarded, or the phrase alone opened the armed window), so the assistant
   * answers it; false only when it was dropped (asleep, no phrase). An utterance accepted without a phrase (mode
   * `always`, or inside an armed or follow-up window) has `accepted: true` and no `phrase`.
   */
  readonly heard?: { readonly text: string; readonly phrase?: string; readonly accepted: boolean }
}

export interface WakeGate {
  /** Live; discards a held utterance, keeps an open window only if it is still open under the new config. */
  configure(config: WakeConfig): void
  readonly config: () => WakeConfig
  /** A spoken reply finished or was stopped: opens the follow-up window. */
  replyEnded(now: number): void
  /** A spoken reply started: while it lasts the device counts as awake when `followUpMs > 0`. */
  replyStarted(now: number): void
  /**
   * `one-shot`: open a window that admits exactly one utterance without a phrase (a confirmation question was played
   * to its end), for `ms`. Reports nothing by itself; the session sends the cue. Does not leave TAKEN by itself.
   */
  answerWindow(now: number, ms: number): void
  /** `one-shot`: a reply is owed or playing (from an accepted request until `replyEnded`). Always false in other modes. */
  taken(now: number): boolean
  /** Reacting without a phrase right now (a window is open, or mode `always`). */
  awake(now: number): boolean
  filter(event: SttEvent, now: number): WakeResult
}

// ---------------------------------------------------------------------------
// Matching

/** Levenshtein distance, stopping early once it exceeds `limit`. */
const editDistance = (a: string, b: string, limit: number): number => {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      row.push(v)
      if (v < best) best = v
    }
    if (best > limit) return limit + 1
    prev = row
  }
  return prev[b.length]!
}

const sameWord = (phraseWord: string, heard: string, match: WakeMatch): boolean => {
  if (phraseWord === heard) return true
  if (match === "exact") return false
  return [...phraseWord].length >= CLOSE_MATCH_MIN_LETTERS && editDistance(phraseWord, heard, 1) <= 1
}

interface Token {
  readonly word: string
  readonly end: number
}

const tokens = (text: string): Array<Token> => {
  const out: Array<Token> = []
  for (const m of text.matchAll(WAKE_TOKEN)) {
    const word = normaliseWakeToken(m[0])
    if (word.length > 0) out.push({ word, end: m.index + m[0].length })
  }
  return out
}

const LEADING = /^[\s\p{P}]+/u

/**
 * `close` only: the phrase run together ("heyjeff") against the first k heard words run together (k = 1 ..
 * `maxWords`, starting at `skip`), within one edit. Catches "heyjeff" and "hay jeff" from streaming recognisers,
 * which the per-word rule misses (one word; a 3-letter word that must be equal). Only for phrases of at least
 * `JOINED_MIN_LETTERS` letters, so short phrases do not match half the room. Returns k (fewest edits, then
 * fewest words), or `undefined`.
 */
const joinedMatch = (joined: string, heard: ReadonlyArray<Token>, skip: number, maxWords: number): number | undefined => {
  if ([...joined].length < JOINED_MIN_LETTERS) return undefined
  let best: { k: number; d: number } | undefined
  let run = ""
  for (let k = 1; k <= maxWords && skip + k <= heard.length; k++) {
    run += heard[skip + k - 1]!.word
    if (run.length > joined.length + 1) break
    const d = editDistance(joined, run, 1)
    if (d <= 1 && (best === undefined || d < best.d)) best = { k, d }
  }
  return best?.k
}

/** A run-together phrase must have at least this many letters to be matched run together (`joinedMatch`). */
export const JOINED_MIN_LETTERS = 6

/**
 * Does `text` start with one of `phrases` (after at most two filler words)? Both sides are normalised by
 * `wakeWords` and compared word by word; in `close` mode a phrase of `JOINED_MIN_LETTERS` or more letters also
 * matches when the first k heard words run together are within one edit of the phrase run together
 * (`joinedMatch`). The longest matching phrase wins (most words, then most characters; then the fewest fillers).
 * `rest` is the original text after the matched words, leading punctuation and spaces removed, casing kept.
 */
export const matchWakePhrase = (
  text: string,
  phrases: ReadonlyArray<string>,
  match: WakeMatch
): { readonly phrase: string; readonly rest: string } | undefined => {
  const heard = tokens(text)
  let best: { phrase: string; words: number; chars: number; end: number } | undefined
  for (let skip = 0; skip <= WAKE_MAX_FILLERS && skip < heard.length; skip++) {
    if (skip > 0 && !WAKE_FILLERS.has(heard[skip - 1]!.word)) break
    for (const phrase of phrases) {
      const words = wakeWords(phrase)
      if (words.length === 0) continue
      const taken =
        skip + words.length <= heard.length && words.every((w, i) => sameWord(w, heard[skip + i]!.word, match))
          ? words.length
          : match === "close"
            ? joinedMatch(words.join(""), heard, skip, words.length + 1)
            : undefined
      if (taken === undefined) continue
      const chars = words.join(" ").length
      if (best === undefined || words.length > best.words || (words.length === best.words && chars > best.chars)) {
        best = { phrase, words: words.length, chars, end: heard[skip + taken - 1]!.end }
      }
    }
  }
  return best === undefined ? undefined : { phrase: best.phrase, rest: text.slice(best.end).replace(LEADING, "") }
}

// ---------------------------------------------------------------------------
// The gate

type Utterance =
  /** Started asleep; nothing forwarded yet. `eagerPending`: an `EagerEndOfTurn` was held and not yet resumed. */
  | { readonly kind: "held"; start: SttEvent; eagerPending: boolean }
  /**
   * Its `SpeechStarted` was forwarded; forwarded to its `EndOfTurn`. `eagerSwallowed`: the last `EagerEndOfTurn`
   * was not forwarded, so the `TurnResumed` that answers it is not forwarded either.
   */
  | { readonly kind: "accepted"; woke: boolean; eagerSwallowed: boolean }
  /** Discarded by `configure` while held: dropped to its `EndOfTurn`. */
  | { readonly kind: "discarding" }

const pass = (...events: Array<SttEvent>): WakeResult => ({ events })
const none: WakeResult = { events: [] }

const withText = (event: SttEvent, text: string): SttEvent =>
  event._tag === "Interim" || event._tag === "EagerEndOfTurn" || event._tag === "EndOfTurn"
    ? (event.text === text ? event : { _tag: event._tag, text })
    : event

export const makeWakeGate = (initial: WakeConfig = WAKE_ALWAYS): WakeGate => {
  let config = initial
  let utterance: Utterance | undefined
  let replying = false
  /** When the armed window opened (the phrase alone); consumed by the next utterance that starts in it. */
  let armedAt: number | undefined
  /** When the follow-up window opened (a reply ended, or an accepted utterance ended). */
  let followFrom: number | undefined
  /** `one-shot` TAKEN: a request was accepted and `replyEnded` has not come yet. */
  let takenFlag = false
  /** `one-shot`: the answer window (confirmation question) is open until this time; consumed by one utterance. */
  let answerUntil: number | undefined

  const oneShot = () => config.activation === "one-shot"
  const armedMs = () => config.armedMs ?? WAKE_ARMED_MS
  const armed = (now: number) => armedAt !== undefined && now - armedAt < armedMs()
  const answering = (now: number) => answerUntil !== undefined && now < answerUntil
  const following = (now: number) =>
    !oneShot() && followFrom !== undefined && config.followUpMs > 0 && now - followFrom < config.followUpMs

  const awake = (now: number): boolean =>
    config.activation === "always" ||
    armed(now) ||
    answering(now) ||
    (oneShot() ? false : following(now) || (replying && config.followUpMs > 0))

  /** The utterance ended with a request: the follow-up window starts (wake-phrase) or a reply is owed (one-shot). */
  const requestEnded = (now: number) => {
    if (oneShot()) takenFlag = true
    else followFrom = now
  }

  /** The phrase alone: opens the armed window. In TAKEN it stops the reply (`duringReply`) and leaves TAKEN. */
  const phraseAlone = (phrase: string, now: number): NonNullable<WakeResult["woke"]> => {
    armedAt = now
    if (oneShot() && takenFlag) {
      takenFlag = false
      return { phrase, armed: true, duringReply: true }
    }
    return { phrase, armed: true }
  }

  const match = (text: string) => matchWakePhrase(text, config.phrases, config.match)

  const heardOf = (text: string, phrase: string | undefined, accepted: boolean): Pick<WakeResult, "heard"> =>
    text.trim().length === 0 ? {} : { heard: phrase === undefined ? { text, accepted } : { text, phrase, accepted } }

  /** An event of an accepted utterance: remove a leading phrase. */
  const accepted = (u: Extract<Utterance, { kind: "accepted" }>, event: SttEvent, now: number): WakeResult => {
    if (config.activation === "always") {
      if (event._tag === "TurnResumed" && u.eagerSwallowed) {
        // Answers an EagerEndOfTurn swallowed before a switch to `always`.
        u.eagerSwallowed = false
        return none
      }
      if (event._tag === "EagerEndOfTurn") u.eagerSwallowed = false
      if (event._tag !== "EndOfTurn") return pass(event)
      utterance = undefined
      return { events: [event], ...heardOf(event.text, match(event.text)?.phrase, true) }
    }
    switch (event._tag) {
      case "SpeechStarted":
        // A repeated SpeechStarted inside the utterance: the recogniser's business, passed on.
        return pass(event)
      case "TurnResumed":
        if (!u.eagerSwallowed) return pass(event)
        u.eagerSwallowed = false
        return none
      case "Interim":
      case "EagerEndOfTurn":
      case "EndOfTurn": {
        const m = match(event.text)
        const text = m === undefined ? event.text : m.rest
        const woke = m !== undefined && !u.woke
        if (m !== undefined) u.woke = true
        if (event._tag === "EndOfTurn") {
          utterance = undefined
          const only = m !== undefined && text.trim().length === 0
          let onlyWoke: WakeResult["woke"]
          if (only) onlyWoke = phraseAlone(m!.phrase, now)
          else if (text.trim().length > 0) requestEnded(now)
          return {
            events: [withText(event, text)],
            ...(onlyWoke !== undefined ? { woke: onlyWoke } : woke ? { woke: { phrase: m!.phrase, armed: false } } : {}),
            ...heardOf(event.text, m?.phrase, true)
          }
        }
        const result = (events: Array<SttEvent>): WakeResult =>
          woke ? { events, woke: { phrase: m!.phrase, armed: false } } : { events }
        if (text.trim().length === 0) {
          if (event._tag === "EagerEndOfTurn") u.eagerSwallowed = true
          return result([])
        }
        if (event._tag === "EagerEndOfTurn") u.eagerSwallowed = false
        return result([withText(event, text)])
      }
    }
  }

  const held = (u: Extract<Utterance, { kind: "held" }>, event: SttEvent, now: number): WakeResult => {
    const start = u.start
    switch (event._tag) {
      case "SpeechStarted":
        u.start = event
        return none
      case "TurnResumed":
        u.eagerPending = false
        return none
      case "Interim":
      case "EagerEndOfTurn": {
        const m = match(event.text)
        if (m === undefined || m.rest.trim().length === 0) {
          // Undecided: the sentence may go on.
          if (event._tag === "EagerEndOfTurn") u.eagerPending = true
          return none
        }
        utterance = { kind: "accepted", woke: true, eagerSwallowed: event._tag === "EagerEndOfTurn" ? false : u.eagerPending }
        return { events: [start, withText(event, m.rest)], woke: { phrase: m.phrase, armed: false } }
      }
      case "EndOfTurn": {
        utterance = undefined
        const m = match(event.text)
        if (m === undefined) {
          return event.text.trim().length === 0 ? none : { events: [], dropped: { text: event.text }, ...heardOf(event.text, undefined, false) }
        }
        if (m.rest.trim().length === 0) {
          return { events: [], woke: phraseAlone(m.phrase, now), ...heardOf(event.text, m.phrase, true) }
        }
        requestEnded(now)
        return { events: [start, withText(event, m.rest)], woke: { phrase: m.phrase, armed: false }, ...heardOf(event.text, m.phrase, true) }
      }
    }
  }

  return {
    configure: (next) => {
      config = next
      if (next.activation !== "one-shot") {
        takenFlag = false
        answerUntil = undefined
      }
      if (utterance?.kind === "held") utterance = { kind: "discarding" }
    },
    config: () => config,
    replyStarted: () => {
      replying = true
    },
    replyEnded: (now) => {
      replying = false
      if (oneShot()) takenFlag = false // TAKEN → ASLEEP at once: no follow-up window
      else followFrom = now
    },
    answerWindow: (now, ms) => {
      if (oneShot() && ms > 0) answerUntil = now + ms
    },
    taken: () => oneShot() && takenFlag,
    awake,
    filter: (event, now) => {
      const u = utterance
      if (u?.kind === "discarding") {
        if (event._tag === "EndOfTurn") utterance = undefined
        return none
      }
      if (u?.kind === "accepted") return accepted(u, event, now)
      if (u?.kind === "held") return held(u, event, now)
      // No utterance open.
      if (config.activation === "always") {
        if (event._tag === "SpeechStarted") utterance = { kind: "accepted", woke: false, eagerSwallowed: false }
        if (event._tag === "EndOfTurn") return { events: [event], ...heardOf(event.text, match(event.text)?.phrase, true) }
        return pass(event)
      }
      if (event._tag !== "SpeechStarted") {
        // Outside the contract (no SpeechStarted first): passed while awake, dropped while asleep.
        return awake(now) ? pass(event) : none
      }
      if (awake(now)) {
        // The armed and answer windows admit one utterance.
        if (armed(now)) armedAt = undefined
        if (answering(now)) answerUntil = undefined
        utterance = { kind: "accepted", woke: false, eagerSwallowed: false }
        return pass(event)
      }
      utterance = { kind: "held", start: event, eagerPending: false }
      return none
    }
  }
}
