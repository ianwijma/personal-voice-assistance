// @ts-check
import { StreamResampler } from "./resampler.js"

/**
 * Reply playback. One node per page; replies are identified by their turn id.
 *
 * Messages in (main thread → worklet, in socket order):
 *   { type: "start", id, rate, prebufferMs? }  a new reply at `rate` Hz (`reply.start`)
 *   { type: "frame", buffer }                  a whole binary reply frame (8-byte header + PCM s16le),
 *                                              transferred; the reply id is read from the header
 *   { type: "end", id }                        every frame of the reply has arrived (`reply.end`)
 *   { type: "stop", id?, report }              stop now: 4 ms fade, drop the queue (`reply.stop`,
 *                                              the Stop button, or a lost socket with report=false)
 *   { type: "prebuffer", ms }                  default prebuffer for later replies
 *
 * Messages out:
 *   { type: "started", id, startDelayMs }       first sample handed to the device (once per reply)
 *   { type: "progress", id, playedSamples, underruns }   every 250 ms of render time while a reply is active
 *   { type: "finished", id, playedSamples }     the queue ran dry after `end`
 *   { type: "stopped", id, playedSamples, report }        after a stop (final count)
 *   { type: "underrun", id, underruns }
 *   { type: "stats", id, underruns, gapMs, clicks, minQueueMs, srcRate, ctxRate, prebufferMs }
 *                                               once per reply, right after finished/stopped (for the
 *                                               "This device" playback diagnostics; never sent to the server)
 *
 * `playedSamples` counts samples of the reply at its source rate handed to the
 * audio device. States follow docs/UI-AND-MODULES.md §2.6:
 * idle → buffering (start) → playing (prebuffer reached or end) ⇄ buffering (underrun, 40 ms refill)
 * → idle (finished after end, or stopped). Frames whose id is not the active reply are dropped.
 * A stop for the reply that just ended or stopped is answered again with the same final count.
 *
 * No clicks at the edges. Wherever the output would jump (the queue runs dry mid-quantum, playback
 * resumes after an underrun, a reply starts, ends, or replaces another one), the jump is spread over
 * about 3 ms by a decaying offset (a de-clicker): the waveform stays continuous, a gap sounds like a
 * gap instead of a pop. Each underrun in a reply doubles the refill target (40, 80, 160, 320 ms), so a
 * link that stalls repeatedly (Wi-Fi power saving) buffers more instead of stuttering on.
 */
export const HEADER_BYTES = 8

export class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    /** @type {"idle" | "buffering" | "playing" | "fading"} */
    this.state = "idle"
    this.id = 0
    this.srcRate = 0
    /** @type {StreamResampler | null} */
    this.rs = null
    /** @type {Float32Array[]} */
    this.q = []
    this.qOff = 0
    this.queued = 0
    this.ended = false
    this.receivedSrc = 0
    this.playedOut = 0
    this.threshold = 0
    this.initialThreshold = 0
    this.underruns = 0
    this.firstFrameAt = -1
    this.startedSent = false
    this.sinceProgress = 0
    this.fade = 0
    this.report = true
    this.prebufferMs = 60
    this.refill = Math.round(0.04 * sampleRate)
    this.maxRefill = Math.round(0.32 * sampleRate)
    // De-clicker: an offset added to the output that decays to 1 % in 3 ms.
    this.declick = 0
    this.declickDecay = Math.exp(Math.log(0.01) / (0.003 * sampleRate))
    /** The last sample handed to the device (after the de-clicker). */
    this.lastOut = 0
    /** The next sample of content starts after a discontinuity (new reply, refill after an underrun). */
    this.boundary = true
    /** The previous quantum ended with reply content (so silence now would be a jump). */
    this.lastWasContent = false
    // Per-reply diagnostics.
    this.clicks = 0
    this.gapSamples = 0
    this.minQueue = Infinity
    this.fadeLen = Math.max(1, Math.round(0.004 * sampleRate))
    this.progressEvery = Math.round(0.25 * sampleRate)
    /** The last reply that ended (finished or stopped), to answer a late stop. */
    this.lastId = 0
    this.lastPlayed = 0
    this.port.onmessage = (/** @type {MessageEvent} */ e) => this.onMessage(e.data)
  }

  /** Samples of the source handed to the device, at the source rate. */
  playedSrc() {
    return Math.min(this.receivedSrc, Math.round((this.playedOut * this.srcRate) / sampleRate))
  }

  reset() {
    this.state = "idle"
    this.id = 0
    this.rs = null
    this.q = []
    this.qOff = 0
    this.queued = 0
    this.ended = false
    this.receivedSrc = 0
    this.playedOut = 0
    this.underruns = 0
    this.firstFrameAt = -1
    this.startedSent = false
    this.sinceProgress = 0
    this.fade = 0
    this.report = true
    this.boundary = true
    this.clicks = 0
    this.gapSamples = 0
    this.minQueue = Infinity
  }

  /** Per-reply diagnostics, posted after finished/stopped. */
  postStats() {
    if (this.id === 0) return
    this.port.postMessage({
      type: "stats",
      id: this.id,
      underruns: this.underruns,
      gapMs: Math.round((this.gapSamples / sampleRate) * 1000),
      clicks: this.clicks,
      minQueueMs: Number.isFinite(this.minQueue) ? Math.round((this.minQueue / sampleRate) * 1000) : -1,
      srcRate: this.srcRate,
      ctxRate: sampleRate,
      prebufferMs: Math.round((this.initialThreshold / sampleRate) * 1000)
    })
  }

  /**
   * The output would jump from `from` (the last sample out) to `to` (the next raw sample): start a
   * de-click ramp that bridges the jump.
   * @param {number} from
   * @param {number} to
   */
  discontinuity(from, to) {
    const jump = to - from
    if (Math.abs(jump) > 0.1) this.clicks++ // a step of -20 dBFS or more: a clearly audible click
    this.declick = -jump
  }

  /** @param {any} m */
  onMessage(m) {
    if (!m || typeof m.type !== "string") return
    switch (m.type) {
      case "start": {
        if (this.state !== "idle") this.finishStopped() // a new reply replaces an active one: hard cut
        this.reset()
        this.id = m.id
        this.srcRate = m.rate
        this.rs = m.rate === sampleRate ? null : new StreamResampler(m.rate, sampleRate, 16384)
        const ms = typeof m.prebufferMs === "number" ? m.prebufferMs : this.prebufferMs
        this.threshold = Math.max(1, Math.round((ms / 1000) * sampleRate))
        this.initialThreshold = this.threshold
        this.state = "buffering"
        break
      }
      case "frame": {
        /** @type {ArrayBuffer} */
        const buffer = m.buffer
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= HEADER_BYTES) return
        const id = new DataView(buffer, 0, HEADER_BYTES).getUint32(4, true)
        if (id !== this.id || this.ended || (this.state !== "buffering" && this.state !== "playing")) return // stale
        const s16 = new Int16Array(buffer, HEADER_BYTES, (buffer.byteLength - HEADER_BYTES) >> 1)
        const f = new Float32Array(s16.length)
        for (let i = 0; i < s16.length; i++) f[i] = /** @type {number} */ (s16[i]) / 32768
        if (this.firstFrameAt < 0) this.firstFrameAt = currentTime
        this.receivedSrc += s16.length
        this.push(f)
        if (this.state === "buffering" && this.queued >= this.threshold) this.state = "playing"
        break
      }
      case "end": {
        if (m.id !== this.id || this.ended || (this.state !== "buffering" && this.state !== "playing")) return
        this.ended = true
        if (this.rs) {
          const tail = new Float32Array(this.rs.maxOutput(0))
          const n = this.rs.flush(tail)
          if (n > 0) this.enqueue(tail.subarray(0, n))
        }
        if (this.state === "buffering") this.state = "playing" // play what is there; finishes when dry
        break
      }
      case "stop": {
        const report = m.report !== false
        const id = typeof m.id === "number" ? m.id : undefined
        if (this.state === "fading") {
          this.report = this.report || report
          return
        }
        if (this.state !== "idle" && (id === undefined || id === this.id)) {
          this.report = report
          if (this.state === "playing" && this.queued > 0) {
            this.state = "fading" // process() ramps down over 4 ms, then reports
            this.fade = this.fadeLen
          } else {
            this.finishStopped()
          }
          return
        }
        if (id === undefined) return // nothing playing: nothing to report
        // Idle (or another reply): answer for the reply that already ended, else nothing was played.
        const played = id === this.lastId ? this.lastPlayed : 0
        this.port.postMessage({ type: "stopped", id, playedSamples: played, report })
        break
      }
      case "prebuffer": {
        if (typeof m.ms === "number" && m.ms >= 0) this.prebufferMs = m.ms
        break
      }
    }
  }

  /** @param {Float32Array} f source-rate samples */
  push(f) {
    if (!this.rs) {
      this.enqueue(f)
      return
    }
    const out = new Float32Array(this.rs.maxOutput(f.length))
    const n = this.rs.process(f, out)
    if (n > 0) this.enqueue(out.subarray(0, n))
  }

  /** @param {Float32Array} chunk context-rate samples */
  enqueue(chunk) {
    this.q.push(chunk)
    this.queued += chunk.length
  }

  finishStopped() {
    const id = this.id
    const played = this.playedSrc()
    const report = this.report
    this.lastId = id
    this.lastPlayed = played
    this.port.postMessage({ type: "stopped", id, playedSamples: played, report })
    this.postStats()
    this.reset()
  }

  finishFinished() {
    const id = this.id
    const played = this.receivedSrc // everything was handed to the device
    this.lastId = id
    this.lastPlayed = played
    this.port.postMessage({ type: "finished", id, playedSamples: played })
    this.postStats()
    this.reset()
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   * @returns {boolean}
   */
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    const n = out.length
    let i = 0
    if (this.state === "playing" || this.state === "fading") {
      if (this.state === "playing" && !this.ended && this.queued < this.minQueue) this.minQueue = this.queued
      // While fading, only the samples under the 4 ms ramp are taken (and counted as played).
      const limit = this.state === "fading" ? Math.min(n, this.fade) : n
      while (i < limit && this.queued > 0) {
        const c = /** @type {Float32Array} */ (this.q[0])
        const take = Math.min(c.length - this.qOff, limit - i)
        out.set(c.subarray(this.qOff, this.qOff + take), i)
        this.qOff += take
        this.queued -= take
        i += take
        if (this.qOff === c.length) {
          this.q.shift()
          this.qOff = 0
        }
      }
      if (i > 0 && this.boundary) {
        // Content starts (a new reply, or a refill after an underrun) where the output was something else.
        this.discontinuity(this.lastOut, /** @type {number} */ (out[0]))
      } else if (i === 0 && this.lastWasContent) {
        this.discontinuity(this.lastOut, 0)
      }
      if (i > 0) this.boundary = false
      if (i > 0 && !this.startedSent && this.state === "playing") {
        this.startedSent = true
        const delay = this.firstFrameAt < 0 ? 0 : Math.max(0, (currentTime - this.firstFrameAt) * 1000)
        this.port.postMessage({ type: "started", id: this.id, startDelayMs: delay })
      }
      this.playedOut += i
    } else if (this.lastWasContent) {
      // Content was cut off between quanta (a new reply replaced it): silence starts here.
      this.discontinuity(this.lastOut, 0)
    }
    if (i < n) out.fill(0, i)

    if (this.state === "fading") {
      for (let k = 0; k < n; k++) {
        out[k] = /** @type {number} */ (out[k]) * (this.fade / this.fadeLen)
        if (this.fade > 0) this.fade--
      }
      this.applyDeclick(out, 0)
      this.lastWasContent = false // the fade ends at zero
      if (this.fade === 0) this.finishStopped()
      return true
    }

    if (this.state === "playing" && i > 0 && i < n) {
      // The queue ran dry at `i`: continue from the last sample down to the silence that follows.
      this.applyDeclick(out, 0, i)
      this.discontinuity(this.lastOut, 0)
      this.applyDeclick(out, i)
    } else {
      this.applyDeclick(out, 0)
    }
    this.lastWasContent = this.state === "playing" && i === n
    if (this.state === "idle") return true
    if (this.state === "buffering" && this.startedSent) this.gapSamples += n

    // Progress is driven by render time, so it stays regular in background tabs.
    this.sinceProgress += n
    if (this.sinceProgress >= this.progressEvery) {
      this.sinceProgress -= this.progressEvery
      this.port.postMessage({ type: "progress", id: this.id, playedSamples: this.playedSrc(), underruns: this.underruns })
    }

    if (this.state === "playing" && i < n) {
      if (this.ended) {
        this.finishFinished()
      } else {
        this.state = "buffering"
        this.underruns++
        this.boundary = true
        this.threshold = Math.min(this.maxRefill, this.refill * 2 ** (this.underruns - 1))
        this.port.postMessage({ type: "underrun", id: this.id, underruns: this.underruns })
      }
    }
    return true
  }

  /**
   * Adds the decaying de-click offset to `out[from..to)` and remembers the last sample.
   * @param {Float32Array} out
   * @param {number} from
   * @param {number} [to]
   */
  applyDeclick(out, from, to = out.length) {
    let d = this.declick
    if (d !== 0) {
      const decay = this.declickDecay
      for (let k = from; k < to; k++) {
        out[k] = /** @type {number} */ (out[k]) + d
        d *= decay
        if (d > -1e-5 && d < 1e-5) {
          d = 0
          break
        }
      }
      this.declick = d
    }
    if (to > 0) this.lastOut = /** @type {number} */ (out[to - 1])
  }
}

if (typeof registerProcessor === "function") registerProcessor("pva-player", PlayerProcessor)
