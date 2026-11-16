/**
 * Profile head: a head in side profile, drawn as one contour, facing right, toward you. The most
 * literal design of the set: your voice arrives as mint wavefronts that converge on the ear and
 * drop into the head as dots (one per syllable you say); while it thinks the dots swirl, link up
 * and turn amber; while it speaks they flow to the mouth and leave it as amber wavefronts, with
 * the jaw moving to the reply. What you said is visibly what it works with.
 *
 * The contour is precomputed once as a polyline (from cubic Béziers in head units) with a jaw
 * weight per point, so the jaw can rotate open about its hinge without any per-frame allocation.
 */
import type { Character, CharacterInstance, Frame } from "../contract.ts"
import { approach, clamp, clamp01, clear2d, lerp, noise2, optChoice, optNumber, rng, setup2d, TAU } from "../kit.ts"
import {
  APPEARANCE,
  Blinker,
  Dip,
  EXPRESSIVENESS,
  type Five,
  fit,
  Glide,
  Ink,
  instanceSeed,
  lineWeightOption,
  LIVELINESS,
  mixInto,
  ModeMix,
  Mouth,
  MOUTH_RANGE,
  nodsOption,
  Personality,
  Social,
  sized,
  sizeOption,
  SoftSpot
} from "../shared/figure.ts"

// ---- Contour, in head units (ear near the origin, y down, facing +x).
type Seg = readonly [number, number, number, number, number, number, number, number]
// Upper contour: from the back of the neck, over the skull and face, to the mouth corner.
const UPPER: ReadonlyArray<Seg> = [
  [-0.36, 1.3, -0.4, 1.0, -0.44, 0.8, -0.5, 0.62],
  [-0.5, 0.62, -0.98, 0.42, -1.06, -0.55, -0.45, -1.02],
  [-0.45, -1.02, 0.05, -1.32, 0.66, -1.08, 0.78, -0.5],
  [0.78, -0.5, 0.8, -0.38, 0.76, -0.3, 0.79, -0.22],
  [0.79, -0.22, 0.86, -0.08, 1.03, 0.02, 1.0, 0.09],
  [1.0, 0.09, 0.98, 0.14, 0.9, 0.13, 0.87, 0.16],
  [0.87, 0.16, 0.9, 0.2, 0.92, 0.25, 0.9, 0.29],
  [0.9, 0.29, 0.86, 0.31, 0.8, 0.31, 0.76, 0.31]
]
// Lower contour: from the mouth corner, over the lower lip and chin, under the jaw, down the neck.
const LOWER: ReadonlyArray<Seg> = [
  [0.76, 0.31, 0.82, 0.32, 0.9, 0.34, 0.89, 0.4],
  [0.89, 0.4, 0.88, 0.45, 0.82, 0.46, 0.8, 0.49],
  [0.8, 0.49, 0.86, 0.56, 0.84, 0.68, 0.66, 0.71],
  [0.66, 0.71, 0.44, 0.74, 0.3, 0.78, 0.27, 0.92],
  [0.27, 0.92, 0.25, 1.05, 0.26, 1.18, 0.28, 1.3]
]
const PER_SEG = 10
const HINGE_X = -0.02
const HINGE_Y = 0.12

const sample = (segs: ReadonlyArray<Seg>, xs: Float32Array, ys: Float32Array): void => {
  let k = 0
  for (let si = 0; si < segs.length; si++) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = segs[si]!
    for (let j = si === 0 ? 0 : 1; j <= PER_SEG; j++) {
      const t = j / PER_SEG
      const u = 1 - t
      xs[k] = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3
      ys[k] = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
      k++
    }
  }
}
const countOf = (segs: ReadonlyArray<Seg>): number => segs.length * PER_SEG + 1
const NU = countOf(UPPER)
const NL = countOf(LOWER)
const UX = new Float32Array(NU)
const UY = new Float32Array(NU)
const LX = new Float32Array(NL)
const LY = new Float32Array(NL)
sample(UPPER, UX, UY)
sample(LOWER, LX, LY)
// Jaw weight on the lower contour: the lips and chin follow the jaw fully; the neck not at all.
const LW = new Float32Array(NL)
for (let i = 0; i < NL; i++) LW[i] = 1 - clamp01((LY[i]! - 0.72) / 0.22)

// Mind region (inside the cranium) and key points.
const MIND_X = -0.12
const MIND_Y = -0.42
const MIND_RX = 0.52
const MIND_RY = 0.36
const EAR_X = -0.04
const EAR_Y = 0.06
const MOUTH_X = 0.93
const MOUTH_Y = 0.33
const EYE_X = 0.6
const EYE_Y = -0.2

//                          idle   listen hear   think  speak
const PITCH: Five = [0.14, -0.03, 0, -0.05, 0] // head rotation, positive = chin down
const EYE_OPEN: Five = [0, 1, 1, 0.8, 0.95]
const ALERT: Five = [0, 1, 1, 1, 1]
const BLINK_MEAN: Five = [5, 4.2, 4.8, 2.8, 3.3]

const DOTS = 30
const WAVES = 10

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1 // the focus box's size, set each frame
  let H = 1
  let CW = 1 // the canvas (the whole stage)
  let CH = 1
  let dpr = 1
  const seed = instanceSeed(11)
  const mix = new ModeMix()
  const social = new Social(seed)
  const blink = new Blinker(seed + 1)
  const rand = rng(seed + 2)
  const mouth = new Mouth()
  const ink = new Ink()
  const earSpot = new SoftSpot()
  const lineRgb: [number, number, number] = [0, 0, 0]
  const dotRgb: [number, number, number] = [0, 0, 0]
  const pers = new Personality()
  const gSize = new Glide(1)
  const gWeight = new Glide(1)
  const gSolid = new Glide(0)
  const facing = new Dip<string>("right")
  // Per-frame transformed contour.
  const ux = new Float32Array(NU)
  const uy = new Float32Array(NU)
  const lx = new Float32Array(NL)
  const ly = new Float32Array(NL)
  // Dots in the mind (head units).
  const dx = new Float32Array(DOTS)
  const dy = new Float32Array(DOTS)
  const hx = new Float32Array(DOTS) // home, relative to the mind centre, in −1..1
  const hy = new Float32Array(DOTS)
  const dc = new Float32Array(DOTS) // colour −1 neutral, 0 mint .. 1 amber
  const delay = new Float32Array(DOTS)
  const life = new Float32Array(DOTS) // 0 off .. 1 on
  const leaving = new Uint8Array(DOTS)
  const born = new Float32Array(DOTS)
  // Wavefronts: incoming (to the ear) and outgoing (from the mouth).
  const inAge = new Float32Array(WAVES).fill(99)
  const inPow = new Float32Array(WAVES)
  const outAge = new Float32Array(WAVES).fill(99)
  const outPow = new Float32Array(WAVES)
  let inNext = 0
  let outNext = 0
  let lastUserOnset = 0
  let lastAgentOnset = 0
  let swirl = 0
  let pitchS = 0.14
  let jawS = 0
  let earS = 0
  let browS = 0
  let clock = 0
  let sinceSpawn = 0
  for (let i = 0; i < DOTS; i++) {
    const a = rand() * TAU
    const r = Math.sqrt(rand())
    hx[i] = Math.cos(a) * r
    hy[i] = Math.sin(a) * r
    delay[i] = rand()
    dx[i] = MIND_X + hx[i]! * MIND_RX
    dy[i] = MIND_Y + MIND_RY * 0.8
    life[i] = i < 4 ? 0.4 : 0
    dc[i] = -1 // neutral until your words fill the head
  }

  const spawnDot = (fromEar: boolean, colour: number): void => {
    // Reuse an off dot, else the oldest.
    let best = 0
    let bestBorn = Infinity
    for (let i = 0; i < DOTS; i++) {
      if (life[i]! <= 0.01 && leaving[i] === 0) {
        best = i
        bestBorn = -1
        break
      }
      if (born[i]! < bestBorn) {
        bestBorn = born[i]!
        best = i
      }
    }
    dx[best] = fromEar ? EAR_X + 0.05 : MIND_X + hx[best]! * MIND_RX * 0.5
    dy[best] = fromEar ? EAR_Y - 0.05 : MIND_Y + hy[best]! * MIND_RY * 0.5
    dc[best] = colour
    life[best] = fromEar ? 1 : 0.05
    leaving[best] = 0
    born[best] = clock
  }
  // Head units → canvas pixels: rotation about the neck pivot (0, 1), scale, offset. Its state is
  // set once per frame; the functions themselves are created once.
  let Tcp = 1
  let Tsp = 0
  let Tox = 0
  let Toy = 0
  let Ts = 1
  const tx = (x: number, y: number): number => Tox + (x * Tcp - (y - 1) * Tsp) * Ts
  const ty = (x: number, y: number): number => Toy + (x * Tsp + (y - 1) * Tcp + 1) * Ts
  /** Adds the closed head outline (current frame) to the path. */
  const headPath = (gg: CanvasRenderingContext2D): void => {
    gg.moveTo(ux[0]!, uy[0]!)
    for (let i = 1; i < NU; i++) gg.lineTo(ux[i]!, uy[i]!)
    for (let i = 0; i < NL; i++) gg.lineTo(lx[i]!, ly[i]!)
    gg.closePath()
  }
  const activeCount = (): number => {
    let n = 0
    for (let i = 0; i < DOTS; i++) if (life[i]! > 0.3 && leaving[i] === 0) n++
    return n
  }

  return {
    resize(width, height, ratio) {
      CW = width
      CH = height
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f: Frame) {
      const fo = f.focus
      W = fo.width
      H = fo.height
      const dt = f.dt
      const P = f.palette
      const reduced = f.reducedMotion
      clock += dt
      sinceSpawn += dt
      pers.read(f)
      mix.step(f, 0.25)
      social.step(f, pers)
      const S = social
      // Appearance options: size, weight and the silhouette glide; turning to face the other way
      // is a quick fade out and in (a mirror has no in-between).
      const size = gSize.step(optNumber(f.options, "size"), f)
      const weight = gWeight.step(optNumber(f.options, "lineWeight"), f, 0.15)
      const solid = gSolid.step(optChoice(f.options, "style") === "silhouette" ? 1 : 0, f, 0.25)
      facing.step(optChoice(f.options, "facing") === "left" ? "left" : "right", f)
      const fade = facing.alpha
      const hearW = mix.hearing
      const speakW = mix.speaking
      const thinkW = mix.thinking
      const u = f.user
      const a = f.agent

      // Layout: box 3.5 × 2.75 units; the head sits left of centre, the sound has room on the right.
      // The size option scales it, never past the 3.3 × 2.44 units the skull and face need (the
      // neck may run off the bottom, as in a portrait).
      const s = sized(fit(W, H, 3.5, 2.75, 0.94), size, W, H, 3.3, 2.44)
      const ox = W / 2 - 0.55 * s
      const oy = H / 2 - 0.02 * s

      // ---- Events: syllables become waves and dots.
      const userOnset = S.userTalking && u.onset > 0.95 && lastUserOnset <= 0.95
      lastUserOnset = u.onset
      const agentOnset = f.mode === "speaking" && a.speaking && a.onset > 0.95 && lastAgentOnset <= 0.95
      lastAgentOnset = a.onset
      if (!reduced) {
        if (userOnset) {
          inAge[inNext] = 0
          inPow[inNext] = Math.max(0.12, u.level)
          inNext = (inNext + 1) % WAVES
        }
        if (agentOnset) {
          outAge[outNext] = 0
          outPow[outNext] = Math.max(0.12, a.level)
          outNext = (outNext + 1) % WAVES
          // One dot leaves for the mouth with each syllable.
          let pick = -1
          let px = -9
          for (let i = 0; i < DOTS; i++) {
            if (life[i]! > 0.3 && leaving[i] === 0 && dx[i]! > px) {
              px = dx[i]!
              pick = i
            }
          }
          if (pick >= 0) leaving[pick] = 1
        }
        for (let i = 0; i < WAVES; i++) {
          inAge[i] = inAge[i]! + dt
          outAge[i] = outAge[i]! + dt
        }
      }
      // An incoming wave reaching the ear drops a mint dot into the mind.
      if (!reduced) {
        for (let i = 0; i < WAVES; i++) {
          const ag = inAge[i]!
          if (ag >= 0.8 && ag - dt < 0.8) spawnDot(true, 0)
        }
        // Keep material to work with: thinking and speaking grow a few amber dots if the mind is
        // nearly empty (a pinned mode), idle lets them fade to a few resting ones.
        const n = activeCount()
        if ((f.mode === "thinking" && n < 14) || (f.mode === "speaking" && n < 6)) {
          if (sinceSpawn > 0.18) {
            spawnDot(false, 1)
            sinceSpawn = 0
          }
        }
      }

      // ---- Pose.
      mouth.step(f, S.size, speakW, pers.mouthRange)
      const breathe = reduced ? 0 : Math.sin(clock * 1.2) * 0.6 + noise2(clock * 0.3, 5.5) * 0.4
      const lean = S.lean * hearW
      const reg01 = clamp01((S.regard - 0.15) / 0.67)
      // Chin down for dozing and nods and a high/child voice; up for questions and while thinking;
      // the whole head leans forward for a whisper and back from a shout.
      const pitchT =
        mix.pick(PITCH) + hearW * (0.08 * (reg01 - 0.45) - 0.08 * S.question - 0.05 * Math.max(0, lean) + 0.06 * S.brace) + 0.07 * S.nod + 0.04 * S.flinch + (reduced ? 0 : 0.008 * breathe)
      pitchS = reduced ? pitchT : approach(pitchS, pitchT, dt, 0.15)
      const shiftX = (0.1 * Math.max(0, lean) - 0.09 * S.brace * hearW - 0.06 * S.flinch) * s
      jawS = reduced ? mouth.open * 0.3 : approach(jawS, mouth.open, dt, 0.03)
      const jaw = jawS * 0.2 * (0.8 + 0.4 * S.talkSlow)
      const protrude = mouth.round * 0.05
      browS = approach(browS, hearW * (0.6 * S.question + 0.3 * Math.max(0, S.energy - 0.5)) + thinkW * 0.5, dt, reduced ? 0 : 0.15)

      // Transform the contour: jaw about the hinge, then the head about the neck.
      const cp = Math.cos(pitchS)
      const sp = Math.sin(pitchS)
      const cj = Math.cos(jaw)
      const sj = Math.sin(jaw)
      Tcp = cp
      Tsp = sp
      Tox = ox + shiftX
      Toy = oy
      Ts = s
      for (let i = 0; i < NU; i++) {
        let x = UX[i]!
        const y = UY[i]!
        if (y > 0.15 && x > 0.8) x += protrude // upper lip pushes out for "oo"
        ux[i] = tx(x, y)
        uy[i] = ty(x, y)
      }
      for (let i = 0; i < NL; i++) {
        const w = LW[i]!
        let x = LX[i]!
        let y = LY[i]!
        if (y < 0.5 && x > 0.8) x += protrude
        // Rotate about the hinge by jaw × weight.
        const ang = jaw * w
        if (ang !== 0) {
          const c = ang === jaw ? cj : Math.cos(ang)
          const sn = ang === jaw ? sj : Math.sin(ang)
          const rx = x - HINGE_X
          const ry = y - HINGE_Y
          x = HINGE_X + rx * c - ry * sn
          y = HINGE_Y + rx * sn + ry * c
        }
        lx[i] = tx(x, y)
        ly[i] = ty(x, y)
      }

      // ---- Colours.
      const alert = mix.pick(ALERT)
      mixInto(lineRgb, P.inkFaint, P.ink, 0.35 + 0.65 * alert)
      clear2d(g, dpr, fo) // (0, 0) is the box's top-left corner; the canvas reaches beyond it on every side
      if (facing.shown === "left") g.setTransform(-dpr, 0, 0, dpr, dpr * (fo.x + W), dpr * fo.y) // mirrored about the box: facing left
      if (fade < 1) g.globalAlpha = fade
      g.lineCap = "round"
      g.lineJoin = "round"
      const lw = Math.max(1.4, 0.026 * s) * weight

      // Head fill: faint, so the inside reads as a space; or solid, as a silhouette.
      g.fillStyle = ink.css(P.ink, (P.dark ? 0.045 : 0.05) + solid * (P.dark ? 0.17 : 0.12))
      g.beginPath()
      headPath(g)
      g.fill()

      // Ear glow (mint) while it listens.
      const youLv = S.userTalking ? Math.max(0.12, u.level) : 0.08
      const earT = mix.listening * 0.35 + hearW * (0.4 + 0.6 * clamp01(youLv * 1.8))
      earS = reduced ? earT : approach(earS, earT, dt, earT > earS ? 0.04 : 0.25)
      const ex = tx(EAR_X, EAR_Y)
      const ey = ty(EAR_X, EAR_Y)
      earSpot.draw(g, ex, ey, 0.42 * s, 0.42 * s, 0, P.you, earS * (P.dark ? 0.45 : 0.4) * fade) // sets its own alpha, then restores the fade

      // Incoming wavefronts: arcs centred on the ear, closing in from the right. Drawn twice: full
      // strength outside the head, faint where they pass over the face on their way to the ear.
      const regK = reg01 * hearW + 0.5 * (1 - hearW)
      const youCol = P.you
      if (mix.listening > 0.02 || hearW > 0.02 || reduced) {
        const base = mix.listening * 0.5 + hearW
        if (reduced || mix.listening > 0.5) {
          const lv = reduced ? (S.userTalking ? Math.round(u.level * 4) / 4 : 0.1) : 0.08
          for (let k = 0; k < 2; k++) {
            const r = (0.75 + k * 0.4) * s
            g.strokeStyle = ink.css(youCol, base * (0.3 + 0.6 * clamp01(lv * 2)))
            g.lineWidth = lw * (0.8 + 1.2 * clamp01(lv * 2))
            g.beginPath()
            g.arc(ex + shiftX * 0, ey, r, -0.38, 0.38)
            g.stroke()
          }
        } else {
          for (let pass = 0; pass < 2; pass++) {
            g.save()
            g.beginPath()
            if (pass === 0) g.rect(facing.shown === "left" ? W - CW + fo.x : -fo.x, -fo.y, CW, CH) // outside: the whole canvas (in mirrored coordinates when facing left) minus head (even-odd)
            headPath(g)
            g.clip(pass === 0 ? "evenodd" : "nonzero")
            const k = pass === 0 ? 1 : 0.35
            for (let i = 0; i < WAVES; i++) {
              const ag = inAge[i]!
              if (ag >= 0.8) continue
              const d = ag / 0.8 // 0 far .. 1 at the ear
              const pw = inPow[i]!
              const r = lerp(2.1, 0.22, d) * s
              const alpha = k * base * Math.sin(Math.PI * Math.min(1, d * 1.05)) * (0.35 + 0.65 * clamp01(pw * 2))
              g.strokeStyle = ink.css(youCol, alpha)
              g.lineWidth = lw * lerp(2.4, 0.9, regK) * (0.6 + 0.8 * clamp01(pw * 1.6))
              const span = 0.22 + 0.3 * clamp01(pw * 1.5)
              g.beginPath()
              g.arc(ex, ey, r, -span, span)
              g.stroke()
            }
            g.restore()
          }
        }
      }

      // Outgoing wavefronts from the mouth while it speaks.
      const mxp = tx(MOUTH_X + protrude, MOUTH_Y + jaw * 0.4)
      const myp = ty(MOUTH_X + protrude, MOUTH_Y + jaw * 0.4)
      if (speakW > 0.02) {
        if (reduced) {
          for (let k = 0; k < 3; k++) {
            g.strokeStyle = ink.css(P.voice, speakW * (0.75 - k * 0.2))
            g.lineWidth = lw * 1.6
            g.beginPath()
            g.arc(mxp, myp, (0.25 + k * 0.28) * s, -0.45, 0.45)
            g.stroke()
          }
        } else {
          for (let i = 0; i < WAVES; i++) {
            const ag = outAge[i]!
            if (ag >= 1) continue
            const pw = outPow[i]!
            const r = lerp(0.12, 1.5, ag) * s * (0.85 + 0.3 * S.size)
            const alpha = speakW * (1 - ag) * (0.4 + 0.6 * clamp01(pw * 2))
            g.strokeStyle = ink.css(P.voice, alpha)
            g.lineWidth = lw * (0.8 + 1.4 * clamp01(pw * 1.6)) * (0.8 + 0.4 * S.size)
            const span = 0.3 + 0.25 * clamp01(pw * 1.5)
            g.beginPath()
            g.arc(mxp, myp, r, -span, span)
            g.stroke()
          }
        }
      }

      // ---- The mind: dots.
      if (!reduced) {
        swirl += dt * (0.25 + 1.6 * thinkW + 0.3 * speakW)
        const idleW = mix.idle
        for (let i = 0; i < DOTS; i++) {
          if (life[i]! <= 0.005 && leaving[i] === 0) continue
          let tgx: number
          let tgy: number
          if (leaving[i] === 1) {
            tgx = MOUTH_X - 0.05
            tgy = MOUTH_Y
            life[i] = Math.max(0, life[i]! - dt * 1.6)
            if (Math.abs(dx[i]! - tgx) < 0.08 || life[i]! <= 0.02) {
              leaving[i] = 0
              life[i] = 0
            }
          } else {
            // Home: scattered in the mind, rotating while it thinks, sinking low while it dozes.
            const ang = swirl * (0.6 + 0.4 * delay[i]!)
            const c = Math.cos(ang)
            const sn = Math.sin(ang)
            const hxx = hx[i]! * c - hy[i]! * sn * 0.8
            const hyy = hx[i]! * sn * 0.8 + hy[i]! * c
            tgx = MIND_X + hxx * MIND_RX * (1 - 0.35 * idleW)
            tgy = lerp(MIND_Y + hyy * MIND_RY, MIND_Y + MIND_RY * 0.75 + hyy * 0.08, idleW)
            tgx += noise2(i * 3.1, clock * 0.4) * 0.05
            tgy += noise2(i * 5.7, clock * 0.4 + 9) * 0.04
            // Colour: mint while hearing; turns amber while thinking (each dot in its own time).
            if (thinkW > 0.5 && f.modeAge > delay[i]! * 1.2) dc[i] = approach(Math.max(0, dc[i]!), 1, dt, 0.25)
            // Idle: dots fade to a few dim resting ones.
            if (idleW > 0.5 && i >= 5) life[i] = approach(life[i]!, 0, dt, 1.2)
            else if (life[i]! < 1) life[i] = Math.min(1, life[i]! + dt * 2)
          }
          const k = leaving[i] === 1 ? 0.12 : 0.18
          dx[i] = approach(dx[i]!, tgx, dt, k)
          dy[i] = approach(dy[i]!, tgy, dt, k)
        }
      } else {
        // Reduced motion: a still arrangement that says the mode.
        for (let i = 0; i < DOTS; i++) {
          const on = f.mode === "idle" ? i < 4 : f.mode === "listening" ? i < 6 : f.mode === "hearing" ? i < 16 : f.mode === "thinking" ? i < 18 : i < 10
          life[i] = on ? (f.mode === "idle" ? 0.4 : 1) : 0
          leaving[i] = 0
          dc[i] = f.mode === "thinking" ? (i % 2 === 0 ? 1 : 0) : f.mode === "speaking" ? 1 : f.mode === "hearing" ? 0 : -1
          dx[i] = MIND_X + hx[i]! * MIND_RX * (f.mode === "idle" ? 0.6 : 1)
          dy[i] = f.mode === "idle" ? MIND_Y + MIND_RY * 0.75 + hy[i]! * 0.08 : MIND_Y + hy[i]! * MIND_RY
        }
      }

      // Links between near dots while thinking ("connecting what you said").
      if (thinkW > 0.05) {
        g.lineWidth = Math.max(0.8, 0.012 * s)
        for (let i = 0; i < DOTS; i++) {
          if (life[i]! < 0.5) continue
          for (let j = i + 1; j < DOTS; j++) {
            if (life[j]! < 0.5) continue
            const ddx = dx[i]! - dx[j]!
            const ddy = dy[i]! - dy[j]!
            const d2 = ddx * ddx + ddy * ddy
            if (d2 > 0.06) continue
            const flick = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(clock * 5 + i * 1.7 + j)
            g.strokeStyle = ink.css(P.voice, thinkW * 0.5 * flick * (1 - d2 / 0.06))
            g.beginPath()
            g.moveTo(tx(dx[i]!, dy[i]!), ty(dx[i]!, dy[i]!))
            g.lineTo(tx(dx[j]!, dy[j]!), ty(dx[j]!, dy[j]!))
            g.stroke()
          }
        }
      }
      const dotR = Math.max(1.3, 0.032 * s)
      for (let i = 0; i < DOTS; i++) {
        const l = life[i]!
        if (l <= 0.02) continue
        const c = dc[i]!
        if (c < 0) mixInto(dotRgb, P.you, P.inkFaint, -c)
        else mixInto(dotRgb, P.you, P.voice, c)
        if (mix.idle > 0.5) mixInto(dotRgb, dotRgb, P.inkFaint, 0.7)
        g.fillStyle = ink.css(dotRgb, clamp01(l) * (0.55 + 0.45 * alert))
        g.beginPath()
        g.arc(tx(dx[i]!, dy[i]!), ty(dx[i]!, dy[i]!), dotR * (0.7 + 0.3 * l), 0, TAU)
        g.fill()
      }

      // Contour (receding into the silhouette's edge).
      g.strokeStyle = ink.css(lineRgb, 1 - 0.75 * solid)
      g.lineWidth = lw
      g.beginPath()
      g.moveTo(ux[0]!, uy[0]!)
      for (let i = 1; i < NU; i++) g.lineTo(ux[i]!, uy[i]!)
      g.stroke()
      g.beginPath()
      g.moveTo(lx[0]!, ly[0]!)
      for (let i = 1; i < NL; i++) g.lineTo(lx[i]!, ly[i]!)
      g.stroke()
      // Mouth opening: a dark wedge between the lips when the jaw is open.
      if (jaw > 0.01) {
        g.fillStyle = ink.css(P.dark ? [0, 0, 0] : P.ink, P.dark ? 0.5 : 0.25)
        g.beginPath()
        g.moveTo(ux[NU - 1]!, uy[NU - 1]!)
        for (let i = NU - 1; i >= NU - 1 - PER_SEG; i--) g.lineTo(ux[i]!, uy[i]!)
        for (let i = PER_SEG; i >= 0; i--) g.lineTo(lx[i]!, ly[i]!)
        g.closePath()
        g.fill()
      }

      // Ear: a "(" rim with a small inner curl.
      g.strokeStyle = ink.css(lineRgb, 1)
      g.lineWidth = lw
      const er = 0.16 * s
      g.save()
      g.translate(ex, ey)
      g.rotate(pitchS)
      g.beginPath()
      g.arc(0.02 * s, 0, er, Math.PI * 0.42, Math.PI * 1.6)
      g.stroke()
      g.lineWidth = lw * 0.8
      g.beginPath()
      g.arc(0.03 * s, 0.01 * s, er * 0.45, Math.PI * 0.6, Math.PI * 1.45)
      g.stroke()
      g.restore()

      // Eye: an almond that blinks and looks up while thinking; a brow line above.
      if (S.ack) blink.trigger()
      const bl = blink.step(dt, mix.pick(BLINK_MEAN) / pers.liveliness, !reduced && mix.idle < 0.5)
      const open = clamp01(mix.pick(EYE_OPEN) + hearW * (0.25 * Math.max(0, lean) - 0.35 * S.brace + 0.2 * (S.energy - 0.45))) * (1 - bl)
      const exx = tx(EYE_X, EYE_Y)
      const eyy = ty(EYE_X, EYE_Y)
      const ew = 0.1 * s
      g.save()
      g.translate(exx, eyy)
      g.rotate(pitchS)
      if (open > 0.12) {
        g.fillStyle = ink.css(lineRgb, 1)
        g.beginPath()
        g.ellipse(0.01 * s, 0, ew * 0.42, ew * 0.42 * (0.35 + 0.65 * open), 0, 0, TAU)
        g.fill()
        // Pupil highlight shows where it looks: forward (you), up while thinking.
        const look = thinkW * -0.5 + (mix.idle > 0.5 ? 0.3 : 0) - 0.15 * S.lookAway
        g.fillStyle = ink.css(P.dark ? P.bg : P.surface, 0.9)
        g.beginPath()
        g.arc(0.03 * s, look * ew * 0.3, ew * 0.12, 0, TAU)
        g.fill()
      } else {
        g.beginPath()
        g.moveTo(-ew * 0.45, 0)
        g.quadraticCurveTo(0, ew * (mix.idle > 0.5 ? 0.3 : 0.1), ew * 0.45, 0)
        g.stroke()
      }
      // Brow.
      g.lineWidth = lw * 0.9
      g.beginPath()
      g.moveTo(-ew * 0.4, -ew * (0.78 + 0.35 * browS))
      g.quadraticCurveTo(ew * 0.1, -ew * (0.98 + 0.45 * browS), ew * 0.55, -ew * (0.82 + 0.25 * browS))
      g.stroke()
      g.restore()
      if (fade < 1) g.globalAlpha = 1
    },

    dispose() {}
  }
}

const design: Character = {
  id: "profile-head",
  name: "Profile head",
  version: "1.1.0",
  contract: 1,
  family: "figure",
  summary: "A head in side profile: your voice arrives at the ear as mint wavefronts and drops in as dots, the dots link up and turn amber while it thinks, and leave the mouth as amber waves when it speaks.",
  inspiredBy: "Editorial and medical profile illustrations, Meta AI's inward-for-listening / outward-for-speaking rule, NOMI's turn-toward-the-speaker, the Rapport Agent's pause-timed nods.",
  modes: {
    idle: "Faint contour, chin down, eye closed; a few dim dots resting low in the head.",
    listening: "Head up, eye open; the ear glows faint mint with two still arcs in front of it: open to sound.",
    hearing: "Mint wavefronts converge on the glowing ear, one per syllable you say, and each drops a mint dot into the head; it nods at your pauses, lifts its chin and brow at questions, leans in for a whisper and back from a shout.",
    thinking: "Eye looks up, brow raised; the dots swirl, link with flickering amber lines and turn from mint to amber one by one.",
    speaking: "The jaw moves with the reply; with each syllable a dot flows to the mouth and an amber wavefront leaves it, sized by the voice."
  },
  mappings: [
    { signal: "user.onset × level", effect: "One incoming mint wavefront per syllable (0.8 s to reach the ear), weight and span by loudness; on arrival it drops a mint dot into the head." },
    { signal: "user.level (live)", effect: "Ear glow brightness." },
    { signal: "user.register", effect: "Wavefront thickness (deep: heavy, child: fine); chin dips slightly for a high or child voice, lifts for a deep one." },
    { signal: "user phrase end (pause after ≥ 0.6 s of speech)", effect: "A nod (chin down and back) with a blink." },
    { signal: "user.pitchDelta at phrase end (rising)", effect: "Chin and brow lift (curious), fading over ~3 s." },
    { signal: "user.level over 0.5 s (and voicing)", effect: "Whisper: head moves forward and tips toward you, eye opens wider. Shout: head pulls back and lifts, eye narrows." },
    { signal: "user.onset at level > 0.58", effect: "Flinch: a quick pull back, habituating over 3 s." },
    { signal: "user.syllableRate and |pitchDelta|", effect: "Energy: more wavefronts (one per syllable), brow and eye lift with lively speech." },
    { signal: "agent.mouth.open / round", effect: "Jaw rotates open about its hinge (up to 0.2 rad, scaled by the reply's loudness over ~1 s); lips push forward for 'oo'." },
    { signal: "agent.onset × level", effect: "One outgoing amber wavefront from the mouth per syllable, and one dot flows from the head to the mouth." },
    { signal: "agent.register", effect: "Outgoing wavefronts bigger and heavier for a deep voice, smaller for a high one; jaw smoothing slower for deep." },
    { signal: "mode", effect: "Pose blend over ~0.25 s: head pitch, eye openness, brow, contour brightness, ear glow, wave direction; dots swirl and turn amber in thinking, sink and fade in idle." },
    { signal: "time (seeded)", effect: "Blinks, breathing in the head pitch, slow drift of the dots, link flicker." },
    { signal: "reducedMotion", effect: "Still arrangements per mode: fixed dot sets (few and low idle, mint hearing, half amber thinking, amber speaking), two still arcs at the ear or three at the mouth, no jaw motion beyond a held opening, no blinks." },
    {
      signal: "options",
      effect:
        "Size (capped so skull and face stay in frame), facing left or right (a 0.3 s fade through the mirror), contour or silhouette and line weight (glide ~0.2 s); expressiveness scales nods, chin and brow lifts, lean and flinch; liveliness divides the blink interval; mouth range scales the jaw; nods switch off."
    }
  ],
  uses: [
    {
      ext: "speech.words",
      gain: "The dots become the actual words you say and the reply says, one per word, instead of one per syllable.",
      without: "One dot per syllable onset, as drawn now."
    },
    {
      ext: "speech.phonemes",
      gain: "The jaw and lips follow exact mouth shapes, aligned to the played audio.",
      without: "The jaw follows the spectral mouth estimate."
    }
  ],
  renderer: "2d",
  canvas: "stage",
  options: [
    sizeOption(0.5, 1.2),
    {
      id: "facing",
      kind: "choice",
      label: "Facing",
      choices: [
        { value: "right", label: "Right" },
        { value: "left", label: "Left" }
      ],
      default: "right",
      group: APPEARANCE,
      help: "Which way the head looks, so it can face into the room from either side of a screen."
    },
    {
      id: "style",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "contour", label: "Contour" },
        { value: "silhouette", label: "Silhouette" }
      ],
      default: "contour",
      group: APPEARANCE,
      help: "A line drawing with a faint inside, or a solid head shape."
    },
    lineWeightOption("Thickness of the head line, ear, brow and sound waves."),
    EXPRESSIVENESS,
    LIVELINESS,
    MOUTH_RANGE,
    nodsOption("Dips its chin at the end of each of your phrases, the way a listener nods.")
  ],
  create
}

export default design
