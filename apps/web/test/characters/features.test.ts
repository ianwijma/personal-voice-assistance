// @vitest-environment node
// The lab's extractor tests (docs/research/visualiser-investigation/lab/test/features.test.ts), run against the app's copy.
import { describe, expect, it } from "vitest"
import { FeatureExtractor } from "@/characters/features.ts"
import { renderVoice } from "./support/synth.ts"

const FPS = 60
const DT = 1 / FPS

/** Feed `seconds` of a generated signal to the extractor, 40 ms windows once per frame. */
const run = (ex: FeatureExtractor, seconds: number, sample: (n: number) => number, start = 0): void => {
  const rate = ex.sampleRate
  const len = Math.round(0.04 * rate)
  const w = new Float32Array(len)
  for (let t = DT; t <= seconds + 1e-9; t += DT) {
    const end = start + Math.round(t * rate)
    for (let i = 0; i < len; i++) w[i] = sample(end - len + i)
    ex.process(w, DT)
  }
}

/** A harmonic tone (falling 1/k partials), like a sustained vowel. */
const tone = (hz: number, rate: number, amp = 0.2) => (n: number) => {
  let s = 0
  for (let k = 1; k <= 12; k++) s += Math.sin((2 * Math.PI * hz * k * n) / rate) / k
  return amp * s * 0.5
}

/** Deterministic white noise. */
const noise = (amp: number) => {
  let a = 12345
  return () => {
    a = (a * 1103515245 + 12345) >>> 0
    return amp * ((a / 4294967296) * 2 - 1)
  }
}

describe("FeatureExtractor", () => {
  for (const rate of [16000, 48000, 44100]) {
    for (const hz of [110, 300]) {
      it(`${hz} Hz harmonic tone at ${rate} Hz: pitch within 5 %, voicing high`, () => {
        const ex = new FeatureExtractor(rate)
        run(ex, 0.6, tone(hz, rate))
        const f = ex.features
        expect(Math.abs(f.pitchHz - hz) / hz).toBeLessThan(0.05)
        expect(f.voicing).toBeGreaterThan(0.8)
        expect(f.speaking).toBe(true)
        expect(f.sibilance).toBeLessThan(0.2)
      })
    }
  }

  it("white noise: voicing low, sibilance high, no pitch", () => {
    const ex = new FeatureExtractor(16000)
    run(ex, 0.6, noise(0.2))
    const f = ex.features
    expect(f.voicing).toBeLessThan(0.25)
    expect(f.sibilance).toBeGreaterThan(0.5)
    expect(f.pitchHz).toBe(0)
    expect(f.brightness).toBeGreaterThan(0.6)
  })

  it("silence: level 0, and speaking false after the 250 ms hangover", () => {
    const ex = new FeatureExtractor(16000)
    run(ex, 0.5, tone(150, 16000))
    expect(ex.features.speaking).toBe(true)
    run(ex, 0.2, () => 0)
    expect(ex.features.speaking).toBe(true) // still inside the hangover
    run(ex, 0.4, () => 0)
    const f = ex.features
    expect(f.speaking).toBe(false)
    expect(f.level).toBe(0)
    expect(f.speechFor).toBe(0)
    expect(f.silenceFor).toBeGreaterThan(0.2)
    expect(f.mouth.open).toBeLessThan(0.01)
  })

  it("louder input gives a monotonically higher level", () => {
    const levels = [0.003, 0.01, 0.03, 0.1, 0.3].map((amp) => {
      const ex = new FeatureExtractor(16000)
      run(ex, 0.5, tone(150, 16000, amp))
      return ex.features.level
    })
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThan(levels[i - 1]!)
    expect(levels[0]!).toBeGreaterThanOrEqual(0)
    expect(levels[levels.length - 1]!).toBeLessThanOrEqual(1)
  })

  it("on simulated speech: register follows the voice, loudness orders the level, fast speech has more syllables", () => {
    const stats = (register: "deep" | "child", loudness: "whisper" | "normal" | "shouting", delivery: "slow-flat" | "fast-excited" | "normal") => {
      const clip = renderVoice({ register, loudness, delivery, seed: 1 })
      const ex = new FeatureExtractor(clip.sampleRate)
      let level = 0
      let rate = 0
      let n = 0
      run(ex, clip.samples.length / clip.sampleRate - 0.1, (i) => clip.samples[i] ?? 0)
      // Second pass, sampling the speaking frames.
      const len = 640
      const w = new Float32Array(len)
      for (let t = 0.05; t < clip.samples.length / clip.sampleRate; t += DT) {
        const end = Math.round(t * clip.sampleRate)
        for (let i = 0; i < len; i++) w[i] = clip.samples[end - len + i] ?? 0
        const f = ex.process(w, DT)
        if (f.speaking) {
          level += f.level
          rate += f.syllableRate
          n++
        }
      }
      return { level: level / n, rate: rate / n, register: ex.features.register }
    }
    const deep = stats("deep", "normal", "normal")
    const child = stats("child", "normal", "normal")
    expect(child.register).toBeGreaterThan(deep.register + 0.3)
    const whisper = stats("deep", "whisper", "normal")
    const shout = stats("deep", "shouting", "normal")
    expect(whisper.level).toBeLessThan(deep.level)
    expect(shout.level).toBeGreaterThan(deep.level)
    expect(stats("deep", "normal", "fast-excited").rate).toBeGreaterThan(stats("deep", "normal", "slow-flat").rate)
  })

  it("costs well under 0.3 ms per call", () => {
    // Windows are generated up front so only process() is timed; best of several batches,
    // because the full test run shares the CPU with many workers.
    const rate = 48000
    const len = Math.round(0.04 * rate)
    const sample = tone(140, rate)
    const windows = Array.from({ length: 60 }, (_, k) => Float32Array.from({ length: len }, (_, i) => sample(k * 800 + i)))
    const ex = new FeatureExtractor(rate)
    for (const w of windows) ex.process(w, DT) // warm up
    let best = Infinity
    for (let batch = 0; batch < 8; batch++) {
      const t0 = performance.now()
      for (const w of windows) ex.process(w, DT)
      best = Math.min(best, (performance.now() - t0) / windows.length)
    }
    expect(best).toBeLessThan(0.3)
  })
})
