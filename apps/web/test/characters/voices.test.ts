// @vitest-environment node
/** The two voices the host feeds characters (src/characters/voices.ts): the live extractor wrapper and the observer's stand-ins. */
import { describe, expect, it } from "vitest"
import { BAND_COUNT, WAVE_SIZE } from "@/characters/contract.ts"
import { agentOn, LiveVoice, noise, standInAgent, standInUser, StandIn, userOn } from "@/characters/voices.ts"

const DT = 1 / 60
const sine = (buf: Float32Array, rate: number, hz: number, amp: number) => {
  for (let i = 0; i < buf.length; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
}

describe("which side is on", () => {
  it("the person while listening or hearing, the assistant only while speaking", () => {
    const table = { idle: [false, false], listening: [true, false], hearing: [true, false], thinking: [false, false], speaking: [false, true] } as const
    for (const [mode, [u, a]] of Object.entries(table)) {
      expect(userOn(mode as keyof typeof table), mode).toBe(u)
      expect(agentOn(mode as keyof typeof table), mode).toBe(a)
    }
  })
})

describe("LiveVoice", () => {
  it("hands out a 40 ms window for the rate it is asked for, and keeps the buffer while the rate stays", () => {
    const v = new LiveVoice()
    expect(v.window(16000).length).toBe(640)
    const same = v.window(16000)
    expect(v.window(16000)).toBe(same)
    expect(v.window(48000).length).toBe(1920)
    expect(v.window(44100).length).toBe(1764)
  })

  it("ignores a rate that is not a real sample rate (below 4 kHz) rather than building an extractor for it", () => {
    const v = new LiveVoice()
    expect(v.window(0).length).toBe(640)
    expect(v.window(-1).length).toBe(640)
    expect(v.window(Number.NaN).length).toBe(640)
    expect(v.window(3999).length).toBe(640)
    expect(v.window(4000).length).toBe(160)
  })

  it("analyses the window when there is audio, and decays to silence when there is none, clearing the window", () => {
    const v = new LiveVoice()
    const w = v.window(16000)
    sine(w, 16000, 200, 0.3)
    let f = v.features
    for (let i = 0; i < 30; i++) f = v.step(DT, true)
    expect(f.level).toBeGreaterThan(0.5)
    expect(f.rms).toBeGreaterThan(0.1)
    for (let i = 0; i < 60; i++) f = v.step(DT, false)
    expect(w.every((x) => x === 0)).toBe(true)
    expect(f.level).toBe(0)
    expect(f.speaking).toBe(false)
  })

  it("exposes the same features object the extractor fills, so reading it never allocates", () => {
    const v = new LiveVoice()
    const a = v.features
    v.step(DT, false)
    expect(v.features).toBe(a)
    expect(v.step(DT, false)).toBe(a)
  })

  it("keeps working after the rate changes (a new extractor with fresh state)", () => {
    const v = new LiveVoice()
    sine(v.window(16000), 16000, 200, 0.3)
    for (let i = 0; i < 20; i++) v.step(DT, true)
    const before = v.features
    sine(v.window(48000), 48000, 200, 0.3)
    for (let i = 0; i < 20; i++) v.step(DT, true)
    expect(v.features).not.toBe(before)
    expect(v.features.level).toBeGreaterThan(0.5)
  })
})

describe("noise", () => {
  it("is smooth, deterministic and within [-1, 1]", () => {
    let prev = noise(0)
    for (let i = 1; i < 5000; i++) {
      const v = noise(i * 0.01)
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(Math.abs(v - prev)).toBeLessThan(0.1)
      expect(noise(i * 0.01)).toBe(v)
      prev = v
    }
  })
})

describe("StandIn", () => {
  const run = (s: StandIn, kind: "silent" | "room" | "voice", seconds: number, t0 = 0) => {
    let f = s.features
    for (let i = 0; i < seconds * 60; i++) f = s.step(kind, t0 + i * DT, DT)
    return f
  }

  it("a talking stand-in is speaking, loud, voiced, with a syllable beat of about four a second", () => {
    const s = standInUser()
    let onsets = 0
    for (let i = 0; i < 600; i++) {
      s.step("voice", i * DT, DT)
      if (s.features.onset === 1) onsets++
    }
    const f = s.features
    expect(f.speaking).toBe(true)
    expect(f.level).toBeGreaterThan(0.15)
    expect(f.voicing).toBeGreaterThan(0.5)
    expect(f.pitchHz).toBeGreaterThan(70)
    expect(f.pitchHz).toBeLessThan(400)
    expect(f.syllableRate).toBeGreaterThan(3.5)
    expect(onsets).toBeGreaterThanOrEqual(30)
    expect(onsets).toBeLessThanOrEqual(50)
    expect(f.mouth.open).toBeGreaterThan(0)
    expect(f.speechFor).toBeGreaterThan(5)
    expect(f.silenceFor).toBe(0)
  })

  it("the wave is the right length and as loud as the rms says (peak = √2 · rms)", () => {
    const s = standInAgent()
    const f = run(s, "voice", 1)
    expect(f.wave.length).toBe(WAVE_SIZE)
    const peak = Math.max(...f.wave.map(Math.abs))
    expect(peak).toBeLessThanOrEqual(Math.SQRT2 * f.rms + 1e-9)
    expect(peak).toBeGreaterThan(0.5 * Math.SQRT2 * f.rms)
    expect(f.bands.length).toBe(BAND_COUNT)
    expect(f.bands[0]!).toBeGreaterThan(f.bands[BAND_COUNT - 1]!)
  })

  it("an open microphone in a quiet room has a small steady level and is not speaking", () => {
    const f = run(standInUser(), "room", 2)
    expect(f.rms).toBeCloseTo(0.0075, 9)
    expect(f.speaking).toBe(false)
    expect(f.level).toBeGreaterThan(0)
    expect(f.level).toBeLessThan(0.3)
    expect(f.pitchHz).toBe(0)
    expect(f.voicing).toBe(0)
  })

  it("falls silent after talking: level and mouth decay to 0, speaking turns off and silenceFor counts up", () => {
    const s = standInUser()
    run(s, "voice", 2)
    expect(s.features.speaking).toBe(true)
    const f = run(s, "silent", 3, 2)
    expect(f.speaking).toBe(false)
    expect(f.rms).toBe(0)
    expect(f.level).toBe(0)
    expect(f.mouth.open).toBeLessThan(0.01)
    expect(f.onset).toBe(0)
    expect(f.syllableRate).toBeLessThan(0.1)
    expect(f.speechFor).toBe(0)
    expect(f.silenceFor).toBeGreaterThan(2.5)
  })

  it("restarts speechFor at 0 when talking begins again", () => {
    const s = standInUser()
    run(s, "voice", 1)
    run(s, "silent", 1, 1)
    s.step("voice", 2, DT)
    expect(s.features.speechFor).toBe(0)
    s.step("voice", 2 + DT, DT)
    expect(s.features.speechFor).toBeCloseTo(DT, 9)
  })

  it("survives a zero, negative, NaN or huge dt: values stay finite and in range", () => {
    const s = standInAgent()
    for (const dt of [0, -1, Number.NaN, 100, 1e9, Infinity]) {
      const f = s.step("voice", 1, dt)
      for (const [k, v] of Object.entries(f)) if (typeof v === "number") expect(Number.isFinite(v), `${k} with dt ${dt}`).toBe(true)
      expect(f.level).toBeGreaterThanOrEqual(0)
      expect(f.level).toBeLessThanOrEqual(1)
      expect(f.mouth.open).toBeLessThanOrEqual(1)
    }
  })

  it("starts at its register (pitch) before it has said anything, and different stand-ins have different registers", () => {
    expect(standInUser().features.register).toBe(0.42)
    expect(standInAgent().features.register).toBe(0.36)
    const custom = new StandIn({ pitch: 0.7, k: 1, loudness: () => 1 })
    expect(custom.features.pitch).toBe(0.7)
  })

  it("the loudness function drives the level: a louder target gives a higher rms, via rms = L² / k", () => {
    const quiet = new StandIn({ pitch: 0.4, k: 4, loudness: () => 0.2 })
    const loud = new StandIn({ pitch: 0.4, k: 4, loudness: () => 0.8 })
    quiet.step("voice", 0, DT)
    loud.step("voice", 0, DT)
    expect(quiet.features.rms).toBeCloseTo(0.04 / 4, 12)
    expect(loud.features.rms).toBeCloseTo(0.64 / 4, 12)
    // The target is clamped to 0..1 before it is squared.
    const wild = new StandIn({ pitch: 0.4, k: 4, loudness: () => 9 })
    wild.step("voice", 0, DT)
    expect(wild.features.rms).toBeCloseTo(1 / 4, 12)
  })
})
