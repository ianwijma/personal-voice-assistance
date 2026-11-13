import type { PlayerEvent } from "./audio/VoiceAudio.ts"

/**
 * The echo test (docs/UI-AND-MODULES.md §5): play 3 s of a speech-like signal
 * through the normal player and compare the microphone level during playback
 * with 1 s of silence before it. Within 6 dB of the silence: the browser
 * cancels the assistant's voice.
 */

/** A chirp train with a syllable envelope: 4 bursts per second sweeping 250–1100 Hz, with two harmonics. */
export const echoSignal = (rate = 24_000, seconds = 3): Int16Array => {
  const n = Math.round(rate * seconds)
  const out = new Int16Array(n)
  const burst = 0.18
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const inBurst = t % 0.25
    if (inBurst > burst) continue
    const u = inBurst / burst
    const freq = 250 + 850 * u
    phase += (2 * Math.PI * freq) / rate
    const env = Math.sin(Math.PI * u) ** 2
    const s = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)
    out[i] = Math.round(9000 * env * s)
  }
  return out
}

export interface EchoTestDeps {
  readonly play: (pcm: Int16Array, sampleRate: number) => void
  readonly micRms: () => number
  readonly onPlayer: (listener: (e: PlayerEvent) => void) => void
  readonly sleep?: (ms: number) => Promise<void>
}

export const ECHO_THRESHOLD_DB = 6

const meanSquare = (xs: ReadonlyArray<number>) => xs.reduce((s, x) => s + x * x, 0) / Math.max(1, xs.length)

export const runEchoTest = async (deps: EchoTestDeps): Promise<{ cancelled: boolean; residualDb: number }> => {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const sample = async (ms: number, until?: () => boolean) => {
    const values: Array<number> = []
    const end = performance.now() + ms
    while (performance.now() < end && !(until?.() ?? false)) {
      values.push(deps.micRms())
      await sleep(20)
    }
    return values
  }
  const silence = await sample(1000)
  let done = false
  deps.onPlayer((e) => {
    if (e.type === "finished" || e.type === "stopped") done = true
  })
  deps.play(echoSignal(), 24_000)
  const during = await sample(4000, () => done)
  const floor = Math.max(meanSquare(silence), 1e-10)
  const residualDb = 10 * Math.log10(Math.max(meanSquare(during), 1e-10) / floor)
  return { cancelled: residualDb < ECHO_THRESHOLD_DB, residualDb: Math.round(residualDb * 10) / 10 }
}
