/**
 * The wake cue (docs/FRONTENDS-AND-ACTIVATION.md §5): two short soft tones, rising, under 200 ms, generated (no
 * asset file). Played through the player like a reply, so it follows the chosen speaker and output path.
 */
export const CUE_RATE = 24_000

const TONES: ReadonlyArray<{ readonly hz: number; readonly ms: number }> = [
  { hz: 660, ms: 70 },
  { hz: 990, ms: 90 }
]
/** Silence between the two tones. */
const GAP_MS = 20
/** Peak amplitude: soft, well below a reply's level. */
const PEAK = 0.18
/** Raised-cosine fade in and out of each tone, so neither edge clicks. */
const FADE_MS = 12

export const CUE_MS = TONES.reduce((n, t) => n + t.ms, 0) + GAP_MS

export const wakeCue = (rate = CUE_RATE): Int16Array => {
  const total = Math.round((CUE_MS * rate) / 1000)
  const out = new Int16Array(total)
  let offset = 0
  TONES.forEach((tone, i) => {
    const n = Math.round((tone.ms * rate) / 1000)
    const fade = Math.round((FADE_MS * rate) / 1000)
    for (let k = 0; k < n && offset + k < total; k++) {
      const edge = Math.min(k, n - 1 - k)
      const env = edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade)
      // A little of the octave makes it rounder than a bare sine.
      const s = Math.sin((2 * Math.PI * tone.hz * k) / rate) + 0.25 * Math.sin((4 * Math.PI * tone.hz * k) / rate)
      out[offset + k] = Math.round((PEAK / 1.25) * env * s * 32767)
    }
    offset += n + (i === 0 ? Math.round((GAP_MS * rate) / 1000) : 0)
  })
  return out
}
