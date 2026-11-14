/**
 * Sounds the node makes itself (docs/VOICE-NODES.md §4.4): cues and test tones, generated, no assets.
 * All are s16le mono at `TONE_RATE`, played through the same output as replies, at the profile's volume.
 */

export const TONE_RATE = 24_000

interface Tone {
  readonly hz: number
  readonly ms: number
}

/** −20 dBFS peak. */
const CUE_PEAK = 0.1
/** Raised-cosine fade at both edges of every tone, so nothing clicks. */
const FADE_MS = 12
const GAP_MS = 20

/** A run of tones with `GAP_MS` between them, raised-cosine edges, a little octave for roundness (as the web cue). */
export const toneSequence = (tones: ReadonlyArray<Tone>, peak: number, rate = TONE_RATE, octave = 0.25): Int16Array => {
  const gap = Math.round((GAP_MS * rate) / 1000)
  const lengths = tones.map((t) => Math.round((t.ms * rate) / 1000))
  const out = new Int16Array(lengths.reduce((n, l) => n + l, 0) + gap * Math.max(0, tones.length - 1))
  const fade = Math.round((FADE_MS * rate) / 1000)
  let offset = 0
  tones.forEach((tone, i) => {
    const n = lengths[i]!
    for (let k = 0; k < n; k++) {
      const edge = Math.min(k, n - 1 - k)
      const env = edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade)
      const s = Math.sin((2 * Math.PI * tone.hz * k) / rate) + octave * Math.sin((4 * Math.PI * tone.hz * k) / rate)
      out[offset + k] = Math.round((peak / (1 + octave)) * env * s * 32767)
    }
    offset += n + gap
  })
  return out
}

/** Wake cue: 660 → 990 Hz, about 180 ms (`wake { armed: true }`). */
export const wakeCue = (rate = TONE_RATE) => toneSequence([{ hz: 660, ms: 70 }, { hz: 990, ms: 90 }], CUE_PEAK, rate)

/** Lapse cue: 990 → 660 Hz (the armed window closed with nothing said). */
export const lapseCue = (rate = TONE_RATE) => toneSequence([{ hz: 990, ms: 70 }, { hz: 660, ms: 90 }], CUE_PEAK, rate)

/** Identify: three rising tones, about 1.2 s (WP-10's `node.command identify`; also `test-tone --identify`). */
export const identifySound = (rate = TONE_RATE) =>
  toneSequence([{ hz: 523, ms: 380 }, { hz: 659, ms: 380 }, { hz: 784, ms: 400 }], CUE_PEAK, rate)

/** Test tone: a pure 1 kHz sine at −20 dBFS (`test-tone`, WP-10's `test-speaker`). */
export const testTone = (durationMs = 1000, rate = TONE_RATE) => toneSequence([{ hz: 1000, ms: durationMs }], CUE_PEAK, rate, 0)

export const asBytes = (samples: Int16Array): Uint8Array => new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
