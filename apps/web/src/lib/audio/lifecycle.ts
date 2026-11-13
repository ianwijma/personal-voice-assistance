/**
 * The microphone-and-session lifecycle of the page, as one explicit state
 * machine. `VoiceAudio` owns an instance and the client reads it; every
 * asynchronous continuation (a `getUserMedia` that settles, a graph that
 * finishes building, a context that finishes closing, a client `.then`)
 * captures a `Ticket` first and checks it before changing anything. A stale
 * continuation may only clean up what it opened itself.
 *
 * ```
 *                 start                    started
 *   idle ───────────────────▶ starting ─────────────────▶ running
 *   failed ──────┘              │  ▲ mic-change            │  ▲
 *     ▲                         │  └─(new request; the     │  │ mic-acquired
 *     │ refused / track-ended / │     start loop opens     │  │ (current request)
 *     │ player-failed           │                          │  │
 *     ├─────────────────────────┘     the latest one)      ▼  │
 *     │                                       mic-change ┌──────────┐
 *     │ refused (no fallback) / track-ended /     ───────▶│replacing │◀─┐ mic-change
 *     │ player-failed (also from running)                 │          │  │
 *     └──────────────────────────────────────────────────└──────────┘──┘
 *
 *   any but idle ── end / takeover ──▶ stopping ── stopped ──▶ idle
 * ```
 *
 * - `session` changes on start, end, takeover and fatal failure: everything
 *   begun under an older session is stale (its stream is stopped, its context
 *   closed, its result ignored; it never stops the newer session).
 * - `request` changes on every microphone acquisition within a session: an
 *   older acquisition is superseded (its stream is stopped) but its session is
 *   untouched: a superseded request never stops its session.
 * - Permission granted or refused late (after End, a takeover or a newer
 *   change) is a stale event: ignored apart from cleaning up.
 */

/**
 * The one way a continuation is protected (fourth review, finding 2): captured when the work begins,
 * checked when its result arrives. `current()` is still true while nothing newer replaced what the
 * work belongs to; `wrap(f)` is `f` run only while current, for a callback handed to other code to
 * run later (the client's ownership release given to `VoiceAudio.stop`, for one). Every continuation in
 * `client.ts`, `VoiceAudio.ts`, `playback.ts` and this file carries a `continuation(<ticket>)` comment
 * saying what it checks; `test/continuations.test.ts` fails on one that does not.
 */
export interface Guard {
  readonly current: () => boolean
  readonly wrap: <A extends ReadonlyArray<unknown>>(f: (...args: A) => void) => (...args: A) => void
}

export const guardOf = (current: () => boolean): Guard => ({
  current,
  wrap: (f) => (...args) => {
    if (current()) f(...args)
  }
})

export type LifecycleState = "idle" | "starting" | "running" | "replacing" | "stopping" | "failed"

export type LifecycleEvent =
  | "start" // Start pressed: a new session
  | "started" // the graph is built around a current microphone
  | "mic-change" // a device or processing change: a new request in the same session
  | "mic-acquired" // the current request's getUserMedia resolved (permission granted)
  | "mic-refused" // the current request failed and nothing could replace it
  | "track-ended" // the current microphone ended (unplugged, permission revoked), or its capture processor failed
  | "player-failed" // the reply player failed too often to replace it again (`VoiceAudio`, `MAX_PLAYER_REPLACEMENTS`)
  | "end" // End pressed
  | "takeover" // another tab claimed the audio
  | "stopped" // the close finished

export interface Ticket {
  readonly session: number
  readonly request: number
}

/** The allowed transitions; anything else is ignored (and reported as `false`). */
const transitions: Readonly<Record<LifecycleState, Partial<Record<LifecycleEvent, LifecycleState>>>> = {
  idle: { start: "starting" },
  failed: { start: "starting", end: "stopping", takeover: "stopping" },
  starting: {
    "mic-change": "starting",
    "mic-acquired": "starting",
    started: "running",
    "mic-refused": "failed",
    "track-ended": "failed",
    "player-failed": "failed",
    end: "stopping",
    takeover: "stopping"
  },
  running: { "mic-change": "replacing", "track-ended": "failed", "player-failed": "failed", end: "stopping", takeover: "stopping" },
  replacing: {
    "mic-change": "replacing",
    "mic-acquired": "running",
    "mic-refused": "failed",
    "track-ended": "failed",
    "player-failed": "failed",
    end: "stopping",
    takeover: "stopping"
  },
  stopping: { stopped: "idle", start: "starting" }
}

export class Lifecycle {
  private current: LifecycleState = "idle"
  private session = 0
  private request = 0

  get state(): LifecycleState {
    return this.current
  }

  /** Audio is open (or opening) for this session: not idle, stopping or failed. */
  get active(): boolean {
    return this.current === "starting" || this.current === "running" || this.current === "replacing"
  }

  ticket(): Ticket {
    return { session: this.session, request: this.request }
  }

  /** Still the same session (End, a takeover, a failure or a newer Start invalidates it). */
  isSession(t: Ticket): boolean {
    return t.session === this.session && this.active
  }

  /** Still the same session and the latest microphone request. */
  isRequest(t: Ticket): boolean {
    return this.isSession(t) && t.request === this.request
  }

  /** A guard for work of the current session (a newer Start, End, takeover or failure makes it stale). */
  sessionGuard(): Guard {
    const t = this.ticket()
    return guardOf(() => this.isSession(t))
  }

  /** A guard for work of the current microphone request (also stale on a newer device or processing change). */
  requestGuard(): Guard {
    const t = this.ticket()
    return guardOf(() => this.isRequest(t))
  }

  /**
   * Apply `event`. Returns the ticket after it (new session on start, end,
   * takeover and failure; new request on start and mic-change), or `undefined`
   * when the event is not allowed in the current state (nothing changes).
   */
  dispatch(event: LifecycleEvent): Ticket | undefined {
    const next = transitions[this.current][event]
    if (next === undefined) return undefined
    if (event === "start" || event === "end" || event === "takeover" || next === "failed") this.session++
    if (event === "start" || event === "mic-change" || event === "end" || event === "takeover" || next === "failed") this.request++
    this.current = next
    return this.ticket()
  }
}
