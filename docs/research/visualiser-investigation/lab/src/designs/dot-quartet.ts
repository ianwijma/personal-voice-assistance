/**
 * Dot quartet: four dots that rest as dots, stand up as bars while someone speaks and orbit
 * while the assistant thinks.
 *
 * After ChatGPT's first voice mode (four ovals) and Google's dots, with one rule added so the
 * listening bars and the speaking bars can never be confused: while you speak, the *outer* bars
 * lead and the inner ones follow a beat later, the row is tight and V-shaped (energy flows in);
 * while the assistant speaks, the *inner* bars lead, the row spreads and is Λ-shaped (energy
 * flows out). A breathy whisper leaves the bars hollow.
 */
import type { Design, DesignInstance, Rgb, VoiceFeatures } from "../contract.ts"
import { AttackRelease, Spring, TAU, approach, clamp, clamp01, clear2d, lerp, optChoice, optNumber, optToggle, setup2d } from "../kit.ts"
import { ChoiceMix, type Col, css, Glide, GlowSprite, mix3Into, mixInto, ModeMix, unit } from "./_light.ts"

const WHITE: Rgb = [255, 255, 255]
const V_SHAPE = [1, 0.62, 0.62, 1] as const
const A_SHAPE = [0.58, 1, 1, 0.58] as const
const SHAPES = ["rounded", "square", "outline"] as const
/** Keep bars this far (CSS px) from the canvas edges. */
const MARGIN = 4

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  let d0 = 10 // dot diameter at size 1
  let d = 10

  const mix = new ModeMix()
  // Options, eased.
  const glide = new Glide()
  const shapeMix = new ChoiceMix(SHAPES)
  let size = 1
  let gap = 1
  let spectrum = 1
  let stairK = 1
  let glowK = 1
  let tails = 1
  let clock = -1 // ambient time, runs at the "Motion speed"
  const xs = [new Spring(0.09, 0, 0.25), new Spring(0.09, 0, 0.25), new Spring(0.09, 0, 0.25), new Spring(0.09, 0, 0.25)]
  const ys = [new Spring(0.08, 0, 0.2), new Spring(0.08, 0, 0.2), new Spring(0.08, 0, 0.2), new Spring(0.08, 0, 0.2)]
  const hs = [new Spring(0.045, 0, 0.3), new Spring(0.045, 0, 0.3), new Spring(0.045, 0, 0.3), new Spring(0.045, 0, 0.3)]
  const ws = [new Spring(0.1), new Spring(0.1), new Spring(0.1), new Spring(0.1)]
  let placed = false

  // The leading pair follows the level at once, the trailing pair a beat behind.
  const lead = new AttackRelease(0.03, 0.16)
  let trail = 0
  let reg = 0.45
  let rise = 0
  let voiced = 0.8
  let bright = 0.4
  const grp = new Float32Array(4)
  let orbit = 0

  const glow = new GlowSprite(64)
  const fill: Col = [0, 0, 0]
  const dotA: Col = [0, 0, 0]
  const dotB: Col = [0, 0, 0]
  const tmp: Col = [0, 0, 0]

  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
      d0 = Math.max(6, unit(W, H) * 0.056)
    },

    frame(f) {
      const dt = f.dt
      const p = f.palette
      const dark = p.dark
      const reduced = f.reducedMotion
      mix.step(f, 0.25)

      // Options.
      const o = f.options
      glide.begin(f)
      size = glide.to(size, optNumber(o, "size"))
      gap = glide.to(gap, optNumber(o, "spacing"))
      spectrum = glide.to(spectrum, optNumber(o, "spectrum"))
      stairK = glide.to(stairK, optNumber(o, "intonation"))
      glowK = glide.to(glowK, optNumber(o, "glow"))
      tails = glide.to(tails, optToggle(o, "trails") ? 1 : 0)
      const shp = shapeMix.step(glide, optChoice(o, "shape"))
      const square = shp[1]!
      const outline = shp[2]!
      const speed = optNumber(o, "speed")
      clock = clock < 0 ? f.t : clock + dt * speed
      d = d0 * size

      const speaking = f.mode === "speaking"
      const live = f.mode === "hearing" || speaking
      const v: VoiceFeatures = speaking ? f.agent : f.user
      let raw = live ? v.level : 0
      if (reduced) raw = Math.round(raw * 4) / 4
      const L = lead.step(raw, dt)
      trail = approach(trail, L, dt, reduced ? 0 : 0.09)
      if (live && v.speaking) {
        reg = approach(reg, v.register, dt, 0.5)
        rise = approach(rise, clamp(v.pitchDelta / 9, -1, 1), dt, 0.3)
        voiced = approach(voiced, v.voicing, dt, 0.2)
        bright = approach(bright, v.brightness, dt, 0.15)
      } else rise = approach(rise, 0, dt, 0.5)
      for (let k = 0; k < 4; k++) {
        let s = 0
        for (let b = 0; b < 6; b++) s += v.bands[k * 6 + b]!
        grp[k] = approach(grp[k]!, live ? s / 6 : 0, dt, 0.05)
      }

      const cx = W / 2
      const cy = H / 2
      const hMax = H * 0.6 * size
      const wHear = mix.hearing
      const wSpeak = mix.speaking
      // The row always fits the width, whatever the size and gap, and neighbours never touch
      // (the widest bar is 1.28 dots; 1.4 is the default's tightest spacing, while hearing).
      const spacing = Math.min(Math.max(d * mix.of(1.9, 1.6, 1.45, 1.7, 2.5) * gap, d * 1.4), (W - 2 * MARGIN - d * 1.45) / 3)
      if (!reduced) orbit += dt * TAU * 0.85 * (0.4 + mix.thinking) * speed
      else orbit = Math.PI / 4
      const rho = d * 1.45
      const press = f.pointer.down && f.pointer.inside
      const lean = f.pointer.inside ? clamp((f.pointer.x - cx) / (W * 0.5), -1, 1) : 0

      for (let i = 0; i < 4; i++) {
        const outer = i === 0 || i === 3
        // Row position (with the hover lean), and the orbit position for thinking.
        const rx = cx + (i - 1.5) * spacing + lean * d * 0.25 * (1 - Math.abs(i - 1.5) / 3)
        const ang = orbit + (i * TAU) / 4
        const ox = cx + Math.cos(ang) * rho
        const oy = cy + Math.sin(ang) * rho
        const th = mix.thinking
        // Listening: dots stay dots and bob in a wave that runs from the outer pair inward.
        const bobPh = clock * (TAU / 1.7) - (outer ? 0 : 0.9)
        const bob = reduced ? 0 : mix.listening * d * 0.38 * Math.max(0, Math.sin(bobPh)) ** 2
        // Intonation: a rising voice makes the row climb to the right like a staircase.
        const stair = (wHear + wSpeak) * rise * (i - 1.5) * d * 0.55 * stairK
        const tx = lerp(rx, ox, th)
        const ty = lerp(cy - bob - stair, oy, th)
        // Bar heights: outer pair leads while hearing (in), inner pair leads while speaking (out).
        const levHear = outer ? L : trail
        const levSpeak = outer ? trail : L
        const bandG = Math.max(0, 1 + spectrum * (0.7 * grp[i]! - 0.35))
        const hearH = hMax * Math.pow(clamp01(levHear * 1.5), 0.9) * V_SHAPE[i]! * bandG
        const speakH = hMax * Math.pow(clamp01(levSpeak * 1.5), 0.9) * A_SHAPE[i]! * bandG
        let th_ = d + wHear * hearH + wSpeak * speakH
        let tw = d * (1 + wHear * lerp(0.28, -0.22, reg) + wSpeak * 0.08)
        if (press) {
          th_ *= 0.82
          tw *= 1.15
        }
        if (!placed) {
          xs[i]!.set(tx)
          ys[i]!.set(ty)
          hs[i]!.set(th_)
          ws[i]!.set(tw)
        }
        xs[i]!.step(tx, dt)
        ys[i]!.step(ty, dt)
        hs[i]!.step(th_, dt)
        ws[i]!.step(tw, dt)
      }
      placed = true

      clear2d(g, dpr)

      // Colour: grey, mint for the person, amber for the reply; while thinking the orbiting dots
      // alternate mint and amber (the turn is being handed over).
      const tt = mix.thinking
      const wYou = mix.listening + wHear
      mix3Into(fill, p.inkFaint, mix.idle, p.you, wYou + tt * 0.5, p.voice, wSpeak + tt * 0.5)
      const fillC = fill
      mix3Into(dotA, p.inkFaint, mix.idle, p.you, wYou, p.voice, wSpeak + tt)
      mix3Into(dotB, p.inkFaint, mix.idle, p.you, wYou + tt, p.voice, wSpeak)

      // Glow behind the dots, stronger with the voice.
      const loud = clamp01(L * 1.6)
      const glowA = (dark ? 0.5 : 0.22) * (mix.listening * 0.3 + (wHear + wSpeak) * (0.25 + 0.75 * loud) + tt * 0.4) * glowK
      if (glowA > 0.01) {
        glow.paint(dark ? fillC : mixInto(tmp, fillC, p.bg, 0.2), 0.1, 2)
        g.globalCompositeOperation = dark ? "lighter" : "source-over"
        const reach = 0.7 + 0.3 * glowK
        for (let i = 0; i < 4; i++) glow.draw(g, xs[i]!.value, ys[i]!.value, (d * 1.6 + hs[i]!.value * 0.5) * reach, glowA * 0.6)
        g.globalCompositeOperation = "source-over"
      }

      // Thinking: comet tails behind each orbiting dot.
      if (tt * tails > 0.02 && !reduced) {
        for (let i = 0; i < 4; i++) {
          for (let k = 1; k <= 4; k++) {
            const ang = orbit + (i * TAU) / 4 - k * 0.2
            const x = cx + Math.cos(ang) * rho
            const y = cy + Math.sin(ang) * rho
            g.fillStyle = css(i % 2 === 0 ? dotA : dotB, tt * tails * (0.5 - k * 0.1))
            g.beginPath()
            g.arc(x, y, (d / 2) * (1 - k * 0.15), 0, TAU)
            g.fill()
          }
        }
      }

      // The dots / bars: filled light when voiced, hollow when breathy.
      // The "Outline" look keeps them hollow always; "Square" sharpens the corners.
      const solid = (live ? 0.12 + 0.88 * clamp01((voiced - 0.15) / 0.5) : 1) * (1 - outline)
      const whiten = dark ? (wHear + wSpeak) * bright * 0.3 : 0
      g.lineWidth = Math.max(1.2, d * 0.09) * (1 + 0.5 * outline)
      for (let i = 0; i < 4; i++) {
        const core = mixInto(tmp, i % 2 === 0 ? dotA : dotB, WHITE, whiten)
        const w = ws[i]!.value
        // Bars never leave the canvas, at any size or loudness.
        const h = Math.min(Math.max(w, hs[i]!.value), H - 2 * MARGIN)
        const x = xs[i]!.value - w / 2
        const y = clamp(ys[i]!.value - h / 2, MARGIN, H - MARGIN - h)
        g.beginPath()
        g.roundRect(x, y, w, h, (w / 2) * (1 - 0.78 * square))
        const a = mix.idle * 0.7 + (1 - mix.idle)
        g.fillStyle = css(core, a * solid)
        g.fill()
        if (solid < 0.95) {
          g.strokeStyle = css(core, a)
          g.stroke()
        }
      }
    },

    dispose() {}
  }
}

const design: Design = {
  id: "dot-quartet",
  name: "Dot quartet",
  family: "abstract",
  renderer: "2d",
  summary: "Four dots that rest as dots, stand up as bars when someone speaks (V-shaped and tight for you, Λ-shaped and spread for the assistant) and orbit while thinking.",
  inspiredBy:
    "ChatGPT's first voice mode (circle, cloud, four ovals) and Google's four dots (rest, bars, spin), with the colours taken from our palette, plus a direction rule (outer bars lead for input, inner bars lead for output) after Meta AI's ring.",
  modes: {
    idle: "Four small grey dots in a row, still.",
    listening: "Four mint dots, slightly closer together; they bob in a wave that runs from the outer pair to the inner pair.",
    hearing: "Mint bars, close together, outer pair taller and leading, inner pair following a beat later: a V that draws in.",
    thinking: "The dots gather into a small circle and orbit, alternating mint and amber, with comet tails.",
    speaking: "Amber bars spread wider, inner pair taller and leading, outer pair following: a Λ that pushes out."
  },
  mappings: [
    { signal: "active.level", effect: "Bar height 0.6·H·(1.5·level)^0.9 before the V/Λ envelope and band gain (30 ms rise, 160 ms fall); the trailing pair follows through a further 90 ms lag." },
    { signal: "active.bands (four quarters)", effect: "Each bar's height is scaled 0.65–1.35× by the energy of its quarter of the spectrum, low on the left to high on the right." },
    { signal: "active.register (hearing)", effect: "Bar width: 1.28× the dot for a deep voice down to 0.78× for a child's." },
    { signal: "active.pitchDelta", effect: "Staircase: rising intonation lifts the row to the right (up to 0.55 dot per bar), falling to the left." },
    { signal: "active.voicing", effect: "Fill opacity: voiced speech is solid light, a whisper leaves hollow outlined bars." },
    { signal: "active.brightness", effect: "Whiter bar cores for bright vowels (dark theme)." },
    { signal: "mode", effect: "Spacing (1.45 dot apart hearing, 2.5 speaking), V vs Λ envelope, which pair leads, row vs orbit, colour grey / mint / alternating mint-and-amber / amber; 250 ms crossfade on springs." },
    { signal: "pointer", effect: "The row leans toward the pointer; pressing squashes the dots (shorter, wider)." },
    { signal: "options", effect: "Size, gap, shape, glow, spectrum detail, pitch staircase, motion speed and comet tails change the drawing in every mode; they glide over about 0.2 s (snap under reduced motion). Bars are kept inside the canvas." },
    { signal: "reducedMotion", effect: "No bobbing or orbiting: thinking is a still diamond of four dots; heights in quarter steps with no lag." }
  ],
  serverNeeds: "none",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.5, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the dots are and how tall the bars grow." },
    { id: "spacing", kind: "number", label: "Gap between dots", min: 0.7, max: 1.6, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How far apart the four dots sit in every mode." },
    { id: "spectrum", kind: "number", label: "Spectrum detail", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much each bar follows its own part of the voice, low notes on the left to high on the right." },
    { id: "intonation", kind: "number", label: "Pitch staircase", min: 0, max: 2.5, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How far a rising or falling voice tilts the row into a staircase." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.25, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the dots bob while waiting and circle while thinking." },
    { id: "trails", kind: "toggle", label: "Comet tails", default: true, group: "Motion", help: "Fading tails behind the dots while they circle." },
    {
      id: "shape",
      kind: "choice",
      label: "Shape",
      choices: [
        { value: "rounded", label: "Rounded" },
        { value: "square", label: "Square" },
        { value: "outline", label: "Outline" }
      ],
      default: "rounded",
      group: "Style",
      help: "Soft pills, crisp blocks, or hollow outlines."
    },
    { id: "glow", kind: "number", label: "Glow", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Style", help: "How strong the soft light behind the dots is." }
  ],
  create
}

export default design
