import { CUE_RATE } from "./cue.ts"

/**
 * The ring cue (docs/NOTIFICATIONS.md "The voice page"): three soft tones, rising, about 600 ms, generated (no asset
 * file, nothing fetched), played through the player like the wake cue, every `RING_EVERY_MS` while a card that is not
 * silent is shown. P10 draws the card on its stage later; the loop stays here.
 */
export const RING_EVERY_MS = 2_500

const TONES: ReadonlyArray<{ readonly hz: number; readonly ms: number }> = [
  { hz: 784, ms: 150 },
  { hz: 988, ms: 150 },
  { hz: 1175, ms: 220 }
]
const GAP_MS = 40
const PEAK = 0.2
const FADE_MS = 12

export const RING_CUE_MS = TONES.reduce((n, t) => n + t.ms, 0) + GAP_MS * (TONES.length - 1)

export const ringCue = (rate = CUE_RATE): Int16Array => {
  const total = Math.round((RING_CUE_MS * rate) / 1000)
  const out = new Int16Array(total)
  let offset = 0
  TONES.forEach((tone, i) => {
    const n = Math.round((tone.ms * rate) / 1000)
    const fade = Math.round((FADE_MS * rate) / 1000)
    for (let k = 0; k < n && offset + k < total; k++) {
      const edge = Math.min(k, n - 1 - k)
      const env = edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade)
      const x = Math.sin((2 * Math.PI * tone.hz * k) / rate) + 0.2 * Math.sin((4 * Math.PI * tone.hz * k) / rate)
      out[offset + k] = Math.round((PEAK / 1.2) * env * x * 32767)
    }
    offset += n + (i < TONES.length - 1 ? Math.round((GAP_MS * rate) / 1000) : 0)
  })
  return out
}

export interface RingLoopDeps {
  /** A card that is not silent and was not pressed here is shown. */
  readonly wanted: () => boolean
  /**
   * The page may make the sound now: it owns the device's audio, the audio was started (the browser's permission and
   * the Start gesture) and runs, and no reply or echo test is playing. Not: the card shows, silently, and the next
   * beat after it may tries again.
   */
  readonly canPlay: () => boolean
  readonly play: () => void
  /** Silence the cue now (it was resolved, pressed, or is no longer wanted). */
  readonly silence: () => void
  readonly setInterval?: (f: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

/**
 * The loop: `update()` after every change of the page's state. It starts at once when a ringing card appears (playing
 * when it may), beats every `RING_EVERY_MS`, and stops (silencing the cue) as soon as nothing wants it: the card was
 * resolved, a button was pressed, or the server sent it again as silent (do not disturb). A reconnect empties the
 * cards at the welcome and the server sends them again: the loop stops and starts again with them.
 */
export const makeRingLoop = (deps: RingLoopDeps) => {
  const every = deps.setInterval ?? ((f, ms) => globalThis.setInterval(f, ms))
  const clear = deps.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>))
  let timer: unknown
  const beat = () => {
    if (!deps.wanted()) return stop()
    if (deps.canPlay()) deps.play()
  }
  const stop = () => {
    if (timer === undefined) return
    clear(timer)
    timer = undefined
    deps.silence()
  }
  return {
    update: () => {
      const wanted = deps.wanted()
      if (wanted && timer === undefined) {
        timer = every(beat, RING_EVERY_MS)
        if (deps.canPlay()) deps.play()
      } else if (!wanted) stop()
    },
    stop,
    running: () => timer !== undefined
  }
}
