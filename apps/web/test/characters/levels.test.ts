// @vitest-environment node
/** The microphone ring buffer the stage reads (src/lib/audio/levels.ts). */
import { beforeEach, describe, expect, it } from "vitest"
import { currentMicRms, frameRms, levels, MIC_RING, pushMicFrame, readMicWindow } from "@/lib/audio/levels.ts"

const frame = (from: number, n = 320) => Int16Array.from({ length: n }, (_, i) => ((from + i) % 30000) - 15000)

beforeEach(() => {
  levels.micWritten = 0
  levels.micAt = 0
  levels.mic.fill(0)
})

describe("levels.mic", () => {
  it("keeps the latest samples in order across the ring's end, with the frame's level and rate", () => {
    let n = 0
    for (let k = 0; k < 20; k++) {
      pushMicFrame(frame(n), 1000 + k * 20, 16000)
      n += 320
    }
    expect(levels.micWritten).toBe(6400)
    expect(levels.micRate).toBe(16000)
    expect(levels.micRms).toBeCloseTo(frameRms(frame(n - 320)), 12)
    const out = new Float32Array(640)
    expect(readMicWindow(out, 1000 + 19 * 20 + 5)).toBe(true)
    for (let i = 0; i < 640; i++) expect(out[i]).toBeCloseTo((((n - 640 + i) % 30000) - 15000) / 32768, 6)
    expect(6400 > MIC_RING).toBe(true)
  })

  it("pads with zeros before enough samples exist, and reports nothing once frames stop", () => {
    pushMicFrame(frame(0, 100), 1000)
    const out = new Float32Array(640).fill(9)
    expect(readMicWindow(out, 1010)).toBe(true)
    expect(out.slice(0, 540).every((x) => x === 0)).toBe(true)
    expect(out[639]).toBeCloseTo(((99 % 30000) - 15000) / 32768, 6)
    expect(readMicWindow(out, 1200)).toBe(false)
    expect(currentMicRms(1200)).toBe(0)
  })

  it("costs next to nothing per 20 ms frame", () => {
    const f = frame(0)
    for (let i = 0; i < 1000; i++) pushMicFrame(f, i)
    const t0 = performance.now()
    for (let i = 0; i < 10_000; i++) pushMicFrame(f, i)
    const perFrame = (performance.now() - t0) / 10_000
    expect(perFrame).toBeLessThan(0.05)
  })
})
