import type { HealthInfo, ServerMessage } from "@pva/protocol"

/** What the mock does for one `health.check` (its effects injected, so the order can be tested). */
export interface HealthCheckIo {
  /** To the requester only. */
  readonly send: (message: ServerMessage) => void
  /** To every admin page (the requester included). */
  readonly broadcast: (message: ServerMessage) => void
  /** The request's `result`. */
  readonly result: () => void
  readonly after: (ms: number, run: () => void) => void
  /** The health once the check is done. */
  readonly finished: (health: HealthInfo) => HealthInfo
}

/**
 * One `health.check`, answered as the server answers it (SessionHub): the requester first has the current health
 * (`checking: true`), then its result; the outcome follows as `health`. A check already running is joined: the joining
 * requester is sent the current health before its result, and there is one timer and one completion for any number
 * of requests.
 */
export const answerHealthCheck = (state: { health: HealthInfo }, io: HealthCheckIo, ms = 1000): void => {
  if (state.health.checking) {
    io.send({ type: "health", health: state.health })
    io.result()
    return
  }
  state.health = { ...state.health, checking: true }
  io.broadcast({ type: "health", health: state.health })
  io.result()
  io.after(ms, () => {
    state.health = { ...io.finished(state.health), checking: false }
    io.broadcast({ type: "health", health: state.health })
  })
}
