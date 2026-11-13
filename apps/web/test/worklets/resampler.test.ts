// @vitest-environment node
import { describe, expect, it } from "vitest"
import { StreamResampler } from "../../worklets/resampler.js"

const sine = (n: number, rate: number, freq: number, amp: number, phase = 0) => {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * (i / rate) + phase)
  return out
}

/** Run a whole signal through a resampler in chunks of the given sizes (cycled), then flush. */
const run = (inRate: number, outRate: number, input: Float32Array, chunks: ReadonlyArray<number>, maxIn = 8192) => {
  const rs = new StreamResampler(inRate, outRate, maxIn)
  const parts: Array<Float32Array> = []
  let off = 0
  let c = 0
  while (off < input.length) {
    const n = Math.min(chunks[c++ % chunks.length]!, input.length - off)
    const out = new Float32Array(rs.maxOutput(n))
    const m = rs.process(input.subarray(off, off + n), out)
    parts.push(out.slice(0, m))
    off += n
  }
  const tail = new Float32Array(rs.maxOutput(0))
  parts.push(tail.slice(0, rs.flush(tail)))
  const total = parts.reduce((s, p) => s + p.length, 0)
  const all = new Float32Array(total)
  let o = 0
  for (const p of parts) {
    all.set(p, o)
    o += p.length
  }
  return { out: all, rs }
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)
const db = (ratio: number) => 20 * Math.log10(ratio)

describe("StreamResampler", () => {
  const cases: ReadonlyArray<readonly [number, number]> = [[48_000, 16_000], [22_050, 48_000], [24_000, 48_000], [44_100, 16_000]]
  for (const [inRate, outRate] of cases) {
    describe(`${inRate} → ${outRate} Hz`, () => {
      const n = inRate // one second
      const input = sine(n, inRate, 1000, 0.5)
      const ratio = outRate / inRate

      it("keeps a 1 kHz sine's amplitude within 1 dB", () => {
        const { out, rs } = run(inRate, outRate, input, [128])
        const edge = Math.ceil(rs.W / rs.step) + 4 // skip the filter's start and end
        const mid = out.subarray(edge, out.length - edge)
        const amp = rms(mid) * Math.SQRT2
        expect(Math.abs(db(amp / 0.5))).toBeLessThan(1)
        // And it is still a 1 kHz sine at the output rate: compare with the ideal signal.
        const ideal = sine(out.length, outRate, 1000, 0.5)
        let err = 0
        for (let i = edge; i < out.length - edge; i++) err = Math.max(err, Math.abs(out[i]! - ideal[i]!))
        expect(err).toBeLessThan(0.01) // −34 dB relative to the signal: no phase shift, no distortion
      })

      it("outputs ceil(n · ratio) samples for n inputs (within ±1)", () => {
        const { out } = run(inRate, outRate, input, [128])
        expect(Math.abs(out.length - n * ratio)).toBeLessThanOrEqual(1)
      })

      it("has no discontinuity at chunk boundaries: any chunking gives the same output", () => {
        const whole = run(inRate, outRate, input, [n]).out
        const ragged = run(inRate, outRate, input, [1, 7, 128, 333, 2, 1000, 64], 256).out
        expect(ragged.length).toBe(whole.length)
        let diff = 0
        for (let i = 0; i < whole.length; i++) diff = Math.max(diff, Math.abs(whole[i]! - ragged[i]!))
        expect(diff).toBeLessThan(1e-5)
        // Largest step between neighbours stays that of a 1 kHz sine (2π·f/fs·A) plus a margin.
        const maxStep = 2 * Math.PI * 1000 / outRate * 0.5 * 1.05
        const edge = 64
        for (let i = edge; i < ragged.length - edge; i++) {
          expect(Math.abs(ragged[i]! - ragged[i - 1]!)).toBeLessThan(maxStep)
        }
      })
    })
  }

  it("attenuates content above the output Nyquist frequency when downsampling", () => {
    const input = sine(48_000, 48_000, 12_000, 0.5) // above 8 kHz: must not alias into the 16 kHz stream
    const { out } = run(48_000, 16_000, input, [128])
    const mid = out.subarray(100, out.length - 100)
    expect(db(rms(mid) * Math.SQRT2 / 0.5)).toBeLessThan(-40)
  })

  it("adds under 1 ms of delay at 48 → 16 kHz (kernel half width)", () => {
    const rs = new StreamResampler(48_000, 16_000)
    expect(rs.W / 48_000).toBeLessThan(0.001)
  })
})
