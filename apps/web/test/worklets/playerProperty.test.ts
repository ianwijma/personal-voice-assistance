// @vitest-environment node
/**
 * Property-style test of the reply player (second review, finding 6): random sequences of everything
 * the player can be sent — a new reply at any moment (also replacing a playing one), frames of random
 * sizes, end, stop, an immediate stop while the context is suspended, rendering, and suspensions of
 * random length (the device plays silence meanwhile) — at the four usual rate combinations. After
 * every step:
 *
 * 1. No sample-to-sample step above `allowed` (below) anywhere the player decides the output. The
 *    one edge it does not decide, where the browser stops rendering at a suspension, is exempt.
 * 2. Idle output is exactly zero once the de-click tail has decayed (it snaps to zero below 1e-5,
 *    within ~3 ms), and right after a suspension.
 * 3. Every reported `playedSamples` is at most the source samples the player was given for that
 *    reply and at most what its handed-out output corresponds to; per reply it never decreases.
 *
 * Exactness of the counts (undercounting included) is checked against an independent oracle, through the
 * page's `PlaybackLink` and every way a reply can end, in `playedOracle.test.ts` (third review).
 */
import { describe, expect, it } from "vitest"
import { setCurrentTime, setSampleRate } from "./shim.ts"
import { HEADER_BYTES, PlayerProcessor } from "../../worklets/player.js"

const QUANTUM = 128
const FREQ = 440
const AMP = 16_384 // -6 dBFS: content peaks at ±0.5

/** mulberry32: a small seeded generator, so a failure names a seed that reproduces it. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const frame = (id: number, samples: Int16Array): ArrayBuffer => {
  const buf = new ArrayBuffer(HEADER_BYTES + samples.byteLength)
  new DataView(buf).setUint32(4, id, true)
  new Int16Array(buf, HEADER_BYTES).set(samples)
  return buf
}

/**
 * The threshold, from what the player is meant to do rather than a margin found by trial: content
 * is a -6 dBFS 440 Hz tone, so its own largest step is 2π·440·0.5/rate (≈0.031 at 44.1 kHz), plus a
 * little resampler overshoot (5 %). Every edge the player makes (a start, a cut, an underrun, a new
 * reply replacing an old one, resuming after silence) is bridged by the de-clicker, whose largest
 * per-sample step for a jump J is J·(1 − decay) — J is at most 1.0 here (one peak to the other) —
 * or by the 4 ms fades, whose steps are smaller. A step above the sum is an edge that was not
 * bridged. Why a bridged edge is inaudible as a click: the de-clicker turns a jump into a first-order
 * decay with a 3 ms time constant to 1 % (τ ≈ 0.65 ms), a low-pass at about 1/(2πτ) ≈ 245 Hz, so its
 * energy sits below ~250 Hz and falls 6 dB per octave above: a soft thump at the level of the jump at
 * worst, not the broadband tick an unbridged step makes (the "step of 0.1" the player counts as a
 * click in its diagnostics is ten times larger than what can survive this check unbridged).
 */
const thresholdFor = (ctxRate: number, decay: number) => ((2 * Math.PI * FREQ * AMP) / 32_768 / ctxRate) * 1.05 + 1.0 * (1 - decay) + 1e-3

interface Reply {
  readonly id: number
  readonly src: number
  phase: number
  sent: number
  lastPlayed: number
}

const runSequence = (seed: number, srcRate: number, ctxRate: number, steps: number) => {
  const random = rng(seed)
  const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(random() * xs.length)]!
  setSampleRate(ctxRate)
  setCurrentTime(0)
  const proc: any = new PlayerProcessor()
  let wall = 0
  let audioTime = 0 // the context's currentTime: advances only while rendering
  proc.now = () => wall
  const allowed = thresholdFor(ctxRate, proc.declickDecay)
  const tailQuanta = Math.ceil((0.0075 * ctxRate) / QUANTUM) + 1
  const log: Array<string> = []
  const fail = (what: string) => {
    throw new Error(`seed ${seed} (${srcRate}→${ctxRate}): ${what}\n${log.slice(-40).join("\n")}`)
  }

  const replies = new Map<number, Reply>()
  let nextId = 1
  let current: Reply | undefined
  let last = 0 // the last sample the owner heard
  let idleQuanta = 0
  let suspendedSince = false // the next render follows a suspension

  // Every report is checked against what the player was given and what it handed out.
  const send = proc.port.postMessage.bind(proc.port)
  proc.port.postMessage = (m: any) => {
    if (m && typeof m.playedSamples === "number") {
      const reply = replies.get(m.id)
      const given = reply?.sent ?? 0
      if (m.playedSamples > given) fail(`${m.type} reports ${m.playedSamples} played of ${given} given`)
      const handed = Math.ceil((proc.playedOut * srcRate) / ctxRate) + 1
      if (m.type !== "finished" && proc.id === m.id && m.playedSamples > handed) fail(`${m.type} reports ${m.playedSamples}, handed out ${handed}`)
      if (reply !== undefined) {
        if (m.playedSamples < reply.lastPlayed) fail(`${m.type} count went down: ${reply.lastPlayed} → ${m.playedSamples}`)
        reply.lastPlayed = m.playedSamples
      }
    }
    send(m)
  }
  const deliver = (m: any) => {
    log.push(JSON.stringify(m.type === "frame" ? { type: "frame", bytes: m.buffer.byteLength } : m))
    proc.port.deliver(m)
  }

  const render = (quanta: number) => {
    for (let q = 0; q < quanta; q++) {
      const idleBefore = proc.state === "idle"
      log.push(`render state=${proc.state} queued=${proc.queued} declick=${proc.declick.toFixed(4)} lastOut=${proc.lastOut.toFixed(4)} boundary=${proc.boundary} wall=${wall.toFixed(1)}`)
      const out = new Float32Array(QUANTUM)
      proc.process([], [[out]])
      audioTime += QUANTUM / ctxRate
      setCurrentTime(audioTime)
      wall += (QUANTUM / ctxRate) * 1000
      for (let k = 0; k < QUANTUM; k++) {
        const v = out[k]!
        if (!Number.isFinite(v)) fail(`non-finite output ${v}`)
        if (Math.abs(v - last) > allowed) fail(`step ${Math.abs(v - last).toFixed(4)} > ${allowed.toFixed(4)} (${last.toFixed(4)} → ${v.toFixed(4)})`)
        last = v
      }
      if (idleBefore && proc.state === "idle") {
        idleQuanta++
        // Right after a suspension, and once the de-click tail has snapped to zero, exactly zero. The
        // tail decays to 1 % in 3 ms and snaps below 1e-5: for the largest jump here (1.0) that is
        // log(1e-5)/log(0.01) × 3 ms = 7.5 ms, so from the fourth idle quantum on (≥ 8.7 ms).
        if ((suspendedSince || idleQuanta >= tailQuanta) && out.some((v) => v !== 0)) fail(`idle output not zero (${idleQuanta} idle quanta)`)
      } else idleQuanta = 0
      suspendedSince = false
    }
  }

  const sendFrame = (reply: Reply, n: number) => {
    const pcm = Int16Array.from({ length: n }, (_, i) => Math.round(AMP * Math.cos((2 * Math.PI * FREQ * (reply.phase + i)) / reply.src)))
    reply.phase += n
    // The player keeps only frames of the active reply that has not ended: count what it accepts.
    const accepted = proc.id === reply.id && !proc.ended && (proc.state === "buffering" || proc.state === "playing")
    if (accepted) reply.sent += n
    deliver({ type: "frame", buffer: frame(reply.id, pcm) })
  }

  for (let step = 0; step < steps; step++) {
    const action = pick(["start", "frame", "frame", "frame", "end", "stop", "suspend-stop-now", "render", "render", "render", "suspend"] as const)
    switch (action) {
      case "start": {
        // Random phase: replies may start (or replace another) anywhere, including at a peak.
        const reply: Reply = { id: nextId++, src: srcRate, phase: Math.floor(random() * 1000), sent: 0, lastPlayed: 0 }
        replies.set(reply.id, reply)
        current = reply
        deliver({ type: "start", id: reply.id, rate: srcRate, prebufferMs: pick([0, 20, 60, 120]) })
        break
      }
      case "frame":
        if (current !== undefined) sendFrame(current, pick([1, 2, 17, 128, 441, 1000, 2205, 5000]))
        break
      case "end":
        if (current !== undefined) deliver({ type: "end", id: current.id })
        break
      case "stop":
        deliver(random() < 0.5 || current === undefined ? { type: "stop", report: true } : { type: "stop", id: current.id, report: true })
        break
      case "suspend-stop-now": {
        // The page sends `now` only while the context is not rendering.
        const ms = pick([5, 50, 100, 400])
        log.push(`suspend-stop-now ${ms}`)
        last = 0 // the device is silent from here (the edge itself is the browser's)
        deliver({ type: "suspended", at: audioTime }) // the page's notice (VoiceAudio, on statechange)
        wall += ms / 2
        deliver(current === undefined ? { type: "stop", report: true, now: true } : { type: "stop", id: current.id, report: true, now: true })
        if (random() < 0.3) {
          // A new reply arrives while still suspended (before the notice was even handled, or after).
          const reply: Reply = { id: nextId++, src: srcRate, phase: Math.floor(random() * 1000), sent: 0, lastPlayed: 0 }
          replies.set(reply.id, reply)
          current = reply
          deliver({ type: "start", id: reply.id, rate: srcRate, prebufferMs: 0 })
          sendFrame(reply, pick([441, 2205]))
        }
        wall += ms / 2
        suspendedSince = true
        break
      }
      case "render":
        render(pick([1, 2, 3, 10, 40]))
        break
      case "suspend": {
        // Suspended for a while: the device plays silence; then rendering resumes.
        const ms = pick([10, 100, 300, 1000])
        log.push(`suspend ${ms}`)
        last = 0
        // The page's notice: always for a short suspension (the player has no other way to know: this
        // is the part that depends on messages reaching a suspended worklet); for a long one sometimes
        // late (after rendering resumed, where it must change nothing) or never (the wall clock notices).
        const notice = random()
        if (notice < 0.6 || ms <= 250) deliver({ type: "suspended", at: audioTime })
        wall += ms
        suspendedSince = proc.state === "idle" // the first quantum after this must be silent
        if (notice >= 0.6 && notice < 0.9 && ms > 250) {
          render(pick([1, 3])) // rendering resumed before the notice arrived
          deliver({ type: "suspended", at: audioTime - 1 })
        }
        break
      }
    }
  }
  // Drain: end whatever plays and let it finish; the output ends in exact silence.
  if (current !== undefined) deliver({ type: "end", id: current.id })
  render(800)
  if (proc.state !== "idle") fail(`still ${proc.state} after draining`)
  if (last !== 0) fail(`ends at ${last}, not silence`)
}

describe.each([44_100, 48_000])("player property test at a %i Hz device", (ctxRate) => {
  describe.each([22_050, 24_000])("%i Hz voice", (srcRate) => {
    it("random sequences of inputs: no unbridged step, silent when idle, counts within what was played", () => {
      for (let seed = 1; seed <= Number(process.env.PLAYER_SEEDS ?? 150); seed++) runSequence(seed * 7919 + srcRate + ctxRate, srcRate, ctxRate, Number(process.env.PLAYER_STEPS ?? 80))
    })
  })
})

describe("the threshold", () => {
  it("is tight: a single unbridged jump of a quarter of the content's range would exceed it", () => {
    for (const ctxRate of [44_100, 48_000]) {
      setSampleRate(ctxRate)
      const decay = new (PlayerProcessor as any)().declickDecay
      const allowed = thresholdFor(ctxRate, decay)
      expect(allowed).toBeLessThan(0.07)
      expect(allowed).toBeGreaterThan((2 * Math.PI * FREQ * 0.5) / ctxRate)
    }
  })
})
