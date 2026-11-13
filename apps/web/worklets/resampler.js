// @ts-check
/**
 * Streaming windowed-sinc resampler (Blackman window), arbitrary ratio, with
 * its state carried across calls so chunk boundaries are seamless.
 *
 * Shared by both worklets. `scripts/build-worklets.mjs` inlines this file into
 * `public/worklets/{capture,player}.js` (worklet modules cannot import app code).
 *
 * Based on docs/research/browser-audio.md §1.3, verified by test/worklets/resampler.test.ts.
 * Changes from the research draft: `flush()` (emit the look-ahead tail at the end
 * of a stream) and `maxOutput()` (size output buffers safely).
 */
export class StreamResampler {
  /**
   * @param {number} inRate input sample rate
   * @param {number} outRate output sample rate
   * @param {number} [maxIn] largest input block processed at once (longer inputs are split)
   * @param {number} [taps] zero crossings on each side of the kernel centre
   */
  constructor(inRate, outRate, maxIn = 8192, taps = 12) {
    /** Input samples per output sample. */
    this.step = inRate / outRate
    const cutoff = Math.min(1, outRate / inRate) * 0.94 // relative to the input Nyquist frequency
    /** Kernel half width, in input samples. */
    this.W = taps / cutoff
    this.OS = 128 // table oversampling
    const n = Math.ceil(this.W * this.OS) + 2
    this.tab = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = i / this.OS
      if (x >= this.W) {
        this.tab[i] = 0
        continue
      }
      const px = Math.PI * cutoff * x
      const sinc = x === 0 ? 1 : Math.sin(px) / px
      const a = (Math.PI * x) / this.W
      const win = 0.42 + 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a)
      this.tab[i] = cutoff * sinc * win
    }
    this.maxIn = maxIn
    this.buf = new Float32Array(Math.ceil(this.W) * 2 + maxIn + 8)
    this.len = Math.ceil(this.W) // leading zeros (history)
    this.t = this.len // position of the next output sample's centre, in input samples
    this.zeros = new Float32Array(Math.ceil(this.W) + 2)
    this.inCount = 0
    this.outCount = 0
  }

  /**
   * Upper bound on the output count for `inputLength` input samples.
   * @param {number} inputLength
   */
  maxOutput(inputLength) {
    return Math.ceil((inputLength + this.W * 2 + 2) / this.step) + 2
  }

  /**
   * Resample `input` and write the result to `out` (which must hold `maxOutput(input.length)`).
   * @param {Float32Array} input
   * @param {Float32Array} out
   * @returns {number} output samples written
   */
  process(input, out) {
    let produced = 0
    for (let off = 0; off < input.length; off += this.maxIn) {
      const n = Math.min(this.maxIn, input.length - off)
      this.buf.set(input.subarray(off, off + n), this.len)
      this.len += n
      const W = this.W
      const OS = this.OS
      const tab = this.tab
      const buf = this.buf
      while (this.t + W < this.len) {
        const t = this.t
        const lo = Math.ceil(t - W)
        const hi = Math.floor(t + W)
        let acc = 0
        for (let k = lo; k <= hi; k++) {
          const x = Math.abs(k - t) * OS
          const i = x | 0
          const f = x - i
          const a = /** @type {number} */ (tab[i])
          const b = /** @type {number} */ (tab[i + 1])
          acc += /** @type {number} */ (buf[k]) * (a + (b - a) * f)
        }
        out[produced++] = acc
        this.t += this.step
      }
      const keep = Math.max(0, Math.ceil(this.t - W))
      this.buf.copyWithin(0, keep, this.len)
      this.len -= keep
      this.t -= keep
    }
    this.inCount += input.length
    this.outCount += produced
    return produced
  }

  /**
   * End of stream: emit the samples still held back by the kernel's look-ahead
   * (about W input samples) by feeding silence, up to the output sample that
   * corresponds to the last input sample, so a whole stream of n input samples
   * yields ceil(n / step) outputs. Do not use the resampler after this.
   * @param {Float32Array} out must hold `maxOutput(0)`
   * @returns {number} output samples written
   */
  flush(out) {
    const before = this.outCount
    const inputs = this.inCount
    const produced = this.process(this.zeros, out)
    const allowed = Math.max(0, Math.ceil(inputs / this.step - 1e-9) - before)
    const n = Math.min(produced, allowed)
    this.outCount = before + n
    return n
  }
}
