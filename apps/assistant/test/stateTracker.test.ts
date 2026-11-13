import { describe, expect, it } from "vitest"
import { makeStateTracker } from "../src/serve/StateTracker.ts"

const tracker = () => {
  const seen: Array<string> = []
  const t = makeStateTracker({ onChange: (s) => seen.push(s.state), now: () => 0 })
  t.setOwner(true, true)
  t.turnStarted(1, false)
  t.playbackStarted(1)
  return { t, seen }
}

describe("state tracker", () => {
  it("after finished or stopped, stays speaking until the turn ends (no flicker through thinking)", () => {
    for (const reason of ["finished", "stopped"] as const) {
      const { t, seen } = tracker()
      t.playbackEnded(1, reason)
      expect(t.current().state).toBe("speaking")
      t.turnEnded(1)
      expect(seen).toEqual(["listening", "thinking", "speaking", "listening"])
      t.dispose()
    }
  })

  it("after a failed playback (owner lost, stall), drops to thinking at once", () => {
    const { t } = tracker()
    t.playbackEnded(1, "failed")
    expect(t.current()).toEqual({ state: "thinking", turnId: 1 })
    t.dispose()
  })
})
