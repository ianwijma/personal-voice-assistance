// @ts-check
import { StreamResampler } from "./resampler.js"

/**
 * Microphone capture: mixes to mono, resamples the context rate to 16 kHz,
 * cuts 20 ms frames (320 samples) and converts them to s16le.
 *
 * Each frame is posted to the main thread as an ArrayBuffer of
 * `HEADER_BYTES + 640` bytes with the PCM after an empty 8-byte header, and
 * transferred (no copy): the main thread fills in the header
 * (`writeFrameHeader`) and calls `ws.send(buffer)` as is.
 *
 * Messages in: `{ type: "mute", value: boolean }` (muted: no frames are posted).
 * Messages out: the frame buffers.
 */
export const HEADER_BYTES = 8

export class CaptureProcessor extends AudioWorkletProcessor {
  /** @param {{ processorOptions?: { targetRate?: number, frameSamples?: number } }} [options] */
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    const targetRate = opts.targetRate ?? 16000
    this.targetRate = targetRate
    /** Samples per frame. */
    this.frame = opts.frameSamples ?? Math.round(targetRate * 0.02)
    this.bypass = sampleRate === targetRate
    this.rs = this.bypass ? null : new StreamResampler(sampleRate, targetRate, 128)
    this.tmp = new Float32Array(this.rs ? this.rs.maxOutput(128) : 128)
    this.mono = new Float32Array(128)
    this.newFrame()
    this.muted = false
    this.port.onmessage = (/** @type {MessageEvent} */ e) => {
      const m = e.data
      if (m && m.type === "mute") {
        const muted = !!m.value
        // Unmuting starts from silence: no stale resampler history from before the mute.
        if (muted !== this.muted && !muted && this.rs) this.rs = new StreamResampler(sampleRate, this.targetRate, 128)
        this.muted = muted
        this.n = 0 // a frame is never half old audio, half new
      }
    }
  }

  newFrame() {
    this.buffer = new ArrayBuffer(HEADER_BYTES + this.frame * 2)
    this.pcm = new Int16Array(this.buffer, HEADER_BYTES, this.frame)
    this.n = 0
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean}
   */
  process(inputs) {
    const input = inputs[0]
    if (this.muted || !input || input.length === 0) return true
    let ch = /** @type {Float32Array} */ (input[0])
    if (input.length > 1) {
      if (this.mono.length < ch.length) this.mono = new Float32Array(ch.length)
      for (let i = 0; i < ch.length; i++) {
        let s = 0
        for (let c = 0; c < input.length; c++) s += /** @type {Float32Array} */ (input[c])[i] ?? 0
        this.mono[i] = s / input.length
      }
      ch = this.mono.subarray(0, ch.length)
    }
    let src = ch
    let m = ch.length
    if (this.rs) {
      if (this.tmp.length < this.rs.maxOutput(ch.length)) this.tmp = new Float32Array(this.rs.maxOutput(ch.length))
      m = this.rs.process(ch, this.tmp)
      src = this.tmp
    }
    for (let i = 0; i < m; i++) {
      let s = /** @type {number} */ (src[i])
      s = s > 1 ? 1 : s < -1 ? -1 : s
      const pcm = /** @type {Int16Array} */ (this.pcm)
      pcm[this.n++] = Math.round(s < 0 ? s * 32768 : s * 32767)
      if (this.n === this.frame) {
        const buffer = /** @type {ArrayBuffer} */ (this.buffer)
        this.port.postMessage(buffer, [buffer])
        this.newFrame()
      }
    }
    return true
  }
}

if (typeof registerProcessor === "function") registerProcessor("pva-capture", CaptureProcessor)
