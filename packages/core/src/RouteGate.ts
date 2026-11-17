import { WAKE_ARMED_MS, type WakeMatch } from "@pva/protocol"
import type { SttEvent } from "./Domain.ts"
import { matchWakePhrase, type WakeConfig } from "./WakeGate.ts"

/**
 * The route gate (docs/ASSISTANTS.md §2.6 "Answering a sentence on a device", §3.4): sits after the `EchoGate`
 * and decides, for each utterance on a device, which assistant it goes to. Built from `WakeGate` (its matcher, its
 * held / accepted states and its utterance contract), with phrases that carry their assistant and windows that
 * belong to an assistant. Pure and synchronous; time is passed in.
 *
 * The route, per text event:
 * 1. a wake phrase at the start (longest wins, over every assignment's phrases) → its assistant, phrase removed;
 *    the phrase alone forwards nothing and opens that assistant's armed window;
 * 2. else an armed window that was open when the utterance started → its assistant (it admits one utterance);
 * 3. else a follow-up window (or a reply in progress, when that assistant's follow-up is above zero) → the assistant
 *    that last replied;
 * 4. else `withoutPhrase`: `assistant` → `defaultAssistant`; `decide` → `{ by: "decide" }` (the caller asks
 *    TypeSafe; the gate calls nothing) with the fallback; `nobody` → the utterance is held until a phrase, else dropped.
 * 5. a switched-off assistant (`off`) reached by any of these is the answer, and the utterance is dropped: an off
 *    assistant's phrase never reaches another assistant. A decide fallback that is off is `null`.
 *
 * Steps 2–4 are decided when the utterance starts (its *base* target); step 1 is applied to every text event, so
 * the target of a forwarded event is tentative and may change between events (the dispatcher handles a change).
 * Every result returned for an open utterance carries `target`.
 *
 * Utterance contract (docs/ARCHITECTURE.md), as WakeGate: for input that keeps it, every forwarded utterance begins
 * with `SpeechStarted` and ends with exactly one `EndOfTurn`; a dropped utterance forwards nothing.
 * - An utterance whose base target is an assistant or `decide` is *accepted* at its `SpeechStarted` and forwarded to
 *   its `EndOfTurn`. Phrases are matched and removed in every mode (WakeGate's `always` passed them on).
 * - An utterance whose base target is nobody (asleep, or an off assistant) is *held* until a transcript matches a
 *   switched-on assistant's phrase with words after it; an `EndOfTurn` without one drops it whole.
 * - In an accepted utterance, an event whose target is an off assistant is not forwarded (an `EagerEndOfTurn`
 *   swallowed this way also swallows its `TurnResumed`), and its `EndOfTurn` is forwarded as `""` so the
 *   utterance closes and starts nothing.
 *
 * Choices where §3.4 left room:
 * - Follow-up lengths are part of the config (`followUpMs`, per assistant), not an argument of `replyEnded`, so
 *   that, as in WakeGate, windows are stored as the time they opened and measured with the current lengths.
 * - An accepted, non-empty `EndOfTurn` routed to an assistant opens that assistant's follow-up window (WakeGate
 *   did the same for its one assistant). A `decide` target opens none: the gate does not learn the decision; the
 *   window opens at `replyEnded`.
 * - There is one armed window and one follow-up window per device: the latest phrase alone, and the assistant that
 *   last replied (or was last answered). `replyStarted(x)` closes another assistant's follow-up window.
 * - A window of an assistant that is switched off counts as step 2/3 for that off assistant: the utterance is held
 *   (a phrase can still reach a switched-on assistant) and otherwise dropped with reason `off`.
 * - `defaultAssistant` missing with `withoutPhrase: "assistant"` behaves as `nobody`.
 */

/** One wake phrase on the device and the assistant it reaches (every assignment's phrases, as configured). */
export interface RoutePhrase {
  readonly phrase: string
  readonly assistant: string
}

/** "Answers without a phrase": nobody, one assistant, or decide (the dispatcher asks TypeSafe). */
export type WithoutPhraseMode = "nobody" | "assistant" | "decide"

export interface RouteConfig {
  readonly phrases: ReadonlyArray<RoutePhrase>
  readonly match: WakeMatch
  readonly withoutPhrase: WithoutPhraseMode
  /** With `assistant`: who answers without a phrase. */
  readonly defaultAssistant?: string
  /** With `decide`: who answers when TypeSafe chooses nobody, gives up or fails. Absent or `null`: nobody. */
  readonly fallback?: string | null
  /**
   * Per assistant, how long its follow-up window lasts after a reply (the assignment's `followUpSeconds`, else the
   * assistant's, in ms). Missing or 0: no window.
   */
  readonly followUpMs?: Readonly<Record<string, number>>
  /** Switched-off assistants: never routed. */
  readonly off: ReadonlySet<string>
  /** After a phrase alone, the next utterance starting within this long goes to that assistant. Default `WAKE_ARMED_MS`. */
  readonly armedMs?: number
}

export type RouteTarget =
  | { readonly assistant: string; readonly by: "phrase"; readonly phrase: string }
  | { readonly assistant: string; readonly by: "armed" | "follow-up" | "default" }
  /** The dispatcher must ask TypeSafe; `fallback` answers when it does not choose (already `null` when off). */
  | { readonly by: "decide"; readonly fallback: string | null }
  /** `assistant`: the switched-off assistant the route reached (reason `off`). */
  | { readonly by: "dropped"; readonly reason: "asleep" | "off"; readonly assistant?: string }

export interface RouteResult {
  /** Events to pass on, in order. */
  readonly events: ReadonlyArray<SttEvent>
  /** Where `events` go: present for every event of an open utterance, and for a dropped one. */
  readonly target?: RouteTarget
  /** Nobody answers this utterance (asleep, or an off assistant). Only for the admin tester; never stored. */
  readonly dropped?: { readonly text: string }
  /** A switched-on assistant's wake phrase was heard (once per utterance). `armed`: it was the phrase alone. */
  readonly woke?: { readonly phrase: string; readonly assistant: string; readonly armed: boolean }
  /**
   * Every non-blank `EndOfTurn` the gate sees, before the phrase was removed, with the phrase it matched and that
   * phrase's assistant (if any): what the admin tester shows (`wake.heard`). `accepted`: someone answers it (or the
   * phrase alone armed an assistant); false when it was dropped.
   */
  readonly heard?: {
    readonly text: string
    readonly phrase?: string
    readonly assistant?: string
    readonly accepted: boolean
  }
}

export interface RouteGate {
  /**
   * Live; discards a held utterance, keeps an open window only if it is still open under the new config. An armed
   * window closes when its assistant is no longer on the device (no phrase and no follow-up length in the new config).
   */
  configure(config: RouteConfig): void
  readonly config: () => RouteConfig
  /** `assistant` started a spoken reply: while it lasts, its follow-up counts as open when its length is above 0. */
  replyStarted(assistant: string, now: number): void
  /** `assistant`'s spoken reply finished or was stopped: opens its follow-up window. */
  replyEnded(assistant: string, now: number): void
  /**
   * Closes the armed and follow-up windows: a pick on the device (`device.pick`) decides who answers the next sentence
   * without a phrase. A reply still playing keeps counting until it ends, and its end opens its follow-up window as
   * usual; an open utterance keeps its target.
   */
  release(): void
  /** An utterance starting now would be accepted without a phrase. */
  awake(now: number): boolean
  /** The open window right now, if any (armed first, then follow-up). */
  window(now: number): { readonly assistant: string; readonly by: "armed" | "follow-up" } | undefined
  filter(event: SttEvent, now: number): RouteResult
}

/**
 * A `WakeGate` configuration as a route config for one assistant: `always` → that assistant answers without a
 * phrase, `wake-phrase` → nobody does. For the bench and for the migration period.
 */
export const routeConfigFromWake = (wake: WakeConfig, assistant: string): RouteConfig => ({
  phrases: wake.phrases.map((phrase) => ({ phrase, assistant })),
  match: wake.match,
  withoutPhrase: wake.activation === "always" ? "assistant" : "nobody",
  defaultAssistant: assistant,
  followUpMs: { [assistant]: wake.followUpMs },
  off: new Set(),
  ...(wake.armedMs !== undefined ? { armedMs: wake.armedMs } : {})
})

// ---------------------------------------------------------------------------
// The gate

type Utterance =
  /** Base target nobody; nothing forwarded yet. `eagerPending`: an `EagerEndOfTurn` was held and not yet resumed. */
  | {
    readonly kind: "held"
    start: SttEvent
    eagerPending: boolean
    readonly why: Extract<RouteTarget, { by: "dropped" }>
  }
  /**
   * Its `SpeechStarted` was forwarded; forwarded to its `EndOfTurn`. `woke`: a phrase was reported. `eagerSwallowed`:
   * the last `EagerEndOfTurn` was not forwarded, so the `TurnResumed` that answers it is not forwarded either.
   */
  | { readonly kind: "accepted"; readonly base: RouteTarget; woke: boolean; eagerSwallowed: boolean }
  /** Discarded by `configure` while held: dropped to its `EndOfTurn`. */
  | { readonly kind: "discarding" }

const none: RouteResult = { events: [] }

const withText = (event: SttEvent, text: string): SttEvent =>
  event._tag === "Interim" || event._tag === "EagerEndOfTurn" || event._tag === "EndOfTurn"
    ? (event.text === text ? event : { ...event, text })
    : event

const blank = (text: string) => text.trim().length === 0

export const makeRouteGate = (initial: RouteConfig): RouteGate => {
  let config = initial
  let utterance: Utterance | undefined
  /** The assistant whose reply is playing. */
  let replying: string | undefined
  /** The phrase alone opened this assistant's armed window; consumed by the next utterance that starts in it. */
  let armed: { readonly assistant: string; readonly at: number } | undefined
  /** The assistant that last replied (or was last answered), and when its follow-up window opened. */
  let following: { readonly assistant: string; readonly from: number } | undefined

  const armedMs = () => config.armedMs ?? WAKE_ARMED_MS
  const followUpOf = (assistant: string) => config.followUpMs?.[assistant] ?? 0
  const isOff = (assistant: string) => config.off.has(assistant)
  /** Still on the device: one of its phrases, or a follow-up length, is in the config. */
  const assigned = (assistant: string) =>
    config.phrases.some((p) => p.assistant === assistant) || Object.hasOwn(config.followUpMs ?? {}, assistant)

  const armedOpen = (now: number) => armed !== undefined && now - armed.at < armedMs()
  const followingOpen = (now: number) => {
    if (replying !== undefined && followUpOf(replying) > 0) return replying
    if (following === undefined) return undefined
    const ms = followUpOf(following.assistant)
    return ms > 0 && now - following.from < ms ? following.assistant : undefined
  }

  const window = (now: number): ReturnType<RouteGate["window"]> => {
    if (armedOpen(now)) return { assistant: armed!.assistant, by: "armed" }
    const f = followingOpen(now)
    return f === undefined ? undefined : { assistant: f, by: "follow-up" }
  }

  /** An assistant target, or the drop it means when that assistant is off. */
  const live = (target: RouteTarget): RouteTarget =>
    "assistant" in target && target.by !== "dropped" && isOff(target.assistant)
      ? { by: "dropped", reason: "off", assistant: target.assistant }
      : target

  /** Steps 2–5 for an utterance starting now. `consume`: an armed window admits one utterance. */
  const baseTarget = (now: number, consume: boolean): RouteTarget => {
    const w = window(now)
    if (w !== undefined) {
      if (w.by === "armed" && consume) armed = undefined
      return live({ assistant: w.assistant, by: w.by })
    }
    switch (config.withoutPhrase) {
      case "assistant":
        return config.defaultAssistant === undefined
          ? { by: "dropped", reason: "asleep" }
          : live({ assistant: config.defaultAssistant, by: "default" })
      case "decide": {
        const fallback = config.fallback ?? null
        return { by: "decide", fallback: fallback !== null && isOff(fallback) ? null : fallback }
      }
      case "nobody":
        return { by: "dropped", reason: "asleep" }
    }
  }

  const match = (text: string) => {
    const phrases = config.phrases
    const m = matchWakePhrase(text, phrases.map((p) => p.phrase), config.match)
    if (m === undefined) return undefined
    // The first assignment with that exact phrase string (duplicates are refused on save, §2.3).
    const assistant = phrases.find((p) => p.phrase === m.phrase)!.assistant
    return { ...m, assistant, target: live({ assistant, by: "phrase", phrase: m.phrase }) }
  }

  const heardOf = (
    text: string,
    m: { readonly phrase: string; readonly assistant: string } | undefined,
    accepted: boolean
  ): Pick<RouteResult, "heard"> =>
    blank(text) ? {} : { heard: m === undefined ? { text, accepted } : { text, phrase: m.phrase, assistant: m.assistant, accepted } }

  const accepted = (u: Extract<Utterance, { kind: "accepted" }>, event: SttEvent, now: number): RouteResult => {
    switch (event._tag) {
      case "SpeechStarted":
        // A repeated SpeechStarted inside the utterance: the recogniser's business, passed on.
        return { events: [event], target: live(u.base) }
      case "TurnResumed":
        if (!u.eagerSwallowed) return { events: [event], target: live(u.base) }
        u.eagerSwallowed = false
        return { events: [], target: live(u.base) }
      case "Interim":
      case "EagerEndOfTurn":
      case "EndOfTurn": {
        const m = match(event.text)
        const target = m?.target ?? live(u.base)
        const dropped = target.by === "dropped"
        const text = m === undefined ? event.text : m.rest
        const woke = m !== undefined && !dropped && !u.woke
        if (woke) u.woke = true
        if (event._tag === "EndOfTurn") {
          utterance = undefined
          if (dropped) {
            // The utterance must close (its SpeechStarted went out); "" starts nothing.
            return {
              events: [withText(event, "")],
              target,
              ...(blank(event.text) ? {} : { dropped: { text: event.text } }),
              ...heardOf(event.text, m, false)
            }
          }
          const only = m !== undefined && blank(text)
          if (only) armed = { assistant: m.assistant, at: now }
          else if (!blank(text) && "assistant" in target) following = { assistant: target.assistant, from: now }
          return {
            events: [withText(event, text)],
            target,
            ...(woke || only ? { woke: { phrase: m!.phrase, assistant: m!.assistant, armed: only } } : {}),
            ...heardOf(event.text, m, true)
          }
        }
        const result = (events: Array<SttEvent>): RouteResult =>
          woke ? { events, target, woke: { phrase: m!.phrase, assistant: m!.assistant, armed: false } } : { events, target }
        if (dropped || blank(text)) {
          if (event._tag === "EagerEndOfTurn") u.eagerSwallowed = true
          return result([])
        }
        if (event._tag === "EagerEndOfTurn") u.eagerSwallowed = false
        return result([withText(event, text)])
      }
    }
  }

  const held = (u: Extract<Utterance, { kind: "held" }>, event: SttEvent, now: number): RouteResult => {
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
        if (m === undefined || blank(m.rest) || m.target.by === "dropped") {
          // Undecided: the sentence may go on (or the phrase is an off assistant's, which never releases).
          if (event._tag === "EagerEndOfTurn") u.eagerPending = true
          return none
        }
        utterance = {
          kind: "accepted",
          base: m.target,
          woke: true,
          eagerSwallowed: event._tag === "EagerEndOfTurn" ? false : u.eagerPending
        }
        return {
          events: [u.start, withText(event, m.rest)],
          target: m.target,
          woke: { phrase: m.phrase, assistant: m.assistant, armed: false }
        }
      }
      case "EndOfTurn": {
        utterance = undefined
        const m = match(event.text)
        if (m === undefined) {
          return blank(event.text)
            ? none
            : { events: [], target: u.why, dropped: { text: event.text }, ...heardOf(event.text, undefined, false) }
        }
        if (m.target.by === "dropped") {
          return { events: [], target: m.target, dropped: { text: event.text }, ...heardOf(event.text, m, false) }
        }
        const woke = { phrase: m.phrase, assistant: m.assistant }
        if (blank(m.rest)) {
          armed = { assistant: m.assistant, at: now }
          return { events: [], target: m.target, woke: { ...woke, armed: true }, ...heardOf(event.text, m, true) }
        }
        following = { assistant: m.assistant, from: now }
        return {
          events: [u.start, withText(event, m.rest)],
          target: m.target,
          woke: { ...woke, armed: false },
          ...heardOf(event.text, m, true)
        }
      }
    }
  }

  return {
    configure: (next) => {
      config = next
      if (utterance?.kind === "held") utterance = { kind: "discarding" }
      // An armed assistant that was removed from the device must not answer the next sentence.
      if (armed !== undefined && !assigned(armed.assistant)) armed = undefined
    },
    config: () => config,
    replyStarted: (assistant) => {
      replying = assistant
      if (following !== undefined && following.assistant !== assistant) following = undefined
    },
    replyEnded: (assistant, now) => {
      if (replying === assistant) replying = undefined
      following = { assistant, from: now }
    },
    release: () => {
      armed = undefined
      following = undefined
    },
    awake: (now) => baseTarget(now, false).by !== "dropped",
    window,
    filter: (event, now) => {
      const u = utterance
      if (u?.kind === "discarding") {
        if (event._tag === "EndOfTurn") utterance = undefined
        return none
      }
      if (u?.kind === "accepted") return accepted(u, event, now)
      if (u?.kind === "held") return held(u, event, now)
      // No utterance open.
      if (event._tag !== "SpeechStarted") {
        // Outside the contract (no SpeechStarted first): passed unchanged while someone answers, else dropped.
        const target = baseTarget(now, false)
        if (target.by === "dropped") return none
        return event._tag === "EndOfTurn"
          ? { events: [event], target, ...heardOf(event.text, match(event.text), true) }
          : { events: [event], target }
      }
      const base = baseTarget(now, true)
      if (base.by === "dropped") {
        utterance = { kind: "held", start: event, eagerPending: false, why: base }
        return none
      }
      utterance = { kind: "accepted", base, woke: false, eagerSwallowed: false }
      return { events: [event], target: base }
    }
  }
}
