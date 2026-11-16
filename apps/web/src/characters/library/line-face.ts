/**
 * Line face: a face in a handful of confident strokes, in the vocabulary of a comic strip.
 * Two dot eyes, two short brows, one mouth line, an open head contour. Sound marks around the
 * head carry the person's voice inward while it listens; the mouth carries the reply.
 *
 * Geometry is in face units (the head contour has radius 1), drawn through one canvas
 * transform that also carries the head tilt, so every stroke scales with the size.
 */
import type { Character, CharacterInstance, Frame } from "../contract.ts"
import { approach, clamp, clamp01, clear2d, lerp, noise2, optChoice, optNumber, remap, rng, setup2d, TAU } from "../kit.ts"
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
  lineWeightOption,
  LIVELINESS,
  mixInto,
  ModeMix,
  Mouth,
  MOUTH_RANGE,
  mouthPath,
  nodsOption,
  Personality,
  Social,
  sized,
  sizeOption,
  youDirection
} from "../shared/figure.ts"

//                         idle   listen  hear   think  speak
const EYE_OPEN: Five = [0, 1, 1, 0.72, 0.92]
const BROW_UP: Five = [-0.03, 0.07, 0.03, 0.02, 0.03]
const SMILE: Five = [0.1, 0.45, 0.2, -0.1, 0.3]
const DROP: Five = [0.07, -0.02, 0, 0, 0]
const ALERT: Five = [0, 1, 1, 1, 1]
const MARKS: Five = [0, 1, 1, 0, 0]
const HEAD_TILT: Five = [0.1, -0.04, 0, 0, 0]
const BLINK_MEAN: Five = [4, 4.5, 4.8, 2.6, 3.2]

/** "Style" choice → head outline shown, brows shown, brows bold (each 0..1). */
const STYLE: { readonly [k: string]: readonly [outline: number, brows: number, bold: number] } = {
  sketch: [1, 1, 0],
  boldBrows: [1, 1, 1],
  noOutline: [0, 1, 0],
  minimal: [0, 0, 0]
}

/** Two concentric arcs, one each side of the head, at radius `r` and half-angle `span`. */
const drawMarkPair = (g: CanvasRenderingContext2D, r: number, span: number, width: number, css: string): void => {
  g.lineWidth = width
  g.strokeStyle = css
  g.beginPath()
  g.arc(0, 0, r, -span, span)
  g.moveTo(-r * Math.cos(span), -r * Math.sin(span))
  g.arc(0, 0, r, Math.PI + span, Math.PI - span, true)
  g.stroke()
}

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  const mix = new ModeMix()
  const seed = instanceSeed(3)
  const social = new Social(seed)
  const blinkL = new Blinker(seed + 1)
  const gaze = new Gaze(seed + 2)
  const mouth = new Mouth()
  const ink = new Ink()
  const rand = rng(seed + 3)
  const pers = new Personality()
  const gSize = new Glide(1)
  const gWeight = new Glide(1)
  const gOutline = new Glide(1)
  const gBrows = new Glide(1)
  const gBold = new Glide(0)
  const you = { x: 0, y: 0 }
  const strokeRgb: [number, number, number] = [0, 0, 0]
  const mouthRgb: [number, number, number] = [0, 0, 0]
  // Sound marks: one per syllable onset of the person, travelling in over MARK_LIFE seconds.
  const MARKS_N = 10
  const MARK_LIFE = 1.3
  const markAge = new Float32Array(MARKS_N).fill(99)
  const markPower = new Float32Array(MARKS_N)
  let markNext = 0
  let lastOnset = 0
  let markLevel = 0
  let dotsPhase = 0
  let tiltS = 0
  let scaleS = 1
  let lidS = 0
  let browS = 0
  let qS = 0

  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f: Frame) {
      const dt = f.dt
      const P = f.palette
      const reduced = f.reducedMotion
      pers.read(f)
      mix.step(f, 0.24)
      social.step(f, pers)
      const S = social
      // Appearance options, gliding (snap on the first frame and under reduced motion).
      const look = STYLE[optChoice(f.options, "style")] ?? STYLE.sketch!
      const size = gSize.step(optNumber(f.options, "size"), f)
      const weight = gWeight.step(optNumber(f.options, "lineWeight"), f, 0.15)
      const outlineA = gOutline.step(look[0], f, 0.2)
      const browA = gBrows.step(look[1], f, 0.2)
      const bold = gBold.step(look[2], f, 0.2)

      // ---- Layout: the face box is 3.0 × 2.5 units (head plus sound marks), centred; the size
      // option scales it, never past the 3.1 × 2.45 units its head, marks and motion really use.
      const s = sized(fit(W, H, 3.0, 2.55, 0.94), size, W, H, 3.1, 2.45)
      const cx = W / 2
      const cy = H / 2

      // ---- Gaze target per mode.
      youDirection(f, cx, cy, s * 2.2, you, pers.followsPointer)
      const side = S.thinkSide
      let gx = you.x
      let gy = you.y + (mix.hearing > 0.5 ? (S.regard - 0.45) * 0.7 : 0)
      let spread = 0.08
      let hold = 1.3
      if (f.mode === "thinking") {
        gx = 0.75 * side
        gy = -0.75
        spread = 0.45
        hold = 0.32
      } else if (f.mode === "speaking") {
        gx = lerp(gx, 0.75 * S.lookSide, S.lookAway)
        gy = lerp(gy, -0.25, S.lookAway)
        hold = 1.1
      } else if (f.mode === "idle") {
        gy = 0.4
        spread = 0.2
        hold = 3
      }
      gaze.step(dt, gx, gy, spread, hold / pers.liveliness, reduced)
      if (gaze.saccade && f.mode !== "idle" && rand() < 0.3) blinkL.trigger()
      if (S.ack) blinkL.trigger()
      const blink = blinkL.step(dt, mix.pick(BLINK_MEAN) / pers.liveliness, !reduced && mix.idle < 0.5)

      // ---- Pose.
      const breathe = reduced ? 0 : noise2(f.t * 0.18, 3.1) * 0.5 + Math.sin(f.t * TAU * (mix.idle > 0.5 ? 0.17 : 0.24)) * 0.5
      const hearW = mix.hearing
      const speakW = mix.speaking
      // Lean in for quiet speech, pull back from shouting; a flinch on a loud onset.
      const scaleT = 1 + 0.11 * S.lean * hearW - 0.07 * S.brace * hearW - 0.06 * S.flinch + 0.02 * S.talkSlow * speakW
      scaleS = reduced ? scaleT : approach(scaleS, scaleT, dt, 0.18)
      qS = approach(qS, S.question, dt, reduced ? 0 : 0.2)
      const tiltT = mix.pick(HEAD_TILT) + 0.07 * side * mix.thinking + 0.4 * qS * hearW * (you.x < -0.1 ? -1 : 1) + 0.03 * S.lean * hearW
      tiltS = reduced ? tiltT : approach(tiltS, tiltT, dt, 0.3)
      const scale = scaleS * (1 + breathe * 0.008)
      const nodY = 0.09 * S.nod + 0.025 * S.follow * hearW - 0.035 * S.beat * speakW
      const drop = mix.pick(DROP) + breathe * 0.012

      // Eyes: open by mode; wider with the person's energy and for a whisper; squint at a shout.
      const energyEye = hearW * (0.6 * (S.energy - 0.45) + 0.15 * Math.max(0, S.lean)) + speakW * 0.5 * (S.talkSlow - 0.3)
      const lidT = clamp(mix.pick(EYE_OPEN) + energyEye - 0.35 * S.brace * hearW - 0.5 * S.flinch, 0, 1.25)
      lidS = reduced ? lidT : approach(lidS, lidT, dt, 0.09)
      const open = lidS * (1 - blink)
      // Brows: mode, live intonation, a lift for questions and energy, pulled down by a shout.
      const browT =
        mix.pick(BROW_UP) +
        hearW * (0.05 * S.brow + 0.1 * (S.energy - 0.45) + 0.04 * Math.max(0, S.lean) - 0.08 * S.brace + 0.04 * S.waiting) +
        speakW * (0.045 * clamp(f.agent.pitchDelta / 10, -1, 1) * (reduced ? 0 : 1) * S.expr + 0.12 * (S.talkSlow - 0.3)) -
        0.06 * S.flinch
      browS = reduced ? browT : approach(browS, browT, dt, 0.12)
      const browInner = -0.09 * S.brace * hearW + 0.05 * S.waiting + 0.04 * mix.listening

      const reg01 = remap(S.regard, 0.15, 0.82, 0, 1)

      // ---- Colours.
      const alert = mix.pick(ALERT)
      mixInto(strokeRgb, P.inkFaint, P.ink, alert)
      mixInto(mouthRgb, strokeRgb, P.voice, speakW)

      clear2d(g, dpr)
      // Tilt about the neck (below the chin), so the whole head swings, not just its features.
      const pivot = 1.5 * s * scale
      g.translate(cx, cy + drop * s + pivot)
      g.rotate(tiltS)
      g.translate(0, -pivot)
      g.scale(s * scale, s * scale)
      g.lineCap = "round"
      g.lineJoin = "round"
      const lw = Math.max(1.6 / (s * scale), 0.042) * weight

      // Head contour: an open circle, the gap where a brush would lift. Turns a little with gaze.
      const turn = gaze.x * 0.05
      if (outlineA > 0.01) {
        g.lineWidth = lw * 0.8
        g.strokeStyle = ink.css(strokeRgb, (0.32 + 0.18 * alert) * outlineA)
        g.beginPath()
        g.arc(turn * 0.4, 0, 1, -1.25, 4.7)
        g.stroke()
      }

      // Sound marks: concentric arcs travelling in toward the head. Each syllable onset of the
      // person launches one, so fast speech has many in flight and slow speech few; loudness sets
      // their weight and length, the register their spacing ("wavelength") and thickness.
      const marks = mix.pick(MARKS)
      const u = f.user
      if (!reduced) {
        if (S.userTalking && u.onset > 0.95 && lastOnset <= 0.95) {
          markAge[markNext] = 0
          markPower[markNext] = Math.max(0.1, u.level)
          markNext = (markNext + 1) % MARKS_N
        }
        for (let i = 0; i < MARKS_N; i++) markAge[i] = markAge[i]! + dt
      }
      lastOnset = u.onset
      if (marks > 0.02) {
        const youRgb = P.you
        const light = P.dark ? 1 : 1.35 // mint needs more weight on the light page
        const regK = reg01 * hearW + 0.5 * (1 - hearW)
        const weight = lerp(1.4, 0.65, regK)
        const travel = lerp(0.5, 0.26, regK)
        if (reduced || mix.listening > 0.5) {
          // A still pose: listening shows one quiet mark a side; hearing shows three, sized by
          // the person's held loudness.
          const lvT = hearW * (S.userTalking ? Math.max(0.12, u.level) : 0.1)
          markLevel = reduced ? Math.round(lvT * 4) / 4 : lvT
          const n = mix.listening > 0.5 ? 1 : 3
          for (let i = 0; i < n; i++) {
            const lv = mix.listening > 0.5 ? 0.05 : markLevel
            drawMarkPair(g, 1.15 + (i * travel) / 2.5, 0.16 + 0.42 * clamp01(lv * 1.4), lw * weight * (0.6 + 0.9 * clamp01(lv * 1.6)), ink.css(youRgb, marks * light * (0.3 + 0.7 * clamp01(lv * 2.2))))
          }
        } else {
          // The ear mark: always there while hearing, brighter and longer with your level.
          const lvT = S.userTalking ? Math.max(0.1, u.level) : 0.06
          markLevel = approach(markLevel, lvT, dt, lvT > markLevel ? 0.04 : 0.25)
          const ea = marks * light * (0.45 + 0.55 * clamp01(markLevel * 2))
          drawMarkPair(g, 1.15, 0.2 + 0.36 * clamp01(markLevel * 1.4), lw * weight * (0.7 + 0.8 * clamp01(markLevel * 1.6)), ink.css(youRgb, ea))
          for (let i = 0; i < MARKS_N; i++) {
            const age = markAge[i]!
            if (age >= MARK_LIFE) continue
            const d = age / MARK_LIFE // 0 far .. 1 arrived
            const pw = markPower[i]!
            const a = marks * light * Math.sin(Math.PI * Math.min(1, d * 1.1)) * (0.3 + 0.7 * clamp01(pw * 2.2))
            if (a < 0.02) continue
            drawMarkPair(g, 1.15 + travel * (1.2 - d), 0.14 + 0.46 * clamp01(pw * 1.4), lw * weight * (0.55 + 1.0 * clamp01(pw * 1.6)), ink.css(youRgb, a))
          }
        }
      }

      // Features move with the gaze (a head turn), the nod and the drop.
      const fx = gaze.x * 0.1
      const fy = gaze.y * 0.05 + nodY + (reg01 - 0.45) * 0.12 * hearW
      const ex = 0.36
      const ey = -0.1 + fy
      const px = gaze.x * 0.07
      const py = gaze.y * 0.055

      // Eyes.
      g.strokeStyle = ink.css(strokeRgb, 1)
      g.fillStyle = ink.css(strokeRgb, 1)
      g.lineWidth = lw
      // Eye dots grow a little with the line weight, so bold lines do not dwarf them.
      const ew = 0.75 + 0.25 * weight
      const rx = 0.068 * ew
      const ry = 0.1 * ew
      for (let e = -1; e <= 1; e += 2) {
        const x = fx + e * ex + px
        const y = ey + py
        if (open > 0.16) {
          g.beginPath()
          g.ellipse(x, y + ry * (1 - open) * 0.6, rx, Math.max(0.012, ry * open), 0, 0, TAU)
          g.fill()
        } else {
          // Closed: a soft downward arc (resting) that flattens into a line mid-blink.
          const sag = mix.idle > 0.5 ? 0.05 : 0.015
          g.beginPath()
          g.moveTo(x - rx * 1.25, y)
          g.quadraticCurveTo(x, y + sag * 2, x + rx * 1.25, y)
          g.stroke()
        }
      }

      // Brows: one raised higher than the other for a question or while thinking. "Bold" brows
      // are straight, heavy bars (the same motion); "Minimal" fades them out.
      if (browA > 0.01) {
        g.lineWidth = lw * 0.9 + 0.05 * bold
        if (browA < 1) g.strokeStyle = ink.css(strokeRgb, browA)
        for (let e = -1; e <= 1; e += 2) {
          const asym = (e === side ? 1 : -0.3) * 0.06 * mix.thinking + (e === (you.x < -0.1 ? -1 : 1) ? 0.12 : -0.02) * qS * hearW
          const x0 = fx * 1.1 + e * 0.22
          const x1 = fx * 1.1 + e * 0.5
          const yb = -0.36 + fy * 0.9 - browS - asym
          const y0 = yb - browInner
          const y1 = yb + 0.02
          g.beginPath()
          g.moveTo(x0, y0)
          g.quadraticCurveTo((x0 + x1) / 2, lerp(yb - 0.04, (y0 + y1) / 2, bold), x1, y1)
          g.stroke()
        }
      }

      // Mouth.
      mouth.step(f, S.size, speakW, pers.mouthRange)
      const smile = mix.pick(SMILE) + hearW * (0.08 * S.waiting - 0.25 * S.brace) + 0.15 * (S.ack ? 1 : 0)
      const mx = fx * 0.8 + 0.12 * side * mix.thinking
      const my = 0.4 + fy * 0.8
      const sizeK = (0.9 + 0.22 * S.size) * (1 + speakW * (0.9 * S.talkSlow - 0.3))
      const hw = (0.17 - 0.05 * mix.thinking) * (1 + 0.45 * mouth.wide - 0.38 * mouth.round) * sizeK
      const engaged = hearW * 0.07 * remap(S.energy, 0.55, 0.95, 0, 1) // an engaged, slightly open smile
      const mh = (0.42 * mouth.open + 0.08 * mouth.round + 0.07 * mouth.teeth) * sizeK + engaged
      const lift = smile * 0.07
      g.strokeStyle = ink.css(mouthRgb, 1)
      g.lineWidth = lw
      if (mh < 0.025) {
        const slant = 0.03 * mix.thinking * side
        g.beginPath()
        g.moveTo(mx - hw, my - lift + slant)
        g.quadraticCurveTo(mx, my + lift * 1.6, mx + hw, my - lift - slant)
        g.stroke()
      } else {
        g.fillStyle = speakW > 0.5 ? ink.css(P.voice, 0.16 + 0.1 * mouth.open) : ink.css(strokeRgb, 0.12)
        g.beginPath()
        mouthPath(g, mx, my - lift * 0.5, hw, mh * (0.22 + 0.5 * mouth.round), mh * (0.85 - 0.2 * mouth.round), lift * 0.6, 0.25 + 0.6 * mouth.wide)
        g.fill()
        g.stroke()
        if (mouth.teeth > 0.15) {
          g.lineWidth = lw * 0.7
          g.strokeStyle = ink.css(mouthRgb, clamp01(mouth.teeth * 1.5))
          g.beginPath()
          g.moveTo(mx - hw * 0.62, my - mh * 0.08)
          g.lineTo(mx + hw * 0.62, my - mh * 0.08)
          g.stroke()
        }
      }

      // Thinking: three dots above, on the side the eyes search, filling in turn.
      if (mix.thinking > 0.02) {
        if (!reduced) dotsPhase = (dotsPhase + dt / 1.3) % 1
        for (let i = 0; i < 3; i++) {
          const on = reduced ? 0.7 : clamp01((dotsPhase * 4 - i) * 1.5) * (dotsPhase < 0.85 ? 1 : 1 - (dotsPhase - 0.85) / 0.15)
          const a = mix.thinking * (0.18 + 0.82 * on)
          g.fillStyle = ink.css(P.voice, a)
          g.beginPath()
          g.arc(side * (0.55 + i * 0.19), -0.9 - i * 0.075, 0.045 + i * 0.012, 0, TAU)
          g.fill()
        }
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
    },

    dispose() {}
  }
}

const character: Character = {
  id: "line-face",
  name: "Line face",
  version: "1.0.0",
  contract: 1,
  family: "figure",
  summary: "A face in a few confident strokes: dot eyes, short brows, one mouth line, and comic-strip sound marks that carry your voice in.",
  inspiredBy:
    "Comic-strip shorthand (sound marks, thought dots), the Rapport Agent's contingent nods, Rhubarb-style hand-drawable mouth shapes, Cozmo's saccade timing for thinking.",
  modes: {
    idle: "Faint grey strokes, eyes closed in soft arcs, head dropped and tilted, breathing slowly.",
    listening: "Strokes darken, eyes open on you, brows lifted, a small smile; one still mint mark on each side: ears open.",
    hearing: "Mint sound marks travel in toward the head, sized by your voice; it nods at your phrase ends, looks curious at questions, leans in for a whisper and pulls back from a shout.",
    thinking: "Eyes up to one side darting quickly, lids lowered, one brow up, mouth pushed aside; three amber dots fill in turn.",
    speaking: "The mouth opens, widens, rounds and shows a teeth line on 's', outlined in amber; the head bobs on syllables, brows flash on rising pitch, eyes look aside at the start of a phrase."
  },
  mappings: [
    { signal: "agent.mouth.open / wide / round", effect: "Mouth height (33 % of a unit), width (+45 % wide, −38 % round) and rounding; rise 25 ms, fall 60 ms, slower for a deep voice." },
    { signal: "agent.sibilance (with jaw closed)", effect: "Lips part slightly and a teeth line appears across the mouth ('s', 'sh')." },
    { signal: "agent.register", effect: "Mouth size ±11 % and its smoothing time ×0.75..1.35: a deep voice moves bigger and slower." },
    { signal: "agent.onset × level", effect: "A small upward head bob per syllable (bounce spring)." },
    { signal: "agent.pitchDelta", effect: "Brows lift on rising pitch, drop slightly on falling." },
    { signal: "agent.level over ~1 s", effect: "Soft vs loud reply: brow height, eye openness, face scale +2 %." },
    { signal: "agent.speaking start", effect: "60 % of utterances start with a glance aside for 0.5–1.2 s, then back to you." },
    { signal: "user phrase end (silenceFor after ≥ 0.6 s of speech)", effect: "A nod 0.05–0.25 s after the pause begins, with a blink and a smile flicker; bigger after a long phrase." },
    { signal: "user.pitchDelta at phrase end (rising)", effect: "Instead of a nod: head tilt toward you and one brow up, fading over ~3 s." },
    { signal: "user.pitchDelta (live)", effect: "Brows follow your intonation a little." },
    { signal: "user.level over 0.5 s (and voicing)", effect: "Whisper or soft: leans in (face up to +11 %), eyes and brows lift. Loud or shouting: pulls back (−7 %), squints, brows down and in." },
    { signal: "user.onset at level > 0.58", effect: "Flinch: face shrinks 6 % and eyes squeeze, less each time (habituates over 3 s)." },
    { signal: "user.level (live)", effect: "Sound marks: size, thickness, opacity and inward speed." },
    { signal: "user.syllableRate and |pitchDelta|", effect: "Energy: slow flat speech gets lower lids and calmer marks; fast excited speech wider eyes, higher brows, faster marks." },
    { signal: "user.register", effect: "Where it looks: a high or child voice is looked at slightly lower, a deep voice slightly higher." },
    { signal: "user.silenceFor mid-turn", effect: "Waiting: brows soften upward and the smile grows a little." },
    { signal: "pointer (inside)", effect: "Eyes, head turn and tilt direction follow it." },
    { signal: "mode", effect: "Pose blend over ~0.25 s: eye openness, brows, smile, head drop and tilt, stroke colour (faint grey idle to ink), mint marks, amber mouth, thinking dots." },
    { signal: "time (seeded)", effect: "Blinks every ~2.6–4.8 s with doubles, micro-saccades, slow breathing; none of it in reduced motion." },
    { signal: "reducedMotion", effect: "Poses only: no blinks, saccades, nods, bobs, breathing or travelling marks; mouth held half open while speaking; loudness and energy change the pose in held steps." },
    {
      signal: "options",
      effect:
        "Size (capped so head, marks and motion stay in frame), style (head line on/off, curved, bold or no brows) and line weight glide over ~0.2 s; expressiveness scales nods, bobs, tilt, lean, flinch and brows; liveliness divides blink and glance intervals; mouth range scales the opening; nods and pointer-following switch off."
    }
  ],
  uses: [
    {
      ext: "speech.phonemes",
      gain: "Exact mouth shapes from the speech engine's phoneme or viseme timings, notably closed lips on m, b and p.",
      without: "The mouth follows the spectral estimate."
    },
    {
      ext: "reply.expression",
      gain: "A matching expression (for example a question or a warm reply) instead of a neutral pleasant one.",
      without: "A neutral pleasant face; core-driven motion only."
    }
  ],
  renderer: "2d",
  options: [
    sizeOption(0.5, 1.1),
    {
      id: "style",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "sketch", label: "Sketch" },
        { value: "boldBrows", label: "Bold brows" },
        { value: "noOutline", label: "No outline" },
        { value: "minimal", label: "Minimal" }
      ],
      default: "sketch",
      group: APPEARANCE,
      help: "With or without the head line, and with curved, bold or no brows."
    },
    lineWeightOption("How heavy every stroke is, from a fine pen to a marker."),
    EXPRESSIVENESS,
    LIVELINESS,
    MOUTH_RANGE,
    nodsOption(),
    FOLLOWS_POINTER
  ],
  create
}

export default character
