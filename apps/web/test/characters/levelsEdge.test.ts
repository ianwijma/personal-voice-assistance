// @vitest-environment node
/** Edge cases of the microphone ring the stage reads (src/lib/audio/levels.ts) that `levels.test.ts` does not reach. */
import { beforeEach, describe, expect, it } from "vitest"
import { currentMicRms, frameRms, levels, markInterrupted, MIC_RING, pushMicFrame, readMicWindow } from "@/lib/audio/levels.ts"

beforeEach(() => {
  levels.micWritten = 0
  levels.micAt = 0
  levels.micRms = 0
  levels.micRate = 16_000
  levels.mic.fill(0)
  levels.interruptedAt = -Infinity
})

describe("frameRms", () => {
  it("is 0 for an empty or silent frame, and normalises 16-bit PCM to 0..1", () => {
    expect(frameRms(new Int16Array(0))).toBe(0)
    expect(frameRms(new Int16Array(320))).toBe(0)
    expect(frameRms(new Int16Array(100).fill(16384))).toBeCloseTo(0.5, 12)
    expect(frameRms(new Int16Array(100).fill(-16384))).toBeCloseTo(0.5, 12)
    expect(frameRms(new Int16Array(100).fill(-32768))).toBeCloseTo(1, 12)
    expect(frameRms(new Int16Array(100).fill(32767))).toBeLessThanOrEqual(1)
  })

  it("is the root of the mean square (a half-loud, half-silent frame is 1/√2 of the loud level)", () => {
    const pcm = new Int16Array(100)
    pcm.fill(16384, 0, 50)
    expect(frameRms(pcm)).toBeCloseTo(0.5 / Math.SQRT2, 12)
  })
})

describe("pushMicFrame", () => {
  it("an empty frame counts as no samples and level 0, but still marks the time and rate", () => {
    pushMicFrame(new Int16Array(100).fill(8000), 1000)
    pushMicFrame(new Int16Array(0), 1020, 48_000)
    expect(levels.micWritten).toBe(100)
    expect(levels.micRms).toBe(0)
    expect(levels.micAt).toBe(1020)
    expect(levels.micRate).toBe(48_000)
  })

  it("one frame larger than the whole ring keeps its last MIC_RING samples, in order", () => {
    const n = MIC_RING + 500
    const pcm = Int16Array.from({ length: n }, (_, i) => i)
    pushMicFrame(pcm, 1000)
    expect(levels.micWritten).toBe(n)
    const out = new Float32Array(1000)
    expect(readMicWindow(out, 1005)).toBe(true)
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo((n - 1000 + i) / 32768, 6)
  })

  it("a window longer than the ring is zero-padded in front and holds the whole ring after it", () => {
    const n = MIC_RING + 10
    pushMicFrame(Int16Array.from({ length: n }, (_, i) => i + 1), 1000)
    const out = new Float32Array(MIC_RING + 100).fill(7)
    expect(readMicWindow(out, 1001)).toBe(true)
    expect(out.slice(0, 100).every((x) => x === 0)).toBe(true)
    expect(out[100]).toBeCloseTo((n - MIC_RING + 1) / 32768, 6)
    expect(out[out.length - 1]).toBeCloseTo(n / 32768, 6)
  })

  it("rms is of the latest frame only, whatever came before", () => {
    pushMicFrame(new Int16Array(100).fill(30000), 1000)
    pushMicFrame(new Int16Array(100).fill(100), 1020)
    expect(levels.micRms).toBeCloseTo(100 / 32768, 12)
  })
})

describe("readMicWindow", () => {
  it("reports nothing, leaving the buffer alone, before any frame has arrived", () => {
    const out = new Float32Array(8).fill(3)
    expect(readMicWindow(out, 0)).toBe(false)
    expect(Array.from(out)).toEqual(Array(8).fill(3))
  })

  it("treats a frame exactly 120 ms old as live and one older as stalled", () => {
    pushMicFrame(new Int16Array(100).fill(1000), 1000)
    const out = new Float32Array(10)
    expect(readMicWindow(out, 1120)).toBe(true)
    expect(readMicWindow(out, 1121)).toBe(false)
  })

  it("an empty output window is still a live read", () => {
    pushMicFrame(new Int16Array(10).fill(1000), 1000)
    expect(readMicWindow(new Float32Array(0), 1001)).toBe(true)
  })

  it("returns the newest samples right-aligned when the ring has wrapped exactly to its end", () => {
    pushMicFrame(Int16Array.from({ length: MIC_RING }, (_, i) => i), 1000)
    expect(levels.micWritten % MIC_RING).toBe(0)
    const out = new Float32Array(4)
    expect(readMicWindow(out, 1001)).toBe(true)
    expect(Array.from(out).map((x) => Math.round(x * 32768))).toEqual([MIC_RING - 4, MIC_RING - 3, MIC_RING - 2, MIC_RING - 1])
  })
})

describe("currentMicRms", () => {
  it("is the last level while frames keep coming, and 0 once they stop for more than 120 ms", () => {
    pushMicFrame(new Int16Array(100).fill(16384), 1000)
    expect(currentMicRms(1000)).toBeCloseTo(0.5, 12)
    expect(currentMicRms(1120)).toBeCloseTo(0.5, 12)
    expect(currentMicRms(1121)).toBe(0)
  })
})

describe("markInterrupted", () => {
  it("records the time given, and the clock's time by default", () => {
    markInterrupted(1234)
    expect(levels.interruptedAt).toBe(1234)
    const before = performance.now()
    markInterrupted()
    expect(levels.interruptedAt).toBeGreaterThanOrEqual(before)
    expect(levels.interruptedAt).toBeLessThanOrEqual(performance.now())
  })
})
