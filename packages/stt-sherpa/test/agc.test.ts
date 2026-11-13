import { assert, describe, it } from "@effect/vitest"
import { makeAgc } from "../src/agc.mjs"

// 16 kHz, 20 ms frames. Synthetic "speech": 300 ms voiced bursts (150 Hz with harmonics) and 200 ms gaps,
// over a white-noise floor; deterministic.
const FRAME = 320
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12))
const amp = (dbfs: number) => 10 ** (dbfs / 20)

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) >>> 0
  return seed / 2 ** 32 * 2 - 1
}

/** `seconds` of signal as 20 ms frames: bursts at `peakDbfs` (or none), over white noise at `floorDbfs` RMS. */
const signal = (seconds: number, peakDbfs: number | undefined, floorDbfs: number, seed = 1) => {
  const random = rng(seed)
  const noise = amp(floorDbfs) * Math.sqrt(3) // uniform noise: RMS = a / sqrt(3)
  const frames: Array<Float32Array> = []
  let n = 0
  for (let f = 0; f < seconds * 50; f++) {
    const frame = new Float32Array(FRAME)
    for (let i = 0; i < FRAME; i++, n++) {
      const t = n / 16000
      const voiced = peakDbfs !== undefined && (t % 0.5) < 0.3
      const tone = voiced
        ? (Math.sin(2 * Math.PI * 150 * t) + 0.5 * Math.sin(2 * Math.PI * 300 * t) + 0.3 * Math.sin(2 * Math.PI * 450 * t)) / 1.8
        : 0
      frame[i] = tone * amp(peakDbfs ?? -200) + random() * noise
    }
    frames.push(frame)
  }
  return frames
}

const peakOf = (frames: ReadonlyArray<Float32Array>) => frames.reduce((p, f) => Math.max(p, ...Array.from(f, Math.abs)), 0)
const rmsOf = (frames: ReadonlyArray<Float32Array>) => {
  let sum = 0
  let n = 0
  for (const f of frames) for (const v of f) (sum += v * v, n++)
  return Math.sqrt(sum / n)
}
const run = (frames: Array<Float32Array>, agc = makeAgc()) => {
  for (const f of frames) agc.process(f)
  return agc
}

describe("AGC", () => {
  it("brings quiet speech (peaks at -40 dBFS over the server's -75 dBFS floor) up by about 25 dB", () => {
    const frames = signal(12, -40, -75)
    const agc = run(frames)
    const last = frames.slice(-100) // the last 2 s
    assert.isAbove(db(peakOf(last)), -18) // +25 dB: the noise cap keeps the -75 dBFS floor at -50
    assert.isBelow(db(peakOf(last)), -10)
    assert.isAbove(agc.gainDb(), 24)
  })

  it("never attenuates and leaves normal speech alone", () => {
    const frames = signal(5, -6, -70)
    const before = peakOf(frames)
    const agc = run(frames)
    assert.strictEqual(agc.gainDb(), 0)
    assert.closeTo(peakOf(frames), before, 1e-9)
  })

  it("does not amplify the server's noise floor or digital silence", () => {
    const noise = signal(20, undefined, -75)
    const before = rmsOf(noise)
    assert.strictEqual(run(noise).gainDb(), 0)
    assert.closeTo(rmsOf(noise), before, 1e-12)
    const zeros = Array.from({ length: 500 }, () => new Float32Array(FRAME))
    assert.strictEqual(run(zeros).gainDb(), 0)
  })

  it("does not pump steady background noise above -50 dBFS RMS", () => {
    // A fan or room tone whose peaks are above the -48 dBFS gate: without the noise cap it would get +30 dB.
    for (const floor of [-55, -50, -45, -35]) {
      const frames = signal(20, undefined, floor, 7)
      const agc = run(frames)
      const out = db(rmsOf(frames.slice(-250)))
      assert.isAtMost(out, Math.max(-50, floor) + 0.5, `noise at ${floor} dBFS came out at ${out.toFixed(1)}`)
      assert.isAtMost(agc.gainDb(), Math.max(0, -50 - floor) + 0.5)
    }
  })

  it("quiet speech over a noisier floor gets only as much gain as keeps the floor at -50 dBFS", () => {
    const frames = signal(12, -40, -65)
    const agc = run(frames)
    assert.closeTo(agc.gainDb(), 15, 1)
  })

  it("instant attack: a loud word after a quiet stretch is not clipped", () => {
    const frames = [...signal(10, -40, -75), ...signal(1, -3, -75, 3)]
    run(frames)
    const loud = frames.slice(-50)
    let clipped = 0
    for (const f of loud) for (const v of f) if (Math.abs(v) >= 0.999) clipped++
    assert.strictEqual(clipped, 0)
    assert.isBelow(db(peakOf(loud)), -2)
  })

  it("the gain rises slowly (about 9 dB/s), so a short burst of quiet speech is not boosted at once", () => {
    const frames = [...signal(1, -40, -75)]
    const agc = run(frames)
    assert.isBelow(agc.gainDb(), 10)
  })
})
