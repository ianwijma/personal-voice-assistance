/**
 * Shared rig for the character designs (line-face, robot-eyes, lips, blob-buddy, profile-head,
 * dot-matrix). Not a design: the registry ignores files starting with "_".
 *
 *   ModeMix   cross-fading weights of the five modes, so every pose change is a blend, not a cut
 *   Blinker   seeded, irregular blinks (log-normal intervals, double blinks, blinks on demand)
 *   Gaze      fixations and saccades around an attention point, at a mode-dependent rate
 *   Social    the listener and speaker model: backchannel nods at the person's phrase ends,
 *             curiosity at rising pitch, flinch and brace for shouting, leaning in for quiet
 *             speech, energy from tempo and intonation, the assistant's beat and size
 *   Mouth     the assistant's mouth estimate, smoothed by register (deep: big and slow)
 *   Personality, Glide and the shared option specs: the viewer's settings every character
 *             understands with the same ids, so a device profile can carry them between characters
 *
 * Everything is allocation-free per frame and seeded, so two instances with different seeds
 * never blink in step, and the same seed gives the same life.
 */
import type { Frame, Mode, OptionSpec, OptionValues, Rgb, VoiceFeatures } from "../contract.ts"
import { approach, clamp, clamp01, remap, rng, smoothstep, Spring } from "../kit.ts"

// ---------------------------------------------------------------------------------------------
// Options shared by the characters (same ids, labels and meaning in every design)

export const APPEARANCE = "Appearance"
export const PERSONALITY = "Personality"
export const BEHAVIOUR = "Behaviour"

/** Overall size, as a share of the size that fills the canvas. `max` is per design: how much room its layout leaves. */
export const sizeOption = (min: number, max: number): OptionSpec => ({
  id: "size",
  kind: "number",
  label: "Size",
  min,
  max,
  step: 0.05,
  default: 1,
  unit: "×",
  group: APPEARANCE,
  help: "How big the character is drawn; it always stays inside the frame."
})

export const lineWeightOption = (help: string): OptionSpec => ({ id: "lineWeight", kind: "number", label: "Line weight", min: 0.5, max: 2.5, step: 0.05, default: 1, unit: "×", group: APPEARANCE, help })

export const EXPRESSIVENESS: OptionSpec = {
  id: "expressiveness",
  kind: "number",
  label: "Expressiveness",
  min: 0.3,
  max: 1.6,
  step: 0.05,
  default: 1,
  unit: "×",
  group: PERSONALITY,
  help: "From reserved to animated: how big its nods, tilts, bounces, flinches and brow movements are."
}
export const LIVELINESS: OptionSpec = {
  id: "liveliness",
  kind: "number",
  label: "Liveliness",
  min: 0.3,
  max: 2,
  step: 0.05,
  default: 1,
  unit: "×",
  group: PERSONALITY,
  help: "How often it blinks and shifts its gaze."
}
export const MOUTH_RANGE: OptionSpec = {
  id: "mouthRange",
  kind: "number",
  label: "Mouth range",
  min: 0.4,
  max: 1.5,
  step: 0.05,
  default: 1,
  unit: "×",
  group: PERSONALITY,
  help: "How far the mouth opens when it talks."
}
export const nodsOption = (help = "Nods at the end of each of your phrases, the way a listener says “mm-hm”."): OptionSpec => ({
  id: "nods",
  kind: "toggle",
  label: "Nods along",
  default: true,
  group: BEHAVIOUR,
  help
})
export const FOLLOWS_POINTER: OptionSpec = {
  id: "followsPointer",
  kind: "toggle",
  label: "Eyes follow the pointer",
  default: true,
  group: BEHAVIOUR,
  help: "When the pointer is over it, it looks at the pointer; otherwise it looks straight out at you."
}

const optNum = (o: OptionValues, id: string, fallback: number): number => {
  const v = o[id]
  return typeof v === "number" ? v : fallback
}
const optBool = (o: OptionValues, id: string, fallback: boolean): boolean => {
  const v = o[id]
  return typeof v === "boolean" ? v : fallback
}

/**
 * An appearance value gliding to its option's value: snaps on the first frame and under reduced
 * motion, otherwise follows with time constant `tau`, so a changed setting never jumps.
 */
export class Glide {
  value: number
  private started = false
  constructor(initial = 0) {
    this.value = initial
  }
  step(target: number, f: Frame, tau = 0.2): number {
    if (!this.started || f.reducedMotion) {
      this.started = true
      this.value = target
    } else this.value = approach(this.value, target, f.dt, tau)
    return this.value
  }
}

/**
 * The personality settings, read from `frame.options` once per frame. A design that does not
 * declare one of them gets its neutral value (1 or true), so the rig code needs no special cases.
 *   expressiveness  scales nods, tilts, bounces, flinches, lean and brow movement (via `Social`)
 *   liveliness      divides the mean blink interval and the gaze hold time
 *   mouthRange      scales how far the mouth opens (via `Mouth`)
 */
export class Personality {
  expressiveness = 1
  liveliness = 1
  mouthRange = 1
  nods = true
  followsPointer = true
  private readonly gEx = new Glide(1)
  private readonly gLive = new Glide(1)
  private readonly gRange = new Glide(1)
  read(f: Frame): this {
    const o = f.options
    this.expressiveness = this.gEx.step(optNum(o, "expressiveness", 1), f, 0.3)
    this.liveliness = this.gLive.step(optNum(o, "liveliness", 1), f, 0.3)
    this.mouthRange = this.gRange.step(optNum(o, "mouthRange", 1), f, 0.2)
    this.nods = optBool(o, "nods", true)
    this.followsPointer = optBool(o, "followsPointer", true)
    return this
  }
}

/**
 * Scale the character's own size `s` (px per unit) by the size option, never past the scale at
 * which its content box (`cw × ch` units, its true extent including motion) still fits with a 2 %
 * margin. Each design picks the box no larger than its layout box allows, so at size 1 this is `s`.
 */
export const sized = (s: number, size: number, w: number, h: number, cw: number, ch: number): number => Math.min(s * size, fit(w, h, cw, ch, 0.98))

/**
 * A discrete appearance change (a mirror, a new grid) as a short dip: fades out, reports the
 * switch, fades back in. `alpha` multiplies the drawing; `shown` is the value to draw now.
 */
export class Dip<T> {
  alpha = 1
  shown: T
  private started = false
  constructor(initial: T) {
    this.shown = initial
  }
  step(target: T, f: Frame, half = 0.14): void {
    if (!this.started) {
      this.started = true
      this.shown = target
    }
    if (target === this.shown) {
      this.alpha = f.reducedMotion ? 1 : Math.min(1, this.alpha + f.dt / half)
      return
    }
    this.alpha = f.reducedMotion ? 0 : Math.max(0, this.alpha - f.dt / half)
    if (this.alpha <= 0) {
      this.shown = target
      if (f.reducedMotion) this.alpha = 1
    }
  }
}

/** Relative luminance-ish lightness of a colour, 0..1 (for choosing feature contrast). */
export const lightness = (c: Rgb): number => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255

export type Five = readonly [idle: number, listening: number, hearing: number, thinking: number, speaking: number]

// ---------------------------------------------------------------------------------------------
// Mode blending

const MODE_INDEX: { readonly [M in Mode]: number } = { idle: 0, listening: 1, hearing: 2, thinking: 3, speaking: 4 }

/**
 * Five weights that sum to 1 and glide toward the current mode. `pick` turns a per-mode table
 * into one blended number, so every parameter of a pose moves together during a transition.
 */
export class ModeMix {
  readonly w = new Float32Array([1, 0, 0, 0, 0])
  private started = false
  /** `tau`: seconds for 63 % of a transition. Reduced motion cuts straight to the pose. */
  step(f: Frame, tau = 0.22): void {
    const target = MODE_INDEX[f.mode]
    const instant = f.reducedMotion || !this.started
    this.started = true
    let sum = 0
    for (let i = 0; i < 5; i++) {
      const v = approach(this.w[i]!, i === target ? 1 : 0, f.dt, instant ? 0 : tau)
      this.w[i] = v
      sum += v
    }
    for (let i = 0; i < 5; i++) this.w[i] = this.w[i]! / sum
  }
  pick(v: Five): number {
    const w = this.w
    return w[0]! * v[0] + w[1]! * v[1] + w[2]! * v[2] + w[3]! * v[3] + w[4]! * v[4]
  }
  get idle(): number {
    return this.w[0]!
  }
  get listening(): number {
    return this.w[1]!
  }
  get hearing(): number {
    return this.w[2]!
  }
  get thinking(): number {
    return this.w[3]!
  }
  get speaking(): number {
    return this.w[4]!
  }
}

// ---------------------------------------------------------------------------------------------
// Random helpers

let instances = 0
/**
 * A seed for a new instance: `base` plus a per-page counter, so the same design in several
 * cells of the reaction matrix does not blink and glance in lockstep.
 */
export const instanceSeed = (base: number): number => base * 1000 + ++instances * 7919

/** Roughly normal, mean 0, sd 1 (sum of three uniforms, rescaled). */
const gauss = (r: () => number): number => (r() + r() + r() - 1.5) * 2
/** Log-normal interval around `mean` seconds: mostly near it, sometimes much longer. */
export const interval = (r: () => number, mean: number, spread = 0.45): number => mean * Math.exp(gauss(r) * spread - (spread * spread) / 2)

// ---------------------------------------------------------------------------------------------
// Blinks

/**
 * Irregular blinks. `closed` is 0 (open) .. 1 (shut). A blink closes in 70 ms and opens in
 * 130 ms (eyelids close faster than they open); 18 % of blinks are doubles.
 */
export class Blinker {
  closed = 0
  private readonly r: () => number
  private wait: number
  private phase = -1
  private double = false
  constructor(seed: number) {
    this.r = rng(seed)
    this.wait = 0.8 + this.r() * 2.5
  }
  /** Blink now (a backchannel or a gaze shift), unless one is under way. */
  trigger(): void {
    if (this.phase < 0) this.phase = 0
  }
  /** `mean`: seconds between blinks now. `enabled` false holds the eyes open. */
  step(dt: number, mean: number, enabled: boolean): number {
    if (!enabled) {
      this.phase = -1
      this.closed = 0
      return 0
    }
    if (this.phase < 0) {
      this.wait -= dt
      if (this.wait <= 0) this.phase = 0
    }
    if (this.phase >= 0) {
      this.phase += dt
      const p = this.phase
      if (p < 0.07) this.closed = smoothstep(0, 0.07, p)
      else if (p < 0.2) this.closed = 1 - smoothstep(0.07, 0.2, p)
      else {
        this.closed = 0
        this.phase = -1
        if (!this.double && this.r() < 0.18) {
          this.double = true
          this.wait = 0.09
        } else {
          this.double = false
          this.wait = interval(this.r, mean)
        }
      }
    }
    return this.closed
  }
}

// ---------------------------------------------------------------------------------------------
// Gaze

/**
 * Eye direction in −1..1 on both axes (x right, y down). The eyes fixate a point near
 * `cx, cy`, scattered by `spread`, for about `hold` seconds, then jump (a saccade, 30–50 ms).
 * Fast holds read as busy thought, slow holds as calm (the Cozmo/Vector rule).
 * `saccade` is true on the frame a jump of more than 0.25 starts, so a design can blink with it.
 */
export class Gaze {
  x = 0
  y = 0
  saccade = false
  private tx = 0
  private ty = 0
  private ox = 0
  private oy = 0
  private wait = 0
  private readonly r: () => number
  private readonly sx = new Spring(0.035)
  private readonly sy = new Spring(0.035)
  constructor(seed: number) {
    this.r = rng(seed)
  }
  step(dt: number, cx: number, cy: number, spread: number, hold: number, reduced: boolean): void {
    this.saccade = false
    if (reduced) {
      this.x = cx
      this.y = cy
      this.sx.set(cx)
      this.sy.set(cy)
      this.ox = 0
      this.oy = 0
      return
    }
    this.wait -= dt
    if (this.wait <= 0) {
      const nx = gauss(this.r) * spread * 0.6
      const ny = gauss(this.r) * spread * 0.4
      if (Math.abs(nx - this.ox) + Math.abs(ny - this.oy) > 0.25) this.saccade = true
      this.ox = nx
      this.oy = ny
      this.wait = interval(this.r, hold, 0.5)
    }
    this.tx = clamp(cx + this.ox, -1, 1)
    this.ty = clamp(cy + this.oy, -1, 1)
    this.x = this.sx.step(this.tx, dt)
    this.y = this.sy.step(this.ty, dt)
  }
}

/**
 * Where "you" are, as a gaze direction: the pointer when it is over the canvas (and `follow`, the
 * "Eyes follow the pointer" setting, is on), else straight out.
 */
export const youDirection = (f: Frame, cx: number, cy: number, reach: number, out: { x: number; y: number }, follow = true): void => {
  if (f.pointer.inside && follow) {
    out.x = clamp((f.pointer.x - cx) / reach, -1, 1)
    out.y = clamp((f.pointer.y - cy) / reach, -1, 1)
  } else {
    out.x = 0
    out.y = 0.05
  }
}

// ---------------------------------------------------------------------------------------------
// Held values for reduced motion

/** A value that only changes in steps, at most every `minHold` seconds: a pose, not a motion. */
class Held {
  value: number
  private since = 99
  constructor(initial: number) {
    this.value = initial
  }
  step(target: number, dt: number, step: number, minHold: number): number {
    this.since += dt
    const q = Math.round(target / step) * step
    if (q !== this.value && this.since >= minHold) {
      this.value = q
      this.since = 0
    }
    return this.value
  }
}

// ---------------------------------------------------------------------------------------------
// Social behaviour

/**
 * The listener (while the person speaks) and speaker (while the assistant speaks) model, shared
 * by all character designs. Every output is a plain number a design maps to its own drawing.
 *
 * Listening (mode hearing, from `user`):
 *  - `nod`: a head-nod spring (positive = chin down). Fires 0–0.12 s after the person's
 *    250 ms voice-activity hangover ends (so 0.25–0.37 s into the pause), if the phrase lasted ≥ 0.6 s and ended with falling or flat
 *    intonation; a small nod at a mid-phrase pitch fall; a "got it" nod when hearing hands over
 *    to thinking. Never more often than every 1.1 s. Peaks at about 1.
 *    Timed to the person, never to a clock (the Rapport Agent finding).
 *  - `question`: 0..1, set at a phrase end that rose in pitch (mean voiced pitchDelta over its
 *    last ~0.6 s > +1 st/s), decaying over ~3 s; a run of such phrase ends holds it at up to 0.8
 *    until hearing ends. Instead of a nod, the character looks curious.
 *  - `ack`: true on the frame a nod or a question response fires (designs blink or smile).
 *  - `brow`: live intonation, −1..1 (pitchDelta / 10 st/s while voiced).
 *  - `lean`: +1 leaning in for a whisper or soft voice, −1 pulling back from shouting.
 *  - `brace`: 0..1, held while the person stays very loud (level > 0.5).
 *  - `flinch`: 0..1 impulse on a loud onset; habituates, so a long shout is not a seizure.
 *  - `energy`: 0..1 arousal from syllable rate (1.8 → 4.8 /s) and pitch movement.
 *  - `regard`: the person's register, 0 deep .. 1 child-high.
 *  - `follow`: 0..1 small bob on each stressed syllable of the person.
 *  - `waiting`: 0..1, the person paused mid-turn (still hearing, silent for 0.3–1.2 s).
 *
 * Speaking (mode speaking, from `agent`):
 *  - `talk`: loudness envelope (50 ms rise, 220 ms fall); `talkSlow`: over ~1 s (soft vs loud).
 *  - `beat`: a bounce spring kicked on each syllable onset, slower and bigger for a deep voice.
 *  - `size`: the assistant's register as size, 1 deep (big, slow) .. 0 high (small, quick).
 *  - `lookAway`: 0..1, looking aside at the start of an utterance and back at its end
 *    (speakers avert gaze to plan, then return it to hand over), `lookSide` ±1.
 *
 * Thinking: `thinkSide` ±1, chosen per thinking spell, for where the eyes go to search.
 * In reduced motion all impulses (nod, flinch, follow, beat, look-away) are zero and the slow
 * values change in held steps at most every 1.5 s.
 *
 * Personality (pass a `Personality` to `step`): `expr` scales `nod`, `beat`, `follow`, and
 * `question`, `brow`, `lean`, `brace`, `flinch` (those clamped to their natural range, so an
 * animated character reacts more readily but never past its designed extreme pose). With
 * `nodsOn` false the nod spring is never kicked; `ack` still fires, so it still blinks or smiles.
 */
export class Social {
  nod = 0
  question = 0
  ack = false
  brow = 0
  lean = 0
  brace = 0
  flinch = 0
  /** Expressiveness this frame (1 = as designed); designs scale their own expressive motion by it. */
  expr = 1
  /** "Nods along" setting this frame. */
  nodsOn = true
  energy = 0.4
  regard = 0.4
  follow = 0
  waiting = 0
  talk = 0
  talkSlow = 0
  beat = 0
  size = 0.5
  lookAway = 0
  lookSide = 1
  thinkSide = 1
  /** The person is speaking right now (hearing only). */
  userTalking = false
  /** Seconds since the last backchannel. */
  sinceAck = 99

  private readonly r: () => number
  private readonly nodSpring = new Spring(0.1, 0, 0.35)
  private readonly beatSpring: Spring = new Spring(0.08, 0, 0.45)
  // Unscaled state; the public fields above are these times `expr`.
  private q = 0
  private browR = 0
  private leanR = 0
  private braceR = 0
  private flinchR = 0
  private followR = 0
  private nodQueue = -1
  private nodThreshold = 0.15
  private wasSpeaking = false
  private utterLen = 0
  private endRise = 0
  private qTrait = 0
  private levelSlow = 0
  private pdAbs = 2
  private rate = 3
  private habit = 0
  private sinceFlinch = 99
  private sincePitchNod = 99
  private wasAgentSpeaking = false
  private awayFor = 0
  private lastMode: Mode = "idle"
  private readonly hLean = new Held(0)
  private readonly hBrace = new Held(0)
  private readonly hEnergy = new Held(0.5)
  private readonly hQuestion = new Held(0)
  private readonly hRegard = new Held(0.5)
  private readonly hTalk = new Held(0)
  private readonly hSize = new Held(0.5)

  constructor(seed: number) {
    this.r = rng(seed * 7919 + 13)
  }

  step(f: Frame, personality?: Personality): void {
    const dt = f.dt
    this.expr = personality?.expressiveness ?? 1
    this.nodsOn = personality?.nods ?? true
    const u = f.user
    const a = f.agent
    const hearing = f.mode === "hearing"
    const speaking = f.mode === "speaking"
    this.ack = false
    this.sinceAck += dt
    this.sinceFlinch += dt
    this.sincePitchNod += dt
    if (f.mode !== this.lastMode) {
      if (f.mode === "thinking") {
        this.thinkSide = this.r() < 0.5 ? -1 : 1
        // "Got it": the hand-over from the person to the assistant gets a nod of its own.
        if (this.lastMode === "hearing" && this.sinceAck > 0.8 && !f.reducedMotion) {
          if (this.nodsOn) this.nodSpring.velocity += 26
          this.ack = true
          this.sinceAck = 0
        }
      }
      this.lastMode = f.mode
    }

    // --- Listener ------------------------------------------------------------------------
    const talking = hearing && u.speaking
    this.userTalking = talking
    if (talking) {
      this.utterLen = u.speechFor
      if (u.voicing > 0.4) this.endRise = approach(this.endRise, u.pitchDelta, dt, 0.35)
      this.levelSlow = approach(this.levelSlow, u.level, dt, 0.5)
      if (u.voicing > 0.4) this.pdAbs = approach(this.pdAbs, Math.abs(u.pitchDelta), dt, 1.2)
      this.rate = approach(this.rate, u.syllableRate, dt, 0.8)
      // A whisper has almost no voicing: count it as very quiet even if the level wobbles.
      const quiet = u.voicing < 0.25 ? Math.min(this.levelSlow, 0.08) : this.levelSlow
      const lean = quiet < 0.3 ? remap(quiet, 0.07, 0.3, 1, 0) : -remap(quiet, 0.38, 0.72, 0, 1)
      this.leanR = approach(this.leanR, lean, dt, 0.5)
      this.braceR = approach(this.braceR, smoothstep(0.48, 0.72, this.levelSlow), dt, 0.4)
      this.browR = approach(this.browR, u.voicing > 0.4 ? clamp(u.pitchDelta / 10, -1, 1) : this.browR * 0.5, dt, 0.18)
      // Small nod at a clear pitch fall well into a phrase (a "low pitch region" cue).
      if (this.nodsOn && u.pitchDelta < -7 && u.speechFor > 1.2 && this.sincePitchNod > 2.2 && this.sinceAck > 1.1) {
        this.nodSpring.velocity += 9
        this.sincePitchNod = 0
        this.sinceAck = 0
        this.ack = true
      }
      // Loud onsets make it flinch, less each time (habituation over ~3 s).
      if (u.onset > 0.95 && u.level > 0.58 && this.sinceFlinch > 0.25) {
        this.flinchR = Math.max(this.flinchR, clamp01((u.level - 0.5) * 2.4) * (1 - this.habit))
        this.habit = Math.min(0.8, this.habit + 0.3)
        this.sinceFlinch = 0
      }
      if (u.onset > 0.95) this.followR = Math.max(this.followR, clamp01(u.level * 2.2))
    } else if (hearing) {
      this.leanR = approach(this.leanR, this.leanR * 0.7, dt, 2) // hold the pose through a pause
      this.browR = approach(this.browR, 0, dt, 0.5)
      this.braceR = approach(this.braceR, 0, dt, 1.2)
    } else {
      this.leanR = approach(this.leanR, f.mode === "listening" ? 0.25 : 0, dt, 0.6)
      this.browR = approach(this.browR, 0, dt, 0.4)
      this.braceR = approach(this.braceR, 0, dt, 0.4)
    }
    this.flinchR = approach(this.flinchR, 0, dt, 0.3)
    this.habit = approach(this.habit, 0, dt, 3)
    this.followR = approach(this.followR, 0, dt, 0.12)

    // Phrase end: queue a nod (or a curious look) shortly after the hangover runs out.
    if (this.wasSpeaking && !u.speaking && hearing) {
      if (this.utterLen >= 0.6) {
        this.nodQueue = 0
        this.nodThreshold = this.r() * 0.12
      }
    }
    this.wasSpeaking = u.speaking
    if (this.nodQueue >= 0) {
      if (u.speaking || !hearing) this.nodQueue = -1
      else if (u.silenceFor >= this.nodThreshold && this.sinceAck > 1.1) {
        const rose = this.endRise > 1
        this.qTrait = this.qTrait * 0.5 + (rose ? 0.5 : 0)
        if (rose) {
          this.q = Math.max(this.q, clamp01((this.endRise - 0.3) / 2))
        } else if (this.nodsOn) {
          const size = 22 + 14 * clamp01(this.utterLen / 3)
          this.nodSpring.velocity += size
        }
        this.ack = true
        this.sinceAck = 0
        this.nodQueue = -1
        this.endRise = 0
      }
    }
    // A run of rising phrase ends keeps a curious pose between them (the person is asking).
    if (!hearing) this.qTrait = approach(this.qTrait, 0, dt, 1.5)
    this.q = Math.max(approach(this.q, 0, dt, hearing ? 3 : 0.8), hearing ? 0.8 * this.qTrait : 0)
    this.nod = this.nodSpring.step(0, dt)
    this.waiting = approach(this.waiting, hearing && !u.speaking ? smoothstep(0.1, 0.8, u.silenceFor) : 0, dt, 0.25)

    // Slow descriptions of the person's voice, updated only while they speak.
    const energy = 0.55 * remap(this.rate, 1.8, 4.8, 0, 1) + 0.45 * remap(this.pdAbs, 1.2, 4.2, 0, 1)
    if (talking) this.energy = approach(this.energy, energy, dt, 0.9)
    else if (!hearing) this.energy = approach(this.energy, 0.4, dt, 1.5)
    if (talking && u.voicing > 0.4) this.regard = approach(this.regard, u.register, dt, 1.2)

    // --- Speaker --------------------------------------------------------------------------
    const asp = speaking && a.speaking
    this.talk = approach(this.talk, speaking ? a.level : 0, dt, a.level > this.talk ? 0.05 : 0.22)
    if (asp) this.talkSlow = approach(this.talkSlow, a.level, dt, 0.9)
    else if (!speaking) this.talkSlow = approach(this.talkSlow, 0, dt, 0.6)
    if (asp && a.voicing > 0.4) this.size = approach(this.size, 1 - remap(a.register, 0.15, 0.8, 0, 1), dt, 0.8)
    this.beatSpring.halfLife = 0.06 + 0.07 * this.size
    if (asp && a.onset > 0.95) this.beatSpring.velocity += (25 + 15 * this.size) * clamp01(a.level * 2)
    this.beat = this.beatSpring.step(0, dt)
    // Gaze aversion at an utterance start, return toward its end.
    if (speaking && a.speaking && !this.wasAgentSpeaking && this.r() < 0.6) {
      this.awayFor = 0.5 + this.r() * 0.7
      this.lookSide = this.r() < 0.5 ? -1 : 1
    }
    this.wasAgentSpeaking = speaking && a.speaking
    this.awayFor = speaking ? this.awayFor - dt : 0
    this.lookAway = approach(this.lookAway, this.awayFor > 0 ? 1 : 0, dt, 0.12)

    // --- Reduced motion: no impulses, slow values as held steps -----------------------------
    if (f.reducedMotion) {
      this.nod = 0
      this.flinchR = 0
      this.followR = 0
      this.beat = 0
      this.lookAway = 0
      this.leanR = this.hLean.step(this.leanR, dt, 0.5, 1.5)
      this.braceR = this.hBrace.step(this.braceR, dt, 0.5, 1.5)
      this.energy = this.hEnergy.step(this.energy, dt, 0.5, 1.5)
      this.q = this.hQuestion.step(this.q, dt, 0.5, 1.5)
      this.regard = this.hRegard.step(this.regard, dt, 0.5, 1.5)
      this.talkSlow = this.hTalk.step(this.talkSlow, dt, 0.25, 1.5)
      this.talk = this.talkSlow
      this.size = this.hSize.step(this.size, dt, 0.5, 1.5)
      this.browR = 0
    }

    // --- Expressiveness: the outputs designs read -------------------------------------------
    const x = this.expr
    this.nod *= x
    this.beat *= x
    this.follow = this.followR * x
    if (x === 1) {
      this.question = this.q
      this.brow = this.browR
      this.lean = this.leanR
      this.brace = this.braceR
      this.flinch = this.flinchR
    } else {
      this.question = clamp01(this.q * x)
      this.brow = clamp(this.browR * x, -1, 1)
      this.lean = clamp(this.leanR * x, -1, 1)
      this.brace = clamp01(this.braceR * x)
      this.flinch = clamp01(this.flinchR * x)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The assistant's mouth

/**
 * The assistant's mouth shape, from the harness's spectral estimate, smoothed so a deep voice
 * moves bigger and slower and a high voice smaller and quicker. `teeth` is the "s" shape: jaw
 * nearly closed, lips apart, teeth together. Within an utterance the lips never fully close
 * (open ≥ 0.09), so a still frame of speech still shows a parted mouth. In reduced motion the mouth holds one open "ah"
 * pose while speaking, so the mode still reads. `range` (the "Mouth range" setting) scales how far it opens.
 */
export class Mouth {
  open = 0
  wide = 0
  round = 0
  teeth = 0
  step(f: Frame, size: number, gate: number, range = 1): void {
    const a: VoiceFeatures = f.agent
    const dt = f.dt
    if (f.reducedMotion) {
      this.open = 0.45 * gate * range
      this.wide = 0.3 * gate
      this.round = 0
      this.teeth = 0
      return
    }
    const k = 0.75 + 0.6 * size // time scale
    const amp = 0.8 + 0.35 * size
    // Mid-utterance the lips stay a little apart between syllables, as in real speech; they
    // close fully only in pauses (the spectrum cannot see m/b/p closures anyway).
    const tOpen = Math.max(clamp01(a.mouth.open * amp), a.speaking ? 0.09 : 0) * gate * range
    this.open = approach(this.open, tOpen, dt, (tOpen > this.open ? 0.025 : 0.06) * k)
    this.wide = approach(this.wide, a.mouth.wide * gate, dt, 0.05 * k)
    this.round = approach(this.round, a.mouth.round * gate, dt, 0.06 * k)
    const s = a.sibilance * (1 - clamp01(a.mouth.open * 1.6)) * gate
    this.teeth = approach(this.teeth, clamp01(s * 1.4), dt, s > this.teeth ? 0.02 : 0.07)
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers

/** A cache of CSS colour strings, so steady colours do not build a string every frame. */
export class Ink {
  private key = -1
  private str = ""
  css(c: Rgb, alpha: number): string {
    const a = Math.round(clamp01(alpha) * 100)
    const k = ((((c[0] | 0) * 256 + (c[1] | 0)) * 256 + (c[2] | 0)) * 101 + a) | 0
    if (k !== this.key) {
      this.key = k
      this.str = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a / 100})`
    }
    return this.str
  }
}

/** Mix two colours into `out` without allocating. */
export const mixInto = (out: [number, number, number], a: Rgb, b: Rgb, t: number): [number, number, number] => {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/** Path for a rounded rectangle centred on (cx, cy). */
export const roundRect = (g: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, r: number): void => {
  const x = cx - w / 2
  const y = cy - h / 2
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  g.moveTo(x + rr, y)
  g.lineTo(x + w - rr, y)
  g.arcTo(x + w, y, x + w, y + rr, rr)
  g.lineTo(x + w, y + h - rr)
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  g.lineTo(x + rr, y + h)
  g.arcTo(x, y + h, x, y + h - rr, rr)
  g.lineTo(x, y + rr)
  g.arcTo(x, y, x + rr, y, rr)
  g.closePath()
}

/** Fit a design box of `bw × bh` units into the canvas, centred: returns the scale (px per unit). */
export const fit = (w: number, h: number, bw: number, bh: number, margin = 0.9): number => Math.min((w * margin) / bw, (h * margin) / bh)

const MOUTH_STEPS = 28
const MOUTH_COS = new Float32Array(MOUTH_STEPS)
const MOUTH_SIN = new Float32Array(MOUTH_STEPS)
for (let i = 0; i < MOUTH_STEPS; i++) {
  MOUTH_COS[i] = Math.cos((i / MOUTH_STEPS) * Math.PI * 2)
  MOUTH_SIN[i] = Math.sin((i / MOUTH_STEPS) * Math.PI * 2)
}
const spow = (v: number, e: number): number => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e))

/**
 * A closed mouth-opening path centred on (cx, cy): half-width `hw`, `top` height above the
 * corners, `bottom` below, corners raised by `lift` (a smile), `square` 0 (oval, "oo") .. 1
 * (boxy, "ee"). A small top and large bottom gives the rounded D of "ah". No cusps at any size.
 */
export const mouthPath = (g: CanvasRenderingContext2D, cx: number, cy: number, hw: number, top: number, bottom: number, lift: number, square: number): void => {
  const e = 1 - 0.55 * clamp01(square) // superellipse exponent on cos/sin: < 1 squares the shape
  for (let i = 0; i < MOUTH_STEPS; i++) {
    const c = MOUTH_COS[i]!
    const sn = MOUTH_SIN[i]!
    const x = cx + hw * spow(c, e)
    const y = cy + (sn > 0 ? bottom : top) * spow(sn, e) - lift * c * c
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.closePath()
}

/**
 * A soft round spot (a highlight, a shade, a glow) as a radial gradient on a unit circle, drawn
 * through a transform so it can be any ellipse. The gradient is rebuilt only when the colour
 * changes; strength goes through `globalAlpha`, so a pulsing glow allocates nothing.
 */
export class SoftSpot {
  private grad: CanvasGradient | null = null
  private key = -1
  private ctx: CanvasRenderingContext2D | null = null
  draw(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot: number, c: Rgb, alpha: number): void {
    if (alpha <= 0.004 || rx <= 0 || ry <= 0) return
    const key = ((c[0] | 0) * 256 + (c[1] | 0)) * 256 + (c[2] | 0)
    if (this.grad === null || key !== this.key || g !== this.ctx) {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1)
      const base = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`
      gr.addColorStop(0, `rgba(${base},1)`)
      gr.addColorStop(0.45, `rgba(${base},0.55)`)
      gr.addColorStop(1, `rgba(${base},0)`)
      this.grad = gr
      this.key = key
      this.ctx = g
    }
    g.save()
    g.translate(x, y)
    g.rotate(rot)
    g.scale(rx, ry)
    g.globalAlpha = clamp01(alpha)
    g.fillStyle = this.grad
    g.beginPath()
    g.arc(0, 0, 1, 0, Math.PI * 2)
    g.fill()
    g.restore()
  }
}
