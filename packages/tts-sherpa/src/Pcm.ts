/**
 * Clause joins and PCM conversion, on typed arrays.
 *
 * Every clause is synthesised on its own and comes with its own leading and
 * trailing silence (Piper: up to ~70 ms before, 76–186 ms after). Played back
 * to back that gives uneven, often long pauses. So each clause is trimmed to
 * its speech plus a short pad, and a controlled pause is put in front of every
 * clause but the first: the total silence at a join is `sentencePauseMs` after
 * `. ! ?` and `clausePauseMs` after anything else (`, ; :`). Trimming the first
 * clause's leading silence also makes the first audible sound come sooner.
 */

export interface JoinOptions {
  /** Trim leading/trailing silence and insert controlled pauses. Default true. */
  readonly trim: boolean
  /** Absolute float amplitude below which a sample counts as silence. Default 0.01 (−40 dBFS). */
  readonly threshold: number
  /** Silence kept next to speech at each cut, so soft onsets and endings survive. Default 20 ms. */
  readonly padMs: number
  /** Linear fade over the outer part of the pad, so cuts never click. Default 5 ms (at most `padMs`). */
  readonly fadeMs: number
  /** Total silence between two clauses when the first ends in `, ; :` or nothing. Default 150 ms. */
  readonly clausePauseMs: number
  /** Total silence between two clauses when the first ends a sentence (`. ! ?`). Default 300 ms. */
  readonly sentencePauseMs: number
  /** Size of the emitted audio chunks. Default 40 ms. */
  readonly chunkMs: number
}

export const defaultJoinOptions: JoinOptions = {
  trim: true,
  threshold: 0.01,
  padMs: 20,
  fadeMs: 5,
  clausePauseMs: 150,
  sentencePauseMs: 300,
  chunkMs: 40
}

const ms = (sampleRate: number, millis: number) => Math.max(0, Math.round((sampleRate * millis) / 1000))

/** Float samples in [-1, 1] → s16 into `out` at `offset`, clamped. */
export const floatToS16 = (samples: Float32Array, out: Int16Array = new Int16Array(samples.length), offset = 0) => {
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! * 32767
    out[offset + i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v)
  }
  return out
}

/** Splits s16 PCM into byte views of at most `size` samples (no copy). */
export const chunkPcm = (pcm: Int16Array, size: number): Array<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  for (let i = 0; i < pcm.length; i += size) {
    const n = Math.min(size, pcm.length - i)
    chunks.push(new Uint8Array(pcm.buffer, pcm.byteOffset + i * 2, n * 2))
  }
  return chunks
}

const endsSentence = (text: string) => /[.!?…]["')\]]*\s*$/.test(text)

/**
 * Stateful per-turn joiner: feed it each clause's samples in order, get back
 * the s16le chunks to emit for that clause (pause first, then speech).
 */
export const makeJoiner = (sampleRate: number, options: JoinOptions = defaultJoinOptions) => {
  const pad = ms(sampleRate, options.padMs)
  const fade = Math.min(ms(sampleRate, options.fadeMs), pad)
  const chunk = Math.max(1, ms(sampleRate, options.chunkMs))
  let previous: { readonly text: string; readonly trailing: number } | undefined

  return (samples: Float32Array, text: string): Array<Uint8Array> => {
    if (!options.trim) return chunkPcm(floatToS16(samples), chunk)
    const t = options.threshold
    let first = 0
    while (first < samples.length && Math.abs(samples[first]!) < t) first++
    if (first === samples.length) return [] // nothing audible
    let last = samples.length - 1
    while (last > first && Math.abs(samples[last]!) < t) last--
    const start = Math.max(0, first - pad)
    const end = Math.min(samples.length, last + 1 + pad)
    const leading = first - start
    const trailing = end - (last + 1)

    let gap = 0
    if (previous !== undefined) {
      const pause = endsSentence(previous.text) ? options.sentencePauseMs : options.clausePauseMs
      gap = Math.max(0, ms(sampleRate, pause) - previous.trailing - leading)
    }
    previous = { text, trailing }

    const out = new Int16Array(gap + end - start) // the gap is the zeros at the front
    floatToS16(samples.subarray(start, end), out, gap)
    // Fade the outer edges of the pads (only where we actually cut).
    const fadeIn = start > 0 ? Math.min(fade, leading) : 0
    for (let i = 0; i < fadeIn; i++) out[gap + i] = Math.round(out[gap + i]! * (i / fadeIn))
    const fadeOut = end < samples.length ? Math.min(fade, trailing) : 0
    for (let i = 0; i < fadeOut; i++) {
      const j = out.length - 1 - i
      out[j] = Math.round(out[j]! * (i / fadeOut))
    }
    return chunkPcm(out, chunk)
  }
}

/** Silent stretches (|x| < threshold for at least `minMs`) in s16 PCM, in ms. For measurements and tests. */
export const silentRuns = (
  pcm: Int16Array,
  sampleRate: number,
  threshold = defaultJoinOptions.threshold,
  minMs = 30
): Array<{ readonly atMs: number; readonly ms: number }> => {
  const limit = threshold * 32767
  const runs: Array<{ atMs: number; ms: number }> = []
  let runStart = -1
  for (let i = 0; i <= pcm.length; i++) {
    const quiet = i < pcm.length && Math.abs(pcm[i]!) < limit
    if (quiet && runStart < 0) runStart = i
    else if (!quiet && runStart >= 0) {
      const len = ((i - runStart) * 1000) / sampleRate
      if (len >= minMs) runs.push({ atMs: (runStart * 1000) / sampleRate, ms: len })
      runStart = -1
    }
  }
  return runs
}

/** s16le PCM → a WAV file's bytes. */
export const wav = (pcm: Uint8Array, sampleRate: number): Uint8Array => {
  const out = new Uint8Array(44 + pcm.length)
  const view = new DataView(out.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + pcm.length, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}
