// @vitest-environment node
import { describe, expect, it } from "vitest"
import { setSampleRate } from "./shim.ts"
import { CaptureProcessor, HEADER_BYTES } from "../../worklets/capture.js"
import { StreamResampler } from "../../worklets/resampler.js"

const QUANTUM = 128

const make = (rate: number) => {
  setSampleRate(rate)
  return new CaptureProcessor({ processorOptions: { targetRate: 16_000 } }) as any
}

/** Feed `seconds` of a sine in 128-sample quanta (optionally on several channels). */
const feed = (proc: any, rate: number, seconds: number, channels = 1, freq = 440, amp = 0.5) => {
  const total = Math.round(rate * seconds / QUANTUM) * QUANTUM
  const signal = new Float32Array(total)
  for (let i = 0; i < total; i++) signal[i] = amp * Math.sin(2 * Math.PI * freq * i / rate)
  for (let off = 0; off < total; off += QUANTUM) {
    const q = signal.subarray(off, off + QUANTUM)
    const input = Array.from({ length: channels }, () => q.slice())
    expect(proc.process([input])).toBe(true)
  }
  return signal
}

const frames = (proc: any): Array<ArrayBuffer> => proc.port.sent

describe("capture worklet", () => {
  it("posts 20 ms frames of exactly 320 samples behind an empty 8-byte header", () => {
    const proc = make(48_000)
    feed(proc, 48_000, 1)
    const out = frames(proc)
    // 1 s at 16 kHz = 50 frames, minus the resampler's look-ahead (< 1 ms) for the last one.
    expect(out.length).toBe(49)
    for (const buf of out) {
      expect(buf).toBeInstanceOf(ArrayBuffer)
      expect(buf.byteLength).toBe(HEADER_BYTES + 640)
      expect([...new Uint8Array(buf, 0, HEADER_BYTES)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    }
  })

  it("frames are a seamless 16 kHz stream: their concatenation equals the resampled input", () => {
    const proc = make(48_000)
    const signal = feed(proc, 48_000, 0.5)
    const pcm = frames(proc).flatMap((b) => [...new Int16Array(b, HEADER_BYTES)])
    const rs = new StreamResampler(48_000, 16_000, 128)
    const ref = new Float32Array(rs.maxOutput(signal.length))
    let m = 0
    for (let off = 0; off < signal.length; off += QUANTUM) {
      const out = new Float32Array(rs.maxOutput(QUANTUM))
      const k = rs.process(signal.subarray(off, off + QUANTUM), out)
      ref.set(out.subarray(0, k), m)
      m += k
    }
    expect(pcm.length).toBe(Math.floor(m / 320) * 320)
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, ref[i]!))
      expect(pcm[i]).toBe(Math.round(s < 0 ? s * 32768 : s * 32767) | 0)
    }
  })

  it("produces a frame every 7.5 quanta at 48 kHz (sequence of frames per 128-sample quantum)", () => {
    const proc = make(48_000)
    const counts: Array<number> = []
    const q = new Float32Array(QUANTUM)
    for (let i = 0; i < 60; i++) {
      proc.process([[q]])
      counts.push(frames(proc).length)
    }
    // 128 samples at 48 kHz → 42.67 samples at 16 kHz; a frame (320) every 7.5 quanta.
    const firstAt = counts.findIndex((c) => c === 1)
    expect(firstAt).toBeGreaterThanOrEqual(7)
    expect(firstAt).toBeLessThanOrEqual(8)
    expect(counts[59]).toBeGreaterThanOrEqual(7)
    expect(counts[59]).toBeLessThanOrEqual(8)
  })

  it("passes 16 kHz input through unchanged (no resampler)", () => {
    const proc = make(16_000)
    expect(proc.rs).toBeNull()
    const signal = feed(proc, 16_000, 0.2)
    const pcm = frames(proc).flatMap((b) => [...new Int16Array(b, HEADER_BYTES)])
    expect(pcm.length).toBe(3200)
    expect(pcm[100]).toBe(Math.round(signal[100]! < 0 ? signal[100]! * 32768 : signal[100]! * 32767))
  })

  it("handles 44.1 kHz contexts", () => {
    const proc = make(44_100)
    feed(proc, 44_100, 1) // 345 quanta = 44 160 samples → 16 022 at 16 kHz minus look-ahead
    expect(frames(proc).length).toBe(50)
  })

  it("mixes several channels down to mono", () => {
    const mono = make(48_000)
    feed(mono, 48_000, 0.1, 1)
    const stereo = make(48_000)
    feed(stereo, 48_000, 0.1, 2)
    const a = new Int16Array(frames(mono)[2]!, HEADER_BYTES)
    const b = new Int16Array(frames(stereo)[2]!, HEADER_BYTES)
    expect([...b]).toEqual([...a])
  })

  it("clips to the s16 range", () => {
    const proc = make(16_000)
    feed(proc, 16_000, 0.04, 1, 100, 3)
    const pcm = new Int16Array(frames(proc)[0]!, HEADER_BYTES)
    expect(Math.max(...pcm)).toBe(32767)
    expect(Math.min(...pcm)).toBe(-32768)
  })

  it("posts nothing while muted, and starts a fresh frame on unmute", () => {
    const proc = make(48_000)
    proc.port.deliver({ type: "mute", value: true })
    feed(proc, 48_000, 0.5)
    expect(frames(proc).length).toBe(0)
    proc.port.deliver({ type: "mute", value: false })
    feed(proc, 48_000, 0.1)
    expect(frames(proc).length).toBe(5) // 4864 samples → 1621 at 16 kHz minus look-ahead → 5 frames
  })
})
