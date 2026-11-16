// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Mode } from "../src/contract.ts"
import { Conversation } from "../src/driver.ts"
import type { MicFeed } from "../src/sources.ts"
import type { VoiceClip } from "../src/synth.ts"

const RATE = 16000
const DT = 1 / 60

/** A clip of a steady tone with one phrase (seconds), so the loop's timing is predictable. */
const clip = (label: string, seconds: number, phrase: { start: number; end: number }, hz = 150): VoiceClip => ({
  samples: Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => (i / RATE >= phrase.start && i / RATE < phrase.end ? 0.2 * Math.sin((2 * Math.PI * hz * i) / RATE) : 0)),
  sampleRate: RATE,
  phrases: [phrase],
  label
})

const user = () => clip("user", 3, { start: 0.5, end: 1.5 }) // plays 0.45 .. 1.85 s = 1.4 s
const agent = () => clip("agent", 3, { start: 0.5, end: 1.5 }, 220)

const make = (pin: "auto" | Mode = "auto") => new Conversation({ pin, user: user(), agent: agent() })

/** Step until the mode changes (or `max` seconds pass); returns the seconds it took. */
const untilChange = (c: Conversation, max = 10): number => {
  const from = c.mode
  let t = 0
  while (c.mode === from && t < max) {
    c.step(DT)
    t += DT
  }
  return t
}

/** Step until the conversation reaches `mode` (at most `max` seconds). */
const untilMode = (c: Conversation, mode: Mode, max = 30): void => {
  for (let t = 0; t < max && c.mode !== mode; t += DT) c.step(DT)
  expect(c.mode).toBe(mode)
}

describe("Conversation (automatic loop)", () => {
  it("starts idle, with silent features", () => {
    const c = make()
    expect(c.mode).toBe("idle")
    expect(c.pinned).toBe("auto")
    expect(c.user.speaking).toBe(false)
    expect(c.agent.speaking).toBe(false)
    expect(c.audible).toBeNull()
  })

  it("runs idle 1.5 s → listening 1.2 s → hearing → thinking 1.5 s → speaking → listening", () => {
    const c = make()
    expect(untilChange(c)).toBeCloseTo(1.5, 1)
    expect(c.mode).toBe("listening")
    expect(c.prevMode).toBe("idle")
    expect(c.modeAge).toBeLessThan(DT)
    expect(untilChange(c)).toBeCloseTo(1.2, 1)
    expect(c.mode).toBe("hearing")
    expect(untilChange(c)).toBeCloseTo(1.4, 1) // the phrase plus its lead and tail
    expect(c.mode).toBe("thinking")
    expect(untilChange(c)).toBeCloseTo(1.5, 1)
    expect(c.mode).toBe("speaking")
    expect(untilChange(c)).toBeCloseTo(1.4, 1)
    expect(c.mode).toBe("listening")
    expect(c.prevMode).toBe("speaking")
  })

  it("goes back through idle on every third exchange", () => {
    const c = make()
    const afterSpeaking: Array<Mode> = []
    for (let guard = 0; guard < 40 && afterSpeaking.length < 3; guard++) {
      const from = c.mode
      untilChange(c)
      if (from === "speaking") afterSpeaking.push(c.mode)
    }
    expect(afterSpeaking).toEqual(["listening", "listening", "idle"])
  })

  it("only the side that is on hears audio: user in hearing, agent in speaking", () => {
    const c = make()
    untilMode(c, "hearing")
    for (let i = 0; i < 40; i++) c.step(DT)
    expect(c.user.level).toBeGreaterThan(0.05)
    expect(c.user.speaking).toBe(true)
    expect(c.agent.level).toBe(0)
    expect(c.audible).not.toBeNull()
    untilMode(c, "speaking")
    for (let i = 0; i < 40; i++) c.step(DT)
    expect(c.agent.level).toBeGreaterThan(0.05)
    expect(c.agent.speaking).toBe(true)
    expect(c.user.speaking).toBe(false)
    expect(c.audible).not.toBeNull()
  })

  it("keeps hearing/speaking audible only in those modes", () => {
    const c = make()
    untilMode(c, "thinking")
    expect(c.audible).toBeNull()
  })

  it("the clock advances with every step and modeAge resets on a mode change", () => {
    const c = make()
    for (let i = 0; i < 30; i++) c.step(DT)
    expect(c.clock).toBeCloseTo(0.5, 6)
    expect(c.modeAge).toBeCloseTo(0.5, 6)
    untilChange(c)
    expect(c.modeAge).toBeLessThan(0.05)
    expect(c.clock).toBeGreaterThan(1.5)
  })
})

describe("Conversation (pinned)", () => {
  for (const mode of ["idle", "listening", "hearing", "thinking", "speaking"] as const) {
    it(`pin "${mode}" holds the mode`, () => {
      const c = make(mode)
      expect(c.mode).toBe(mode)
      expect(c.pinned).toBe(mode)
      for (let i = 0; i < 60 * 12; i++) c.step(DT)
      expect(c.mode).toBe(mode)
    })
  }

  it("pinned hearing loops the whole user clip; pinned speaking loops the agent clip", () => {
    const h = make("hearing")
    let spoke = 0
    for (let i = 0; i < 60 * 8; i++) {
      h.step(DT)
      if (h.user.speaking) spoke++
    }
    expect(spoke).toBeGreaterThan(60 * 2) // speech on in several passes of the loop
    expect(h.audible).not.toBeNull()
    const s = make("speaking")
    for (let i = 0; i < 60 * 3; i++) s.step(DT)
    expect(s.audible).not.toBeNull()
    expect(s.audible!.playing).toBe(true)
  })

  it("pinned idle and thinking are silent on both sides", () => {
    for (const mode of ["idle", "thinking"] as const) {
      const c = make(mode)
      for (let i = 0; i < 120; i++) c.step(DT)
      expect(c.user.level).toBe(0)
      expect(c.agent.level).toBe(0)
      expect(c.audible).toBeNull()
    }
  })

  it("pinned listening carries only faint room tone: the user is not speaking", () => {
    const c = make("listening")
    for (let i = 0; i < 180; i++) c.step(DT)
    expect(c.user.speaking).toBe(false)
    expect(c.user.level).toBeLessThan(0.05)
  })

  it("setPin switches the mode at once; back to auto starts in listening and the loop resumes", () => {
    const c = make("auto")
    c.setPin("thinking")
    expect(c.mode).toBe("thinking")
    expect(c.prevMode).toBe("idle")
    c.setPin("thinking") // no change
    expect(c.pinned).toBe("thinking")
    c.setPin("auto")
    expect(c.pinned).toBe("auto")
    expect(c.mode).toBe("listening")
    expect(untilChange(c)).toBeCloseTo(1.2, 1)
    expect(c.mode).toBe("hearing")
  })
})

describe("Conversation clips", () => {
  it("swapping the user clip while hearing restarts it, and the same clip is a no-op", () => {
    const c = make("hearing")
    for (let i = 0; i < 30; i++) c.step(DT)
    const next = clip("loud user", 2, { start: 0, end: 2 }, 300)
    c.setUserClip(next)
    c.setUserClip(next)
    for (let i = 0; i < 20; i++) c.step(DT)
    expect(c.mode).toBe("hearing")
    expect(c.user.speaking).toBe(true)
    expect(c.user.pitchHz).toBeGreaterThan(250)
  })

  it("swapping the agent clip while speaking restarts it", () => {
    const c = make("speaking")
    for (let i = 0; i < 30; i++) c.step(DT)
    c.setAgentClip(clip("high agent", 2, { start: 0, end: 2 }, 300))
    for (let i = 0; i < 20; i++) c.step(DT)
    expect(c.agent.pitchHz).toBeGreaterThan(250)
  })
})

describe("Conversation with a microphone", () => {
  /** A fake mic: a fixed sample rate whose window is whatever `level` says. */
  const fakeMic = () => {
    const state = { on: false }
    const loud = new Float32Array(640)
    for (let i = 0; i < loud.length; i++) loud[i] = 0.25 * Math.sin((2 * Math.PI * 160 * i) / RATE)
    const quiet = new Float32Array(640)
    const mic = { sampleRate: RATE, window: () => (state.on ? loud : quiet) } as unknown as MicFeed
    return { mic, state }
  }

  it("listening waits for speech, hearing ends 0.6 s after the person stops, and it never goes idle", () => {
    const c = make("auto")
    const { mic, state } = fakeMic()
    c.setMic(mic)
    expect(c.mode).toBe("listening")
    for (let i = 0; i < 60 * 5; i++) c.step(DT) // five quiet seconds: still listening
    expect(c.mode).toBe("listening")
    state.on = true
    for (let i = 0; i < 60 && c.mode === "listening"; i++) c.step(DT)
    expect(c.mode).toBe("hearing")
    for (let i = 0; i < 60; i++) c.step(DT) // keep talking: stays in hearing
    expect(c.mode).toBe("hearing")
    state.on = false
    let t = 0
    while (c.mode === "hearing" && t < 5) {
      c.step(DT)
      t += DT
    }
    expect(c.mode).toBe("thinking")
    // silence is measured from when speech stopped (after the 250 ms hangover) + 0.6 s
    expect(t).toBeGreaterThan(0.6)
    expect(t).toBeLessThan(1.5)
    // the simulated user clip is not audible while the real mic is in use
    c.setPin("hearing")
    expect(c.audible).toBeNull()
  })

  it("setMic(null) goes back to the simulator", () => {
    const c = make("auto")
    c.setMic(fakeMic().mic)
    c.setMic(null)
    expect(c.mode).toBe("listening")
    expect(untilChange(c)).toBeCloseTo(1.2, 1)
    expect(c.mode).toBe("hearing")
    expect(c.audible).not.toBeNull()
  })
})

describe("Conversation analysis at other sample rates", () => {
  it("keeps the learned register through silence after a 44.1 kHz phrase", () => {
    const rate = 44100
    const phrase = { start: 0.5, end: 2 }
    const user44 = (): VoiceClip => ({
      samples: Float32Array.from({ length: rate * 3 }, (_, i) => (i / rate >= phrase.start && i / rate < phrase.end ? 0.2 * Math.sin((2 * Math.PI * 150 * i) / rate) : 0)),
      sampleRate: rate,
      phrases: [phrase],
      label: "user44"
    })
    const c = new Conversation({ pin: "auto", user: user44(), agent: agent() })
    untilMode(c, "hearing")
    // Let the person speak for a while so the extractor learns their register.
    for (let t = 0; t < 1.2; t += DT) c.step(DT)
    const during = c.user
    const registerDuring = during.register
    expect(c.user.speaking).toBe(true)
    expect(registerDuring).toBeGreaterThan(0)
    // The phrase ends and the side is fed silence (thinking): the same extractor must carry on.
    untilMode(c, "thinking")
    for (let t = 0; t < 0.5; t += DT) c.step(DT)
    expect(c.user).toBe(during)
    expect(c.user.register).toBeCloseTo(registerDuring, 5)
    expect(c.user.silenceFor).toBeGreaterThan(0)
  })
})
