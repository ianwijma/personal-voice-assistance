/**
 * Voice feature extractor (copied from the lab, docs/research/visualiser-investigation/lab/src/features.ts,
 * which stays as a frozen research snapshot): time-domain windows in, one `VoiceFeatures` out.
 *
 * Pure TypeScript, no DOM, no Web Audio, no dependencies, so the same class can
 * run on the microphone frames and on the reply player's output (the host, `host.ts`, does).
 * Call `process(window, dt)` once per animation frame with the latest ~40 ms of
 * samples and the seconds since the previous call. It updates and returns the
 * same `features` object every time (arrays included): copy what you keep.
 *
 * Pipeline per call (all buffers preallocated, nothing is allocated per call):
 *   resample the window to 16 kHz → RMS / level / voice activity
 *   → Hann + 1024-point FFT → log bands, low/mid/high, centroid, sibilance, formant regions
 *   → YIN pitch on an 8 kHz copy → voicing, pitch, intonation, register
 *   → energy-rise onsets → syllable rate → mouth estimate.
 */
import { BAND_COUNT, WAVE_SIZE, type VoiceFeatures } from "./contract.ts"

/** Analysis rate: every input is resampled to this. */
const RATE = 16000
/** Analysis window: 40 ms at 16 kHz. */
const WIN = 640
const NFFT = 1024
const HALF = NFFT / 2
const BIN_HZ = RATE / NFFT
/** Pitch analysis runs at RATE / 2. */
const P_RATE = RATE / 2
const P_LEN = WIN / 2
const F0_MIN = 70
const F0_MAX = 450
const LAG_MAX = Math.ceil(P_RATE / F0_MIN) // 115
const LAG_MIN = Math.floor(P_RATE / F0_MAX) // 17
const YIN_W = P_LEN - LAG_MAX - 1
const LOG_PITCH_LO = Math.log(70)
const LOG_PITCH_SPAN = Math.log(400) - LOG_PITCH_LO

/** Level: dBFS (RMS) → 0..1. −50 dB is silence, −45 a whisper (~0.1), −32 normal speech (~0.4), −16 shouting (~0.75). */
const LEVEL_FLOOR_DB = -50
const LEVEL_SPAN_DB = 45
/** Voice activity needs at least this level and this far above the tracked noise floor. */
const VAD_MIN_DB = -52
const VAD_ABOVE_FLOOR_DB = 8
const HANGOVER = 0.25

/** Spectrum display: dB per octave added above 500 Hz (speech falls off; this keeps high bands visible). */
const TILT_DB_PER_OCT = 4.5
const BAND_FLOOR_DB = -95
const BAND_SPAN_DB = 60
const RANGE_FLOOR_DB = -78
const RANGE_SPAN_DB = 55

const ATTACK = 0.03
const RELEASE = 0.15

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const dbOf = (power: number): number => 10 * Math.log10(power + 1e-12)

/** A fresh, silent `VoiceFeatures`. */
export const createVoiceFeatures = (): VoiceFeatures => ({
  level: 0,
  rms: 0,
  speaking: false,
  speechFor: 0,
  silenceFor: 0,
  voicing: 0,
  pitchHz: 0,
  pitch: 0.4,
  pitchDelta: 0,
  register: 0.4,
  bands: new Float32Array(BAND_COUNT),
  low: 0,
  mid: 0,
  high: 0,
  brightness: 0,
  sibilance: 0,
  onset: 0,
  syllableRate: 0,
  mouth: { open: 0, wide: 0, round: 0 },
  wave: new Float32Array(WAVE_SIZE)
})

/** Copy every field of `from` into `to` (arrays by value). */
export const copyVoiceFeatures = (to: VoiceFeatures, from: VoiceFeatures): void => {
  to.level = from.level
  to.rms = from.rms
  to.speaking = from.speaking
  to.speechFor = from.speechFor
  to.silenceFor = from.silenceFor
  to.voicing = from.voicing
  to.pitchHz = from.pitchHz
  to.pitch = from.pitch
  to.pitchDelta = from.pitchDelta
  to.register = from.register
  to.bands.set(from.bands)
  to.low = from.low
  to.mid = from.mid
  to.high = from.high
  to.brightness = from.brightness
  to.sibilance = from.sibilance
  to.onset = from.onset
  to.syllableRate = from.syllableRate
  to.mouth.open = from.mouth.open
  to.mouth.wide = from.mouth.wide
  to.mouth.round = from.mouth.round
  to.wave.set(from.wave)
}

/** One-pole smoothing toward `target` with a faster attack than release. */
const ar = (current: number, target: number, dt: number, attack = ATTACK, release = RELEASE): number =>
  current + (target - current) * (1 - Math.exp(-dt / (target > current ? attack : release)))

const lowpass = (current: number, target: number, dt: number, tau: number): number =>
  current + (target - current) * (1 - Math.exp(-dt / tau))

export class FeatureExtractor {
  readonly features: VoiceFeatures = createVoiceFeatures()
  readonly sampleRate: number

  // Work buffers.
  private readonly x16 = new Float32Array(WIN)
  private readonly x8 = new Float32Array(P_LEN)
  private readonly re = new Float32Array(NFFT)
  private readonly im = new Float32Array(NFFT)
  private readonly power = new Float32Array(HALF + 1)
  private readonly yin = new Float32Array(LAG_MAX + 2)
  private readonly hann = new Float32Array(WIN)
  private hannGain = 1
  private readonly cosT = new Float32Array(HALF)
  private readonly sinT = new Float32Array(HALF)
  private readonly rev = new Uint16Array(NFFT)
  private readonly bandLo = new Uint16Array(BAND_COUNT)
  private readonly bandHi = new Uint16Array(BAND_COUNT)
  private readonly bandTilt = new Float32Array(BAND_COUNT)

  // State.
  private hang = 0
  private noiseFloor = -70
  private lastSemitone = 0
  private hadPitch = false
  private voicedTime = 0
  private registerSeeded = false
  private fastDb = -100
  private slowDb = -100
  private armed = true
  private sinceOnset = 1
  private rateOnsets = 0
  private rateSpeech = 0
  private clock = 0

  constructor(sampleRate: number) {
    if (!(sampleRate >= 4000)) throw new Error(`FeatureExtractor: unsupported sample rate ${sampleRate}`)
    this.sampleRate = sampleRate
    let sum = 0
    for (let i = 0; i < WIN; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1))
      this.hann[i] = w
      sum += w
    }
    // A full-scale sine then reads as power 0.5 (its mean square), like the time-domain RMS².
    this.hannGain = 2 / (sum * sum)
    for (let i = 0; i < HALF; i++) {
      this.cosT[i] = Math.cos((2 * Math.PI * i) / NFFT)
      this.sinT[i] = -Math.sin((2 * Math.PI * i) / NFFT)
    }
    const bits = Math.log2(NFFT)
    for (let i = 0; i < NFFT; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    for (let b = 0; b < BAND_COUNT; b++) {
      const f0 = 80 * Math.pow(100, b / BAND_COUNT)
      const f1 = 80 * Math.pow(100, (b + 1) / BAND_COUNT)
      let lo = Math.ceil(f0 / BIN_HZ)
      let hi = Math.floor(f1 / BIN_HZ)
      if (hi < lo) lo = hi = Math.round(Math.sqrt(f0 * f1) / BIN_HZ)
      this.bandLo[b] = lo
      this.bandHi[b] = Math.min(HALF, hi)
      this.bandTilt[b] = Math.max(0, TILT_DB_PER_OCT * Math.log2(Math.sqrt(f0 * f1) / 500))
    }
  }

  /** Forget everything (a new speaker, a new source). */
  reset(): void {
    const f = this.features
    const fresh = createVoiceFeatures()
    copyVoiceFeatures(f, fresh)
    this.hang = 0
    this.noiseFloor = -70
    this.hadPitch = false
    this.voicedTime = 0
    this.registerSeeded = false
    this.fastDb = this.slowDb = -100
    this.armed = true
    this.sinceOnset = 1
    this.rateOnsets = 0
    this.rateSpeech = 0
    this.clock = 0
  }

  /**
   * Analyse the latest window (any length; the last 40 ms are used) and advance
   * the smoothed state by `dt` seconds. Returns `this.features`.
   */
  process(input: Float32Array, dt: number): VoiceFeatures {
    const f = this.features
    dt = dt > 0 ? Math.min(dt, 0.25) : 1 / 60
    this.clock += dt

    // 1. Raw RMS of the last 40 ms of the input, and a 16 kHz copy of it.
    const take = Math.min(input.length, Math.round(0.04 * this.sampleRate))
    let sq = 0
    for (let i = input.length - take; i < input.length; i++) {
      const s = input[i]!
      sq += s * s
    }
    const rms = take > 0 ? Math.sqrt(sq / take) : 0
    const n = this.resample(input)
    f.rms = Math.min(1, rms)
    const x = this.x16
    f.wave.set(x.subarray(WIN - WAVE_SIZE))

    // 2. Level and voice activity.
    const db = 20 * Math.log10(rms + 1e-9)
    const levelTarget = clamp01((db - LEVEL_FLOOR_DB) / LEVEL_SPAN_DB)
    f.level = ar(f.level, levelTarget, dt)
    if (f.level < 0.02 && levelTarget === 0) f.level = 0 // settle to exactly 0 in silence
    if (db < this.noiseFloor) this.noiseFloor = lowpass(this.noiseFloor, db, dt, 0.1)
    else this.noiseFloor += Math.min(db - this.noiseFloor, 2 * dt) // creeps up 2 dB/s under steady sound
    if (this.noiseFloor < -90) this.noiseFloor = -90
    const active = db > VAD_MIN_DB && db > Math.min(this.noiseFloor, -30) + VAD_ABOVE_FLOOR_DB
    if (active) this.hang = HANGOVER
    else this.hang -= dt
    const wasSpeaking = f.speaking
    f.speaking = this.hang > 0
    if (f.speaking) {
      f.speechFor = wasSpeaking ? f.speechFor + dt : 0
      f.silenceFor = 0
    } else {
      f.silenceFor = wasSpeaking ? 0 : f.silenceFor + dt
      f.speechFor = 0
    }

    // 3. Spectrum.
    const re = this.re
    const im = this.im
    const hann = this.hann
    const off = WIN - n
    for (let i = 0; i < WIN; i++) re[i] = i < off ? 0 : x[i]! * hann[i]!
    re.fill(0, WIN)
    im.fill(0)
    this.fft()
    const P = this.power
    const g = this.hannGain
    for (let k = 0; k <= HALF; k++) P[k] = (re[k]! * re[k]! + im[k]! * im[k]!) * g

    for (let b = 0; b < BAND_COUNT; b++) {
      const lo = this.bandLo[b]!
      const hi = this.bandHi[b]!
      let s = 0
      for (let k = lo; k <= hi; k++) s += P[k]!
      const v = clamp01((dbOf(s / (hi - lo + 1)) + this.bandTilt[b]! - BAND_FLOOR_DB) / BAND_SPAN_DB)
      f.bands[b] = ar(f.bands[b]!, v, dt)
    }

    // Ranges, centroid and formant regions in one pass over the bins.
    let pLow = 0
    let pMid = 0
    let pHigh = 0
    let pSib = 0
    let cNum = 0
    let cDen = 0
    let f1Num = 0
    let f1Den = 0
    let f2Num = 0
    let f2Den = 0
    const kLow = Math.round(80 / BIN_HZ)
    const kTop = HALF - 1
    for (let k = kLow; k <= kTop; k++) {
      const p = P[k]!
      const hz = k * BIN_HZ
      if (hz < 300) pLow += p
      else if (hz < 1500) pMid += p
      else pHigh += p
      if (hz >= 3500) pSib += p
      // Centroid on magnitude, log frequency, tilt-compensated (+6 dB/oct above 500 Hz).
      const m = Math.sqrt(p) * (hz > 500 ? hz / 500 : 1)
      cNum += m * Math.log2(hz)
      cDen += m
      if (hz >= 250 && hz < 1000) {
        f1Num += p * hz
        f1Den += p
      } else if (hz >= 900 && hz < 2800) {
        const w = p * (hz / 900) // compensate the falling slope a little
        f2Num += w * hz
        f2Den += w
      }
    }
    const total = pLow + pMid + pHigh
    const gate = clamp01((db - LEVEL_FLOOR_DB) / 6) // 0 in silence, 1 from 6 dB above it
    f.low = ar(f.low, gate * clamp01((dbOf(pLow) - RANGE_FLOOR_DB) / RANGE_SPAN_DB), dt)
    f.mid = ar(f.mid, gate * clamp01((dbOf(pMid) - RANGE_FLOOR_DB) / RANGE_SPAN_DB), dt)
    f.high = ar(f.high, gate * clamp01((dbOf(pHigh) + 8 - RANGE_FLOOR_DB) / RANGE_SPAN_DB), dt)
    const centroidHz = cDen > 0 ? Math.pow(2, cNum / cDen) : 0
    const bright = cDen > 0 ? clamp01(Math.log2(Math.max(1, centroidHz) / 400) / Math.log2(5000 / 400)) : 0
    f.brightness = ar(f.brightness, gate * bright, dt)

    // 4. Pitch (YIN) on an 8 kHz copy.
    const dmin = this.yinPitch()
    const yinLag = this.yinLag
    const periodic = clamp01((0.5 - dmin) / 0.35)
    const voicedNow = gate > 0.5 && yinLag > 0 && dmin < 0.22
    f.voicing = ar(f.voicing, gate * periodic, dt, 0.03, 0.1)
    const sibRatio = total > 0 ? pSib / total : 0
    f.sibilance = ar(f.sibilance, gate * clamp01(sibRatio * 2.2) * (1 - 0.9 * periodic), dt)

    if (voicedNow) {
      const hz = P_RATE / yinLag
      f.pitchHz = f.pitchHz > 0 ? lowpass(f.pitchHz, hz, dt, 0.02) : hz
      const p = clamp01((Math.log(f.pitchHz) - LOG_PITCH_LO) / LOG_PITCH_SPAN)
      f.pitch = this.hadPitch ? lowpass(f.pitch, p, dt, 0.03) : p
      const semi = 12 * Math.log2(f.pitchHz)
      const rate = this.hadPitch ? (semi - this.lastSemitone) / dt : 0
      f.pitchDelta = lowpass(f.pitchDelta, Math.max(-60, Math.min(60, rate)), dt, 0.2)
      this.lastSemitone = semi
      this.hadPitch = true
      // Register: a running median of `pitch` (sign-step tracker), fast at first, then over a few seconds.
      this.voicedTime += dt
      if (!this.registerSeeded) {
        f.register = f.pitch
        this.registerSeeded = true
      } else {
        const step = (0.06 + 0.5 * Math.exp(-this.voicedTime / 1.5)) * dt
        f.register += f.pitch > f.register ? step : -step
        f.register = clamp01(f.register)
      }
    } else {
      f.pitchHz = 0
      this.hadPitch = false
      f.pitchDelta = lowpass(f.pitchDelta, 0, dt, 0.2)
    }

    // 5. Onsets: the voice-band energy rises fast against its slower envelope.
    const vDb = dbOf(pMid + 0.3 * pLow)
    this.fastDb = lowpass(this.fastDb, vDb, dt, 0.012)
    this.slowDb = lowpass(this.slowDb, vDb, dt, 0.09)
    const rise = this.fastDb - this.slowDb
    this.sinceOnset += dt
    f.onset *= Math.exp(-dt / 0.05)
    if (f.onset < 1e-3) f.onset = 0
    if (this.armed && rise > 3 && f.speaking && this.sinceOnset > 0.09 && db > LEVEL_FLOOR_DB + 4) {
      f.onset = 1
      this.armed = false
      this.sinceOnset = 0
    } else if (rise < 1.5) {
      this.armed = true
    }
    // Rate = onsets per second of speech, both counted over the last 2 s (exponential window),
    // so pauses between phrases do not dilute it. Fades out after a second of silence.
    const keep = Math.exp(-dt / 2)
    this.rateOnsets *= keep
    this.rateSpeech = this.rateSpeech * keep + (f.speaking ? dt : 0)
    if (f.onset === 1 && this.sinceOnset === 0) this.rateOnsets += 1
    const rate = this.rateSpeech > 0.4 ? this.rateOnsets / this.rateSpeech : 0
    f.syllableRate = lowpass(f.syllableRate, f.silenceFor > 1 ? 0 : Math.min(12, rate), dt, 0.25)

    // 6. Mouth from formant regions: F1 high → open jaw, F2 high → spread lips, both low → rounded.
    const f1 = f1Den > 0 ? f1Num / f1Den : 0
    const f2 = f2Den > 0 ? f2Num / f2Den : 0
    const f1n = clamp01((f1 - 350) / (700 - 350))
    const f2n = clamp01((f2 - 1250) / (1900 - 1250))
    const vowel = gate * clamp01(f.level * 2.2) * (0.25 + 0.75 * periodic)
    f.mouth.open = ar(f.mouth.open, vowel * (0.3 + 0.7 * f1n) * clamp01(0.4 + f.level * 1.4), dt)
    f.mouth.wide = ar(f.mouth.wide, vowel * f2n * (1 - 0.6 * f1n), dt)
    f.mouth.round = ar(f.mouth.round, vowel * (1 - f2n) * (1 - 0.7 * f1n), dt)
    return f
  }

  /** Box-filter resample of the input's last 40 ms into `x16` (right-aligned). Returns valid samples. */
  private resample(input: Float32Array): number {
    const out = this.x16
    const r = this.sampleRate / RATE
    if (r === 1) {
      const n = Math.min(WIN, input.length)
      out.fill(0, 0, WIN - n)
      out.set(input.subarray(input.length - n), WIN - n)
      return n
    }
    const n = Math.min(WIN, Math.floor(input.length / r))
    const start = input.length - n * r
    out.fill(0, 0, WIN - n)
    if (r > 1) {
      for (let i = 0; i < n; i++) {
        const a = Math.floor(start + i * r)
        const b = Math.max(a + 1, Math.floor(start + (i + 1) * r))
        let s = 0
        for (let j = a; j < b; j++) s += input[j] ?? 0
        out[WIN - n + i] = s / (b - a)
      }
    } else {
      for (let i = 0; i < n; i++) {
        const p = start + i * r
        const a = Math.floor(p)
        const u = p - a
        out[WIN - n + i] = (input[a] ?? 0) * (1 - u) + (input[a + 1] ?? input[a] ?? 0) * u
      }
    }
    return n
  }

  private yinLag = 0

  /** YIN on an 8 kHz, low-passed copy. Sets `yinLag` (fractional, 0 if none) and returns the dip depth (0 periodic .. 1 noise). */
  private yinPitch(): number {
    const x = this.x16
    const y = this.x8
    // Two cascaded one-poles at ~1.8 kHz, then keep every other sample.
    const a = 1 - Math.exp((-2 * Math.PI * 1800) / RATE)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < WIN; i++) {
      s1 += a * (x[i]! - s1)
      s2 += a * (s1 - s2)
      if (i & 1) y[i >> 1] = s2
    }
    const d = this.yin
    let run = 0
    d[0] = 1
    let best = -1
    let bestVal = 1
    for (let tau = 1; tau <= LAG_MAX; tau++) {
      let s = 0
      for (let i = 0; i < YIN_W; i++) {
        const v = y[i]! - y[i + tau]!
        s += v * v
      }
      run += s
      const cm = run > 0 ? (s * tau) / run : 1
      d[tau] = cm
    }
    // First dip under the threshold (avoids octave errors), else the global minimum.
    const threshold = 0.15
    for (let tau = LAG_MIN; tau < LAG_MAX; tau++) {
      if (d[tau]! < threshold) {
        while (tau + 1 < LAG_MAX && d[tau + 1]! < d[tau]!) tau++
        best = tau
        bestVal = d[tau]!
        break
      }
    }
    if (best < 0) {
      for (let tau = LAG_MIN; tau < LAG_MAX; tau++) {
        if (d[tau]! < bestVal) {
          bestVal = d[tau]!
          best = tau
        }
      }
    }
    if (best <= LAG_MIN || best >= LAG_MAX) {
      this.yinLag = 0
      return Math.min(1, bestVal)
    }
    // Parabolic interpolation around the dip.
    const l = d[best - 1]!
    const c = d[best]!
    const r = d[best + 1]!
    const den = l - 2 * c + r
    const shift = den > 0 ? (0.5 * (l - r)) / den : 0
    this.yinLag = best + Math.max(-0.5, Math.min(0.5, shift))
    return Math.max(0, Math.min(1, c))
  }

  /** In-place radix-2 complex FFT of `re`/`im`. */
  private fft(): void {
    const re = this.re
    const im = this.im
    const rev = this.rev
    for (let i = 0; i < NFFT; i++) {
      const j = rev[i]!
      if (j > i) {
        const tr = re[i]!
        re[i] = re[j]!
        re[j] = tr
        const ti = im[i]!
        im[i] = im[j]!
        im[j] = ti
      }
    }
    for (let size = 2; size <= NFFT; size <<= 1) {
      const half = size >> 1
      const step = NFFT / size
      for (let start = 0; start < NFFT; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cosT[k * step]!
          const wi = this.sinT[k * step]!
          const a = start + k
          const b = a + half
          const xr = re[b]! * wr - im[b]! * wi
          const xi = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - xr
          im[b] = im[a]! - xi
          re[a] = re[a]! + xr
          im[a] = im[a]! + xi
        }
      }
    }
  }
}
