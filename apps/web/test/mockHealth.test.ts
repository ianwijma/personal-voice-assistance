import type { HealthInfo, ServerMessage } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { answerHealthCheck } from "../mock/health.ts"

// Review round 4 (p1-r4c finding 8): the mock answers `health.check` as the server does: the current health before
// the result, for the requester that starts the check and for one that joins it; one timer, one completion.
describe("mock health.check", () => {
  it("two requests: each sees the running check before its result; one completion", () => {
    const state = { health: { issues: [], checkedAt: 1, checking: false } as HealthInfo }
    const log: Array<string> = []
    const timers: Array<() => void> = []
    const io = (who: string) => ({
      send: (m: ServerMessage) => void log.push(`${who} <- ${m.type}${m.type === "health" ? ` checking=${m.health.checking}` : ""}`),
      broadcast: (m: ServerMessage) => void log.push(`all <- ${m.type}${m.type === "health" ? ` checking=${m.health.checking}` : ""}`),
      result: () => void log.push(`${who} <- result`),
      after: (_ms: number, run: () => void) => void timers.push(run),
      finished: (h: HealthInfo) => ({ ...h, checkedAt: 2 })
    })
    answerHealthCheck(state, io("a"))
    answerHealthCheck(state, io("b"))
    expect(timers).toHaveLength(1)
    timers[0]!()
    expect(log).toEqual([
      "all <- health checking=true",
      "a <- result",
      "b <- health checking=true",
      "b <- result",
      "all <- health checking=false"
    ])
    expect(state.health).toEqual({ issues: [], checkedAt: 2, checking: false })
  })
})
