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

describe("state tracker: asleep (wake-phrase mode)", () => {
  it("listening becomes asleep while the gate is asleep; a window re-check brings it back without any event", async () => {
    let asleep = true
    const seen: Array<string> = []
    const t = makeStateTracker({ onChange: (s) => seen.push(s.state), asleep: () => asleep })
    t.setOwner(true, true)
    expect(t.current().state).toBe("asleep")
    // Muted: idle, not asleep.
    t.setOwner(true, false)
    expect(t.current().state).toBe("idle")
    t.setOwner(true, true)
    // A window opens (the phrase alone): listening, and asleep again once it closes by itself.
    asleep = false
    t.wakeChanged(30)
    expect(t.current().state).toBe("listening")
    setTimeout(() => (asleep = true), 20)
    await new Promise((r) => setTimeout(r, 80))
    expect(t.current().state).toBe("asleep")
    // Speech that passed the gate still shows as hearing, a turn as thinking.
    t.stt({ _tag: "SpeechStarted" })
    expect(t.current().state).toBe("hearing")
    t.turnStarted(1, false)
    expect(t.current().state).toBe("thinking")
    expect(seen).toEqual(["asleep", "idle", "asleep", "listening", "asleep", "hearing", "thinking"])
    t.dispose()
  })
})
