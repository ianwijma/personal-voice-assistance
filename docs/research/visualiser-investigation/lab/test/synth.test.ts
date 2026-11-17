// @vitest-environment node
import { describe, expect, it } from "vitest"
import { DELIVERIES, LOUDNESSES, REGISTERS, SYNTH_RATE, renderRoomNoise, renderVoice, voiceKey, type VoiceSpec } from "../src/synth.ts"

const rms = (s: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < s.length; i++) sum += s[i]! * s[i]!
  return Math.sqrt(sum / s.length)
}

describe("synth presets", () => {
  it("lists every register, loudness and delivery once", () => {
    expect(new Set(REGISTERS).size).toBe(REGISTERS.length)
    expect(new Set(LOUDNESSES).size).toBe(LOUDNESSES.length)
    expect(new Set(DELIVERIES).size).toBe(DELIVERIES.length)
  })

  it("voiceKey identifies a spec by all four fields", () => {
    const spec: VoiceSpec = { register: "deep", loudness: "soft", delivery: "hesitant", seed: 4 }
    expect(voiceKey(spec)).toBe("deep/soft/hesitant/4")
    expect(voiceKey({ ...spec, seed: 5 })).not.toBe(voiceKey(spec))
    expect(voiceKey({ ...spec, register: "mid" })).not.toBe(voiceKey(spec))
  })
})

describe("renderVoice", () => {
  const spec: VoiceSpec = { register: "mid", loudness: "normal", delivery: "normal", seed: 2 }

  it("renders 5–15 s of 16 kHz audio with ordered, in-range phrases and some syllables", () => {
    const clip = renderVoice(spec)
    expect(clip.sampleRate).toBe(SYNTH_RATE)
    const seconds = clip.samples.length / clip.sampleRate
    expect(seconds).toBeGreaterThan(5)
    expect(seconds).toBeLessThan(15)
    expect(clip.phrases.length).toBeGreaterThan(0)
    let prevEnd = -1
    for (const p of clip.phrases) {
      expect(p.start).toBeGreaterThanOrEqual(0)
      expect(p.end).toBeGreaterThan(p.start)
      expect(p.end).toBeLessThanOrEqual(seconds + 1e-6)
      expect(p.start).toBeGreaterThanOrEqual(prevEnd)
      prevEnd = p.end
    }
    expect(clip.syllables).toBeGreaterThan(5)
    let peak = 0
    for (const v of clip.samples) {
      expect(Number.isFinite(v)).toBe(true)
      peak = Math.max(peak, Math.abs(v))
    }
    expect(peak).toBeLessThanOrEqual(1)
    expect(peak).toBeGreaterThan(0.05)
  })

  it("is cached: the same spec returns the same clip object", () => {
    expect(renderVoice(spec)).toBe(renderVoice({ ...spec }))
  })

  it("is deterministic per seed and differs between seeds", () => {
    const a = renderVoice({ ...spec, seed: 11 })
    const b = renderVoice({ ...spec, seed: 12 })
    expect(a).not.toBe(b)
    expect(Array.from(a.samples.slice(8000, 8100))).not.toEqual(Array.from(b.samples.slice(8000, 8100)))
  })

  it("fades the loop's ends so it repeats without a click", () => {
    const { samples } = renderVoice(spec)
    expect(samples[0]).toBe(0)
    expect(Math.abs(samples[samples.length - 1]!)).toBeLessThan(0.01)
    expect(Math.abs(samples[1]!)).toBeLessThan(0.01)
  })

  it("loudness presets order the RMS: whisper < normal < shouting", () => {
    const at = (loudness: VoiceSpec["loudness"]) => rms(renderVoice({ ...spec, loudness, seed: 3 }).samples)
    expect(at("whisper")).toBeLessThan(at("normal"))
    expect(at("normal")).toBeLessThan(at("shouting"))
  })
})

describe("renderRoomNoise", () => {
  it("is 2 s of looping room tone at about the requested level, with no phrases", () => {
    const clip = renderRoomNoise(-50, 9)
    expect(clip.sampleRate).toBe(SYNTH_RATE)
    expect(clip.samples.length).toBe(SYNTH_RATE * 2)
    expect(clip.phrases).toEqual([])
    const db = 20 * Math.log10(rms(clip.samples))
    expect(db).toBeGreaterThan(-51)
    expect(db).toBeLessThan(-49)
  })

  it("is cached per level and seed, and quieter for a lower level", () => {
    expect(renderRoomNoise(-50, 9)).toBe(renderRoomNoise(-50, 9))
    expect(renderRoomNoise(-50, 9)).not.toBe(renderRoomNoise(-50, 10))
    expect(rms(renderRoomNoise(-70, 9).samples)).toBeLessThan(rms(renderRoomNoise(-50, 9).samples))
  })
})
