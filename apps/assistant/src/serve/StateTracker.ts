import type { SttEvent } from "@pva/core"
import type { AssistantState } from "@pva/protocol"

/**
 * The assistant state (docs/UI-AND-MODULES.md §2.4), computed on the server
 * from ownership, the microphone, recognition events, turns and playback.
 * Calls `onChange` only when the state (or its turn) changes. First match wins:
 * speaking > thinking > hearing > asleep > listening > idle.
 *
 * `asleep` (protocol 5): the owner's microphone is live, its device is in wake-phrase mode and the wake gate is not
 * awake (`options.asleep`). The gate's windows close by time, so `wakeChanged(ms)` re-checks the state after `ms`
 * (the longest window that may have just opened), and the state returns to `asleep` with nobody speaking.
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
  /** The wake gate's state may have changed now, and may change again by itself within `recheckInMs`. */
  readonly wakeChanged: (recheckInMs?: number) => void
  readonly dispose: () => void
}

export const makeStateTracker = (options: {
  readonly onChange: (state: { readonly state: AssistantState; readonly turnId?: number }) => void
  readonly now?: () => number
  /** The owner's device is in wake-phrase mode and the wake gate is asleep. Default: never. */
  readonly asleep?: () => boolean
}): StateTracker => {
  const asleep = options.asleep ?? (() => false)
  /** One per window that may close by itself (rare: a reply end, a phrase); each re-checks once. */
  const wakeTimers = new Set<ReturnType<typeof setTimeout>>()
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
    if (live && asleep()) return { state: "asleep" }
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
    wakeChanged: (recheckInMs) => {
      update()
      if (recheckInMs === undefined) return
      const t = setTimeout(() => {
        wakeTimers.delete(t)
        update()
      }, recheckInMs + 5)
      t.unref?.()
      wakeTimers.add(t)
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      for (const t of wakeTimers) clearTimeout(t)
      wakeTimers.clear()
    }
  }
}
