import type { SttEvent } from "@pva/core"
import type { AssistantState } from "@pva/protocol"

/**
 * The assistant state (docs/UI-AND-MODULES.md §2.4), computed on the server
 * from ownership, the microphone, recognition events, turns and playback.
 * Calls `onChange` only when the state (or its turn) changes. First match wins:
 * speaking > thinking > hearing > listening > idle.
 */

/** An utterance counts as open this long after the last recognition event. */
export const HEARING_WINDOW_MS = 2_000

export interface StateTracker {
  readonly current: () => { readonly state: AssistantState; readonly turnId?: number }
  readonly setOwner: (present: boolean, micLive: boolean) => void
  /** A recognition event that passed the echo gate. */
  readonly stt: (event: SttEvent) => void
  readonly turnStarted: (turnId: number, speculative: boolean) => void
  readonly turnPromoted: (turnId: number) => void
  readonly turnEnded: (turnId: number) => void
  readonly playbackStarted: (turnId: number) => void
  /**
   * Playback ended. After `finished` (the turn is about to complete) and after `stopped` (the turn is being
   * interrupted: barge-in, Stop) the turn ends within milliseconds, so the state stays `speaking` until
   * `turnEnded` instead of flickering through `thinking`. After `failed` it drops to `thinking` at once.
   */
  readonly playbackEnded: (turnId: number, reason?: "finished" | "stopped" | "failed") => void
  readonly dispose: () => void
}

export const makeStateTracker = (options: {
  readonly onChange: (state: { readonly state: AssistantState; readonly turnId?: number }) => void
  readonly now?: () => number
}): StateTracker => {
  const now = options.now ?? (() => performance.now())
  let owner = false
  let micLive = false
  let committed: number | undefined
  let pending: number | undefined
  let playing: number | undefined
  let utteranceAt: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: { state: AssistantState; turnId?: number } = { state: "idle" }

  const compute = (): { state: AssistantState; turnId?: number } => {
    if (playing !== undefined && playing === committed) return { state: "speaking", turnId: playing }
    if (committed !== undefined) return { state: "thinking", turnId: committed }
    const live = owner && micLive
    if (live && (pending !== undefined || (utteranceAt !== undefined && now() - utteranceAt < HEARING_WINDOW_MS))) return { state: "hearing" }
    if (live) return { state: "listening" }
    return { state: "idle" }
  }

  const update = () => {
    const next = compute()
    if (next.state !== last.state || next.turnId !== last.turnId) {
      last = next
      options.onChange(next)
    }
  }

  const touchUtterance = () => {
    utteranceAt = now()
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      update()
    }, HEARING_WINDOW_MS + 5)
    timer.unref?.()
  }

  return {
    current: () => last,
    setOwner: (present, live) => {
      owner = present
      micLive = live
      update()
    },
    stt: (event) => {
      if (event._tag === "EndOfTurn") return
      touchUtterance()
      update()
    },
    turnStarted: (turnId, speculative) => {
      if (speculative) pending = turnId
      else {
        committed = turnId
        utteranceAt = undefined
      }
      update()
    },
    turnPromoted: (turnId) => {
      if (pending === turnId) pending = undefined
      committed = turnId
      utteranceAt = undefined
      update()
    },
    turnEnded: (turnId) => {
      if (pending === turnId) pending = undefined
      if (committed === turnId) committed = undefined
      if (playing === turnId) playing = undefined
      update()
    },
    playbackStarted: (turnId) => {
      playing = turnId
      update()
    },
    playbackEnded: (turnId, reason) => {
      if (playing === turnId && !((reason === "finished" || reason === "stopped") && committed === turnId)) playing = undefined
      update()
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
