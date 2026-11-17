/**
 * Both voices' `VoiceFeatures` for the host, once per animation frame (docs/CHARACTERS.md §2.2).
 *
 * - The owner tab has audio: the person from the microphone's ring buffer (`levels.ts`), the assistant from the
 *   player's analyser. Each side runs its own `FeatureExtractor`; only the side that is "on" gets audio (the
 *   person while listening or hearing, the assistant while speaking), the other is fed silence so its features
 *   decay naturally, exactly as in the lab.
 * - An observer tab (another tab owns the audio) has no audio: `StandIn` writes plausible features from smooth
 *   pseudo-noise so characters still move. Its loudness is chosen so the baseline's formulas give the same levels
 *   the pre-character visualiser used for observers (docs/UI-AND-MODULES.md §3.3).
 *
 * Nothing here allocates per frame.
 */
import { BAND_COUNT, type CoreMode, type VoiceFeatures, WAVE_SIZE } from "./contract.ts"
import { createVoiceFeatures, FeatureExtractor } from "./features.ts"

/** Which side gets audio in a mode: the person while the microphone matters, the assistant while it speaks. */
export const userOn = (m: CoreMode): boolean => m === "listening" || m === "hearing"
export const agentOn = (m: CoreMode): boolean => m === "speaking"

/** Seconds of audio each extractor call analyses. */
const WINDOW_S = 0.04

/** One voice through the extractor: a window buffer sized for its sample rate, and silence when it is off. */
export class LiveVoice {
  private extractor: FeatureExtractor = new FeatureExtractor(16000)
  private buf: Float32Array = new Float32Array(Math.round(WINDOW_S * 16000))

  get features(): VoiceFeatures {
    return this.extractor.features
  }

  /** The buffer to fill with the latest 40 ms at `rate` (right-aligned, zeros where there is nothing). */
  window(rate: number): Float32Array {
    if (this.extractor.sampleRate !== rate && rate >= 4000) {
      this.extractor = new FeatureExtractor(rate)
      this.buf = new Float32Array(Math.round(WINDOW_S * rate))
    }
    return this.buf
  }

  /** Analyse the window (`hasAudio`: it was filled this frame) or silence, and advance by `dt`. */
  step(dt: number, hasAudio: boolean): VoiceFeatures {
    if (!hasAudio) this.buf.fill(0)
    return this.extractor.process(this.buf, dt)
  }
}

/** Smooth pseudo-noise in about [-1, 1] (the pre-character visualiser's observer stand-in). */
export const noise = (t: number): number => 0.5 * Math.sin(1.7 * t) + 0.3 * Math.sin(2.9 * t + 1.3) + 0.2 * Math.sin(5.3 * t + 0.4)

export type StandInKind = "silent" | "room" | "voice"

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const approach = (c: number, t: number, dt: number, tau: number): number => c + (t - c) * (1 - Math.exp(-dt / tau))
const ar = (c: number, t: number, dt: number): number => approach(c, t, dt, t > c ? 0.03 : 0.15)
/** The extractor's loudness scale: −50 dBFS is 0, −5 dBFS is 1. */
const levelOf = (rms: number): number => clamp01((20 * Math.log10(rms + 1e-9) + 50) / 45)

/**
 * Stand-in features for a tab without audio. `kind`: "voice" (someone is talking: smooth loudness, voiced,
 * about four syllables a second), "room" (the microphone is open in a quiet room), "silent" (decays to silence).
 * `loudness(t)` is the 0..1 level target for "voice"; `rms = loudness² / k` so `√(rms·k)` gives it back.
 */
export class StandIn {
  readonly features: VoiceFeatures = createVoiceFeatures()
  private syllable = 0
  private clock = 0
  private readonly basePitch: number
  private readonly k: number
  private readonly loudness: (t: number) => number

  constructor(opts: { readonly pitch: number; readonly k: number; readonly loudness: (t: number) => number }) {
    this.basePitch = opts.pitch
    this.k = opts.k
    this.loudness = opts.loudness
    this.features.register = opts.pitch
    this.features.pitch = opts.pitch
  }

  step(kind: StandInKind, t: number, dt: number): VoiceFeatures {
    const f = this.features
    dt = dt > 0 ? Math.min(dt, 0.25) : 1 / 60
    this.clock += dt
    const talking = kind === "voice"
    const L = talking ? clamp01(this.loudness(t)) : 0
    const rms = talking ? (L * L) / this.k : kind === "room" ? 0.0075 : 0
    f.rms = rms
    f.level = ar(f.level, levelOf(rms) * (rms > 0 ? 1 : 0), dt)
    if (f.level < 0.02 && rms === 0) f.level = 0
    const was = f.speaking
    f.speaking = talking
    if (talking) {
      f.speechFor = was ? f.speechFor + dt : 0
      f.silenceFor = 0
    } else {
      f.silenceFor = was ? 0 : f.silenceFor + dt
      f.speechFor = 0
    }
    // Voice: pitch wanders around the register; about four syllables a second.
    const p = this.basePitch + 0.08 * noise(0.7 * t + 2)
    const prevPitch = f.pitch
    f.pitch = talking ? clamp01(p) : f.pitch
    f.pitchHz = talking ? Math.exp(Math.log(70) + f.pitch * (Math.log(400) - Math.log(70))) : 0
    f.pitchDelta = approach(f.pitchDelta, talking ? ((f.pitch - prevPitch) * 12 * Math.log2(400 / 70)) / dt : 0, dt, 0.2)
    f.voicing = ar(f.voicing, talking ? 0.75 : 0, dt)
    const lvl = f.level
    // Equal low / mid / high, as the old visualiser's observer weights were (a third each).
    f.low = ar(f.low, lvl * 0.9, dt)
    f.mid = f.low
    f.high = f.low
    for (let b = 0; b < BAND_COUNT; b++) f.bands[b] = ar(f.bands[b]!, clamp01(lvl * 1.3 * (1 - (0.6 * b) / BAND_COUNT)), dt)
    f.brightness = ar(f.brightness, talking ? 0.4 + 0.1 * noise(1.1 * t) : 0, dt)
    f.sibilance = ar(f.sibilance, talking ? 0.05 : 0, dt)
    f.onset *= Math.exp(-dt / 0.05)
    if (f.onset < 1e-3) f.onset = 0
    if (talking) {
      this.syllable += dt * 4 * (1 + 0.2 * noise(0.9 * t))
      if (this.syllable >= 1) {
        this.syllable -= 1
        f.onset = 1
      }
    }
    f.syllableRate = approach(f.syllableRate, talking ? 4 : 0, dt, 0.25)
    const shape = Math.abs(Math.sin(Math.PI * this.syllable))
    f.mouth.open = ar(f.mouth.open, talking ? clamp01(lvl * 1.2 * (0.4 + 0.6 * shape)) : 0, dt)
    f.mouth.wide = ar(f.mouth.wide, talking ? 0.3 * lvl : 0, dt)
    f.mouth.round = ar(f.mouth.round, talking ? 0.2 * lvl : 0, dt)
    const amp = Math.SQRT2 * rms
    const w = (2 * Math.PI * (f.pitchHz > 0 ? f.pitchHz : 120)) / 16000
    for (let i = 0; i < WAVE_SIZE; i++) f.wave[i] = amp * Math.sin(w * i + this.clock * 40)
    return f
  }
}

/** The observer's person: the old visualiser's hearing level, 0.3 + 0.15·noise(1.3 t), through √(rms·9). */
export const standInUser = (): StandIn => new StandIn({ pitch: 0.42, k: 9, loudness: (t) => 0.3 + 0.15 * noise(t * 1.3) })
/** The observer's assistant: 0.35 + 0.15·noise(t), through √(rms·5). */
export const standInAgent = (): StandIn => new StandIn({ pitch: 0.36, k: 5, loudness: (t) => 0.35 + 0.15 * noise(t) })
