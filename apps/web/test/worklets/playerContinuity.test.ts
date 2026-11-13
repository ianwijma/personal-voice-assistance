// @vitest-environment node
/**
 * A scan for audible discontinuities ("pops") in the reply player, across every transition it has:
 * the start of a reply, chunk boundaries, an underrun and re-buffer, the end of a reply, a stop at
 * every phase, and a new reply right after a stop or replacing a playing one, at the two voice rates
 * (22 050 Hz Piper, 24 000 Hz Kokoro/Cartesia) on the two usual device rates (44 100 and 48 000 Hz).
 *
 * The content is a 440 Hz tone at -6 dBFS whose edges sit at peaks (the worst case for an edge).
 * Each scenario renders one continuous output, and no sample-to-sample step may exceed what the tone
 * itself does by more than a small margin. A jump to or from silence would be a step of up to 0.5;
 * the de-clicker spreads such a jump over ~3 ms (a step of about 0.016 per sample).
 */
import { beforeEach, describe, expect, it } from "vitest"
import { getCurrentTime, setCurrentTime, setSampleRate } from "./shim.ts"
import { HEADER_BYTES, PlayerProcessor } from "../../worklets/player.js"

const QUANTUM = 128
const FREQ = 440
const AMP = 16_384 // -6 dBFS

const frame = (id: number, samples: Int16Array): ArrayBuffer => {
  const buf = new ArrayBuffer(HEADER_BYTES + samples.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, 2)
  view.setUint32(4, id, true)
  new Int16Array(buf, HEADER_BYTES).set(samples)
  return buf
}

/** `n` samples of the tone starting at a peak (cosine), continuing from sample `from`. */
const tone = (n: number, rate: number, from = 0) =>
  Int16Array.from({ length: n }, (_, i) => Math.round(AMP * Math.cos((2 * Math.PI * FREQ * (from + i)) / rate)))

/** A length that makes the tone's last sample land on a peak (an abrupt end at full level). */
const toPeak = (approx: number, rate: number) => Math.round(Math.round((approx * FREQ) / rate) * rate / FREQ) + 1

interface Run {
  readonly proc: any
  readonly out: Array<number>
  readonly send: (m: unknown) => void
  readonly render: (quanta: number) => void
  /**
   * The context stops rendering for `ms` (suspended, interrupted): the device plays silence, which
   * is part of what the owner hears, so it goes into `out` as zeros. Nothing is rendered meanwhile.
   */
  readonly suspend: (ms: number) => void
  /** Steps the player does not make: the edge where rendering stopped (the browser cuts it there). */
  readonly exempt: Set<number>
  readonly msgs: (type: string) => Array<any>
}

const run = (ctxRate: number): Run => {
  setSampleRate(ctxRate)
  setCurrentTime(0)
  const proc: any = new PlayerProcessor()
  const out: Array<number> = []
  const exempt = new Set<number>()
  let wall = 0
  proc.now = () => wall // a virtual wall clock: render calls are one quantum apart unless suspended
  return {
    proc,
    out,
    send: (m) => proc.port.deliver(m),
    render: (quanta) => {
      for (let q = 0; q < quanta; q++) {
        const o = new Float32Array(QUANTUM)
        proc.process([], [[o]])
        for (const v of o) out.push(v)
        setCurrentTime(getCurrentTime() + QUANTUM / ctxRate)
        wall += (QUANTUM / ctxRate) * 1000
      }
    },
    exempt,
    suspend: (ms) => {
      exempt.add(out.length)
      for (let k = 0; k < Math.round((ms / 1000) * ctxRate); k++) out.push(0)
      wall += ms
    },
    msgs: (type) => proc.port.sent.filter((m: any) => m.type === type)
  }
}

/** The largest sample-to-sample step, and where it is. */
const worstStep = (x: ReadonlyArray<number>, exempt: ReadonlySet<number> = new Set()) => {
  let max = 0
  let at = -1
  for (let i = 1; i < x.length; i++) {
    if (exempt.has(i)) continue
    const d = Math.abs(x[i]! - x[i - 1]!)
    if (d > max) {
      max = d
      at = i
    }
  }
  return { max, at, around: x.slice(Math.max(0, at - 3), at + 3).map((v) => +v.toFixed(4)) }
}

/**
 * The number of source samples that leaves exactly `quanta * 128 + remainder` (±2) context-rate
 * samples queued after `start` + one frame (the resampler's ratio is not an integer).
 */
const sourceLengthFor = (srcRate: number, ctxRate: number, quanta: number, remainder: number) => {
  const target = quanta * QUANTUM + remainder
  let best = 0
  let bestErr = Infinity
  for (let n = Math.floor((target * srcRate) / ctxRate) - 40; n < (target * srcRate) / ctxRate + 40; n++) {
    const r = run(ctxRate)
    r.send({ type: "start", id: 1, rate: srcRate, prebufferMs: 0 })
    r.send({ type: "frame", buffer: frame(1, tone(n, srcRate)) })
    const err = Math.abs(r.proc.queued - target)
    if (err < bestErr) {
      best = n
      bestErr = err
    }
  }
  return best
}

const scenarios: ReadonlyArray<{ readonly name: string; readonly play: (r: Run, src: number, ctx: number) => void }> = [
  {
    name: "a reply that starts at a peak, arrives in uneven chunks and ends abruptly at a peak",
    play: (r, src) => {
      const whole = tone(toPeak(src * 0.5, src), src)
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 60 })
      const sizes = [1, 441, 2205, 17, 3001, 1, 882, 5000]
      for (let off = 0, k = 0; off < whole.length; k++) {
        const size = Math.min(sizes[k % sizes.length]!, whole.length - off)
        r.send({ type: "frame", buffer: frame(1, whole.subarray(off, off + size)) })
        off += size
        if (k % 3 === 0) r.render(2) // frames keep arriving while it plays
      }
      r.send({ type: "end", id: 1 })
      r.render(200)
    }
  },
  {
    name: "an underrun that cuts the tone at a peak, then a re-buffer that resumes it at a peak",
    play: (r, src) => {
      const first = toPeak(src * 0.2, src)
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 20 })
      r.send({ type: "frame", buffer: frame(1, tone(first, src)) })
      r.render(150) // runs dry
      expect(r.msgs("underrun")).toHaveLength(1)
      r.send({ type: "frame", buffer: frame(1, tone(src / 5, src, first)) })
      r.send({ type: "end", id: 1 })
      r.render(200)
    }
  },
  {
    name: "a stop with plenty queued",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(37)
      r.send({ type: "stop", id: 1, report: true })
      r.render(60)
    }
  },
  ...[10, 100, 150, 180, 250].map((remainder) => ({
    name: `a stop with ${remainder} samples queued (fade is ${"≈"}4 ms, a quantum is 128)`,
    play: (r: Run, src: number, ctx: number) => {
      const n = sourceLengthFor(src, ctx, 6, remainder)
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(n, src)) })
      r.render(6)
      expect(Math.abs(r.proc.queued - remainder)).toBeLessThanOrEqual(3)
      const queuedAtStop = r.proc.queued
      const fadeLen = r.proc.fadeLen
      r.send({ type: "stop", id: 1, report: true })
      r.render(60)
      expect(r.msgs("stopped")).toHaveLength(1)
      // Only reply content handed to the device counts: what was queued, up to the fade's length,
      // never the held samples that carry a short queue down to zero.
      const playedOut = 6 * QUANTUM + Math.min(queuedAtStop, fadeLen)
      expect(r.msgs("stopped")[0].playedSamples).toBe(Math.min(n, Math.round((playedOut * src) / ctx)))
    }
  })),
  {
    name: "a stop in the very first quantum of a reply (while the start is being smoothed)",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(1)
      r.send({ type: "stop", id: 1, report: true })
      r.render(60)
    }
  },
  {
    name: "a stop while re-buffering after an underrun",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 20 })
      r.send({ type: "frame", buffer: frame(1, tone(toPeak(src * 0.1, src), src)) })
      r.render(ms(r, 0.1) + 1)
      expect(r.proc.state).toBe("buffering")
      r.send({ type: "stop", id: 1, report: true })
      r.render(60)
    }
  },
  {
    name: "a second stop during the fade",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(20)
      r.send({ type: "stop", report: true })
      r.render(1)
      r.send({ type: "stop", id: 1, report: true })
      r.render(60)
      expect(r.msgs("stopped")).toHaveLength(1)
    }
  },
  {
    name: "an immediate stop (context suspended) while playing: reported at once, silent and smooth on resume",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(30)
      r.suspend(50) // shorter than GAP_MS: only the immediate stop itself can clear the state
      r.send({ type: "stop", id: 1, report: true, now: true })
      expect(r.msgs("stopped")).toHaveLength(1) // without rendering anything more
      r.suspend(50)
      const resumedAt = r.out.length
      r.render(60)
      // Nothing is playing: the resumed output is exactly silent (second review, finding 6).
      expect(r.out.slice(resumedAt).every((v) => v === 0)).toBe(true)
    }
  },
  {
    name: "an immediate stop arriving during a fade (the context suspended mid-fade)",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(30)
      r.send({ type: "stop", id: 1, report: true })
      r.render(1)
      r.suspend(50)
      r.send({ type: "stop", id: 1, report: true, now: true })
      expect(r.msgs("stopped")).toHaveLength(1)
      r.suspend(50)
      const resumedAt = r.out.length
      r.render(60)
      expect(r.out.slice(resumedAt).every((v) => v === 0)).toBe(true)
    }
  },
  {
    name: "a suspension mid-reply (longer than GAP_MS): playback resumes bridged up from the silence",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.send({ type: "end", id: 1 })
      r.render(30)
      r.suspend(400)
      r.render(500)
    }
  },
  {
    name: "a suspension during a de-click tail (just after a cut), then idle: resumed output is exactly zero",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(30)
      r.send({ type: "start", id: 2, rate: src, prebufferMs: 60 }) // hard cut: the de-clicker is carrying the old level
      r.suspend(400)
      r.send({ type: "stop", id: 2, report: true })
      const resumedAt = r.out.length
      r.render(60)
      expect(r.out.slice(resumedAt).every((v) => v === 0)).toBe(true)
    }
  },
  {
    name: "a stop right after the last frame, with the resampler's tail queued",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src / 10, src)) })
      r.send({ type: "end", id: 1 })
      r.render(ms(r, 0.1) - 1)
      r.send({ type: "stop", id: 1, report: true })
      r.render(60)
    }
  },
  {
    name: "a new reply right after a stop (in the same tick, during the fade), starting at a peak",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(30)
      r.send({ type: "stop", id: 1, report: true })
      r.send({ type: "start", id: 2, rate: src, prebufferMs: 60 })
      r.render(1)
      r.send({ type: "frame", buffer: frame(2, tone(src / 2, src)) })
      r.send({ type: "end", id: 2 })
      r.render(250)
    }
  },
  {
    name: "a new reply one quantum after a stop (mid-fade)",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(30)
      r.send({ type: "stop", id: 1, report: true })
      r.render(1)
      r.send({ type: "start", id: 2, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(2, tone(src / 2, src)) })
      r.send({ type: "end", id: 2 })
      r.render(250)
    }
  },
  {
    name: "a new reply that is still buffering, one quantum after a stop (cuts the fade short)",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(30)
      r.send({ type: "stop", id: 1, report: true })
      r.render(1)
      r.send({ type: "start", id: 2, rate: src, prebufferMs: 60 })
      r.render(10)
      r.send({ type: "frame", buffer: frame(2, tone(src / 2, src)) })
      r.send({ type: "end", id: 2 })
      r.render(250)
    }
  },
  {
    name: "a new reply replacing a playing one (no stop), starting at the opposite peak",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(1, tone(src, src)) })
      r.render(30)
      r.send({ type: "start", id: 2, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(2, tone(src / 2, src, Math.round(src / FREQ / 2))) })
      r.send({ type: "end", id: 2 })
      r.render(250)
    }
  },
  {
    name: "a new reply replacing one that is re-buffering, with the old de-click still decaying",
    play: (r, src) => {
      r.send({ type: "start", id: 1, rate: src, prebufferMs: 20 })
      r.send({ type: "frame", buffer: frame(1, tone(toPeak(src * 0.05, src), src)) })
      r.render(ms(r, 0.05) + 1)
      r.send({ type: "start", id: 2, rate: src, prebufferMs: 0 })
      r.send({ type: "frame", buffer: frame(2, tone(src / 2, src)) })
      r.send({ type: "end", id: 2 })
      r.render(250)
    }
  }
]

/** Render quanta covering `seconds` at the current context rate. */
function ms(_r: Run, seconds: number) {
  return Math.ceil((seconds * (globalThis as { sampleRate?: number }).sampleRate!) / QUANTUM)
}

beforeEach(() => setCurrentTime(0))

describe.each([44_100, 48_000])("player discontinuity scan at a %i Hz device", (ctxRate) => {
  // The tone's own largest step (+5 % resampler overshoot) plus the de-clicker's largest step for the
  // largest jump here (peak to opposite peak, 1.0): anything above it is an edge that was not bridged.
  // The reasoning, and why a bridged edge is not an audible click, is in playerProperty.test.ts.
  setSampleRate(ctxRate)
  const decay = new (PlayerProcessor as any)().declickDecay as number
  const allowed = ((2 * Math.PI * FREQ * AMP) / 32_768 / ctxRate) * 1.05 + 1.0 * (1 - decay) + 1e-3
  describe.each([22_050, 24_000])("%i Hz voice", (srcRate) => {
    it.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, scenario) => {
      const r = run(ctxRate)
      scenario.play(r, srcRate, ctxRate)
      const worst = worstStep(r.out, r.exempt)
      expect(worst.max, `largest step ${worst.max.toFixed(4)} at sample ${worst.at}: ${worst.around.join(", ")}`).toBeLessThan(allowed)
      // Every scenario ends in silence, and nothing is left playing.
      expect(Math.abs(r.out.at(-1)!)).toBeLessThan(1e-4)
      expect(r.proc.state).toBe("idle")
    })
  })
})
