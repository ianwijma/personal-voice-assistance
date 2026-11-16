/**
 * Robot eyes: two solid rounded eyes, the companion-robot tradition (Cozmo, Vector, EMO), with
 * no mouth. Everything is said with openness, lid angle, squash and stretch, gaze and saccade
 * rate. A coloured rim light says whose voice is in the air: mint for the person, amber for the
 * assistant, as bright as that voice is loud.
 *
 * Each eye is a superellipse clamped between a top-lid line (with a slant, the robot's brow) and
 * a bottom-lid curve (raised in the middle for the happy, talking squint).
 */
import type { Character, CharacterInstance, Frame } from "../contract.ts"
import { approach, clamp, clamp01, clear2d, lerp, noise2, optChoice, optColor, optNumber, remap, rng, setup2d, smoothstep, Spring } from "../kit.ts"
import {
  APPEARANCE,
  Blinker,
  EXPRESSIVENESS,
  type Five,
  fit,
  FOLLOWS_POINTER,
  Gaze,
  Glide,
  Ink,
  instanceSeed,
  LIVELINESS,
  mixInto,
  ModeMix,
  nodsOption,
  Personality,
  roundRect,
  Social,
  sized,
  sizeOption,
  youDirection
} from "../shared/figure.ts"

//                          idle   listen hear   think  speak
const OPEN: Five = [0.12, 1, 0.96, 0.78, 0.92]
const TOP: Five = [0.42, 0, 0.02, 0.2, 0.03]
const SMILE: Five = [0, 0.04, 0.02, 0, 0.21]
const SIZE: Five = [0.92, 1.06, 1, 0.95, 1]
const LIFT: Five = [0.14, -0.06, 0, -0.04, 0]
const BLINK_MEAN: Five = [5, 4.2, 4.8, 2.4, 3]
const SAG: Five = [0.1, 0, 0, 0, 0] // outer corners droop when dozing

/** "Eye shape" choice → half-width, half-height (units), superellipse exponent, visor (0..1). */
const SHAPES: { readonly [k: string]: readonly [a: number, b: number, n: number, visor: number] } = {
  rounded: [0.31, 0.4, 3.9, 0],
  round: [0.35, 0.35, 2, 0],
  tall: [0.22, 0.47, 3, 0],
  visor: [0.31, 0.4, 3.9, 1]
}

const N = 44
const COS = new Float32Array(N)
const SIN = new Float32Array(N)
for (let i = 0; i < N; i++) {
  COS[i] = Math.cos((i / N) * Math.PI * 2)
  SIN[i] = Math.sin((i / N) * Math.PI * 2)
}

/**
 * One eye: superellipse of half-size a × b (exponent `n`), clamped between the top lid
 * (`top` 0..1 of the height cut, slanted by `slant`: positive lowers the inner corner) and the
 * bottom lid (`lower` 0..1 raised flat, `smile` 0..1 raised in a curve, more in the middle).
 * `inner` is +1 if the inner corner is on the right.
 */
const eyePath = (g: CanvasRenderingContext2D, cx: number, cy: number, a: number, b: number, n: number, top: number, slant: number, smile: number, lower: number, inner: number, minH: number): void => {
  const e = 2 / n
  const yTop0 = cy - b + top * 2 * b
  const yBot0 = cy + b - lower * 2 * b
  for (let i = 0; i < N; i++) {
    const c = COS[i]!
    const s = SIN[i]!
    const px = a * (c < 0 ? -Math.pow(-c, e) : Math.pow(c, e))
    let py = b * (s < 0 ? -Math.pow(-s, e) : Math.pow(s, e))
    const u = px / a // −1..1
    const yt = yTop0 + slant * b * u * inner - cy
    const yb = yBot0 - smile * 2 * b * (1 - 0.55 * u * u) - cy
    let lo = yt
    let hi = yb
    if (hi - lo < minH) {
      const m = (lo + hi) / 2
      lo = m - minH / 2
      hi = m + minH / 2
    }
    py = clamp(py, lo, hi)
    if (i === 0) g.moveTo(cx + px, cy + py)
    else g.lineTo(cx + px, cy + py)
  }
  g.closePath()
}

/**
 * The visor: one bar of half-size a × b centred on (cx, cy). Its top lid dips in the middle for a
 * positive `slant` (the brow, as the inner corners of two eyes would) and slopes by `asym` (one
 * side more open); the bottom lid rises in a curve for `smile`.
 */
const visorPath = (g: CanvasRenderingContext2D, cx: number, cy: number, a: number, b: number, n: number, top: number, slant: number, asym: number, smile: number, lower: number, minH: number): void => {
  const e = 2 / n
  const yTop0 = -b + top * 2 * b
  const yBot0 = b - lower * 2 * b
  for (let i = 0; i < N; i++) {
    const c = COS[i]!
    const s = SIN[i]!
    const px = a * (c < 0 ? -Math.pow(-c, e) : Math.pow(c, e))
    let py = b * (s < 0 ? -Math.pow(-s, e) : Math.pow(s, e))
    const u = px / a
    let lo = yTop0 + slant * b * (1 - 2 * Math.abs(u)) + asym * b * u
    let hi = yBot0 - smile * 2 * b * (1 - 0.55 * u * u)
    if (hi - lo < minH) {
      const m = (lo + hi) / 2
      lo = m - minH / 2
      hi = m + minH / 2
    }
    py = clamp(py, lo, hi)
    if (i === 0) g.moveTo(cx + px, cy + py)
    else g.lineTo(cx + px, cy + py)
  }
  g.closePath()
}

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let dpr = 1
  const mix = new ModeMix()
  const seed = instanceSeed(5)
  const social = new Social(seed)
  const blink = new Blinker(seed + 1)
  const gaze = new Gaze(seed + 2)
  const rand = rng(seed + 3)
  const ink = new Ink()
  const you = { x: 0, y: 0 }
  const rimRgb: [number, number, number] = [0, 0, 0]
  const eyeRgb: [number, number, number] = [0, 0, 0]
  const dimRgb: [number, number, number] = [0, 0, 0]
  const barRgb: [number, number, number] = [0, 0, 0]
  const pers = new Personality()
  const gSize = new Glide(1)
  const gA = new Glide(0.31)
  const gB = new Glide(0.4)
  const gN = new Glide(3.9)
  const gVisor = new Glide(0)
  const gRim = new Glide(1)
  const squash = new Spring(0.07, 0, 0.5) // syllable squash-and-stretch (person's or assistant's)
  let rim = 0
  let openS = 0.12
  let topS = 0.42
  let smileS = 0
  let lowerS = 0
  let tiltS = 0
  let sizeS = 1
  let slantS = 0
  let peek = 0
  let peekWait = 6

  return {
    resize(width, height, ratio) {
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f: Frame) {
      const fo = f.focus
      const W = fo.width
      const H = fo.height
      const dt = f.dt
      const P = f.palette
      const reduced = f.reducedMotion
      pers.read(f)
      mix.step(f, 0.2)
      social.step(f, pers)
      const S = social
      // Appearance options: the eye shape morphs (size, roundness) and cross-fades to the visor.
      const shape = SHAPES[optChoice(f.options, "eyeShape")] ?? SHAPES.rounded!
      const size = gSize.step(optNumber(f.options, "size"), f)
      const shapeA = gA.step(shape[0], f, 0.18)
      const shapeB = gB.step(shape[1], f, 0.18)
      const shapeN = gN.step(shape[2], f, 0.18)
      const visorK = gVisor.step(shape[3], f, 0.18)
      const rimW = gRim.step(optNumber(f.options, "rimLight"), f, 0.15)
      const hearW = mix.hearing
      const speakW = mix.speaking
      const thinkW = mix.thinking

      // Layout: a 3.2 × 1.9 unit box; the eyes are 0.62 × 0.8 units, 1.06 apart. The size option
      // scales it, never past the 2.9 × 1.7 units the eyes and their motion can reach.
      const s = sized(fit(W, H, 3.2, 1.9, 0.92), size, W, H, 2.9, 1.7)
      const cx = W / 2
      const cy = H / 2

      // Gaze.
      youDirection(f, fo.x + cx, fo.y + cy, s * 2.4, you, pers.followsPointer)
      const side = S.thinkSide
      let gx = you.x
      const reg01 = remap(S.regard, 0.15, 0.82, 0, 1)
      let gy = you.y + hearW * (reg01 - 0.45) * 1.6
      let spread = 0.07
      let hold = 1.4
      if (f.mode === "thinking") {
        // Busy: quick darts around a point up and to one side (fast saccades read as working).
        gx = 0.6 * side
        gy = -0.6
        spread = 0.7
        hold = 0.28
      } else if (f.mode === "speaking") {
        gx = lerp(gx, 0.7 * S.lookSide, S.lookAway)
        gy = lerp(gy, -0.3, S.lookAway)
        hold = 1.2
      } else if (f.mode === "idle") {
        gy = 0.5
        spread = 0.25
        hold = 3.5
      }
      gaze.step(dt, gx, gy, spread, hold / pers.liveliness, reduced)
      if (gaze.saccade && rand() < 0.25) blink.trigger()
      if (S.ack) blink.trigger()
      const bl = blink.step(dt, mix.pick(BLINK_MEAN) / pers.liveliness, !reduced && mix.idle < 0.5)

      // Idle: now and then one slow half-open peek, then back to dozing.
      if (!reduced && f.mode === "idle") {
        peekWait -= dt
        if (peekWait < 0) {
          peek = Math.min(1, peek + dt / 0.6)
          if (peekWait < -2.2) peekWait = 7 + rand() * 6
        } else peek = Math.max(0, peek - dt / 0.8)
      } else peek = approach(peek, 0, dt, 0.2)

      // Squash and stretch on syllables: the person's while hearing (small), the assistant's while
      // speaking (bigger, slower for a deep voice).
      if (!reduced) {
        if (S.userTalking && f.user.onset > 0.95) squash.velocity += 22 * clamp01(f.user.level * 2) * (0.5 + S.energy) * S.expr
        squash.halfLife = 0.05 + 0.06 * S.size * speakW
      }
      const sq = reduced ? 0 : squash.step(0, dt) + S.beat * 0.9 * speakW

      // Pose targets.
      const breathe = reduced ? 0 : 0.6 * Math.sin(f.t * 1.1) + 0.4 * noise2(f.t * 0.3, 7.7)
      const lean = S.lean * hearW
      const sizeT = mix.pick(SIZE) * (1 + 0.14 * Math.max(0, lean) - 0.12 * S.brace * hearW - 0.08 * S.flinch + 0.18 * hearW * Math.max(0, S.energy - 0.5)) * (1 + speakW * (0.18 * S.size - 0.06 + 0.25 * (S.talkSlow - 0.3)))
      const openT =
        mix.pick(OPEN) + mix.idle * (0.04 * breathe + 0.35 * peek) + hearW * (0.6 * Math.max(0, S.energy - 0.5) + 0.1 * Math.max(0, lean)) + speakW * 0.3 * (S.talkSlow - 0.3)
      const topT = mix.pick(TOP) - mix.idle * 0.25 * peek + hearW * (0.3 * S.brace + 1.1 * Math.max(0, 0.42 - S.energy)) + 0.3 * S.flinch
      const smileT = mix.pick(SMILE) + hearW * (0.06 * S.waiting + 0.12 * Math.max(0, S.energy - 0.6)) + speakW * 0.07 * clamp01(S.talk * 2)
      const lowerT = hearW * 0.22 * S.brace + 0.22 * S.flinch
      // Brow slant: inner corners down when bracing or focusing, up for curiosity and quiet speech.
      const slantT = hearW * (0.35 * S.brace - 0.18 * Math.max(0, lean) - 0.1 * S.brow) + speakW * -0.15 * clamp(f.agent.pitchDelta / 10, -1, 1) * (reduced ? 0 : 1)
      const tiltT = mix.idle * 0.06 + hearW * 0.25 * S.question * (you.x < -0.1 ? -1 : 1) + thinkW * 0.08 * side
      const k = reduced ? 0 : 1
      sizeS = k ? approach(sizeS, sizeT, dt, 0.15) : sizeT
      openS = k ? approach(openS, openT, dt, 0.08) : openT
      topS = k ? approach(topS, topT, dt, 0.08) : topT
      smileS = k ? approach(smileS, smileT, dt, 0.07) : smileT
      lowerS = k ? approach(lowerS, lowerT, dt, 0.07) : lowerT
      slantS = k ? approach(slantS, slantT, dt, 0.1) : slantT
      tiltS = k ? approach(tiltS, tiltT, dt, 0.25) : tiltT

      // Rim light: mint with the person's level while hearing (faint while listening), amber with
      // the assistant's while speaking, a slow amber pulse while thinking.
      const youLv = S.userTalking ? Math.max(0.15, f.user.level) : 0.1
      const rimT = mix.listening * 0.25 + hearW * (0.3 + 0.9 * clamp01(youLv * 1.6)) + speakW * (0.3 + 0.9 * clamp01(S.talk * 1.8)) + thinkW * (reduced ? 0.3 : 0.18 + 0.14 * Math.sin(f.t * 3))
      rim = reduced ? Math.round(rimT * 3) / 3 : approach(rim, rimT, dt, rimT > rim ? 0.04 : 0.2)
      const toVoice = speakW + thinkW
      mixInto(rimRgb, P.you, P.voice, toVoice / Math.max(1e-3, toVoice + hearW + mix.listening))
      // Eyes: the chosen colour, dimmed when dozing (ink dims to the theme's faint ink).
      const eyeC = optColor(f, "eyeColor")
      const dim = f.options.eyeColor === "ink" ? P.inkFaint : mixInto(dimRgb, eyeC, P.bg, 0.45)
      mixInto(eyeRgb, dim, eyeC, 1 - mix.idle * 0.55)
      // With the rim light thinned to nothing, the eyes themselves take on whose voice it is.
      const tint = 1 - smoothstep(0, 0.5, rimW)
      if (tint > 0) mixInto(eyeRgb, eyeRgb, rimRgb, tint * clamp01(rim) * 0.65)

      // Geometry.
      const unit = s * sizeS
      const a = shapeA * unit * (1 + 0.06 * sq)
      const bBase = shapeB * unit * (1 - 0.14 * sq) * (1 + speakW * 0.14 * clamp01(S.talk * 2 - 0.3))
      const b = bBase * clamp(openS, 0.05, 1.3)
      const sep = 0.53 * s * (1 - 0.06 * Math.max(0, lean)) // a whisper draws the eyes closer: leaning in
      const nodY = S.nod * 0.12 * s
      const yc = cy + mix.pick(LIFT) * s + gaze.y * 0.26 * s + nodY - sq * 0.09 * s - (reduced ? 0 : breathe * 0.012 * s)
      const xc = cx + gaze.x * 0.36 * s
      const minH = Math.max(1, 0.02 * s)
      // Every corner is rounded by stroking the fill in its own colour with round joins; the
      // path is inset by half that stroke so the size stays true.
      const round = Math.max(2, 0.1 * s)

      clear2d(g, dpr, fo) // the whole stage; (0, 0) is the box's corner, the glow is no longer cut
      g.translate(xc, yc)
      g.rotate(tiltS)
      const glow = P.dark && !reduced
      const rimLine = round + 2 * Math.max(1.2, 0.022 * s) * rimW
      const showRim = rim > 0.02 && rimW > 0.01
      const eyesA = 1 - visorK
      if (eyesA > 0.01 && eyesA < 1) g.globalAlpha = eyesA
      for (let e = -1; e <= 1 && eyesA > 0.01; e += 2) {
        // Perspective: the eye on the side you look toward grows, the other shrinks a little.
        const persp = 1 + 0.09 * gaze.x * e
        const ea = Math.max(1, a * persp - round / 2)
        const eb = Math.max(0.5, b * persp - round / 2)
        const x = e * sep
        const curiosity = hearW * S.question * (e === (you.x < -0.1 ? -1 : 1) ? -0.14 : 0.07) // one eye opens wider
        const ponder = thinkW * (e === side ? 0.16 : -0.04) // thinking: the eye on the searching side narrows
        const top = clamp01(topS + curiosity + ponder + bl * 0.5)
        const lower = clamp01(lowerS + bl * 0.45)
        const smile = smileS
        const sag = mix.pick(SAG)
        // Softer, rounder eyes for a high or child voice; squarer for a deep one.
        const n = Math.max(1.8, shapeN + hearW * (1.9 - 3.2 * reg01))
        // Rim first (wide stroke), then the eye fill on top: the outer half of the stroke shows.
        if (showRim) {
          g.beginPath()
          eyePath(g, x, 0, ea, eb, n, top, slantS - sag, smile, lower, -e, minH)
          g.lineJoin = "round"
          g.lineWidth = rimLine
          g.strokeStyle = ink.css(rimRgb, clamp01(rim) * (P.dark ? 0.85 : 1))
          if (glow) {
            g.shadowBlur = 0.22 * s * clamp01(rim)
            g.shadowColor = ink.css(rimRgb, 0.7 * clamp01(rim))
          }
          g.stroke()
          g.shadowBlur = 0
        }
        g.beginPath()
        eyePath(g, x, 0, ea, eb, n, top, slantS - sag, smile, lower, -e, minH)
        const css = ink.css(eyeRgb, 1)
        g.fillStyle = css
        g.strokeStyle = css
        g.lineJoin = "round"
        g.lineWidth = round
        g.fill()
        g.stroke()
      }
      if (eyesA > 0.01 && eyesA < 1) g.globalAlpha = 1

      // Visor: one bar in a dimmed eye colour holding two eye lights that look around inside it;
      // the lids, squint and brow act on the whole bar.
      if (visorK > 0.01) {
        if (visorK < 1) g.globalAlpha = visorK
        const av = sep + a * 0.85
        const bv = Math.max(0.5, b * 0.62 - round / 2)
        const toYou = you.x < -0.1 ? -1 : 1
        const asym = hearW * S.question * 0.22 * toYou - thinkW * 0.2 * side
        const top = clamp01(topS + bl * 0.5)
        const lower = clamp01(lowerS + bl * 0.45)
        const sag = mix.pick(SAG)
        const ax = Math.max(1, av - round / 2)
        if (showRim) {
          g.beginPath()
          visorPath(g, 0, 0, ax, bv, 6, top, slantS - sag, asym, smileS, lower, minH)
          g.lineJoin = "round"
          g.lineWidth = rimLine
          g.strokeStyle = ink.css(rimRgb, clamp01(rim) * (P.dark ? 0.85 : 1))
          if (glow) {
            g.shadowBlur = 0.22 * s * clamp01(rim)
            g.shadowColor = ink.css(rimRgb, 0.7 * clamp01(rim))
          }
          g.stroke()
          g.shadowBlur = 0
        }
        mixInto(barRgb, eyeRgb, P.bg, 0.7)
        const barCss = ink.css(barRgb, 1)
        g.beginPath()
        visorPath(g, 0, 0, ax, bv, 6, top, slantS - sag, asym, smileS, lower, minH)
        g.fillStyle = barCss
        g.strokeStyle = barCss
        g.lineJoin = "round"
        g.lineWidth = round
        g.fill()
        g.stroke()
        g.save()
        g.clip()
        g.fillStyle = ink.css(eyeRgb, 1)
        const lx = gaze.x * 0.14 * s
        const lw = a * 1.1
        const lh = bv * 1.55
        g.beginPath()
        for (let e = -1; e <= 1; e += 2) roundRect(g, e * sep * 0.62 + lx, 0, lw * (1 + 0.09 * gaze.x * e), lh, Math.min(lw, lh) * 0.42)
        g.fill()
        g.restore()
        if (visorK < 1) g.globalAlpha = 1
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
    },

    dispose() {}
  }
}

const design: Character = {
  id: "robot-eyes",
  name: "Robot eyes",
  version: "1.1.0",
  contract: 1,
  family: "figure",
  summary: "Two solid rounded eyes and nothing else: they doze, perk up, follow you, dart while thinking and squint happily as they talk; a rim light says whose voice it is.",
  inspiredBy: "Anki Cozmo and Vector's eye rig (squash, squint, saccade rate for thinking), EMO-style desk robots, the Rapport Agent's pause-timed nods.",
  modes: {
    idle: "Eyes almost shut in thin dim bars, outer corners drooping, breathing; now and then a slow half-open peek.",
    listening: "Eyes tall, a little larger and higher, on you, with a faint mint rim: perked up, your turn.",
    hearing: "Mint rim as bright as your voice; the eyes pulse on your syllables, dip in a nod at your pauses, tilt with one eye wider at a question, grow and draw together for a whisper, shrink and narrow at a shout.",
    thinking: "Lids lowered, the eye on the searching side narrower; the eyes dart quickly up and to one side; a slow amber pulse in the rim.",
    speaking: "Happy squint (bottom lids raised in a curve), amber rim as bright as the reply; the eyes bounce and stretch on each syllable, glance aside at the start of a phrase."
  },
  mappings: [
    { signal: "agent.onset × level", effect: "Eyes hop up (up to 9 % of the box) and squash-stretch per syllable (bounce spring; slower and bigger for a deep voice)." },
    { signal: "agent.level (envelope)", effect: "Amber rim brightness and glow; eye height up to +14 %; the happy squint deepens a little with loudness." },
    { signal: "agent.level over ~1 s", effect: "Soft vs loud reply: eye size ±7 % and openness." },
    { signal: "agent.register", effect: "Eye size +18 % for a deep voice, −6 % for a high one; bounce slower for deep." },
    { signal: "agent.pitchDelta", effect: "Lid slant: inner corners lift on rising pitch (a brow flash)." },
    { signal: "agent.speaking start", effect: "60 % of utterances start with a glance aside for 0.5–1.2 s." },
    { signal: "user.level (live)", effect: "Mint rim brightness and glow." },
    { signal: "user.onset × level", effect: "A small squash-and-stretch pulse per syllable, livelier with energy." },
    { signal: "user phrase end (pause after ≥ 0.6 s of speech)", effect: "A nod: the eyes dip and come back, with a blink." },
    { signal: "user.pitchDelta at phrase end (rising)", effect: "Eyes tilt and the eye on your side opens wider: curious, fades over ~3 s." },
    { signal: "user.level over 0.5 s (and voicing)", effect: "Whisper: eyes up to +14 % and closer together (leaning in), inner corners up. Shout: eyes shrink 12 %, top lids lower, inner corners down (bracing)." },
    { signal: "user.onset at level > 0.58", effect: "Flinch: a quick squeeze and shrink, habituating over 3 s." },
    { signal: "user.syllableRate and |pitchDelta|", effect: "Energy: fast excited speech opens the eyes wider; slow flat speech lowers the lids." },
    { signal: "user.register", effect: "Gaze height: a high or child voice is looked at lower, a deep voice higher." },
    { signal: "user.silenceFor mid-turn", effect: "Waiting: a soft lift of the bottom lids." },
    { signal: "pointer (inside)", effect: "Gaze follows it; the eye on that side grows (perspective)." },
    { signal: "mode", effect: "Pose blend over ~0.2 s: openness, lid height, squint, size, height, droop; rim colour mint → amber." },
    { signal: "time (seeded)", effect: "Blinks every ~2.4–4.8 s with doubles and on big saccades; saccade hold 0.28 s thinking, 1.2–1.4 s otherwise, 3.5 s idle; dozing peeks every 7–13 s." },
    { signal: "reducedMotion", effect: "Held poses: no blinks, saccades, nods, bounces, breathing, peeks or rim pulse; the rim steps in thirds; whisper/shout/energy poses change in held steps." },
    {
      signal: "options",
      effect:
        "Size (capped so the eyes stay in frame), eye shape (rounded, round, tall morph over ~0.2 s; visor cross-fades), eye colour, rim thickness (at 0 the eyes take the voice colour instead); expressiveness scales nods, hops, squash, tilt and lid poses; liveliness divides blink and saccade intervals; nods and pointer-following switch off."
    }
  ],
  uses: [
    { ext: "speech.words", gain: "The bounce lands exactly on stressed syllables instead of detected onsets.", without: "Syllable onsets detected from the reply audio." },
    { ext: "reply.expression", gain: "Chooses between a handful of distinct eye poses for speaking (question, apology, good news).", without: "One pleasant squint." }
  ],
  renderer: "2d",
  canvas: "stage",
  options: [
    sizeOption(0.5, 1.25),
    {
      id: "eyeShape",
      kind: "choice",
      label: "Eye shape",
      choices: [
        { value: "rounded", label: "Rounded" },
        { value: "round", label: "Round" },
        { value: "tall", label: "Tall" },
        { value: "visor", label: "Visor" }
      ],
      default: "rounded",
      group: APPEARANCE,
      help: "Soft squares, circles, tall pills, or one visor bar with two lights inside."
    },
    { id: "eyeColor", kind: "color", label: "Eye colour", default: "ink", group: APPEARANCE, help: "The colour of the eyes; the default follows the theme's ink." },
    {
      id: "rimLight",
      kind: "number",
      label: "Rim light",
      min: 0,
      max: 2.5,
      step: 0.1,
      default: 1,
      unit: "×",
      group: APPEARANCE,
      help: "Thickness of the coloured rim that shows whose voice it is; at 0 the eyes take on that colour instead."
    },
    EXPRESSIVENESS,
    LIVELINESS,
    nodsOption("Dips its eyes at the end of each of your phrases, the way a listener nods."),
    FOLLOWS_POINTER
  ],
  create
}

export default design
