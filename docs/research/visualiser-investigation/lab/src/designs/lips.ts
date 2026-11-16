/**
 * Lips: a mouth and nothing else, drawn as flat graphic shapes (upper and lower lip, a dark
 * opening with teeth and tongue). It speaks with real mouth shapes from the spectral estimate:
 * the jaw for "ah", spread lips for "ee", rounded and pushed-forward lips for "oo", teeth
 * together for "s".
 *
 * A mouth cannot look at you, so it listens another way: it stays sealed (it is not its turn),
 * and the seam between the lips carries your voice as a fine mint waveform. At your pauses it
 * gives a closed-mouth "mm-hm" (a press with the corners lifting), at a rising phrase end one
 * corner lifts, for a whisper the lips part a little ("oh?"), at a shout they tighten.
 */
import type { Design, DesignInstance, Frame } from "../contract.ts"
import { WAVE_SIZE } from "../contract.ts"
import { approach, clamp, clamp01, clear2d, lerp, noise2, optChoice, optColor, optNumber, optToggle, setup2d, smoothstep, Spring, TAU } from "../kit.ts"
import {
  APPEARANCE,
  EXPRESSIVENESS,
  type Five,
  fit,
  Glide,
  Ink,
  instanceSeed,
  lineWeightOption,
  mixInto,
  ModeMix,
  Mouth,
  MOUTH_RANGE,
  nodsOption,
  Personality,
  Social,
  sized,
  sizeOption
} from "./_character.ts"

const N = 33 // samples across the mouth, odd so the centre is a sample

//                          idle   listen hear   think  speak
const SMILE: Five = [-0.04, 0.12, 0.05, 0.02, 0.06]
const WIDTH: Five = [0.92, 1, 1, 0.72, 1]
const SLACK: Five = [0.045, 0, 0, 0, 0] // idle: lips just apart, relaxed
const PRESS: Five = [0, 0.25, 0.15, 0.35, 0] // lips pressed together (thinner)
const POUT: Five = [0, 0, 0, 0.45, 0]
const ALERT: Five = [0, 1, 1, 1, 1]
/** The "Lip colour" default: a muted clay made from the theme's danger and faint-ink tokens (its swatch shows the dark-theme value). */
const CLAY = "#c07e73"

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  const seed = instanceSeed(7)
  const mix = new ModeMix()
  const social = new Social(seed)
  const mouth = new Mouth()
  const ink = new Ink()
  const lipRgb: [number, number, number] = [0, 0, 0]
  const lineRgb: [number, number, number] = [0, 0, 0]
  const cavRgb: [number, number, number] = [0, 0, 0]
  const tongueRgb: [number, number, number] = [0, 0, 0]
  const seamRgb: [number, number, number] = [0, 0, 0]
  const upperRgb: [number, number, number] = [0, 0, 0]
  const hiRgb: [number, number, number] = [0, 0, 0]
  // Edges, sampled across u = −1..1.
  const xs = new Float32Array(N)
  const iu = new Float32Array(N) // inner upper (bottom of the upper lip)
  const il = new Float32Array(N) // inner lower
  const ou = new Float32Array(N) // outer upper
  const ol = new Float32Array(N) // outer lower
  const seam = new Float32Array(N) // the listening waveform offset along the seam
  const press = new Spring(0.09, 0, 0.3) // "mm-hm" press
  const outlineRgb: [number, number, number] = [0, 0, 0]
  const pers = new Personality()
  const gSize = new Glide(1)
  const gWeight = new Glide(1)
  const gFill = new Glide(1)
  const gTeeth = new Glide(1)
  let smileS = 0
  let widthS = 1
  let openS = 0
  let topS = 0
  let roundS = 0
  let shiftS = 0
  let pressS = 0
  let poutS = 0
  let cornerQ = 0
  let tightS = 0
  let partS = 0
  let seamAmp = 0
  let sweep = 0

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
      mix.step(f, 0.2)
      social.step(f, pers)
      const S = social
      // Appearance options, gliding (snap on the first frame and under reduced motion).
      const size = gSize.step(optNumber(f.options, "size"), f)
      const weight = gWeight.step(optNumber(f.options, "lineWeight"), f, 0.15)
      const fillA = gFill.step(optChoice(f.options, "lipStyle") === "line" ? 0 : 1, f, 0.2)
      const lineA = 1 - fillA
      const teethK = gTeeth.step(optToggle(f.options, "teeth") ? 1 : 0, f, 0.2)
      const hearW = mix.hearing
      const speakW = mix.speaking
      const thinkW = mix.thinking
      const k = reduced ? 0 : 1

      // Layout: 3.0 × 1.7 units; the mouth is about 2 units wide at rest. The size option scales
      // it, never past the 3.15 × 1.5 units its widest and most open shapes use.
      const s = sized(fit(W, H, 3.0, 1.75, 0.92), size, W, H, 3.15, 1.5)
      const cx = W / 2
      const cy = H / 2

      mouth.step(f, S.size, speakW, pers.mouthRange)
      if (S.ack && S.nodsOn && !reduced && hearW > 0.5 && S.question < 0.3) press.velocity += 9 * S.expr // "mm-hm"
      const pr = reduced ? 0 : press.step(0, dt)

      // ---- Pose.
      const breathe = reduced ? 0 : 0.5 * Math.sin(f.t * 1.05) + 0.5 * noise2(f.t * 0.25, 4.4)
      const lean = S.lean * hearW
      tightS = k ? approach(tightS, hearW * S.brace + S.flinch, dt, 0.12) : hearW * S.brace
      // A whisper parts the lips a little: leaning in, "oh?".
      partS = k ? approach(partS, hearW * 0.13 * Math.max(0, lean) + 0.05 * hearW * S.waiting, dt, 0.25) : hearW * 0.13 * Math.max(0, lean)
      const smileT = mix.pick(SMILE) + hearW * (0.1 * S.waiting - 0.16 * S.brace + 0.12 * Math.max(0, S.energy - 0.5)) + 0.25 * pr + speakW * 0.05 * S.talkSlow
      smileS = k ? approach(smileS, smileT, dt, 0.12) : smileT
      const widthT =
        mix.pick(WIDTH) * (1 + speakW * (0.45 * mouth.wide - 0.4 * mouth.round) * (0.85 + 0.3 * S.size)) * (1 - 0.18 * tightS + 0.05 * pr) * (1 + speakW * (0.12 * S.size - 0.04))
      widthS = k ? approach(widthS, widthT, dt, 0.05) : widthT
      const openT = mix.pick(SLACK) * (1 + 0.5 * breathe) + partS + speakW * 0.62 * mouth.open * (0.75 + 0.5 * S.talkSlow) + speakW * 0.09 * mouth.teeth
      openS = k ? approach(openS, openT, dt, 0.03) : openT
      const topT = speakW * (0.08 * mouth.open + 0.12 * mouth.round + 0.07 * mouth.teeth) + 0.4 * partS
      topS = k ? approach(topS, topT, dt, 0.035) : topT
      roundS = k ? approach(roundS, speakW * mouth.round, dt, 0.05) : speakW * mouth.round
      const pressT = mix.pick(PRESS) + 0.7 * tightS + 0.4 * pr
      pressS = k ? approach(pressS, pressT, dt, 0.1) : pressT
      poutS = k ? approach(poutS, mix.pick(POUT) + 0.6 * roundS, dt, 0.08) : mix.pick(POUT)
      // Thinking pushes the mouth to one side; a question lifts one corner.
      const shiftT = thinkW * 0.32 * S.thinkSide + (reduced ? 0 : thinkW * 0.08 * Math.sin(f.t * 0.9))
      shiftS = k ? approach(shiftS, shiftT, dt, 0.35) : shiftT
      cornerQ = k ? approach(cornerQ, hearW * S.question + thinkW * 0.6, dt, 0.2) : hearW * S.question + thinkW * 0.6
      const qSide = thinkW > 0.5 ? S.thinkSide : 1

      // ---- Colours: two-tone muted clay (upper lip in shade), dimmer when dozing.
      const alert = mix.pick(ALERT)
      const lipC = f.options.lipColor
      if (lipC === CLAY || typeof lipC !== "string") mixInto(lipRgb, P.danger, P.inkFaint, P.dark ? 0.52 : 0.6)
      else mixInto(lipRgb, optColor(f, "lipColor"), P.inkFaint, 0)
      mixInto(lipRgb, lipRgb, P.bg, (1 - alert) * 0.4 + (P.dark ? 0.08 : 0))
      mixInto(upperRgb, lipRgb, [0, 0, 0], 0.22)
      mixInto(hiRgb, lipRgb, [255, 255, 255], 0.4)
      mixInto(cavRgb, P.bg, [0, 0, 0], P.dark ? 0.65 : 0.85)
      mixInto(tongueRgb, lipRgb, [255, 255, 255], 0.12)
      mixInto(lineRgb, upperRgb, [0, 0, 0], 0.35)
      // Line drawing: the lip colour gives way to the ink colour, dimmer when dozing.
      if (lineA > 0) {
        mixInto(tongueRgb, tongueRgb, P.inkFaint, lineA)
        mixInto(lineRgb, lineRgb, P.ink, lineA)
        mixInto(outlineRgb, P.inkFaint, P.ink, 0.45 + 0.55 * alert)
      }

      // ---- Edges.
      const unit = s * (1 + 0.07 * Math.max(0, lean) - 0.05 * tightS + 0.01 * breathe * (1 - speakW))
      const hw = 0.95 * widthS
      const ox = cx + shiftS * s
      const oy = cy + S.nod * 0.05 * s - S.beat * 0.02 * s * speakW
      const tU = (0.17 - 0.07 * pressS + 0.09 * poutS) * (1 + 0.05 * breathe * (1 - speakW))
      const tL = 0.22 - 0.08 * pressS + 0.11 * poutS
      // The jaw opens at most until the lower lip meets the bottom of the frame (a wide mouth range
      // at a large size would otherwise run off it).
      const openD = Math.min(openS, Math.max(0, (H - 3 - oy) / unit - tL))
      const rnd = clamp01(roundS * 1.3 + poutS * 0.4)
      const pBump = lerp(1.0, 0.45, rnd) // opening profile: flat-wide .. circular
      const reach = 0.93 - 0.08 * clamp01(openD * 2) // the opening stops short of the corners
      const wantSeam = hearW > 0.02 || mix.listening > 0.02
      const wave = f.user.wave
      const ampT = S.userTalking ? clamp01(0.15 + f.user.level * 1.8) : 0
      seamAmp = reduced ? 0 : approach(seamAmp, ampT, dt, ampT > seamAmp ? 0.03 : 0.2)
      let peak = 1e-4
      if (seamAmp > 0.01) for (let i = 0; i < WAVE_SIZE; i++) peak = Math.max(peak, Math.abs(wave[i] ?? 0))
      for (let i = 0; i < N; i++) {
        const u = (i / (N - 1)) * 2 - 1
        const uu = u * u
        const v = clamp(u / reach, -1, 1)
        const bump = Math.pow(Math.max(0, 1 - v * v), pBump)
        const lift = smileS * uu + (u * qSide > 0 ? cornerQ * 0.11 * uu : 0)
        xs[i] = ox + u * hw * unit
        const yc = -lift + 0.06 * openD * uu // corners sag a little as the jaw drops
        iu[i] = oy + (yc - topS * bump) * unit
        il[i] = oy + (yc + openD * bump) * unit
        // Upper lip: two soft peaks with a small dip between (stylised), tapering to the corners.
        const profU = Math.pow(Math.max(0, 1 - uu), 0.7) * (1 - 0.2 * (1 - rnd) * Math.exp(-(u / 0.14) * (u / 0.14)))
        ou[i] = oy + (yc - topS * bump - tU * profU) * unit
        ol[i] = oy + (yc + openD * bump + tL * Math.pow(Math.max(0, 1 - uu), 0.65)) * unit
        // Listening seam: your waveform (peak-normalised), strongest mid-mouth.
        if (wantSeam && seamAmp > 0.01) {
          // A short box filter keeps the fundamental (a deep voice: long waves; a child's: dense
          // ripples) and drops the harmonics that would alias at 33 points.
          const wi = Math.floor(((u + 1) / 2) * (WAVE_SIZE - 1))
          let acc = 0
          for (let j = -4; j <= 4; j++) acc += wave[clamp(wi + j, 0, WAVE_SIZE - 1)] ?? 0
          seam[i] = ((acc / 9) / peak) * 0.13 * seamAmp * Math.pow(Math.max(0, 1 - uu), 0.8) * unit
        } else seam[i] = 0
      }

      clear2d(g, dpr)
      g.lineJoin = "round"
      g.lineCap = "round"
      const lw = Math.max(1.3, 0.03 * s) * weight
      const seamK = 1 / (1 + 0.4 * (weight - 1)) // the seam thickens less than the drawing, so a heavy weight stays a line
      const opening = openD + topS
      const mid = (N - 1) / 2

      // Opening: dark cavity, a warm glow, tongue, teeth along the lip line.
      if (opening > 0.012) {
        g.save()
        g.beginPath()
        g.moveTo(xs[0]!, iu[0]!)
        for (let i = 1; i < N; i++) g.lineTo(xs[i]!, iu[i]!)
        for (let i = N - 1; i >= 0; i--) g.lineTo(xs[i]!, il[i]!)
        g.closePath()
        g.fillStyle = ink.css(cavRgb, 0.45 + 0.55 * fillA)
        g.fill()
        g.clip()
        const yTop = iu[mid]!
        const yBot = il[mid]!
        const span = hw * unit * reach
        if (speakW > 0.02) {
          g.fillStyle = ink.css(P.voice, speakW * (0.1 + 0.35 * clamp01(S.talk * 2)))
          g.beginPath()
          g.ellipse(ox, (yTop + yBot) / 2, span * 0.55, (yBot - yTop) * 0.5 + 1, 0, 0, TAU)
          g.fill()
        }
        const tongueA = clamp01((openD - 0.1) * 4) * teethK
        if (tongueA > 0.01) {
          g.fillStyle = ink.css(tongueRgb, tongueA)
          g.beginPath()
          g.ellipse(ox, yBot + 0.03 * unit, span * 0.52, Math.max(1, openD * 0.45 * unit), 0, Math.PI, TAU)
          g.fill()
        }
        const teethA = clamp01((opening - 0.05) * 8) * teethK
        const toothH = Math.max(1, Math.min(0.085 * unit, (yBot - yTop) * 0.45 + 0.02 * unit))
        g.strokeStyle = ink.css(P.dark ? P.ink : P.surface, teethA * 0.95)
        g.lineCap = "butt"
        g.lineWidth = toothH
        const i0 = Math.round(mid - mid * reach * 0.75)
        const i1 = Math.round(mid + mid * reach * 0.75)
        g.beginPath()
        for (let i = i0; i <= i1; i++) {
          const y = iu[i]! + toothH / 2 - 0.004 * unit
          if (i === i0) g.moveTo(xs[i]!, y)
          else g.lineTo(xs[i]!, y)
        }
        g.stroke()
        const lowerTeeth = clamp01(mouth.teeth * 1.6) * speakW * teethK
        if (lowerTeeth > 0.02) {
          g.globalAlpha = lowerTeeth
          g.beginPath()
          for (let i = i0 + 1; i < i1; i++) {
            const y = il[i]! - toothH / 2 + 0.004 * unit
            if (i === i0 + 1) g.moveTo(xs[i]!, y)
            else g.lineTo(xs[i]!, y)
          }
          g.stroke()
          g.globalAlpha = 1
        }
        g.lineCap = "round"
        g.restore()
      }

      // Lips: the upper in shade, the lower lit (faded out for the line drawing).
      if (fillA > 0.01) {
        if (fillA < 1) g.globalAlpha = fillA
        g.fillStyle = ink.css(upperRgb, 1)
        g.beginPath()
        g.moveTo(xs[0]!, iu[0]!)
        for (let i = 0; i < N; i++) g.lineTo(xs[i]!, ou[i]!)
        for (let i = N - 1; i >= 0; i--) g.lineTo(xs[i]!, iu[i]! + seam[i]! * 0.5)
        g.closePath()
        g.fill()
        g.fillStyle = ink.css(lipRgb, 1)
        g.beginPath()
        g.moveTo(xs[0]!, il[0]!)
        for (let i = 0; i < N; i++) g.lineTo(xs[i]!, il[i]! + seam[i]! * 0.5)
        for (let i = N - 1; i >= 0; i--) g.lineTo(xs[i]!, ol[i]!)
        g.closePath()
        g.fill()

        // Lower-lip highlight.
        g.strokeStyle = ink.css(hiRgb, 0.55)
        g.lineWidth = Math.max(1.5, 0.045 * s)
        g.beginPath()
        const hy = il[mid]! * 0.45 + ol[mid]! * 0.55
        g.moveTo(xs[mid - 5]!, hy + 0.012 * unit)
        g.quadraticCurveTo(xs[mid]!, hy - 0.016 * unit, xs[mid + 5]!, hy + 0.012 * unit)
        g.stroke()
        if (fillA < 1) g.globalAlpha = 1
      }

      // Line drawing: the outer contour of both lips, and the edges of the opening.
      if (lineA > 0.01) {
        g.strokeStyle = ink.css(outlineRgb, lineA)
        g.lineWidth = lw
        g.beginPath()
        g.moveTo(xs[0]!, ou[0]!)
        for (let i = 1; i < N; i++) g.lineTo(xs[i]!, ou[i]!)
        for (let i = N - 1; i >= 0; i--) g.lineTo(xs[i]!, ol[i]!)
        g.closePath()
        if (opening > 0.012) {
          g.moveTo(xs[0]!, iu[0]!)
          for (let i = 1; i < N; i++) g.lineTo(xs[i]!, iu[i]!)
          for (let i = N - 1; i >= 0; i--) g.lineTo(xs[i]!, il[i]!)
          g.closePath()
        }
        g.stroke()
      }

      // The seam where the lips meet: mint and alive while it listens (also in a slight parting,
      // where your voice runs into the gap), a dark line otherwise.
      const listenK = clamp01(hearW + mix.listening)
      const seamVis = opening <= 0.012 ? 1 : listenK * (1 - smoothstep(0.04, 0.16, opening))
      if (seamVis > 0.02) {
        const seamCol = mixInto(seamRgb, lineRgb, P.you, listenK)
        g.strokeStyle = ink.css(seamCol, seamVis)
        g.lineWidth = lw * (0.8 + 0.7 * listenK + 0.5 * seamAmp) * seamK
        g.beginPath()
        for (let i = 0; i < N; i++) {
          const y = (iu[i]! + il[i]!) / 2 + seam[i]!
          if (i === 0) g.moveTo(xs[i]!, y)
          else g.lineTo(xs[i]!, y)
        }
        g.stroke()
      }

      // Smile lines hugging the corners when they lift (the "mm-hm", a warm listening face).
      const dimple = clamp01((smileS - 0.07) * 5) + clamp01(pr * 2)
      if (dimple > 0.03) {
        g.strokeStyle = ink.css(lineRgb, 0.75 * clamp01(dimple))
        g.lineWidth = lw * 0.9
        for (let e = -1; e <= 1; e += 2) {
          const i = e < 0 ? 0 : N - 1
          const x = xs[i]!
          const y = iu[i]!
          const r = 0.1 * unit
          g.beginPath()
          if (e > 0) g.arc(x - r * 0.35, y, r, -0.9, 0.9)
          else g.arc(x + r * 0.35, y, r, Math.PI - 0.9, Math.PI + 0.9)
          g.stroke()
        }
      }

      // Thinking: an amber glint slides slowly along the seam, as if turning a word over.
      if (thinkW > 0.02 && opening <= 0.012) {
        if (!reduced) sweep = (sweep + dt / 2.2) % 1
        const sp = reduced ? 0.5 : 0.5 - 0.5 * Math.cos(sweep * TAU)
        const i = clamp(Math.round((0.15 + 0.7 * sp) * (N - 1)), 1, N - 2)
        g.fillStyle = ink.css(P.voice, thinkW)
        g.beginPath()
        g.arc(xs[i]!, (iu[i]! + il[i]!) / 2, Math.max(1.8, 0.04 * s), 0, TAU)
        g.fill()
      }
    },

    dispose() {}
  }
}

const design: Design = {
  id: "lips",
  name: "Lips",
  family: "character",
  summary: "A mouth alone, in flat graphic shapes with teeth and tongue: real mouth shapes when it speaks, a sealed seam that carries your voice when it listens.",
  inspiredBy: "Rhubarb Lip Sync's hand-drawable mouth set and wawa-lipsync's browser-only shapes; closed-mouth 'mm-hm' backchannels; the Rapport Agent's pause timing.",
  modes: {
    idle: "Dim, relaxed, lips just apart and corners slightly down, breathing slowly.",
    listening: "Lips sealed in a soft closed smile with smile lines; the seam glows faint mint: ready, your turn.",
    hearing: "The seam carries your voice as a fine mint waveform; an 'mm-hm' press at each pause, one corner up at a question, lips part for a whisper, tighten at a shout.",
    thinking: "Lips pursed and pushed to one side, drifting slowly; an amber glint travels along the seam.",
    speaking: "Open, wide, round and teeth-together shapes from the reply, with teeth, tongue and an amber glow inside as bright as the voice."
  },
  mappings: [
    { signal: "agent.mouth.open", effect: "Jaw: lower lip drops up to 0.62 units (scaled 0.75–1.25 by the reply's loudness), tongue appears above ~0.2." },
    { signal: "agent.mouth.wide", effect: "Mouth width up to +45 %, flatter opening ('ee')." },
    { signal: "agent.mouth.round", effect: "Width down 40 %, rounder opening, thicker pushed-out lips ('oo')." },
    { signal: "agent.sibilance (jaw closed)", effect: "Lips part slightly with upper and lower teeth together ('s', 'sh')." },
    { signal: "agent.register", effect: "Mouth size ±8 % and shape smoothing ×0.75..1.35: deep is bigger and slower." },
    { signal: "agent.level", effect: "Amber glow inside the mouth; jaw range over ~1 s (soft vs loud)." },
    { signal: "user.wave × user.level", effect: "The seam traces your live waveform in mint (peak-normalised, lightly low-passed so the wavelength shows your pitch: long waves for a deep voice, dense ripples for a child), height with your level, tapering to the corners." },
    { signal: "user phrase end (pause after ≥ 0.6 s of speech)", effect: "'Mm-hm': a quick press with the corners lifting and smile lines showing." },
    { signal: "user.pitchDelta at phrase end (rising)", effect: "One corner lifts (curious), fading over ~3 s." },
    { signal: "user.level over 0.5 s (and voicing)", effect: "Whisper: the lips part a little and the mouth grows 6 % (leaning in). Shout: lips tighten, thin and narrow, corners drop." },
    { signal: "user.onset at level > 0.58", effect: "Flinch: a quick tightening, habituating over 3 s." },
    { signal: "user.syllableRate and |pitchDelta|", effect: "Energy: lively speech gets a wider smile; flat speech a neutral mouth." },
    { signal: "user.silenceFor mid-turn", effect: "Waiting: lips part slightly and the corners lift (encouraging)." },
    { signal: "mode", effect: "Pose blend over ~0.2 s: slack (idle), sealed smile (listening), press, pout and side shift (thinking); colours dim when idle; mint seam; amber inside when speaking." },
    { signal: "time", effect: "Slow breathing in lip fullness; the thinking glint takes 2.2 s per pass; none in reduced motion." },
    { signal: "reducedMotion", effect: "Held poses: seam flat (still mint), no press, breathing or glint motion; the mouth holds half open while speaking; whisper/shout poses change in held steps." },
    {
      signal: "options",
      effect:
        "Size (capped so the widest shapes stay in frame), lip colour, filled or line drawing (cross-fade ~0.2 s), line weight (seam and drawing), teeth and tongue on/off; expressiveness scales the press, corner lift, parting and tightening; mouth range scales the jaw; nods switch off the 'mm-hm' press."
    }
  ],
  serverNeeds:
    "None to work. This design gains the most from phoneme or viseme timings (Piper alignments, Azure/Polly viseme events): exact closures on m/b/p, lip-teeth contact on f/v and tongue-teeth on th, which the spectrum cannot distinguish. Without them the mouth never fully closes mid-word.",
  renderer: "2d",
  options: [
    sizeOption(0.5, 1.25),
    {
      id: "lipColor",
      kind: "color",
      label: "Lip colour",
      default: CLAY,
      group: APPEARANCE,
      help: "The colour of the lips; the default clay adapts to the theme, and ink gives a neutral look."
    },
    {
      id: "lipStyle",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "filled", label: "Filled" },
        { value: "line", label: "Line drawing" }
      ],
      default: "filled",
      group: APPEARANCE,
      help: "Solid shaded lips in the lip colour, or a plain line drawing in the ink colour."
    },
    lineWeightOption("Thickness of the seam between the lips and of the line drawing."),
    { id: "teeth", kind: "toggle", label: "Teeth and tongue", default: true, group: APPEARANCE, help: "Shows teeth and a tongue inside the open mouth; off leaves a plain dark opening." },
    EXPRESSIVENESS,
    MOUTH_RANGE,
    nodsOption("Gives a closed-mouth “mm-hm” press at the end of each of your phrases.")
  ],
  create
}

export default design
