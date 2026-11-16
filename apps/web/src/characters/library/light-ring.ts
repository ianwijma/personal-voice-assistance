/**
 * Light ring: a ring of light after the Echo light ring, with an honest replacement for its
 * direction cue.
 *
 * The Echo points a bright segment at the person speaking; we have no microphone direction, so
 * the bright arc points at the *pitch* of your voice instead: it sits at the bottom of the ring
 * for a deep voice and climbs the sides toward the top for a high one, like a level in a bowl.
 * Every syllable you speak arrives as a spark from outside that lands on the ring and stays as a
 * bead for a moment, so the beads trace your intonation and their number shows your pace. While
 * the assistant speaks the whole ring lights up amber, its thickness follows the spectrum of the
 * reply, and each syllable sends a ripple outward.
 */
import type { Character, CharacterInstance, Rgb, VoiceFeatures } from "../contract.ts"
import { AttackRelease, TAU, approach, clamp01, clear2d, optChoice, optNumber, optToggle, setup2d } from "../kit.ts"
import { ChoiceMix, type Col, css, Glide, GlowSprite, hueShift, mixInto, ModeMix, ONSET } from "../shared/light.ts"

const BEADS = 24
const RIPPLES = 6
const SEG = 96 // samples around the ring for the spectrum band
const WHITE: Rgb = [255, 255, 255]
const STYLES = ["glow", "crisp", "segments"] as const
const SPOKES = 36 // gaps in the "Segments" style
/** Fixed arc positions (elevation 0 bottom .. 1 top) for the "Arc position" choices that stay put. */
const ARC_PLACE: { readonly [k: string]: number } = { bottom: 0.08, sides: 0.5, top: 0.92 }

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1 // the focus box, set per frame
  let H = 1
  let dpr = 1
  let R = 10 // radius at size 1

  const mix = new ModeMix()
  const lvl = new AttackRelease(0.035, 0.22)
  const radius = new AttackRelease(0.12, 0.3)
  let elev = 0.4 // arc position: 0 bottom .. 1 top (from pitch)
  let voiced = 0.7
  let bright = 0.4
  let prevOnset = 0
  let chase = 0
  const bands = new Float32Array(24)
  const prof = new Float32Array(SEG + 1)

  // Beads: where syllables landed (elevation), when.
  const beadE = new Float32Array(BEADS)
  const beadAge = new Float32Array(BEADS).fill(99)
  let beadHead = 0
  // Ripples (speaking).
  const ripAge = new Float32Array(RIPPLES).fill(99)
  const ripGain = new Float32Array(RIPPLES)
  let ripHead = 0

  // Options, eased.
  const glide = new Glide()
  const styleMix = new ChoiceMix(STYLES)
  let sizeK = 1
  let thickK = 1
  let arcK = 1
  let specK = 1
  let clock = -1 // ambient time at the "Motion speed"
  let soft = 1 // 1 with the glow passes, 0 crisp

  const glow = new GlowSprite(64)
  let paletteRef: unknown = null
  const youDeep: Col = [0, 0, 0]
  const youHigh: Col = [0, 0, 0]
  const col: Col = [0, 0, 0]
  const arcCol: Col = [0, 0, 0]
  const tmp: Col = [0, 0, 0]

  /** Stroke an arc several times, wide-and-faint to narrow-and-bright: a cheap glow. */
  const glowArc = (cx: number, cy: number, r: number, a0: number, a1: number, width: number, c: Rgb, alpha: number, dark: boolean): void => {
    if (alpha <= 0.003 || a1 <= a0) return
    const passes = dark ? 3 : 2
    for (let k = 0; k < passes; k++) {
      const wk = k === 0 ? width * (dark ? 3.4 : 2.6) : k === 1 ? width * (dark ? 1.8 : 1) : width
      // The "Crisp" style fades out the wide outer passes (the glow), keeping the bright core.
      const ak = (k === 0 ? (dark ? 0.14 : 0.14) : k === 1 ? (dark ? 0.32 : 1) : 1) * (k === passes - 1 ? 1 : soft)
      if (ak < 0.003) continue
      // Inner passes are a little shorter, so arcs taper; a full circle stays closed.
      const shrink = k === 0 || a1 - a0 > TAU - 0.01 ? 0 : (a1 - a0) * 0.08 * k
      g.lineWidth = wk
      g.strokeStyle = css(k === passes - 1 && dark ? mixInto(tmp, c, WHITE, 0.25) : c, alpha * ak)
      g.beginPath()
      g.arc(cx, cy, r, a0 + shrink, a1 - shrink)
      g.stroke()
    }
  }

  return {
    resize(width, height, ratio) {
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f) {
      const fo = f.focus
      W = fo.width
      H = fo.height
      R = Math.min(H * 0.34, W * 0.3)
      const px = f.pointer.x - fo.x
      const py = f.pointer.y - fo.y
      const overBox = f.pointer.inside && px >= 0 && px < W && py >= 0 && py < H
      const dt = f.dt
      const p = f.palette
      const dark = p.dark
      const reduced = f.reducedMotion
      mix.step(f, 0.3)

      // Options.
      const o = f.options
      glide.begin(f)
      sizeK = glide.to(sizeK, optNumber(o, "size"))
      thickK = glide.to(thickK, optNumber(o, "thickness"))
      arcK = glide.to(arcK, optNumber(o, "arcLength"))
      specK = glide.to(specK, optNumber(o, "spectrum"))
      const st = styleMix.step(glide, optChoice(o, "style"))
      soft = 1 - st[1]!
      const segs = st[2]!
      const sparks = optToggle(o, "sparks")
      const place = optChoice(o, "arcPlace")
      const speed = optNumber(o, "speed")
      const sdt = dt * speed
      clock = clock < 0 ? f.t : clock + sdt
      if (paletteRef !== p) {
        paletteRef = p
        hueShift(p.you, -22, youDeep)
        hueShift(p.you, 18, youHigh)
      }

      const speaking = f.mode === "speaking"
      const live = f.mode === "hearing" || speaking
      const v: VoiceFeatures = speaking ? f.agent : f.user
      const raw = live ? v.level : 0
      const L = lvl.step(reduced ? Math.round(raw * 4) / 4 : raw, dt)
      const fixed = ARC_PLACE[place]
      if (fixed !== undefined) elev = glide.to(elev, fixed, 0.25)
      else if (live && v.speaking && v.voicing > 0.3) elev = approach(elev, reduced ? Math.round(v.pitch * 6) / 6 : v.pitch, dt, reduced ? 0.25 : 0.09)
      if (live && v.speaking) {
        voiced = approach(voiced, v.voicing, dt, 0.25)
        bright = approach(bright, v.brightness, dt, 0.15)
      }
      for (let i = 0; i < 24; i++) bands[i] = approach(bands[i]!, live ? v.bands[i]! : 0, dt, 0.06)

      // Onsets: a bead (hearing) or a ripple (speaking).
      const hit = live && !reduced && sparks && v.onset > ONSET && prevOnset <= ONSET
      prevOnset = live ? v.onset : 0
      if (hit && f.mode === "hearing") {
        beadE[beadHead] = elev
        beadAge[beadHead] = 0
        beadHead = (beadHead + 1) % BEADS
      }
      if (hit && speaking) {
        ripAge[ripHead] = 0
        ripGain[ripHead] = 0.4 + 0.6 * clamp01(L * 1.6)
        ripHead = (ripHead + 1) % RIPPLES
      }
      for (let i = 0; i < BEADS; i++) beadAge[i] = beadAge[i]! + sdt
      for (let i = 0; i < RIPPLES; i++) ripAge[i] = ripAge[i]! + sdt

      // Ring radius: small and still when ready, full while hearing or speaking.
      const loud = clamp01(L * 1.6)
      const press = f.pointer.down && overBox ? 0.94 : 1
      // Size, capped so the ring and its thickest spectrum band stay inside the canvas.
      const fit = (0.5 * Math.min(W, H) - 2) / (1.07 + (0.105 + 0.219 * specK) * thickK)
      const Rs = Math.min(R * sizeK, fit)
      const rT = Rs * press * mix.of(0.5, 0.56, 1, 0.86, 1 + 0.07 * loud)
      const r = radius.step(rT, dt)
      const cx = W / 2
      const cy = H / 2
      const unitW = Math.max(1, Rs / 40) * thickK // stroke scale
      // Things that fly outside the ring (shimmer, sparks, ripples) travel no further out than at size 1.
      const outK = Math.min(1, R / Rs)
      const edge = 0.5 * Math.min(W, H) - 1

      // Colours.
      const register = clamp01((f.user.register - 0.2) / 0.65)
      mixInto(arcCol, youDeep, youHigh, register)
      mixInto(col, p.inkFaint, p.you, clamp01(mix.listening + mix.hearing + 0.4 * mix.thinking))
      mixInto(col, col, p.voice, clamp01(mix.speaking + 0.6 * mix.thinking))

      clear2d(g, dpr, fo) // the whole canvas; (0, 0) is the box's top-left corner
      g.lineCap = "round"
      g.globalCompositeOperation = dark ? "lighter" : "source-over"

      // Base ring: dim when idle, solid and glowing when ready, a quiet track while hearing,
      // the speaking ring is drawn as the spectrum band below.
      const baseA = mix.of(0.4, 0.95, 0.28, 0.25, 0.1)
      const baseW = unitW * mix.of(1.2, 3, 1.6, 1.8, 1.5)
      glowArc(cx, cy, r, 0, TAU, baseW, col, baseA, dark)

      // Listening: an inner halo, so "ready" reads as a lit ring, not an outline.
      if (mix.listening > 0.01) {
        glow.paint(dark ? p.you : mixInto(tmp, p.you, p.bg, 0.3), 0.55, 2.4)
        glow.draw(g, cx, cy, r * 1.05, mix.listening * (dark ? 0.16 : 0.18))
        // A slow inward shimmer every 3.2 s: a faint ring closing in on the light.
        if (!reduced) {
          const ph = (clock / 3.2) % 1
          const rr = r * (1 + 0.7 * (1 - ph) * outK)
          g.lineWidth = unitW * 1.2
          g.strokeStyle = css(p.you, mix.listening * 0.35 * Math.sin(ph * Math.PI))
          g.beginPath()
          g.arc(cx, cy, rr, 0, TAU)
          g.stroke()
        }
      }

      // Hearing: the arc pair, placed by pitch, long by loudness; dotted when breathy.
      if (mix.hearing > 0.01) {
        const e = elev * Math.PI
        const hl = (0.14 + 1.05 * loud) * mix.hearing * arcK
        const w = unitW * (2.2 + 3.5 * loud)
        const a = mix.hearing * (0.55 + 0.45 * loud)
        // Pointer hover pulls the light toward it a little.
        const brightCol = dark ? mixInto(tmp, arcCol, WHITE, 0.1 + 0.35 * bright) : (arcCol)
        if (voiced < 0.35) {
          // Whisper: the arc breaks into a dotted line of small lights.
          g.setLineDash([unitW * 1.5, unitW * 5])
        }
        for (let s = -1; s <= 1; s += 2) {
          const c = Math.PI / 2 - s * e
          glowArc(cx, cy, r, c - hl, c + hl, w, brightCol, a, dark)
        }
        g.setLineDash([])
        // Beads: each syllable landed at the pitch it had; they fade over 1.8 s.
        for (let i = 0; i < BEADS; i++) {
          const age = beadAge[i]!
          if (age > 1.8) continue
          const be = beadE[i]! * Math.PI
          const land = clamp01(age / 0.22)
          const rr = r * (1 + 0.45 * outK * (1 - land) * (1 - land)) // sparks come in from outside
          const fade = mix.hearing * (age < 0.22 ? 0.4 + 0.6 * land : 1 - (age - 0.22) / 1.58)
          const rad = unitW * (land < 1 ? 2.4 : 3.4)
          for (let s = -1; s <= 1; s += 2) {
            const ang = Math.PI / 2 - s * be
            const x = cx + Math.cos(ang) * rr
            const y = cy + Math.sin(ang) * rr
            glow.paint(dark ? (arcCol) : p.you, 0.25, 1.8)
            glow.draw(g, x, y, rad * 3.5, fade * (dark ? 0.6 : 0.5) * (0.25 + 0.75 * soft))
            g.fillStyle = css(dark ? WHITE : p.you, fade * 0.9)
            g.beginPath()
            g.arc(x, y, rad * 0.6, 0, TAU)
            g.fill()
          }
        }
      }

      // Thinking: a chase of alternating mint and amber segments.
      if (mix.thinking > 0.01) {
        if (!reduced) chase += sdt * 1.05 * TAU
        const n = 3
        const segL = 0.55
        for (let i = 0; i < n * 2; i++) {
          const c = chase + (i * TAU) / (n * 2)
          const cc = i % 2 === 0 ? p.voice : p.you
          glowArc(cx, cy, r, c - segL / 2, c + segL / 2, unitW * 2.6, cc, mix.thinking * (i % 2 === 0 ? 0.95 : 0.6), dark)
        }
      }

      // Speaking: the full ring as a band whose thickness follows the spectrum (low bands at the
      // bottom, high at the top, mirrored), pulsing with the reply; ripples go outward.
      if (mix.speaking > 0.01) {
        const sp = mix.speaking
        const base = unitW * (2.2 + 2 * loud)
        const gain = unitW * 7 * (0.25 + loud) * specK
        // The band grows outward only (light given out), the inner edge stays a clean circle.
        for (let k = 0; k <= SEG; k++) prof[k] = base + gain * bandAt(bands, (k / SEG) * TAU)
        for (let pass = 0; pass < (dark ? 2 : 1); pass++) {
          const grow = pass === 0 && dark ? 1 + 1.4 / Math.max(1, thickK) : 1 // the faint outer glow does not balloon with a thick ring
          if (pass === 0 && dark && soft < 0.01) continue
          g.fillStyle = dark ? css(pass === 0 ? p.voice : mixInto(tmp, p.voice, WHITE, 0.08 + 0.2 * bright), sp * (pass === 0 ? 0.16 * soft : 0.9)) : css(p.voice, sp * 0.92)
          const r0 = Math.max(0, r - base * 0.5 * grow)
          g.beginPath()
          for (let k = 0; k <= SEG; k++) {
            const ang = (k / SEG) * TAU
            const ro = r0 + prof[k]! * grow
            if (k === 0) g.moveTo(cx + Math.cos(ang) * ro, cy + Math.sin(ang) * ro)
            else g.lineTo(cx + Math.cos(ang) * ro, cy + Math.sin(ang) * ro)
          }
          g.closePath()
          g.moveTo(cx + r0, cy)
          g.arc(cx, cy, r0, 0, TAU, true)
          g.fill()
        }
        if (reduced) {
          // A second still ring outside: "giving out", without motion.
          g.lineWidth = unitW * 1.4
          g.strokeStyle = css(p.voice, sp * 0.45)
          g.beginPath()
          g.arc(cx, cy, r * 1.22, 0, TAU)
          g.stroke()
        }
        for (let i = 0; i < RIPPLES; i++) {
          const age = ripAge[i]!
          if (age > 1.1) continue
          const u = age / 1.1
          g.lineWidth = unitW * (2.5 - 1.8 * u) * ripGain[i]!
          g.strokeStyle = css(p.voice, sp * (1 - u) * 0.7 * ripGain[i]!)
          g.beginPath()
          g.arc(cx, cy, r * (1.06 + 0.6 * u * outK), 0, TAU)
          g.stroke()
        }
      }

      // "Segments" style: cut the light into LED-like segments with thin radial gaps.
      if (segs > 0.01) {
        g.globalCompositeOperation = "destination-out"
        g.strokeStyle = css(WHITE, segs)
        // Gaps never take more than a third of the circumference, so a small ring stays readable.
        g.lineWidth = Math.min(Math.max(1.5, unitW * 1.6), (0.33 * TAU * r) / SPOKES)
        g.lineCap = "butt"
        const r0 = r * 0.72
        const r1 = Math.max(edge + 1, r * 1.9) // past the ripples, so no glow is left unsegmented
        g.beginPath()
        for (let k = 0; k < SPOKES; k++) {
          const ang = (k / SPOKES) * TAU + Math.PI / SPOKES
          const ca = Math.cos(ang)
          const sa = Math.sin(ang)
          g.moveTo(cx + ca * r0, cy + sa * r0)
          g.lineTo(cx + ca * r1, cy + sa * r1)
        }
        g.stroke()
        g.lineCap = "round"
        g.globalCompositeOperation = dark ? "lighter" : "source-over"
      }

      // Pointer: a soft highlight on the ring at the pointer's angle.
      if (f.pointer.inside) {
        const ang = Math.atan2(py - cy, px - cx)
        const d = Math.hypot(px - cx, py - cy)
        const near = clamp01(1 - Math.abs(d - r) / (R * 0.8))
        glow.paint(dark ? WHITE : col, 0.2, 2)
        glow.draw(g, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, unitW * 14, near * 0.35)
      }
      g.globalCompositeOperation = "source-over"
    },

    dispose() {}
  }
}

const band = (bands: Float32Array, k: number): number => bands[k < 0 ? 0 : k > 23 ? 23 : k]!

/** Spectrum value around the ring: angle π/2 (bottom) is the lowest band, −π/2 (top) the highest, mirrored left and right. */
const bandAt = (bands: Float32Array, ang: number): number => {
  // Distance from the bottom, 0..π.
  let a = ang - Math.PI / 2
  a = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))
  const x = (a / Math.PI) * 23
  const i = Math.floor(x)
  const t = x - i
  // Average three neighbours so the band is smooth, not lumpy.
  const b0 = (band(bands, i - 1) + 2 * band(bands, i) + band(bands, i + 1)) / 4
  const b1 = (band(bands, i) + 2 * band(bands, i + 1) + band(bands, i + 2)) / 4
  return b0 + (b1 - b0) * t
}

const character: Character = {
  id: "light-ring",
  name: "Light ring",
  version: "1.1.0",
  contract: 1,
  family: "abstract",
  renderer: "2d",
  canvas: "stage",
  summary: "A ring of light whose bright arc sits where your pitch is (deep at the bottom, high at the top), beads marking each syllable; the whole ring lights amber when the assistant speaks.",
  inspiredBy:
    "The Echo light ring (ready, directional arc, alternating chase, full ring) and the Alexa+ indicator's loudness-width pulse. The Echo's arc points at the speaker; with no microphone direction, ours points at your pitch. Outward ripples for the reply after Meta AI's ring.",
  modes: {
    idle: "A small, dim grey ring.",
    listening: "Ready: a small, solid mint ring with an inner glow, still; a faint ring closes in on it every few seconds.",
    hearing: "The ring opens to full size as a faint track; two mint arcs sit at your pitch (bottom for deep, top for high), long when loud; sparks fly in and land as beads.",
    thinking: "Alternating amber and mint segments chase clockwise around a slightly smaller ring.",
    speaking: "The full ring glows amber, thick where the reply's spectrum is strong; each syllable sends a ripple outward."
  },
  mappings: [
    { signal: "user.pitch (hearing)", effect: "Arc position: elevation = pitch × 180° from the bottom of the ring, mirrored left and right; 90 ms smoothing, only while voiced." },
    { signal: "user.level (hearing)", effect: "Arc length (±0.14 → ±1.2 rad) and thickness; 35 ms rise, 220 ms fall." },
    { signal: "user.onset (hearing)", effect: "Each syllable onset fires a spark from 1.45× the radius that lands on the ring at the current pitch and stays as a bead for 1.8 s: the beads trace intonation, their count shows the pace." },
    { signal: "user.voicing (hearing)", effect: "Below 0.35 (a whisper) the arcs break into dotted lights." },
    { signal: "user.register", effect: "Arc hue: mint leans sea-blue for deep voices, spring-green for high ones." },
    { signal: "active.brightness", effect: "Whiter arc core (dark theme) for bright vowels." },
    { signal: "agent.bands (speaking)", effect: "Ring thickness around the circumference: low bands at the bottom up to high bands at the top, mirrored." },
    { signal: "agent.level (speaking)", effect: "Ring radius (+7 %), base thickness and band gain." },
    { signal: "agent.onset (speaking)", effect: "Each syllable sends a ripple outward to 1.66× the radius over 1.1 s, stronger when louder." },
    { signal: "mode", effect: "Ring size (small when idle or ready, full while hearing or speaking), colour (grey / mint / amber), arc vs chase vs full band; 300 ms crossfade." },
    { signal: "pointer", effect: "Hover lights the ring at the pointer's angle; pressing shrinks the ring 6 %." },
    { signal: "options", effect: "Size, ring thickness, arc position (follows pitch, or stays at the bottom, sides or top), arc length, spectrum detail, sparks and ripples, motion speed and style (glow / crisp / segments) change every mode; they glide over about 0.2 s (snap under reduced motion). The ring is capped so it and its spectrum band stay inside the box; its glow, sparks and ripples fade out over the whole page." },
    { signal: "reducedMotion", effect: "No chase, sparks, ripples or shimmer; thinking shows still alternating segments, speaking a second still outer ring; level in quarter steps, arc position in sixths of the ring." }
  ],
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.15, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the ring is." },
    { id: "thickness", kind: "number", label: "Ring thickness", min: 0.5, max: 2.5, step: 0.1, default: 1, unit: "×", group: "Shape", help: "How thick every line of the ring is drawn." },
    { id: "arcLength", kind: "number", label: "Arc length", min: 0.4, max: 1.8, step: 0.1, default: 1, unit: "×", group: "Shape", help: "How far the bright arcs stretch around the ring while you speak." },
    { id: "spectrum", kind: "number", label: "Spectrum detail", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much the ring's thickness follows the reply's low and high sounds while the assistant speaks." },
    { id: "sparks", kind: "toggle", label: "Sparks and ripples", default: true, group: "Motion", help: "Each syllable lands as a spark on the ring (you) or sends a ripple outward (the assistant)." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.3, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the thinking chase runs, beads fade and ripples spread." },
    {
      id: "style",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "glow", label: "Glow" },
        { value: "crisp", label: "Crisp" },
        { value: "segments", label: "Segments" }
      ],
      default: "glow",
      group: "Style",
      help: "Soft glowing light, clean lines without the glow, or light cut into segments like an LED ring."
    },
    {
      id: "arcPlace",
      kind: "choice",
      label: "Arc position",
      choices: [
        { value: "pitch", label: "Follows pitch" },
        { value: "bottom", label: "Bottom" },
        { value: "sides", label: "Sides" },
        { value: "top", label: "Top" }
      ],
      default: "pitch",
      group: "Behaviour",
      help: "Whether the bright arcs climb with the pitch of your voice or stay in one place."
    }
  ],
  create
}

export default character
