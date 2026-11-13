// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest"
import { getCurrentTime, setCurrentTime, setSampleRate } from "./shim.ts"
import { HEADER_BYTES, PlayerProcessor } from "../../worklets/player.js"

const RATE = 48_000
const QUANTUM = 128

/** A binary reply frame as it arrives on the socket: 8-byte header (kind 2, turn id) + PCM. */
const frame = (id: number, samples: Int16Array): ArrayBuffer => {
  const buf = new ArrayBuffer(HEADER_BYTES + samples.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, 2)
  view.setUint32(4, id, true)
  new Int16Array(buf, HEADER_BYTES).set(samples)
  return buf
}

const tone = (n: number, rate: number, freq = 1000, amp = 16_000) => {
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin(2 * Math.PI * freq * i / rate))
  return out
}

let proc: any
let rendered: Array<number>

const msgs = (type?: string): Array<any> => proc.port.sent.filter((m: any) => type === undefined || m.type === type)
const send = (m: unknown) => proc.port.deliver(m)

/** Render `quanta` render quanta, advancing currentTime; returns the output samples. */
const render = (quanta: number): Float32Array => {
  const out = new Float32Array(quanta * QUANTUM)
  for (let q = 0; q < quanta; q++) {
    const o = new Float32Array(QUANTUM)
    expect(proc.process([], [[o]])).toBe(true)
    out.set(o, q * QUANTUM)
    setCurrentTime(getCurrentTime() + QUANTUM / RATE)
  }
  rendered.push(...out)
  return out
}
const ms = (n: number) => Math.ceil(n / 1000 * RATE / QUANTUM)
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length))

beforeEach(() => {
  setSampleRate(RATE)
  setCurrentTime(0)
  proc = new PlayerProcessor()
  rendered = []
})

describe("player worklet", () => {
  it("buffers to the prebuffer, posts started once, plays, and posts finished with every sample after end", () => {
    send({ type: "start", id: 12, rate: 22_050, prebufferMs: 60 })
    send({ type: "frame", buffer: frame(12, tone(882, 22_050)) }) // 40 ms: below the 60 ms prebuffer
    expect(rms(render(4))).toBe(0)
    expect(msgs("started")).toHaveLength(0)
    send({ type: "frame", buffer: frame(12, tone(882, 22_050)) }) // 80 ms queued: plays
    const out = render(ms(60))
    expect(rms(out)).toBeGreaterThan(0.3)
    expect(msgs("started")).toHaveLength(1)
    expect(msgs("started")[0]).toMatchObject({ id: 12 })
    expect(msgs("started")[0].startDelayMs).toBeCloseTo(4 * QUANTUM / RATE * 1000, 1)
    for (let i = 0; i < 3; i++) send({ type: "frame", buffer: frame(12, tone(2205, 22_050)) })
    send({ type: "end", id: 12 })
    render(ms(600))
    expect(msgs("started")).toHaveLength(1)
    expect(msgs("finished")).toEqual([{ type: "finished", id: 12, playedSamples: 882 * 2 + 2205 * 3 }])
    expect(msgs("underrun")).toHaveLength(0)
    expect(proc.state).toBe("idle")
  })

  it("plays the reply at the context rate with the right pitch and level (22.05 kHz → 48 kHz)", () => {
    send({ type: "start", id: 3, rate: 22_050 })
    send({ type: "frame", buffer: frame(3, tone(22_050, 22_050, 1000, 16_384)) })
    send({ type: "end", id: 3 })
    const out = render(ms(1000) + 2)
    const mid = out.subarray(4800, 43_200)
    expect(rms(mid) * Math.SQRT2).toBeCloseTo(0.5, 1)
    let crossings = 0
    for (let i = 1; i < mid.length; i++) if (mid[i - 1]! < 0 && mid[i]! >= 0) crossings++
    expect(crossings).toBeGreaterThanOrEqual(798) // 1 kHz over 0.8 s
    expect(crossings).toBeLessThanOrEqual(802)
    expect(msgs("finished")[0].playedSamples).toBe(22_050)
  })

  it("posts progress every 250 ms of render time while a reply is active", () => {
    send({ type: "start", id: 7, rate: 48_000 })
    send({ type: "frame", buffer: frame(7, tone(48_000, 48_000)) })
    render(ms(1000) - 1)
    const progress = msgs("progress")
    expect(progress).toHaveLength(3)
    // Posted on the first quantum at or past each 250 ms boundary, without drift.
    expect(progress.map((m) => m.playedSamples)).toEqual([94 * 128, 188 * 128, 282 * 128])
    render(2)
    expect(msgs("progress")).toHaveLength(4)
    expect(msgs("progress")[3]).toMatchObject({ id: 7, underruns: 0 })
  })

  it("stops with a 4 ms fade, reports the samples handed to the device, and drops the rest", () => {
    send({ type: "start", id: 9, rate: 24_000 })
    send({ type: "frame", buffer: frame(9, tone(24_000, 24_000)) })
    render(ms(500))
    send({ type: "stop", id: 9, report: true })
    const fade = render(3)
    expect(msgs("stopped")).toHaveLength(1)
    const stopped = msgs("stopped")[0]
    // Everything rendered so far (500 ms of quanta + the 192-sample fade), at the source rate.
    const expected = Math.round((ms(500) * QUANTUM + 192) * 24_000 / RATE)
    expect(stopped).toEqual({ type: "stopped", id: 9, playedSamples: expected, report: true })
    // The fade ramps down within 192 samples, then silence.
    expect(Math.abs(fade[0]!)).toBeGreaterThan(0)
    expect(rms(fade.subarray(192))).toBe(0)
    // Late frames of the stopped reply are dropped; an end is ignored.
    send({ type: "frame", buffer: frame(9, tone(2400, 24_000)) })
    send({ type: "end", id: 9 })
    expect(rms(render(10))).toBe(0)
    expect(msgs("finished")).toHaveLength(0)
    // The server's own reply.stop arriving at an idle player is answered with the same count.
    send({ type: "stop", id: 9, report: true })
    expect(msgs("stopped")).toHaveLength(2)
    expect(msgs("stopped")[1]).toEqual(stopped)
  })

  it("answers a stop for a finished reply with its final count, and a stop for an unknown reply with 0", () => {
    send({ type: "start", id: 4, rate: 48_000 })
    send({ type: "frame", buffer: frame(4, tone(4800, 48_000)) })
    send({ type: "end", id: 4 })
    render(ms(200))
    expect(msgs("finished")).toEqual([{ type: "finished", id: 4, playedSamples: 4800 }])
    send({ type: "stop", id: 4, report: true })
    expect(msgs("stopped")).toEqual([{ type: "stopped", id: 4, playedSamples: 4800, report: true }])
    send({ type: "stop", id: 99, report: true })
    expect(msgs("stopped")[1]).toEqual({ type: "stopped", id: 99, playedSamples: 0, report: true })
    send({ type: "stop", report: true }) // the Stop button with nothing playing: nothing to report
    expect(msgs("stopped")).toHaveLength(2)
  })

  it("stops at once (no fade, no started) while still buffering", () => {
    send({ type: "start", id: 5, rate: 22_050 })
    send({ type: "frame", buffer: frame(5, tone(441, 22_050)) })
    render(2)
    send({ type: "stop", id: 5, report: false })
    expect(msgs("stopped")).toEqual([{ type: "stopped", id: 5, playedSamples: 0, report: false }])
    expect(msgs("started")).toHaveLength(0)
    expect(proc.state).toBe("idle")
  })

  it("drops frames whose id is not the active reply", () => {
    send({ type: "frame", buffer: frame(1, tone(4800, 48_000)) }) // nothing started
    send({ type: "start", id: 2, rate: 48_000 })
    send({ type: "frame", buffer: frame(1, tone(48_000, 48_000)) }) // stale
    expect(proc.queued).toBe(0)
    send({ type: "frame", buffer: frame(2, tone(4800, 48_000)) })
    expect(proc.queued).toBe(4800)
    expect(proc.receivedSrc).toBe(4800)
  })

  it("re-buffers on an underrun (40 ms refill) and counts it", () => {
    send({ type: "start", id: 6, rate: 48_000 })
    send({ type: "frame", buffer: frame(6, tone(4800, 48_000)) }) // 100 ms
    render(ms(150))
    expect(msgs("underrun")).toEqual([{ type: "underrun", id: 6, underruns: 1 }])
    expect(proc.state).toBe("buffering")
    send({ type: "frame", buffer: frame(6, tone(1440, 48_000)) }) // 30 ms: below the 40 ms refill
    expect(rms(render(4))).toBe(0)
    send({ type: "frame", buffer: frame(6, tone(960, 48_000)) }) // 50 ms: plays again
    expect(rms(render(4))).toBeGreaterThan(0.1)
    expect(msgs("started")).toHaveLength(1) // started is once per reply
    render(ms(300))
    const last = msgs("progress").at(-1)
    expect(last.underruns).toBeGreaterThanOrEqual(2)
    send({ type: "end", id: 6 })
    render(2)
    expect(msgs("finished")).toEqual([{ type: "finished", id: 6, playedSamples: 4800 + 1440 + 960 }])
  })

  it("finishes a reply shorter than the prebuffer once it ends, and a reply with no audio without started", () => {
    send({ type: "start", id: 10, rate: 48_000 })
    send({ type: "frame", buffer: frame(10, tone(480, 48_000)) }) // 10 ms
    send({ type: "end", id: 10 })
    render(ms(40))
    expect(msgs("started")).toHaveLength(1)
    expect(msgs("finished")).toEqual([{ type: "finished", id: 10, playedSamples: 480 }])

    send({ type: "start", id: 11, rate: 48_000 })
    send({ type: "end", id: 11 })
    render(2)
    expect(msgs("started")).toHaveLength(1)
    expect(msgs("finished")[1]).toEqual({ type: "finished", id: 11, playedSamples: 0 })
  })

  it("a new reply replaces an active one (the old one is reported stopped)", () => {
    send({ type: "start", id: 20, rate: 48_000 })
    send({ type: "frame", buffer: frame(20, tone(9600, 48_000)) })
    render(ms(100))
    send({ type: "start", id: 21, rate: 48_000 })
    expect(msgs("stopped")).toHaveLength(1)
    expect(msgs("stopped")[0]).toMatchObject({ id: 20 })
    send({ type: "frame", buffer: frame(20, tone(4800, 48_000)) })
    expect(proc.queued).toBe(0)
  })

  it("uses the prebuffer message as the default for later replies", () => {
    send({ type: "prebuffer", ms: 20 })
    send({ type: "start", id: 30, rate: 48_000 })
    send({ type: "frame", buffer: frame(30, tone(1000, 48_000)) }) // 20.8 ms ≥ 20 ms
    render(1)
    expect(msgs("started")).toHaveLength(1)
  })

  it("uses a refill target that doubles with each underrun in a reply (40, 80, … ms)", () => {
    send({ type: "start", id: 40, rate: 48_000, prebufferMs: 20 })
    send({ type: "frame", buffer: frame(40, tone(960, 48_000)) })
    render(ms(40))
    expect(proc.threshold).toBe(Math.round(0.04 * RATE))
    send({ type: "frame", buffer: frame(40, tone(1920, 48_000)) }) // 40 ms: plays, then runs dry again
    render(ms(60))
    expect(msgs("underrun")).toHaveLength(2)
    expect(proc.threshold).toBe(Math.round(0.08 * RATE))
    send({ type: "frame", buffer: frame(40, tone(2880, 48_000)) }) // 60 ms: still buffering
    expect(rms(render(2))).toBe(0)
  })
})

/** Largest sample-to-sample step in `x`. */
const maxStep = (x: Float32Array, from = 1, to = x.length) => {
  let m = 0
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!))
  return m
}

// Continuity at the rates an iPhone runs the AudioContext at (48 kHz; 44.1 kHz on older models and with some
// Bluetooth routes; 24 kHz when voice processing has lowered the hardware rate), for the 22.05 kHz Piper voice
// and the 24 kHz Kokoro voice.
describe.each([48_000, 44_100, 24_000])("player continuity at a %i Hz context", (ctxRate) => {
  const quanta = (s: number) => Math.ceil((s * ctxRate) / QUANTUM)
  const renderAt = (count: number) => {
    const out = new Float32Array(count * QUANTUM)
    for (let q = 0; q < count; q++) {
      const o = new Float32Array(QUANTUM)
      proc.process([], [[o]])
      out.set(o, q * QUANTUM)
      setCurrentTime(getCurrentTime() + QUANTUM / ctxRate)
    }
    return out
  }
  beforeEach(() => {
    setSampleRate(ctxRate)
    setCurrentTime(0)
    proc = new PlayerProcessor()
  })

  it.each([22_050, 24_000])("a %i Hz reply split into uneven frames (clause boundaries) plays exactly as one frame", (srcRate) => {
    const whole = tone(srcRate, srcRate, 440, 12_000) // 1 s
    send({ type: "start", id: 1, rate: srcRate, prebufferMs: 0 })
    send({ type: "frame", buffer: frame(1, whole) })
    send({ type: "end", id: 1 })
    const reference = renderAt(quanta(1.1))

    proc = new PlayerProcessor()
    send({ type: "start", id: 2, rate: srcRate, prebufferMs: 0 })
    // Frames as the server sends them: arbitrary sizes, including odd ones and one-sample frames.
    const sizes = [1, 441, 2205, 17, 3001, 1, 882, 5000]
    let offset = 0
    for (let k = 0; offset < whole.length; k++) {
      const size = Math.min(sizes[k % sizes.length]!, whole.length - offset)
      send({ type: "frame", buffer: frame(2, whole.subarray(offset, offset + size)) })
      offset += size
    }
    send({ type: "end", id: 2 })
    const split = renderAt(quanta(1.1))
    let diff = 0
    for (let i = 0; i < reference.length; i++) diff = Math.max(diff, Math.abs(reference[i]! - split[i]!))
    expect(diff).toBeLessThan(1e-6)
    // And the waveform itself is smooth: no step larger than a 440 Hz sine at this level allows.
    const allowed = (2 * Math.PI * 440 * (12_000 / 32_768)) / ctxRate
    expect(maxStep(split)).toBeLessThan(allowed * 1.2)
    expect(msgs("stats").at(-1)).toMatchObject({ id: 2, underruns: 0, clicks: 0, srcRate, ctxRate })
  })

  it("an underrun in the middle of a loud tone neither pops when the audio stops nor when it resumes", () => {
    const srcRate = 22_050
    send({ type: "start", id: 3, rate: srcRate, prebufferMs: 20 })
    send({ type: "frame", buffer: frame(3, tone(4500, srcRate, 440, 16_000)) }) // 204 ms: ends near a peak
    const first = renderAt(quanta(0.3)) // runs dry about 200 ms in
    expect(msgs("underrun")).toHaveLength(1)
    // A 440 Hz tone at -6 dBFS steps by at most ~0.03 per sample at 48 kHz; dropping to zero would step by up to 0.5.
    const smooth = (2 * Math.PI * 440 * 0.5) / ctxRate * 1.3 + 0.002
    expect(maxStep(first)).toBeLessThan(Math.max(smooth, 0.07))
    // The rest of the same tone arrives late: it continues near a peak, after a gap of silence.
    // (It ends with a 10 ms fade, as speech does: the end of the reply itself is not under test here.)
    const n = srcRate / 5
    const rest = Int16Array.from({ length: n }, (_, i) =>
      Math.round(16_000 * Math.min(1, (n - i) / 220) * Math.sin(2 * Math.PI * 440 * (4500 + i) / srcRate)))
    send({ type: "frame", buffer: frame(3, rest) })
    send({ type: "end", id: 3 })
    const second = renderAt(quanta(0.4))
    expect(maxStep(second)).toBeLessThan(Math.max(smooth, 0.07))
    const stats = msgs("stats").at(-1)
    expect(stats).toMatchObject({ id: 3, underruns: 1 })
    expect(stats.clicks).toBeGreaterThanOrEqual(1) // the edges were steep: counted as smoothed clicks
    expect(stats.gapMs).toBeGreaterThan(0)
  })

  it("a reply that starts or is cut at full level does not pop", () => {
    const dc = new Int16Array(4800).fill(16_000) // a reply whose first sample is already at -6 dBFS
    send({ type: "start", id: 4, rate: 24_000, prebufferMs: 0 })
    send({ type: "frame", buffer: frame(4, dc) })
    const a = renderAt(quanta(0.1))
    expect(Math.abs(a[0]!)).toBeLessThan(0.3)
    send({ type: "start", id: 5, rate: 24_000, prebufferMs: 50 }) // replaces it while it is at full level
    const b = renderAt(quanta(0.05))
    expect(maxStep(new Float32Array([...a.subarray(-8), ...b]))).toBeLessThan(0.1)
  })
})
