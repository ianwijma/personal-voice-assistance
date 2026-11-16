// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ClipPlayer, findPhrases } from "../src/sources.ts"
import type { VoiceClip } from "../src/synth.ts"

const RATE = 16000

/** Samples with `bursts` (start/end seconds) of a loud tone and silence elsewhere. */
const withBursts = (seconds: number, bursts: ReadonlyArray<readonly [number, number]>, amp = 0.3): Float32Array => {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (const [a, b] of bursts) for (let i = Math.round(a * RATE); i < Math.min(out.length, Math.round(b * RATE)); i++) out[i] = amp * Math.sin((2 * Math.PI * 200 * i) / RATE)
  return out
}

describe("findPhrases", () => {
  it("finds two bursts separated by a long pause", () => {
    const p = findPhrases(withBursts(4, [[0.5, 1.5], [2.5, 3.5]]), RATE)
    expect(p).toHaveLength(2)
    expect(p[0]!.start).toBeCloseTo(0.5, 1)
    expect(p[0]!.end).toBeCloseTo(1.5, 1)
    expect(p[1]!.start).toBeCloseTo(2.5, 1)
    expect(p[1]!.end).toBeCloseTo(3.5, 1)
  })

  it("keeps a short pause (under 350 ms) inside one phrase", () => {
    const p = findPhrases(withBursts(3, [[0.5, 1.2], [1.4, 2.2]]), RATE)
    expect(p).toHaveLength(1)
    expect(p[0]!.start).toBeCloseTo(0.5, 1)
    expect(p[0]!.end).toBeCloseTo(2.2, 1)
  })

  it("splits at a pause of 400 ms", () => {
    expect(findPhrases(withBursts(3, [[0.5, 1.2], [1.6, 2.4]]), RATE)).toHaveLength(2)
  })

  it("drops a click shorter than 250 ms when other speech exists", () => {
    const p = findPhrases(withBursts(4, [[0.3, 0.4], [2, 3]]), RATE)
    expect(p).toHaveLength(1)
    expect(p[0]!.start).toBeCloseTo(2, 1)
  })

  it("ends a phrase at the end of the clip when the audio is still loud", () => {
    const p = findPhrases(withBursts(2, [[1, 2]]), RATE)
    expect(p).toEqual([{ start: expect.closeTo(1, 1), end: 2 }])
  })

  it("treats a very quiet signal (below -48 dBFS) as silence and falls back to the whole clip", () => {
    const quiet = withBursts(2, [[0, 2]], 0.001)
    expect(findPhrases(quiet, RATE)).toEqual([{ start: 0, end: 2 }])
  })

  it("falls back to the whole clip for silence and for an empty clip", () => {
    expect(findPhrases(new Float32Array(RATE), RATE)).toEqual([{ start: 0, end: 1 }])
    expect(findPhrases(new Float32Array(0), RATE)).toEqual([{ start: 0, end: 0 }])
  })

  it("works at other sample rates", () => {
    const rate = 48000
    const s = new Float32Array(rate * 3)
    for (let i = rate; i < rate * 2; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate)
    const p = findPhrases(s, rate)
    expect(p).toHaveLength(1)
    expect(p[0]!.start).toBeCloseTo(1, 1)
    expect(p[0]!.end).toBeCloseTo(2, 1)
  })
})

const ramp = (n: number, rate = RATE): VoiceClip => ({ samples: Float32Array.from({ length: n }, (_, i) => i + 1), sampleRate: rate, phrases: [], label: "ramp" })

describe("ClipPlayer", () => {
  it("is silent and done before anything plays", () => {
    const p = new ClipPlayer()
    expect(p.playing).toBe(false)
    expect(p.done).toBe(true)
    expect(p.window().every((v) => v === 0)).toBe(true)
  })

  it("plays a span: advances, then stops and reports done at the end", () => {
    const p = new ClipPlayer()
    p.play(ramp(RATE * 2), 0.5, 1)
    expect(p.playing).toBe(true)
    expect(p.done).toBe(false)
    expect(p.seconds).toBeCloseTo(0.5, 6)
    p.advance(0.25)
    expect(p.seconds).toBeCloseTo(0.75, 6)
    expect(p.done).toBe(false)
    p.advance(0.3)
    expect(p.playing).toBe(false)
    expect(p.done).toBe(true)
    expect(p.window().every((v) => v === 0)).toBe(true)
  })

  it("clamps the span to the clip and ignores negative starts", () => {
    const p = new ClipPlayer()
    p.play(ramp(RATE), -3, 99)
    expect(p.pos).toBe(0)
    expect(p.end).toBe(RATE)
  })

  it("window() is the 40 ms ending at the play position, zero-padded before the clip start", () => {
    const p = new ClipPlayer()
    const clip = ramp(RATE)
    p.play(clip, 0.1, 1)
    const w = p.window()
    expect(w.length).toBe(640)
    const at = Math.round(0.1 * RATE)
    expect(w[639]).toBe(clip.samples[at - 1])
    expect(w[0]).toBe(clip.samples[at - 640])
    const start = new ClipPlayer()
    start.play(clip, 0, 1)
    start.advance(0.01) // 160 samples in
    const sw = start.window()
    expect(sw[0]).toBe(0)
    expect(sw[639]).toBe(clip.samples[159])
  })

  it("loops the whole clip when `to` is null, wrapping the window around the start", () => {
    const p = new ClipPlayer()
    const clip = ramp(1000)
    p.play(clip, 0, null)
    p.advance(2500 / RATE)
    expect(p.playing).toBe(true)
    expect(p.done).toBe(false)
    expect(p.pos).toBeCloseTo(500, 6)
    p.pos = 100
    const w = p.window()
    // the last sample of the window is clip[99]; the one 100 earlier wraps to the clip's end
    expect(w[639]).toBe(clip.samples[99])
    expect(w[539]).toBe(clip.samples[999])
    expect(w[0]).toBe(clip.samples[(100 - 640 + 1000) % 1000])
  })

  it("adopts the clip's sample rate and window length", () => {
    const p = new ClipPlayer()
    p.play(ramp(48000, 48000), 0, null)
    expect(p.sampleRate).toBe(48000)
    expect(p.window().length).toBe(1920)
  })

  it("stop() silences it", () => {
    const p = new ClipPlayer()
    p.play(ramp(RATE), 0, null)
    p.advance(0.1)
    p.stop()
    expect(p.done).toBe(true)
    expect(p.window().every((v) => v === 0)).toBe(true)
  })
})
