/**
 * Voice simulator: a small formant speech synthesiser that renders looping
 * 16 kHz buffers in plain JS (no AudioContext), so the lab animates without a
 * microphone or a user gesture. It is not meant to be intelligible; it is meant
 * to produce realistic feature tracks: syllable rhythm, vowels with moving
 * formants (ah, ee, oo, eh, oh), fricatives (s, sh, f), stop gaps, nasals,
 * phrase intonation with jitter, and pauses.
 *
 * Source: Rosenberg glottal pulses with jitter and shimmer, plus aspiration
 * noise (the whole source for a whisper). Filter: four cascaded Klatt
 * resonators driven from 5 ms control frames. Frication: a parallel noise
 * resonator. Deterministic for a given `VoiceSpec` (seeded RNG).
 */

export const SYNTH_RATE = 16000

export type Register = "deep" | "mid" | "high" | "child"
export type Loudness = "whisper" | "soft" | "normal" | "loud" | "shouting"
export type Delivery = "slow-flat" | "normal" | "fast-excited" | "questions" | "hesitant"

export const REGISTERS: ReadonlyArray<Register> = ["deep", "mid", "high", "child"]
export const LOUDNESSES: ReadonlyArray<Loudness> = ["whisper", "soft", "normal", "loud", "shouting"]
export const DELIVERIES: ReadonlyArray<Delivery> = ["slow-flat", "normal", "fast-excited", "questions", "hesitant"]

export const REGISTER_LABEL: { readonly [R in Register]: string } = { deep: "Deep", mid: "Mid", high: "High", child: "Child" }
export const LOUDNESS_LABEL: { readonly [L in Loudness]: string } = { whisper: "Whisper", soft: "Soft", normal: "Normal", loud: "Loud", shouting: "Shouting" }
export const DELIVERY_LABEL: { readonly [D in Delivery]: string } = {
  "slow-flat": "Slow, flat",
  normal: "Normal",
  "fast-excited": "Fast, excited",
  questions: "Questions",
  hesitant: "Hesitant"
}

export interface VoiceSpec {
  readonly register: Register
  readonly loudness: Loudness
  readonly delivery: Delivery
  /** Same seed, same "words": keep it equal to compare presets side by side. */
  readonly seed: number
}

/** A rendered (or decoded) loop of audio plus where its phrases are. */
export interface VoiceClip {
  readonly samples: Float32Array
  readonly sampleRate: number
  /** Phrase spans in seconds, in order. */
  readonly phrases: ReadonlyArray<{ readonly start: number; readonly end: number }>
  /** Number of syllable nuclei (vowels) rendered, for tests and readouts. */
  readonly syllables?: number
  readonly label: string
}

const REG: { readonly [R in Register]: { readonly f0: number; readonly formants: number } } = {
  deep: { f0: 95, formants: 0.93 },
  mid: { f0: 150, formants: 1.04 },
  high: { f0: 220, formants: 1.16 },
  child: { f0: 300, formants: 1.3 }
}

interface LoudParams {
  /** Target RMS over the active parts, dBFS. */
  readonly db: number
  readonly voiced: boolean
  readonly f0: number
  /** Rosenberg opening and closing fractions of the period: a short closing is a bright, pressed voice. */
  readonly tp: number
  readonly tn: number
  readonly breath: number
}
const LOUD: { readonly [L in Loudness]: LoudParams } = {
  whisper: { db: -45, voiced: false, f0: 1, tp: 0.4, tn: 0.16, breath: 1 },
  soft: { db: -38, voiced: true, f0: 0.95, tp: 0.46, tn: 0.26, breath: 0.12 },
  normal: { db: -31, voiced: true, f0: 1, tp: 0.4, tn: 0.16, breath: 0.05 },
  loud: { db: -23, voiced: true, f0: 1.12, tp: 0.36, tn: 0.1, breath: 0.03 },
  shouting: { db: -13, voiced: true, f0: 1.32, tp: 0.32, tn: 0.065, breath: 0.03 }
}

interface DeliveryParams {
  /** Syllable duration multiplier. */
  readonly tempo: number
  /** Pitch movement multiplier. */
  readonly range: number
  readonly f0: number
  readonly syllables: readonly [number, number]
  readonly pause: readonly [number, number]
  /** Chance a phrase ends rising. */
  readonly question: number
  /** Chance of a filler or a mid-phrase hesitation per syllable. */
  readonly hesitate: number
}
const DELIV: { readonly [D in Delivery]: DeliveryParams } = {
  "slow-flat": { tempo: 1.65, range: 0.3, f0: 0.97, syllables: [4, 7], pause: [0.6, 0.9], question: 0, hesitate: 0 },
  normal: { tempo: 0.88, range: 1, f0: 1, syllables: [5, 10], pause: [0.35, 0.6], question: 0.2, hesitate: 0 },
  "fast-excited": { tempo: 0.56, range: 1.9, f0: 1.12, syllables: [8, 14], pause: [0.2, 0.35], question: 0.15, hesitate: 0 },
  questions: { tempo: 0.92, range: 1.1, f0: 1, syllables: [4, 8], pause: [0.4, 0.65], question: 1, hesitate: 0 },
  hesitant: { tempo: 1.15, range: 0.8, f0: 0.98, syllables: [3, 6], pause: [1.0, 1.8], question: 0.1, hesitate: 0.22 }
}

/** Adult reference formants (Hz): F1, F2, F3. */
const VOWELS = {
  ah: [730, 1090, 2440],
  ee: [280, 2250, 2900],
  oo: [310, 870, 2240],
  eh: [530, 1840, 2480],
  oh: [500, 850, 2410],
  uh: [600, 1200, 2500]
} as const
type Vowel = keyof typeof VOWELS
const VOWEL_CYCLE: ReadonlyArray<Vowel> = ["ah", "ee", "oo", "eh", "oh", "ah", "eh", "ee", "oh", "uh"]

type Onset = "none" | "s" | "sh" | "f" | "stop" | "nasal" | "liquid"
const ONSETS: ReadonlyArray<readonly [Onset, number]> = [
  ["none", 0.22],
  ["s", 0.14],
  ["sh", 0.07],
  ["f", 0.07],
  ["stop", 0.24],
  ["nasal", 0.14],
  ["liquid", 0.12]
]

/** mulberry32: a tiny, good-enough seeded PRNG. */
const prng = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FRAME = 0.005
const SPF = SYNTH_RATE * FRAME // samples per control frame (80)

/** Control tracks, one value per 5 ms frame. */
interface Tracks {
  av: number[] // voicing amplitude
  ah: number[] // aspiration amplitude
  af: number[] // frication amplitude
  ff: number[] // frication centre Hz
  fb: number[] // frication bandwidth Hz
  f1: number[]
  f2: number[]
  f3: number[]
}
type Param = keyof Tracks
type State = { [K in Param]: number }

class Timeline {
  readonly t: Tracks = { av: [], ah: [], af: [], ff: [], fb: [], f1: [], f2: [], f3: [] }
  s: State = { av: 0, ah: 0, af: 0, ff: 4000, fb: 2000, f1: 500, f2: 1500, f3: 2500 }
  get frames(): number {
    return this.t.av.length
  }
  /** Hold for `dur` seconds while moving the given params to their targets over `glide` seconds. */
  go(dur: number, target: Partial<State>, glide = 0.03): void {
    const n = Math.max(1, Math.round(dur / FRAME))
    const g = Math.max(1, Math.round(glide / FRAME))
    const from: State = { ...this.s }
    const to: State = { ...this.s, ...target }
    const keys = Object.keys(this.t) as Array<Param>
    for (let i = 0; i < n; i++) {
      const k = Math.min(1, (i + 1) / g)
      for (const p of keys) this.t[p].push(from[p] + (to[p] - from[p]) * k)
    }
    this.s = to
  }
}

interface Accent {
  readonly at: number // frame
  readonly width: number // frames
  readonly size: number // fraction of f0
}
interface PhraseSpan {
  readonly a: number // first frame
  readonly b: number // end frame
  readonly rising: boolean
}

const cache = new Map<string, VoiceClip>()

export const voiceKey = (s: VoiceSpec): string => `${s.register}/${s.loudness}/${s.delivery}/${s.seed}`

/** Render (or fetch from cache) about 8–10 s of looping speech for `spec`. */
export const renderVoice = (spec: VoiceSpec): VoiceClip => {
  const key = voiceKey(spec)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const clip = render(spec)
  cache.set(key, clip)
  return clip
}

const render = (spec: VoiceSpec): VoiceClip => {
  const rnd = prng(spec.seed * 7919 + 17)
  const reg = REG[spec.register]
  const loud = LOUD[spec.loudness]
  const del = DELIV[spec.delivery]
  const fs = reg.formants
  const range = (a: number, b: number) => a + (b - a) * rnd()
  const pick = <T>(items: ReadonlyArray<readonly [T, number]>): T => {
    let u = rnd()
    for (const [v, w] of items) {
      u -= w
      if (u <= 0) return v
    }
    return items[items.length - 1]![0]
  }

  const tl = new Timeline()
  const accents: Array<Accent> = []
  const phrases: Array<PhraseSpan> = []
  const vowelAt = (v: Vowel): Partial<State> => {
    const [a, b, c] = VOWELS[v]
    return { f1: a * fs, f2: b * fs, f3: c * fs }
  }
  tl.go(0.3, { av: 0, ah: 0, af: 0 })

  let nuclei = 0
  let vowelIx = Math.floor(rnd() * VOWEL_CYCLE.length)
  const MAX = 10
  const MIN = 8
  for (let p = 0; p < 8; p++) {
    const startFrame = tl.frames
    const count = Math.round(range(del.syllables[0], del.syllables[1] + 0.99) - 0.49)
    const stressEvery = 2 + Math.floor(rnd() * 2)
    for (let s = 0; s < count; s++) {
      const tempo = del.tempo * range(0.85, 1.2)
      // Hesitation: a long flat "uh" or a short silent gap.
      if (del.hesitate > 0 && s > 0 && rnd() < del.hesitate) {
        if (rnd() < 0.5) {
          tl.go(0.05, { av: 0, ah: 0, af: 0 }, 0.04)
          tl.go(range(0.3, 0.55), { ...vowelAt("uh"), av: 0.6, ah: loud.breath, af: 0 }, 0.06)
          tl.go(range(0.25, 0.5), { av: 0, ah: 0 }, 0.06)
        } else {
          tl.go(range(0.3, 0.6), { av: 0, ah: 0, af: 0 }, 0.04)
        }
      }
      const onset = pick(ONSETS)
      const v = VOWEL_CYCLE[vowelIx++ % VOWEL_CYCLE.length]!
      const vt = vowelAt(v)
      switch (onset) {
        case "s":
          tl.go(0.02 * tempo, { av: 0, ah: 0 }, 0.02)
          tl.go(range(0.09, 0.13) * tempo, { af: 0.9, ff: 5600, fb: 2400, ...vt }, 0.025)
          break
        case "sh":
          tl.go(0.02 * tempo, { av: 0, ah: 0 }, 0.02)
          tl.go(range(0.09, 0.13) * tempo, { af: 0.75, ff: 3000, fb: 1400, ...vt }, 0.025)
          break
        case "f":
          tl.go(0.02 * tempo, { av: 0, ah: 0 }, 0.02)
          tl.go(range(0.08, 0.11) * tempo, { af: 0.3, ff: 4500, fb: 6000, ...vt }, 0.025)
          break
        case "stop":
          tl.go(range(0.045, 0.075) * tempo, { av: 0, ah: 0, af: 0 }, 0.012)
          tl.go(0.012, { af: 1.1, ff: range(1800, 4200), fb: 3500 }, 0.004)
          tl.go(0.02 * tempo, { af: 0, ah: 0.25, ...vt }, 0.01)
          break
        case "nasal":
          tl.go(range(0.05, 0.08) * tempo, { av: 0.32, ah: loud.breath * 0.5, af: 0, f1: 260 * fs, f2: (rnd() < 0.5 ? 1100 : 1500) * fs, f3: 2300 * fs }, 0.03)
          break
        case "liquid":
          tl.go(range(0.045, 0.07) * tempo, { av: 0.55, ah: loud.breath * 0.5, af: 0, f1: 360 * fs, f2: (rnd() < 0.5 ? 1000 : 1300) * fs, f3: (rnd() < 0.4 ? 1700 : 2500) * fs }, 0.03)
          break
        case "none":
          // A vowel-initial syllable still dips (a light glottal catch) before it.
          if (s > 0) tl.go(0.035 * tempo, { av: 0.2, ah: 0, af: 0 }, 0.02)
          break
      }
      // The vowel nucleus, stressed syllables louder and with a pitch accent.
      const stressed = s % stressEvery === 0
      const dur = range(0.1, 0.16) * tempo * (stressed ? 1.25 : 1) * (s === count - 1 ? 1.35 : 1)
      const vowelStart = tl.frames
      nuclei++
      tl.go(dur, { av: stressed ? 1 : 0.72, ah: loud.breath, af: 0, ...vt }, 0.045)
      if (stressed) accents.push({ at: vowelStart + (dur / FRAME) * 0.4, width: (dur / FRAME) * 1.4, size: range(0.08, 0.16) })
      // Coda sometimes; word gaps between some syllables.
      const r = rnd()
      if (r < 0.15) tl.go(0.07 * tempo, { av: 0, ah: 0, af: 0.7, ff: 5600, fb: 2400 }, 0.02)
      else if (r < 0.3) tl.go(0.05 * tempo, { av: 0.3, ah: 0, af: 0, f1: 260 * fs, f2: 1500 * fs }, 0.03)
      if (s < count - 1 && rnd() < 0.35) tl.go(range(0.03, 0.07) * tempo, { av: 0.04, ah: 0, af: 0 }, 0.02)
    }
    tl.go(0.06, { av: 0, ah: 0, af: 0 }, 0.05)
    phrases.push({ a: startFrame, b: tl.frames, rising: rnd() < del.question })
    const pause = range(del.pause[0], del.pause[1])
    const seconds = tl.frames * FRAME
    if (seconds + pause >= MIN && p >= 1) {
      tl.go(Math.max(pause, 0.25), { av: 0, ah: 0, af: 0 })
      break
    }
    if (seconds + pause + 1.5 > MAX && p >= 1) {
      tl.go(Math.max(pause, MIN - seconds), { av: 0, ah: 0, af: 0 })
      break
    }
    tl.go(pause, { av: 0, ah: 0, af: 0 })
  }
  // Trim to at most MAX seconds (a long last phrase), keeping a short tail of silence.
  if (tl.frames * FRAME > MAX) {
    const keep = Math.round(MAX / FRAME)
    for (const k of Object.keys(tl.t) as Array<Param>) tl.t[k].length = keep
    const last = phrases[phrases.length - 1]
    if (last !== undefined && last.b > keep - 10) phrases[phrases.length - 1] = { ...last, b: keep - 10 }
  }

  // Pitch track: base × declination × final rise/fall × accents × slow wander.
  const frames = tl.frames
  const base = reg.f0 * loud.f0 * del.f0
  const f0 = new Float32Array(frames).fill(base)
  for (const ph of phrases) {
    const len = ph.b - ph.a
    for (let i = ph.a; i < ph.b; i++) {
      const u = (i - ph.a) / len
      let m = 1 + del.range * (0.1 - 0.2 * u)
      const tail = Math.max(0, (i - (ph.b - 0.45 / FRAME)) / (0.45 / FRAME))
      m *= ph.rising ? 1 + 0.42 * del.range * tail * tail : 1 - 0.1 * del.range * tail
      m *= 1 + 0.015 * Math.sin(i * 0.05 + spec.seed)
      f0[i] = base * m
    }
  }
  for (const a of accents) {
    const lo = Math.max(0, Math.floor(a.at - a.width / 2))
    const hi = Math.min(frames, Math.ceil(a.at + a.width / 2))
    for (let i = lo; i < hi; i++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (i - a.at)) / (a.width / 2))
      f0[i] = f0[i]! * (1 + a.size * del.range * w)
    }
  }

  const samples = synthesise(tl.t, f0, frames, loud, fs, rnd)

  // Phrase spans in seconds: the first and last audible frame of each.
  const t = tl.t
  const audible = (i: number) => (t.av[i] ?? 0) + (t.ah[i] ?? 0) + (t.af[i] ?? 0) > 0.06
  const spans: Array<{ start: number; end: number }> = []
  for (const ph of phrases) {
    let a = ph.a
    let b = ph.b - 1
    while (a < b && !audible(a)) a++
    while (b > a && !audible(b)) b--
    spans.push({ start: a * FRAME, end: (b + 1) * FRAME })
  }
  return { samples, sampleRate: SYNTH_RATE, phrases: spans, syllables: nuclei, label: `${REGISTER_LABEL[spec.register]}, ${LOUDNESS_LABEL[spec.loudness].toLowerCase()}, ${DELIVERY_LABEL[spec.delivery].toLowerCase()}` }
}

/** Two-pole resonator (Klatt), unity gain at DC. */
class Resonator {
  private a = 1
  private b = 0
  private c = 0
  private y1 = 0
  private y2 = 0
  set(f: number, bw: number): void {
    const T = 1 / SYNTH_RATE
    this.c = -Math.exp(-2 * Math.PI * bw * T)
    this.b = 2 * Math.exp(-Math.PI * bw * T) * Math.cos(2 * Math.PI * Math.min(f, SYNTH_RATE * 0.48) * T)
    this.a = 1 - this.b - this.c
  }
  step(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

const synthesise = (t: Tracks, f0: Float32Array, frames: number, loud: LoudParams, fs: number, rnd: () => number): Float32Array => {
  const n = frames * SPF
  const out = new Float32Array(n)
  const r1 = new Resonator()
  const r2 = new Resonator()
  const r3 = new Resonator()
  const r4 = new Resonator()
  const rf = new Resonator()
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 0.866
  const lerp = (arr: number[], i: number, u: number) => {
    const a = arr[i] ?? 0
    return a + ((arr[i + 1] ?? a) - a) * u
  }
  let phase = 0
  let period = 1 / (f0[0] ?? 120)
  let shimmer = 1
  let prevFlow = 0
  let prevNoise = 0
  const { tp, tn } = loud
  const voicedGain = loud.voiced ? 1 : 0
  for (let s = 0; s < n; s++) {
    const fi = Math.floor(s / SPF)
    const u = (s % SPF) / SPF
    if ((s & 15) === 0) {
      r1.set(lerp(t.f1, fi, u), 70)
      r2.set(lerp(t.f2, fi, u), 100)
      r3.set(lerp(t.f3, fi, u), 160)
      r4.set(3500 * fs, 250)
      rf.set(lerp(t.ff, fi, u), lerp(t.fb, fi, u))
    }
    const av = lerp(t.av, fi, u)
    const ah = lerp(t.ah, fi, u)
    const af = lerp(t.af, fi, u)
    // Glottal source: Rosenberg flow; the radiated output is its derivative.
    phase += 1 / (period * SYNTH_RATE)
    if (phase >= 1) {
      phase -= 1
      const target = f0[Math.min(frames - 1, fi)] ?? 120
      period = (1 / target) * (1 + 0.012 * gauss()) // jitter ~1.2 %
      shimmer = 1 + 0.06 * gauss()
    }
    let flow = 0
    if (phase < tp) flow = 0.5 * (1 - Math.cos((Math.PI * phase) / tp))
    else if (phase < tp + tn) flow = Math.cos(((Math.PI / 2) * (phase - tp)) / tn)
    const dflow = (flow - prevFlow) * SYNTH_RATE * period * 0.25
    prevFlow = flow
    const noise = rnd() * 2 - 1
    // Aspiration is pulsed with the glottis when voiced; it is the whole source in a whisper.
    const breath = noise * (loud.voiced ? ah * (0.4 + 0.6 * flow) : (av + ah) * 0.9)
    let x = voicedGain * dflow * av * shimmer + breath * 0.5
    x = r4.step(r3.step(r2.step(r1.step(x))))
    // Frication: resonant noise plus a little differentiated noise for the hiss.
    const hiss = noise - prevNoise
    prevNoise = noise
    const fric = af * (rf.step(noise) * 2.2 + hiss * 0.18)
    out[s] = x + fric
  }
  // Normalise the active parts to the loudness target; shouting is softly limited.
  let sum = 0
  let count = 0
  for (let fi = 0; fi < frames; fi++) {
    if ((t.av[fi] ?? 0) + (t.ah[fi] ?? 0) + (t.af[fi] ?? 0) < 0.3) continue
    for (let s = fi * SPF; s < (fi + 1) * SPF; s++) sum += out[s]! * out[s]!
    count += SPF
  }
  const rms = count > 0 ? Math.sqrt(sum / count) : 1
  const gain = Math.pow(10, loud.db / 20) / Math.max(1e-9, rms)
  let peak = 0
  for (let s = 0; s < n; s++) {
    let v = out[s]! * gain
    if (v > 0.7 || v < -0.7) v = Math.sign(v) * (0.7 + 0.3 * Math.tanh((Math.abs(v) - 0.7) / 0.3))
    out[s] = v
    if (Math.abs(v) > peak) peak = Math.abs(v)
  }
  if (peak > 0.99) for (let s = 0; s < n; s++) out[s] = out[s]! * (0.99 / peak)
  // Fade the loop's ends so it repeats without a click.
  for (let s = 0; s < 64 && s < n; s++) {
    out[s] = out[s]! * (s / 64)
    out[n - 1 - s] = out[n - 1 - s]! * (s / 64)
  }
  return out
}

/** Faint room tone (brownish noise with a little hum) at about `db` dBFS RMS, 2 s, looping. */
export const renderRoomNoise = (db = -62, seed = 3): VoiceClip => {
  const key = `room/${db}/${seed}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const rnd = prng(seed)
  const n = SYNTH_RATE * 2
  const out = new Float32Array(n)
  let b = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    b = b * 0.985 + (rnd() * 2 - 1) * 0.15
    const v = b + 0.15 * (rnd() * 2 - 1) + 0.05 * Math.sin((2 * Math.PI * 100 * i) / SYNTH_RATE)
    out[i] = v
    sum += v * v
  }
  const g = Math.pow(10, db / 20) / Math.sqrt(sum / n)
  for (let i = 0; i < n; i++) out[i] = out[i]! * g
  const clip: VoiceClip = { samples: out, sampleRate: SYNTH_RATE, phrases: [], label: "Room tone" }
  cache.set(key, clip)
  return clip
}
