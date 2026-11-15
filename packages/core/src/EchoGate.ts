import type { InterruptMode } from "@pva/protocol"
import type { SttEvent } from "./Domain.ts"

/**
 * The echo gate (docs/UI-AND-MODULES.md §5): sits between the speech
 * recogniser and `Conversation` and decides, while the assistant is audible,
 * whether what the recogniser hears is the user or the assistant's own voice
 * coming back through the microphone. Pure and synchronous; time is passed in.
 *
 * Interrupt modes, during the audible window (playback started → finished or
 * stopped, plus `ECHO_TAIL_MS` of room reverb):
 * - `instant`: everything passes (any speech interrupts).
 * - `confirm`: `SpeechStarted` is held. An `Interim` whose last
 *   `ECHO_WORDS` words are at least `ECHO_MIN_WORDS` words, fewer than
 *   `ECHO_MAX_OVERLAP` of which occur in the recently played words, is the user:
 *   the held `SpeechStarted` is released, then the `Interim`. Anything else is
 *   echo and dropped. End-of-turn events are tested the same way.
 * - `manual`: every event is dropped (the web input also feeds silence).
 * Outside the window every mode passes everything.
 */

export type { InterruptMode }

/** Reverb tail after playback ends during which the window stays open. */
export const ECHO_TAIL_MS = 300
/** Played clauses older than this are forgotten. */
export const ECHO_MEMORY_MS = 5_000
/** Words of an interim result that are compared. */
export const ECHO_WORDS = 6
/** Fewer words than this cannot be told apart from echo, so they never interrupt in `confirm` mode. */
export const ECHO_MIN_WORDS = 2
/** At or above this share of words found in what was just played, it is echo. */
export const ECHO_MAX_OVERLAP = 0.6

export interface GateResult {
  /** Events to pass on, in order. */
  readonly events: ReadonlyArray<SttEvent>
  /** Something was dropped as echo (the UI clears the interim transcript). */
  readonly dropped: boolean
}

export interface EchoGate {
  setMode(mode: InterruptMode): void
  readonly mode: () => InterruptMode
  /** The assistant became audible. */
  playbackStarted(now: number): void
  /** Playback finished or stopped; the window closes `ECHO_TAIL_MS` later. */
  playbackEnded(now: number): void
  /** A clause started playing (its text as sent to the voice). */
  clausePlayed(text: string, now: number): void
  /** Whether the audible window is open at `now`. */
  audible(now: number): boolean
  filter(event: SttEvent, now: number): GateResult
}

const words = (text: string): Array<string> =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter((w) => w.length > 0)

const pass = (...events: Array<SttEvent>): GateResult => ({ events, dropped: false })
const drop: GateResult = { events: [], dropped: true }
const hold: GateResult = { events: [], dropped: false }

export const makeEchoGate = (initial: InterruptMode = "confirm"): EchoGate => {
  let mode = initial
  let playing = false
  let endedAt: number | undefined
  let held: SttEvent | undefined
  let played: Array<{ readonly words: ReadonlyArray<string>; readonly at: number }> = []

  const audible = (now: number) => playing || (endedAt !== undefined && now - endedAt < ECHO_TAIL_MS)

  /** The user, not echo: enough words, and mostly words that were not just played. */
  const isUser = (text: string, now: number): boolean => {
    const heard = words(text).slice(-ECHO_WORDS)
    if (heard.length < ECHO_MIN_WORDS) return false
    played = played.filter((p) => now - p.at <= ECHO_MEMORY_MS)
    const recent = new Set(played.flatMap((p) => p.words))
    const overlap = heard.filter((w) => recent.has(w)).length / heard.length
    return overlap < ECHO_MAX_OVERLAP
  }

  const release = (...events: Array<SttEvent>): GateResult => {
    const first = held
    held = undefined
    return first === undefined ? pass(...events) : pass(first, ...events)
  }

  return {
    setMode: (next) => {
      mode = next
      held = undefined
    },
    mode: () => mode,
    playbackStarted: () => {
      playing = true
      endedAt = undefined
    },
    playbackEnded: (now) => {
      if (!playing) return
      playing = false
      endedAt = now
    },
    clausePlayed: (text, now) => {
      played.push({ words: words(text), at: now })
    },
    audible,
    filter: (event, now) => {
      if (!audible(now)) {
        // The window closed: a still-held SpeechStarted was echo after all.
        held = undefined
        return pass(event)
      }
      switch (mode) {
        case "instant":
          return pass(event)
        case "manual":
          return drop
        case "confirm":
          switch (event._tag) {
            case "SpeechStarted":
              held = event
              return hold
            case "Interim":
              return isUser(event.text, now) ? release(event) : drop
            case "EagerEndOfTurn":
            case "EndOfTurn":
              return isUser(event.text, now) ? release(event) : drop
            case "TurnResumed":
              return pass(event)
          }
      }
    }
  }
}
