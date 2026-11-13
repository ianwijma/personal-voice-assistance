/**
 * Turn detection as a pure state machine: per-frame speech/silence decisions
 * and transcript updates in, `SttEvent`s and recogniser commands out. No
 * clocks, no I/O: time is counted in frames, so tests can script it.
 *
 * How a turn goes:
 * - Speech for `minSpeechMs` opens the turn: `SpeechStarted`.
 * - Partial transcripts of the open segment become `Interim`s.
 * - After `eagerSilenceMs` of silence the detector asks for the segment to be
 *   finalised (`Finalize`). The recogniser answers with the segment's final
 *   text (or a cancel, if speech arrived after the decision point); a turn
 *   with words then gets `EagerEndOfTurn` with all segments so far.
 * - Speech for `minSpeechMs` after that: `TurnResumed`; the next pause
 *   finalises the new segment and sends `EagerEndOfTurn` again.
 * - After `finalSilenceMs`: `EndOfTurn` with the same text as the last
 *   `EagerEndOfTurn` (segments are already final, nothing is re-decoded).
 * - Every utterance that got `SpeechStarted` ends with `EndOfTurn`: with an
 *   empty `text` when no words were recognised (noise, a turn dropped because
 *   the recogniser was overloaded, or input that ended first). An utterance
 *   that never got `SpeechStarted` (a click) ends with no event. `EagerEndOfTurn`
 *   is never empty.
 * - When a turn ends (committed, or dropped because it had no words), the
 *   detector says so (`Commit`), so a recogniser that keeps the turn's audio
 *   can drop it.
 *
 * Cumulative mode (whole-turn recognisers, `cumulative: true`): each answer to
 * `Finalize` is the text of the whole turn so far, decoded again from its
 * start, so it replaces the turn's text instead of being appended. Partials
 * are the live text of the whole turn (from a streaming model running beside
 * it, or from re-decoding the turn so far while the user speaks): they only
 * become `Interim`s and never decide that the user resumed (a streaming
 * model's partial lags the audio and catches up after the pause); resumption
 * is the VAD's call. A turn whose speech never reached
 * `minSpeechMs` (a click, a cough) gets no text in this mode, whatever the
 * model made of it.
 *
 * The thresholds come from an `EndOfTurnPolicy` that sees the transcript, so a
 * smarter detector (one that judges whether the sentence is complete) can
 * shorten or lengthen them without touching anything else.
 */
import type { SttEvent } from "@pva/core"

export const FRAME_MS = 20

export type TurnInput =
  /** One frame of audio was processed; `speech` is the VAD decision. */
  | { readonly _tag: "Frame"; readonly speech: boolean }
  /** Partial transcript of the open segment. */
  | { readonly _tag: "Partial"; readonly text: string }
  /** Answer to `Finalize`: the segment's final text (may be empty). */
  | { readonly _tag: "Segment"; readonly text: string }
  /** Answer to `Finalize`: speech came in after the decision point, the segment stays open. */
  | { readonly _tag: "SegmentCancelled" }
  /** The audio ended. */
  | { readonly _tag: "End" }

export type TurnOutput =
  | SttEvent
  /**
   * Finalise the open segment, unless the VAD saw speech after frame `frame`. With `through`: finalise the turn
   * as it was at frame `frame` (whole-turn recognisers decode its audio up to that frame), whatever came after.
   */
  | { readonly _tag: "Finalize"; readonly frame: number; readonly through?: true }
  /** The turn ended at frame `frame` (committed or dropped). */
  | { readonly _tag: "Commit"; readonly frame: number }

export interface EndOfTurnPolicy {
  /** Silence after which the open segment is finalised and `EagerEndOfTurn` sent. */
  readonly eagerSilenceMs: (text: string) => number
  /** Silence after which the turn is committed with `EndOfTurn`. */
  readonly finalSilenceMs: (text: string) => number
}

export const fixedSilence = (eagerMs: number, finalMs: number): EndOfTurnPolicy => ({
  eagerSilenceMs: () => eagerMs,
  finalSilenceMs: () => finalMs
})

export interface TurnDetectorOptions {
  readonly policy: EndOfTurnPolicy
  /** Continuous speech needed for `SpeechStarted` / `TurnResumed` (filters clicks and short noises). */
  readonly minSpeechMs: number
  /** Answers to `Finalize` are the whole turn's text (see above). Default false. */
  readonly cumulative?: boolean
}

const SPEECH_STARTED: SttEvent = { _tag: "SpeechStarted" }
const TURN_RESUMED: SttEvent = { _tag: "TurnResumed" }

export class TurnDetector {
  private readonly options: TurnDetectorOptions
  private frame = 0
  private speechMs = 0
  private silenceMs = 0
  /** `SpeechStarted` was sent for this turn. */
  private open = false
  /** Final texts of the finalised segments of this turn. */
  private segments: Array<string> = []
  private partial = ""
  private lastInterim = ""
  /** VAD speech since the last `Finalize`: the open segment has audio to finalise. */
  private heard = false
  /** A `Finalize` is waiting for its answer. */
  private pending = false
  /** Commit as soon as the pending segment is final. */
  private finalDue = false
  /** The frame at which the final threshold passed while a `Finalize` was pending. */
  private finalFrame = -1
  /** Speech of at least `minSpeechMs` came after that point: the next turn has started. */
  private nextTurnStarted = false
  /**
   * The user went on (speech of at least `minSpeechMs`) while a `Finalize` was pending, before the final
   * threshold: that answer does not cover the whole turn.
   */
  private resumedWhilePending = false
  /** VAD speech after the final threshold while its answer was awaited (the next turn's audio). */
  private heardAfterFinal = false
  private ended = false
  /** Text of the `EagerEndOfTurn` that has not been resumed. */
  private eagerText: string | undefined = undefined

  constructor(options: TurnDetectorOptions) {
    this.options = options
  }

  /** No `Finalize` is waiting for an answer. After `End`, this means the detector is done. */
  get settled(): boolean {
    return !this.pending
  }

  step(input: TurnInput): Array<TurnOutput> {
    const out: Array<TurnOutput> = []
    switch (input._tag) {
      case "Frame":
        this.onFrame(input.speech, out)
        break
      case "Partial":
        this.onPartial(input.text.trim(), out)
        break
      case "Segment":
        this.onSegment(input.text.trim(), out)
        break
      case "SegmentCancelled":
        this.pending = false
        this.heard = true
        // Speech after the request, but the turn already ended at the final threshold (input that arrives in
        // bursts, or a worker far behind): decode the turn as it was at that point, then go on with the rest.
        if (this.finalDue) this.finalizeThrough(out)
        break
      case "End":
        this.ended = true
        if (this.pending && !this.finalDue) this.finalFrame = this.frame
        this.finalDue = true
        if (this.heard && !this.pending) this.finalize(out)
        else if (!this.pending) this.commit(out)
        break
    }
    return out
  }

  private text(): string {
    if (this.options.cumulative) return this.segments.join(" ")
    return this.partial ? [...this.segments, this.partial].join(" ") : this.segments.join(" ")
  }

  private active(): boolean {
    return this.open || this.heard || this.pending || this.segments.length > 0
  }

  private onFrame(speech: boolean, out: Array<TurnOutput>): void {
    this.frame++
    if (this.ended) return
    if (speech) {
      this.speechMs += FRAME_MS
      this.silenceMs = 0
      this.heard = true
      if (this.finalDue && this.pending) this.heardAfterFinal = true
      if (this.speechMs >= this.options.minSpeechMs) {
        // The turn is over (final threshold passed), only its answer is awaited: this speech is the next turn.
        if (this.finalDue && this.pending) this.nextTurnStarted = true
        else {
          if (this.pending) this.resumedWhilePending = true
          if (!this.open) this.openTurn(out)
          else this.resume(out)
        }
      }
      return
    }
    this.speechMs = 0
    if (!this.active()) return
    this.silenceMs += FRAME_MS
    const text = this.text()
    const final = this.silenceMs >= this.options.policy.finalSilenceMs(text)
    if (this.heard && !this.pending && (final || this.silenceMs >= this.options.policy.eagerSilenceMs(text))) {
      this.finalize(out)
    }
    if (final) {
      if (this.pending) {
        if (!this.finalDue) this.finalFrame = this.frame
        this.finalDue = true
      }
      else this.commit(out)
    }
  }

  private onPartial(text: string, out: Array<TurnOutput>): void {
    if (this.options.cumulative) {
      if (!text || text === this.lastInterim) return
      if (!this.open) this.openTurn(out)
      this.lastInterim = text
      out.push({ _tag: "Interim", text })
      return
    }
    this.partial = text
    const interim = this.text()
    if (!text || interim === this.lastInterim) return
    if (!this.open) this.openTurn(out)
    this.resume(out) // new words after an eager end of turn: the user went on (even if the VAD missed it)
    this.lastInterim = interim
    out.push({ _tag: "Interim", text: interim })
  }

  private onSegment(text: string, out: Array<TurnOutput>): void {
    this.pending = false
    this.partial = ""
    if (this.options.cumulative) {
      // Replaces the turn's text. Noise that never opened the turn has no text.
      this.segments = text && this.open ? [text] : []
      if (!this.heard && !this.finalDue && !this.active()) {
        out.push({ _tag: "Commit", frame: this.frame })
        return
      }
    } else if (text) this.segments.push(text)
    if (this.finalDue && this.resumedWhilePending) {
      // The turn ended at the final threshold, but the user had gone on while this answer was being decoded,
      // before that point: the answer misses those words (streaming: they are in a segment still open). Decode the turn through the final threshold again
      // before committing it (committing now would drop that audio). Speech after the threshold, if any,
      // stays the next turn's (`heard` / `nextTurnStarted` are kept).
      this.finalizeThrough(out)
      return
    }
    if (this.heard && this.finalDue) {
      // The turn ended at the final threshold while its answer was being decoded (a slow model); the speech
      // since then belongs to the next turn, not to this one.
      const started = this.nextTurnStarted
      const silenceMs = this.silenceMs
      this.commit(out, this.finalFrame)
      this.heard = true
      this.silenceMs = silenceMs
      if (started) this.openTurn(out)
      // The input is over: nothing else will finalise the next turn.
      if (this.ended) this.finalize(out)
      return
    }
    if (this.heard) {
      // Speech after the decision point went into a new segment; the next pause finalises it.
      if (this.finalDue) this.finalize(out)
      return
    }
    if (this.finalDue) return this.commit(out)
    const joined = this.text()
    if (!joined) return
    if (!this.open) this.openTurn(out)
    if (joined === this.eagerText) return
    this.resume(out)
    this.eagerText = joined
    out.push({ _tag: "EagerEndOfTurn", text: joined })
  }

  /** Finalise the turn that ended at the final threshold, through that frame, whatever came after it. */
  private finalizeThrough(out: Array<TurnOutput>): void {
    this.resumedWhilePending = false
    this.heard = this.heardAfterFinal
    this.pending = true
    out.push({ _tag: "Finalize", frame: this.finalFrame, through: true })
  }

  private finalize(out: Array<TurnOutput>): void {
    this.heard = false
    this.pending = true
    out.push({ _tag: "Finalize", frame: this.frame })
  }

  private openTurn(out: Array<TurnOutput>): void {
    this.open = true
    out.push(SPEECH_STARTED)
  }

  private resume(out: Array<TurnOutput>): void {
    if (this.eagerText === undefined) return
    this.eagerText = undefined
    out.push(TURN_RESUMED)
  }

  private commit(out: Array<TurnOutput>, frame: number = this.frame): void {
    const text = this.text()
    if (text || this.open) {
      if (!this.open) out.push(SPEECH_STARTED)
      // Empty when no words were recognised: the utterance that `SpeechStarted` opened is over all the same.
      out.push({ _tag: "EndOfTurn", text })
    }
    out.push({ _tag: "Commit", frame })
    this.finalFrame = -1
    this.nextTurnStarted = false
    this.resumedWhilePending = false
    this.heardAfterFinal = false
    this.open = false
    this.segments = []
    this.partial = ""
    this.lastInterim = ""
    this.heard = false
    this.finalDue = this.ended
    this.eagerText = undefined
    this.silenceMs = 0
  }
}
