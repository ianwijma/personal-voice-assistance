/**
 * Streaming sample-rate converter for PCM s16le mono, on typed arrays.
 *
 * Linear interpolation between neighbouring samples, with the position and the
 * last sample carried across chunks so chunk boundaries are seamless. When
 * downsampling, each input sample is first averaged with its predecessor (a
 * two-tap low-pass) to reduce aliasing. Cheap (a few operations per sample) and
 * good enough for speech; not meant for music-grade conversion.
 *
 * Returns a function to call on each chunk in order; it may return an empty
 * chunk. The very last input sample of a stream is not emitted (< 0.1 ms).
 */
export const makeResampler = (from: number, to: number): (chunk: Uint8Array) => Uint8Array => {
  if (from === to) return (chunk) => chunk
  const step = from / to
  const smooth = from > to
  let prev: number | undefined // last (filtered) input sample of the previous chunk
  let prevRaw = 0
  let t = 0 // position of the next output sample, in input samples, relative to `prev`
  let carry: number | undefined // odd trailing byte of the previous chunk

  return (chunk) => {
    let bytes = chunk
    if (carry !== undefined) {
      bytes = new Uint8Array(chunk.length + 1)
      bytes[0] = carry
      bytes.set(chunk, 1)
      carry = undefined
    }
    if (bytes.length % 2 === 1) {
      carry = bytes[bytes.length - 1]
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    const view = bytes.byteOffset % 2 === 0
      ? new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
      : new Int16Array(bytes.slice().buffer)
    // Virtual input: [prev, ...samples] (prev absent on the first chunk).
    const head = prev === undefined ? 0 : 1
    const n = view.length + head
    const input = new Float64Array(n)
    if (head === 1) input[0] = prev!
    for (let i = 0; i < view.length; i++) {
      const s = view[i]!
      input[i + head] = smooth ? (s + prevRaw) / 2 : s
      prevRaw = s
    }
    if (n < 2) {
      if (n === 1) prev = input[0]
      return new Uint8Array(0)
    }
    const count = Math.max(0, Math.ceil((n - 1 - t) / step))
    const out = new Int16Array(count)
    let k = 0
    for (; k < count; k++) {
      const i = Math.floor(t)
      if (i + 1 >= n) break
      const f = t - i
      const v = input[i]! + (input[i + 1]! - input[i]!) * f
      out[k] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v)
      t += step
    }
    prev = input[n - 1]
    t -= n - 1
    return new Uint8Array(out.buffer, 0, k * 2)
  }
}
