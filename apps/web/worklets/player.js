// @ts-check
import { StreamResampler } from "./resampler.js"

/**
 * Reply playback. One node per page; replies are identified by their turn id.
 *
 * Reply instances (seventh review, finding 3): a reply id can repeat (a server restart, the echo test), so the
 * page gives every reply an instance `token` at `start` (a positive integer, unique within the page). Every
 * message about a reply carries it both ways: a `frame`, `end` or `stop` acts only on the active reply when
 * both its id and its token match, and every message out about a reply echoes the token of the instance it is
 * about, as does the shared counter. A message without a token counts as token 0 (tests that drive the worklet
 * by hand; the page never sends 0).
 *
 * Messages in (main thread → worklet, in socket order):
 *   { type: "start", id, token, rate, prebufferMs? }  a new reply at `rate` Hz (`reply.start`)
 *   { type: "frame", buffer, token }           a whole binary reply frame (8-byte header + PCM s16le),
 *                                              transferred; the reply id is read from the header
 *   { type: "end", id, token }                 every frame of the reply has arrived (`reply.end`)
 *   { type: "stop", id?, token?, report, now? }  stop now: 4 ms fade, drop the queue (`reply.stop`,
 *                                              the Stop button, or a lost socket with report=false;
 *                                              without an id: whatever plays, answered with its token);
 *                                              `now`: no fade (the context is not rendering, so a fade
 *                                              would never finish), report at once
 *   { type: "prebuffer", ms }                  default prebuffer for later replies
 *   { type: "suspended", at }                  the context stopped rendering after time `at` (its
 *                                              currentTime then): the device is silent from there
 *   { type: "route", shared }                  the page's verdict on the shared counter (fifth review,
 *                                              finding 4): `true`, it reads the counter correctly, so the
 *                                              `count` messages stop; `false`, it cannot use it, so the
 *                                              counter is dropped and `count` messages carry the count
 *
 * Messages out (each about a reply also carries `token`, the instance's):
 *   { type: "ready", shared }                   sent once, at construction: whether a usable shared counter
 *                                               arrived in `processorOptions` (the page falls back to the
 *                                               message route when it passed one and this says false, or
 *                                               never comes)
 *   { type: "count", id, playedSamples, at, out, queued, received }
 *                                               the live count, after every quantum that handed reply
 *                                               samples to the device, when there is no shared counter
 *                                               (below), or while the page has not confirmed it reads it. `at` is the context time at the end of that
 *                                               quantum; `out` the context-rate samples handed out so
 *                                               far, `queued` those still queued and certain to play
 *                                               (0 unless playing), `received` the source samples
 *                                               received. While these messages wait in the page's task
 *                                               queue, the page computes from them and the context's
 *                                               clock a count it knows was reached (`playback.ts`)
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
 * audio device. The live count is also published after every quantum: into a shared counter when the page
 * is cross-origin isolated (`processorOptions.counter`, a `SharedArrayBuffer` of 5 Int32: a sequence number
 * that is odd while a write is in progress, the reply id, its instance token, the count, 1 while the reply is
 * open; a buffer of another length is not used), otherwise
 * as a `count` message (see `src/lib/audio/playback.ts`, which reads either). States follow docs/UI-AND-MODULES.md §2.6:
 * idle → buffering (start) → playing (prebuffer reached or end) ⇄ buffering (underrun, 40 ms refill)
 * → idle (finished after end, or stopped). Frames whose id is not the active reply are dropped.
 * A stop for the reply that just ended or stopped is answered again with the same final count.
 *
 * No clicks at the edges. Wherever the output would jump (the queue runs dry mid-quantum, playback
 * resumes after an underrun, a reply starts, ends, or replaces another one), the jump is spread over
 * about 3 ms by a decaying offset (a de-clicker): the waveform stays continuous, a gap sounds like a
 * gap instead of a pop. Rendering that stops (a suspended or interrupted context) leaves the device
 * silent, so after a gap in render time the output is treated as having been at zero: an immediate
 * stop (sent only while the context is not rendering) clears the de-click state at once, and any
 * longer pause between two `process()` calls (wall clock, `GAP_MS`) does the same before the next
 * quantum, so resumed audio is bridged up from silence instead of jumping. A shorter suspension is
 * announced by the page (`suspended`); it is applied only if nothing was rendered after `at`, so a
 * notice that arrives late (after rendering resumed) changes nothing. Each underrun in a reply doubles the refill target (40, 80, 160, 320 ms), so a
 * link that stalls repeatedly (Wi-Fi power saving) buffers more instead of stuttering on.
 */
export const HEADER_BYTES = 8

/** The shared counter's length in bytes (`SharedCounter.BYTES` in `playback.ts`). */
export const COUNTER_BYTES = 20

/** A message's instance token (0 when it has none). */
const tokenOf = (/** @type {any} */ m) => (typeof m.token === "number" ? m.token | 0 : 0)

/**
 * A pause between two render calls longer than this means the device played silence meanwhile (a
 * suspension, an interruption, a stalled audio thread). Well above any hardware buffer period
 * (render calls come in bursts one buffer apart: up to ~100 ms with Bluetooth), so normal rendering
 * never trips it; real suspensions last far longer.
 */
export const GAP_MS = 250

/** A monotonic clock where the worklet scope has one (it is not specified there); else the wall clock, guarded in `process`. */
const monotonicNow = () =>
  typeof globalThis.performance === "object" && typeof globalThis.performance.now === "function" ? globalThis.performance.now() : Date.now()

export class PlayerProcessor extends AudioWorkletProcessor {
  /** @param {{ processorOptions?: { counter?: unknown } }} [options] */
  constructor(options) {
    super()
    const counter = options?.processorOptions?.counter
    /** The shared live counter (cross-origin isolated pages only), else null: `count` messages instead. */
    this.shared = typeof SharedArrayBuffer === "function" && counter instanceof SharedArrayBuffer && counter.byteLength === COUNTER_BYTES
      ? new Int32Array(counter, 0, 5)
      : null
    /**
     * The page confirmed it reads the shared counter (`route` message): only then do the `count` messages
     * stop. Until then both are published, so a counter the page cannot see costs nothing but messages.
     */
    this.sharedConfirmed = false
    /** The count last published (to publish only changes). */
    this.publishedId = -1
    this.publishedToken = 0
    this.publishedCount = -1
    /** @type {"idle" | "buffering" | "playing" | "fading"} */
    this.state = "idle"
    this.id = 0
    /** The active reply's instance token (0: none). */
    this.token = 0
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
    /** The last sample of reply content taken from the queue (before fades and the de-clicker). */
    this.lastRaw = 0
    // Per-reply diagnostics.
    this.clicks = 0
    this.gapSamples = 0
    this.minQueue = Infinity
    this.fadeLen = Math.max(1, Math.round(0.004 * sampleRate))
    this.progressEvery = Math.round(0.25 * sampleRate)
    /** The last reply that ended (finished or stopped), to answer a late stop for that same instance. */
    this.lastId = 0
    this.lastToken = 0
    this.lastPlayed = 0
    /**
     * Clock of the last render call, for `GAP_MS`: monotonic where the scope has `performance.now`;
     * otherwise `Date.now`, where a step backwards (a clock adjustment) is never taken as a gap and a step
     * forwards can at worst add one de-click bridge. Tests replace `now`.
     */
    this.now = monotonicNow
    this.lastRenderAt = -1
    /** The next boundary follows silence the player did not render (not counted as a click). */
    this.afterGap = false
    this.port.onmessage = (/** @type {MessageEvent} */ e) => this.onMessage(e.data)
    this.port.postMessage({ type: "ready", shared: this.shared !== null })
  }

  /** Samples of the source handed to the device, at the source rate. */
  playedSrc() {
    return Math.min(this.receivedSrc, Math.round((this.playedOut * this.srcRate) / sampleRate))
  }

  /**
   * Publish the live count of reply `id` (open: still playing). Shared memory: a seqlock write (readers
   * retry on an odd or changed sequence number). Otherwise a `count` message, only when it changed, with
   * what the page needs to bound the count while later messages are still on their way: the context time
   * at the end of this quantum, the context-rate samples handed out, those queued that will play without
   * a gap unless a stop or a new reply arrives (only while playing: a fade or a refill plays none of them
   * for certain), and the source samples received.
   * @param {number} id
   * @param {number} played
   * @param {boolean} open
   * @param {number} [quantum] the length of the quantum just rendered (0 outside `process`)
   */
  publish(id, played, open, quantum = 0) {
    const shared = this.shared
    const token = this.token
    if (shared !== null) {
      const seq = Atomics.load(shared, 0)
      Atomics.store(shared, 0, (seq + 1) | 0)
      Atomics.store(shared, 1, id | 0)
      Atomics.store(shared, 2, token | 0)
      Atomics.store(shared, 3, played | 0)
      Atomics.store(shared, 4, open ? 1 : 0)
      Atomics.store(shared, 0, (seq + 2) | 0)
      if (this.sharedConfirmed) return
    }
    if (id === this.publishedId && token === this.publishedToken && played === this.publishedCount) return
    this.publishedId = id
    this.publishedToken = token
    this.publishedCount = played
    if (!open) return
    this.port.postMessage({
      type: "count",
      id,
      token,
      playedSamples: played,
      at: currentTime + quantum / sampleRate,
      out: this.playedOut,
      queued: this.state === "playing" ? this.queued : 0,
      received: this.receivedSrc
    })
  }

  reset() {
    this.state = "idle"
    this.id = 0
    this.token = 0
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
      token: this.token,
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
    if (Math.abs(jump) > 0.1 && !this.afterGap) this.clicks++ // a step of -20 dBFS or more: a clearly audible click
    this.declick = -jump
  }

  /**
   * The device has been silent without this player rendering it (the context stopped rendering):
   * whatever the de-clicker or a held sample was carrying is gone. Content that follows is bridged
   * up from zero (`boundary`); idle output is exactly zero.
   */
  silenced() {
    this.declick = 0
    this.lastOut = 0
    this.lastRaw = 0
    this.lastWasContent = false
    this.boundary = true
    this.afterGap = true
  }

  /** @param {any} m */
  onMessage(m) {
    if (!m || typeof m.type !== "string") return
    switch (m.type) {
      case "start": {
        if (this.state !== "idle") this.finishStopped() // a new reply replaces an active one: hard cut
        this.reset()
        this.id = m.id
        this.token = tokenOf(m)
        this.srcRate = m.rate
        this.rs = m.rate === sampleRate ? null : new StreamResampler(m.rate, sampleRate, 16384)
        const ms = typeof m.prebufferMs === "number" ? m.prebufferMs : this.prebufferMs
        this.threshold = Math.max(1, Math.round((ms / 1000) * sampleRate))
        this.initialThreshold = this.threshold
        this.state = "buffering"
        this.publish(this.id, 0, true)
        break
      }
      case "frame": {
        /** @type {ArrayBuffer} */
        const buffer = m.buffer
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= HEADER_BYTES) return
        const id = new DataView(buffer, 0, HEADER_BYTES).getUint32(4, true)
        if (id !== this.id || tokenOf(m) !== this.token || this.ended || (this.state !== "buffering" && this.state !== "playing")) return // stale
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
        if (m.id !== this.id || tokenOf(m) !== this.token || this.ended || (this.state !== "buffering" && this.state !== "playing")) return
        this.ended = true
        if (this.rs) {
          const tail = new Float32Array(this.rs.maxOutput(0))
          const n = this.rs.flush(tail)
          if (n > 0) this.enqueue(tail.subarray(0, n))
        }
        this.fadeOutTail()
        if (this.state === "buffering") this.state = "playing" // play what is there; finishes when dry
        break
      }
      case "stop": {
        const report = m.report !== false
        const id = typeof m.id === "number" ? m.id : undefined
        const token = tokenOf(m)
        const now = m.now === true
        // A stop for another instance of the active reply's id is a stop for another reply.
        const forActive = id === undefined || (id === this.id && token === this.token)
        if (this.state === "fading" && forActive) {
          this.report = this.report || report
          if (now) {
            this.finishStopped()
            this.silenced() // not rendering: nothing of the cut-off fade may play on resume
          }
          return
        }
        if (this.state !== "idle" && this.state !== "fading" && forActive) {
          this.report = report
          if (this.state === "playing" && this.queued > 0 && !now) {
            this.state = "fading" // process() ramps down over 4 ms, then reports
            this.fade = this.fadeLen
          } else {
            this.finishStopped()
            if (now) this.silenced()
          }
          return
        }
        if (now) this.silenced() // idle while not rendering: a de-click tail must not play on resume
        if (id === undefined) return // nothing playing: nothing to report
        // Idle (or another reply): answer for the instance that already ended, else nothing was played.
        const played = id === this.lastId && token === this.lastToken ? this.lastPlayed : 0
        this.port.postMessage({ type: "stopped", id, token, playedSamples: played, report })
        break
      }
      case "suspended": {
        // Rendering stopped at `at`. If the notice arrives before anything was rendered after that,
        // the next quantum follows silence; arriving later, the output already went on: ignore it.
        if (typeof m.at === "number" && currentTime <= m.at + 1e-6) this.silenced()
        break
      }
      case "route": {
        if (m.shared === true) this.sharedConfirmed = this.shared !== null
        else if (m.shared === false) {
          this.shared = null
          this.sharedConfirmed = false
          this.publishedId = -1 // the next count goes out as a message even if it did not change
        }
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

  /**
   * The whole reply is queued: ramp its last 4 ms down to zero. A reply whose audio ends above
   * silence would otherwise end in a step (the resampler band-limits it, but a step of a quarter of
   * full scale within two samples is still a click). Speech ends in silence, so this changes nothing
   * audible in the normal case.
   */
  fadeOutTail() {
    const len = Math.min(this.fadeLen, this.queued)
    let j = 0 // distance from the end
    for (let c = this.q.length - 1; c >= 0 && j < len; c--) {
      const chunk = /** @type {Float32Array} */ (this.q[c])
      const start = c === 0 ? this.qOff : 0
      for (let k = chunk.length - 1; k >= start && j < len; k--, j++) {
        chunk[k] = /** @type {number} */ (chunk[k]) * (j / len)
      }
    }
  }

  /** @param {Float32Array} chunk context-rate samples */
  enqueue(chunk) {
    this.q.push(chunk)
    this.queued += chunk.length
  }

  /**
   * Ends the reply now. This can cut audio short (a new reply, an immediate stop, a fade cut off),
   * so the de-clicker carries the output from the last sample out down to whatever follows; at the
   * natural end of a fade the jump is already about zero.
   */
  finishStopped() {
    this.discontinuity(this.lastOut, 0)
    const id = this.id
    const token = this.token
    const played = this.playedSrc()
    const report = this.report
    this.lastId = id
    this.lastToken = token
    this.lastPlayed = played
    this.publish(id, played, false)
    this.port.postMessage({ type: "stopped", id, token, playedSamples: played, report })
    this.postStats()
    this.reset()
  }

  finishFinished() {
    const id = this.id
    const token = this.token
    const played = this.receivedSrc // everything was handed to the device
    this.lastId = id
    this.lastToken = token
    this.lastPlayed = played
    this.publish(id, played, false)
    this.port.postMessage({ type: "finished", id, token, playedSamples: played })
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
    const wall = this.now()
    // A step backwards (only a wall clock can do that) is never a gap.
    if (this.lastRenderAt >= 0 && wall >= this.lastRenderAt && wall - this.lastRenderAt > GAP_MS) this.silenced()
    this.lastRenderAt = wall
    const n = out.length
    let i = 0
    /** Samples written from the start of the quantum (content, or a held sample under the fade). */
    let written = 0
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
      if (i > 0) {
        if (this.playedOut < this.fadeLen) {
          // The first 4 ms of a reply ramp up from zero: the resampler starts from silent history, so
          // audio that begins above silence would start with a steep (band-limited) step.
          for (let k = 0; k < i && this.playedOut + k < this.fadeLen; k++) {
            out[k] = /** @type {number} */ (out[k]) * ((this.playedOut + k) / this.fadeLen)
          }
        }
        this.lastRaw = /** @type {number} */ (out[i - 1])
      }
      if (this.state === "fading" && i < limit) {
        // The queue ran dry under the fade: hold the last sample and let the ramp take it to zero,
        // instead of dropping to zero here (a click). The held samples are not reply content and
        // are not counted as played.
        out.fill(this.lastRaw, i, limit)
        written = limit
      }
      if (i > 0 && this.boundary) {
        // Content starts (a new reply, a refill after an underrun, or resuming after silence) where the
        // output was something else. Bridge to the sample as it will be heard: under a fade, faded.
        const gain = this.state === "fading" ? this.fade / this.fadeLen : 1
        this.discontinuity(this.lastOut, /** @type {number} */ (out[0]) * gain)
      } else if (i === 0 && this.lastWasContent) {
        this.discontinuity(this.lastOut, 0)
      }
      if (i > 0) {
        this.boundary = false
        this.afterGap = false
      }
      if (i > 0 && !this.startedSent && this.state === "playing") {
        this.startedSent = true
        const delay = this.firstFrameAt < 0 ? 0 : Math.max(0, (currentTime - this.firstFrameAt) * 1000)
        this.port.postMessage({ type: "started", id: this.id, token: this.token, startDelayMs: delay })
      }
      this.playedOut += i
      if (i > 0) this.publish(this.id, this.playedSrc(), true, n)
    } else if (this.lastWasContent) {
      // Content was cut off between quanta (a new reply replaced it): silence starts here.
      this.discontinuity(this.lastOut, 0)
    }
    written = Math.max(written, i)
    if (written < n) out.fill(0, written)

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
      this.port.postMessage({ type: "progress", id: this.id, token: this.token, playedSamples: this.playedSrc(), underruns: this.underruns })
    }

    if (this.state === "playing" && i < n) {
      if (this.ended) {
        this.finishFinished()
      } else {
        this.state = "buffering"
        this.underruns++
        this.boundary = true
        this.threshold = Math.min(this.maxRefill, this.refill * 2 ** (this.underruns - 1))
        this.port.postMessage({ type: "underrun", id: this.id, token: this.token, underruns: this.underruns })
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
