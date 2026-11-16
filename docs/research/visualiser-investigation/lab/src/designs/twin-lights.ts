/**
 * Twin lights: the conversation drawn as two lights, yours (mint) and the assistant's (amber),
 * with your words travelling between them.
 *
 * Whoever has the turn is the larger, brighter light. While you speak, every syllable leaves your
 * light as a mote and flies across to the assistant's light, which takes it in; the arc a mote
 * flies on is as high as the pitch it was spoken at, bent up by a rising voice and down by a
 * falling one, and its size is how loud it was. So a still frame shows your pace (how many motes
 * are in the air), your pitch (how high they fly) and your loudness (how big they are). While the
 * assistant answers, the motes fly the other way. While it thinks, the two lights circle each
 * other like a binary star.
 */
import type { Design, DesignInstance, Rgb, VoiceFeatures } from "../contract.ts"
import { AttackRelease, Spring, TAU, approach, clamp, clamp01, clear2d, lerp, optChoice, optNumber, optToggle, rng, setup2d } from "../kit.ts"
import { ChoiceMix, type Col, css, Glide, GlowSprite, hueShift, mixInto, ModeMix, ONSET, unit } from "./_light.ts"

const MOTES = 48
const WHITE: Rgb = [255, 255, 255]
const STYLES = ["glowing", "flat", "rings"] as const
/** Keep the lights' bodies and the motes' peaks this far (CSS px) from the canvas edges. */
const MARGIN = 6

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  let U = 100

  const mix = new ModeMix()
  const rand = rng(5)
  const lvl = new AttackRelease(0.035, 0.22)
  let voiced = 0.8
  let bright = 0.4
  let rise = 0
  let prevOnset = 0
  let orbit = 0
  let breath = 0

  // The two lights: 0 = you, 1 = assistant.
  const lx = [new Spring(0.25), new Spring(0.25)]
  const ly = [new Spring(0.25), new Spring(0.25)]
  const lr = [new Spring(0.08, 0, 0.35), new Spring(0.08, 0, 0.35)]
  const kick = new Float32Array(2) // brief swell when a mote lands
  let placed = false

  // Motes in flight.
  const mAlive = new Uint8Array(MOTES)
  const mFrom = new Uint8Array(MOTES)
  const mT = new Float32Array(MOTES)
  const mSpeed = new Float32Array(MOTES)
  const mArc = new Float32Array(MOTES) // arc height, in units of U
  const mBend = new Float32Array(MOTES) // asymmetry from intonation
  const mSize = new Float32Array(MOTES)
  const mVoiced = new Float32Array(MOTES)
  const mHue = new Float32Array(MOTES)

  // Options, eased.
  const glide = new Glide()
  const styleMix = new ChoiceMix(STYLES)
  let sizeK = 1
  let distK = 1
  let youSide = -1 // −1: your light on the left, 1: on the right
  let arcK = 1
  let trailK = 1
  let glowK = 1
  let arcMax = 1e9 // highest a mote may fly above the lights, px (keeps it inside the canvas)

  const glowYou = new GlowSprite(96)
  const glowVoice = new GlowSprite(96)
  const glowSoft = new GlowSprite(64)
  let paletteRef: unknown = null
  const youLo: Col = [0, 0, 0]
  const youHi: Col = [0, 0, 0]
  const voiceLo: Col = [0, 0, 0]
  const voiceHi: Col = [0, 0, 0]
  const c0: Col = [0, 0, 0]
  const c1: Col = [0, 0, 0]
  const tmp: Col = [0, 0, 0]

  const emit = (from: number, size: number, arc: number, bend: number, voicedness: number, hue: number, speed: number): void => {
    let s = 0
    for (let i = 0; i < MOTES; i++) {
      if (!mAlive[i]) {
        s = i
        break
      }
      if (mT[i]! > mT[s]!) s = i // reuse the one closest to landing
    }
    mAlive[s] = 1
    mFrom[s] = from
    mT[s] = 0
    mSpeed[s] = speed
    mArc[s] = arc
    mBend[s] = bend
    mSize[s] = size
    mVoiced[s] = voicedness
    mHue[s] = hue
  }

  /** Position of a mote at progress t along its quadratic arc from light `from` to the other. */
  const moteX = (i: number, t: number): number => {
    const a = mFrom[i]!
    const x0 = lx[a]!.value
    const x1 = lx[1 - a]!.value
    const xc = (x0 + x1) / 2 + mBend[i]! * U * 0.6 * (x1 >= x0 ? 1 : -1)
    return (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * xc + t * t * x1
  }
  const moteY = (i: number, t: number): number => {
    const a = mFrom[i]!
    const y0 = ly[a]!.value
    const y1 = ly[1 - a]!.value
    const yc = (y0 + y1) / 2 - Math.min(mArc[i]! * U * arcK, arcMax)
    return (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * yc + t * t * y1
  }

  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
      U = unit(W, H)
    },

    frame(f) {
      const dt = f.dt
      const p = f.palette
      const dark = p.dark
      const reduced = f.reducedMotion
      mix.step(f, 0.35)

      // Options.
      const o = f.options
      glide.begin(f)
      sizeK = glide.to(sizeK, optNumber(o, "size"))
      distK = glide.to(distK, optNumber(o, "distance"))
      youSide = glide.to(youSide, optChoice(o, "yourSide") === "right" ? 1 : -1, 0.3)
      arcK = glide.to(arcK, optNumber(o, "arcHeight"))
      trailK = glide.to(trailK, optToggle(o, "trails") ? 1 : 0)
      glowK = glide.to(glowK, optNumber(o, "glow"))
      const st = styleMix.step(glide, optChoice(o, "style"))
      const flat = st[1]!
      const ringed = st[2]!
      const speed = optNumber(o, "speed")
      const sdt = dt * speed
      if (paletteRef !== p) {
        paletteRef = p
        // Register hues, gentler on the light theme where the palette colours are already deep.
        const k = p.dark ? 1 : 0.5
        hueShift(p.you, 26 * k, youLo)
        hueShift(p.you, -22 * k, youHi)
        hueShift(p.voice, -16 * k, voiceLo)
        hueShift(p.voice, 12 * k, voiceHi)
      }

      const speaking = f.mode === "speaking"
      const hearing = f.mode === "hearing"
      const live = hearing || speaking
      const v: VoiceFeatures = speaking ? f.agent : f.user
      let raw = live ? v.level : 0
      if (reduced) raw = Math.round(raw * 4) / 4
      const L = lvl.step(raw, dt)
      const loud = clamp01(L * 1.6)
      if (live && v.speaking) {
        voiced = approach(voiced, v.voicing, dt, 0.2)
        bright = approach(bright, v.brightness, dt, 0.15)
        rise = approach(rise, clamp(v.pitchDelta / 8, -1, 1), dt, 0.25)
      } else rise = approach(rise, 0, dt, 0.5)

      // Syllables become motes: from you while hearing, from the assistant while speaking.
      const hit = live && !reduced && v.onset > ONSET && prevOnset <= ONSET
      prevOnset = live ? v.onset : 0
      if (hit) {
        const from = speaking ? 1 : 0
        const arc = lerp(0.02, 0.5, clamp01((v.pitch - 0.1) / 0.8)) // pitch → arc height
        const pace = clamp01((v.syllableRate - 2) / 4)
        emit(from, 0.5 + 0.8 * loud, arc, rise, voiced, v.register, lerp(0.75, 1.25, pace) * (0.9 + 0.2 * rand()))
      }
      // Pointer: pressing near a light sends a mote from it to the other.
      if (f.pointer.down && f.pointer.inside && !reduced && rand() < dt * 5) {
        const near = Math.abs(f.pointer.x - lx[0]!.value) < Math.abs(f.pointer.x - lx[1]!.value) ? 0 : 1
        emit(near, 0.6, 0.15 + 0.3 * rand(), 0, 1, 0.5, 1)
      }

      // Light positions: apart on a shallow diagonal, or circling each other while thinking.
      if (!reduced) orbit += sdt * TAU * (0.12 + 0.55 * mix.thinking)
      else orbit = 0
      breath += sdt * (reduced ? 0 : 1)
      const cx = W / 2
      const cy = H * 0.52
      const r0 = U * 0.05 * sizeK
      // Apart by the "Distance apart" option, but never so far that a full-size light leaves the canvas.
      const sep = Math.min(Math.min(W * 0.27, U * 0.42) * distK, W / 2 - r0 * 2.1 - MARGIN)
      const th = mix.thinking
      const rho = U * 0.13
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? youSide : -youSide
        const ax = cx + side * sep
        const ay = cy + side * U * 0.02
        const ang = orbit + k * Math.PI
        const ox = cx + Math.cos(ang) * rho * 1.25
        const oy = cy + Math.sin(ang) * rho * 0.7
        const tx = lerp(ax, ox, th)
        const ty = lerp(ay, oy, th)
        if (!placed) {
          lx[k]!.set(tx)
          ly[k]!.set(ty)
        }
        lx[k]!.step(tx, dt)
        ly[k]!.step(ty, dt)
      }
      // Sizes: whoever has the turn is larger; the listener stays small but awake.
      const youR = r0 * mix.of(0.8, 1.35 + (reduced ? 0 : 0.08 * Math.sin(breath * 2)), 1.25 + 1.1 * loud, 0.9, 0.75)
      const voiceR = r0 * mix.of(0.8, 0.85, 0.95, 1.15, 1.3 + 1.1 * loud)
      for (let k = 0; k < 2; k++) {
        kick[k] = approach(kick[k]!, 0, dt, 0.18)
        const t = (k === 0 ? youR : voiceR) * (1 + 0.25 * kick[k]!)
        if (!placed) lr[k]!.set(t)
        lr[k]!.step(t, dt)
      }
      placed = true
      arcMax = 2 * (Math.min(ly[0]!.value, ly[1]!.value) - MARGIN)

      // Colours: grey when idle, otherwise each light its own colour; the light whose turn it
      // is shifts with the voice (register → hue).
      const awake = clamp01(1 - mix.idle)
      const reg = clamp01((v.register - 0.2) / 0.65)
      mixInto(tmp, youLo, youHi, reg)
      mixInto(c0, p.you, tmp, mix.hearing)
      mixInto(c0, p.inkFaint, c0, 0.25 + 0.75 * awake)
      mixInto(tmp, voiceLo, voiceHi, reg)
      mixInto(c1, p.voice, tmp, mix.speaking)
      mixInto(c1, p.inkFaint, c1, 0.25 + 0.75 * awake)
      glowYou.paint(dark ? c0 : mixInto(tmp, c0, p.bg, 0.15), 0.08, 2.2)
      glowVoice.paint(dark ? c1 : mixInto(tmp, c1, p.bg, 0.15), 0.08, 2.2)

      clear2d(g, dpr)
      const comp: GlobalCompositeOperation = dark ? "lighter" : "source-over"
      g.globalCompositeOperation = comp

      // Thinking trails: faint rings where the lights circle.
      if (th > 0.02) {
        g.lineWidth = Math.max(1, U * 0.004)
        g.strokeStyle = css(mixInto(tmp, c0, c1, 0.5), th * 0.22)
        g.beginPath()
        g.ellipse(cx, cy, rho * 1.25, rho * 0.7, 0, 0, TAU)
        g.stroke()
      }

      // The path between the lights while listening (an open line, waiting) and, under reduced
      // motion, chevrons that show which way the words go.
      const pathA = mix.listening * 0.4 + (reduced ? (mix.hearing + mix.speaking) * 0.6 : 0)
      if (pathA > 0.01) {
        const x0 = lx[0]!.value
        const y0 = ly[0]!.value
        const x1 = lx[1]!.value
        const y1 = ly[1]!.value
        g.setLineDash([Math.max(1.5, U * 0.006), Math.max(4, U * 0.02)])
        g.lineWidth = Math.max(1, U * 0.004)
        g.lineCap = "round"
        g.strokeStyle = css(speaking ? c1 : c0, pathA)
        if (!reduced) g.lineDashOffset = -breath * U * 0.03 // the dashes creep toward the assistant: ready to carry your words
        g.beginPath()
        g.moveTo(x0 + (x1 - x0) * 0.15, y0 + (y1 - y0) * 0.15)
        g.lineTo(x0 + (x1 - x0) * 0.85, y0 + (y1 - y0) * 0.85)
        g.stroke()
        g.setLineDash([])
        g.lineDashOffset = 0
        if (reduced && (mix.hearing + mix.speaking) > 0.3) {
          const dir = (speaking ? -1 : 1) * (x1 >= x0 ? 1 : -1)
          const s = U * 0.025
          g.lineWidth = Math.max(1.5, U * 0.006)
          for (let q = 1; q <= 3; q++) {
            const t = 0.25 + q * 0.125
            const x = x0 + (x1 - x0) * t
            const y = y0 + (y1 - y0) * t
            g.beginPath()
            g.moveTo(x - dir * s, y - s)
            g.lineTo(x, y)
            g.lineTo(x - dir * s, y + s)
            g.stroke()
          }
        }
      }

      // Motes.
      for (let i = 0; i < MOTES; i++) {
        if (!mAlive[i]) continue
        if (!reduced) mT[i] = mT[i]! + sdt * mSpeed[i]! * 0.9
        const t = mT[i]!
        if (t >= 1) {
          mAlive[i] = 0
          kick[1 - mFrom[i]!] = Math.min(1.5, kick[1 - mFrom[i]!]! + 0.35 * mSize[i]!)
          continue
        }
        const from = mFrom[i]!
        const x = moteX(i, t)
        const y = moteY(i, t)
        const fade = Math.min(1, t * 6) * Math.min(1, (1 - t) * 5)
        const size = U * 0.02 * mSize[i]! * sizeK
        const spr = from === 0 ? glowYou : glowVoice
        // A short tail behind the mote.
        if (trailK > 0.01) {
          for (let k = 3; k >= 1; k--) {
            const tk = Math.max(0, t - k * 0.035)
            spr.draw(g, moteX(i, tk), moteY(i, tk), size * (2.2 - k * 0.35), fade * (dark ? 0.22 : 0.16) * (1 - k * 0.2) * trailK)
          }
        }
        // Above 1× the mote glow mostly widens, so motes do not burn out into blobs.
        const moteGlow = glowK <= 1 ? glowK : 1 + 0.3 * (glowK - 1)
        spr.draw(g, x, y, size * 3.2 * (0.7 + 0.3 * glowK), fade * (dark ? 0.55 : 0.4) * moteGlow * (1 - flat))
        // The "Rings" style draws every mote hollow; "Flat" makes the solid ones a little bigger.
        const solid = clamp01((mVoiced[i]! - 0.15) / 0.5) * (1 - ringed)
        const mc = from === 0 ? c0 : c1
        if (solid > 0.3) {
          g.fillStyle = css(dark ? mixInto(tmp, mc, WHITE, 0.45) : mc, fade * (0.4 + 0.6 * solid))
          g.beginPath()
          g.arc(x, y, size * (0.7 + 0.3 * flat), 0, TAU)
          g.fill()
        } else {
          // A breathy syllable (whisper) is a hollow ring of light.
          g.strokeStyle = css(dark ? mixInto(tmp, mc, WHITE, 0.3) : mc, fade * 0.8)
          g.lineWidth = Math.max(1.2, size * 0.3)
          g.beginPath()
          g.arc(x, y, Math.max(2.5, size * 1.1), 0, TAU)
          g.stroke()
        }
      }

      // The two lights: a wide glow, a body and a bright core.
      for (let k = 0; k < 2; k++) {
        const x = lx[k]!.value
        const y = ly[k]!.value
        const r = lr[k]!.value
        const turn = k === 0 ? clamp01(mix.listening + mix.hearing) : clamp01(mix.speaking + mix.thinking * 0.6)
        const spr = k === 0 ? glowYou : glowVoice
        const cc = k === 0 ? c0 : c1
        const voiceDrive = (k === 0 ? mix.hearing : mix.speaking) * loud
        // "Flat" drops the glows for crisp discs; "Rings" keeps a little glow around an outlined light.
        const glowA = (glowK <= 1 ? glowK : 1 + 0.6 * (glowK - 1)) * (1 - flat) * (1 - 0.5 * ringed)
        spr.draw(g, x, y, r * (3.2 + 2.4 * voiceDrive) * (0.7 + 0.3 * glowK), (dark ? 0.32 : 0.22) * (0.35 + 0.65 * turn) * (0.4 + 0.6 * awake) * glowA)
        spr.draw(g, x, y, r * 1.7, (dark ? 0.75 : 0.6) * (0.5 + 0.5 * turn) * (0.4 + 0.6 * awake) * (1 - flat) * (1 - 0.7 * ringed))
        g.globalCompositeOperation = "source-over"
        const coreMix = dark ? 0.2 + 0.3 * bright * voiceDrive : 0
        const coreA = (0.55 + 0.45 * awake) * (0.6 + 0.4 * turn)
        const coreR = r * (0.62 + 0.2 * flat)
        mixInto(tmp, cc, dark ? WHITE : cc, coreMix)
        if (ringed < 0.99) {
          g.fillStyle = css(tmp, coreA * (1 - ringed))
          g.beginPath()
          g.arc(x, y, coreR, 0, TAU)
          g.fill()
        }
        if (ringed > 0.01) {
          g.strokeStyle = css(tmp, coreA * ringed)
          g.lineWidth = Math.max(1.5, r * 0.14)
          g.beginPath()
          g.arc(x, y, coreR, 0, TAU)
          g.stroke()
        }
        g.globalCompositeOperation = comp
      }

      // Listening: a slow halo ring around your light that closes in (it is waiting for you).
      if (mix.listening > 0.02 && !reduced) {
        const ph = (breath / 2.6) % 1
        const r = lr[0]!.value * (2.6 - 1.4 * ph)
        g.lineWidth = Math.max(1, U * 0.004)
        g.strokeStyle = css(c0, mix.listening * 0.5 * Math.sin(ph * Math.PI))
        g.beginPath()
        g.arc(lx[0]!.value, ly[0]!.value, r, 0, TAU)
        g.stroke()
      }
      // Hover: the light under the pointer swells its glow.
      if (f.pointer.inside) {
        for (let k = 0; k < 2; k++) {
          const d = Math.hypot(f.pointer.x - lx[k]!.value, f.pointer.y - ly[k]!.value)
          const near = clamp01(1 - d / (U * 0.18))
          if (near <= 0) continue
          glowSoft.paint(k === 0 ? c0 : c1, 0.1, 2)
          glowSoft.draw(g, lx[k]!.value, ly[k]!.value, lr[k]!.value * 4, near * 0.35 * (1 - 0.7 * flat))
        }
      }
      g.globalCompositeOperation = "source-over"
    },

    dispose() {}
  }
}

const design: Design = {
  id: "twin-lights",
  name: "Twin lights",
  family: "abstract",
  renderer: "2d",
  summary: "The conversation as two lights, yours and the assistant's: each syllable flies as a mote of light from whoever is speaking to the other, high for a high pitch, big when loud.",
  inspiredBy:
    "The direction rule of Meta AI's ring (inward when listening, outward when responding) made literal with two parties, the mote-per-syllable idea from the Rapport Agent's finding that timing matters, and the binary-star loading loops of Google's dots. No product shows the two sides as two lights.",
  modes: {
    idle: "Two small grey lights resting apart.",
    listening: "Your mint light is larger and breathing, a halo closing in on it; a dotted path to the small amber light creeps toward the assistant.",
    hearing: "Your light swells with your voice; each syllable flies as a mint mote across to the amber light, which swells a little as it takes each one in.",
    thinking: "The two lights circle each other closely, like a binary star.",
    speaking: "The amber light is large and pulsing; its syllables fly back as amber motes to your small mint light."
  },
  mappings: [
    { signal: "active.onset", effect: "Each syllable onset emits one mote from the speaker's light to the other: a still frame shows the pace as the number of motes in the air." },
    { signal: "active.pitch (at the onset)", effect: "Arc height of that mote's flight: almost flat for a deep voice, up to half the unit high for a child's." },
    { signal: "active.pitchDelta", effect: "Bends the arc: a rising voice (a question) pushes the arc's peak toward the listener, a falling one back toward the speaker." },
    { signal: "active.level", effect: "Speaker light radius (×1.25 → ×2.35) and glow reach (35 ms rise, 220 ms fall); mote size at the onset." },
    { signal: "active.syllableRate", effect: "Mote flight speed, 0.75× for slow speech to 1.25× for fast." },
    { signal: "active.voicing", effect: "Smoothed 200 ms and stamped on each mote at its onset: voiced syllables fly as solid points of light, breathy ones (a whisper) as hollow rings." },
    { signal: "active.register", effect: "Speaker light hue: mint leans sea-blue (deep) to spring green (high); amber leans coral to gold." },
    { signal: "active.brightness", effect: "Whiter core of the speaker's light (dark theme)." },
    { signal: "mode", effect: "Which light is large, which way motes fly, apart vs circling, grey vs colour; 350 ms crossfade on springs." },
    { signal: "pointer", effect: "Hovering a light swells its glow; pressing near one sends motes from it to the other." },
    { signal: "options", effect: "Size, distance apart, which side is yours, flight height, mote tails, motion speed, glow and style (glowing / flat / rings) change every mode; they glide over 0.2–0.3 s (snap under reduced motion). Swapping sides sends the lights past each other. Distance and flight height are capped so lights and motes stay inside the canvas." },
    { signal: "reducedMotion", effect: "No motes, orbit, breathing or creeping path; a still dotted path with chevrons shows which way the words go, light sizes show whose turn it is." }
  ],
  serverNeeds: "none (word timings from the server could emit one mote per word instead of per syllable, and the transcript could label them)",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.5, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the two lights and the motes are." },
    { id: "distance", kind: "number", label: "Distance apart", min: 0.5, max: 1.3, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How far apart the two lights sit." },
    { id: "arcHeight", kind: "number", label: "Flight height", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How high the motes fly for a high-pitched syllable; 0 sends every mote straight across." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.3, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the motes fly, the lights circle while thinking and your light breathes." },
    { id: "trails", kind: "toggle", label: "Mote tails", default: true, group: "Motion", help: "A short fading tail behind each flying mote." },
    {
      id: "style",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "glowing", label: "Glowing" },
        { value: "flat", label: "Flat" },
        { value: "rings", label: "Rings" }
      ],
      default: "glowing",
      group: "Style",
      help: "Soft glowing lights, crisp flat discs, or outlined rings."
    },
    { id: "glow", kind: "number", label: "Glow", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Style", help: "How far the light spreads around each light and mote." },
    {
      id: "yourSide",
      kind: "choice",
      label: "Your side",
      choices: [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" }
      ],
      default: "left",
      group: "Behaviour",
      help: "Which of the two lights is yours."
    }
  ],
  create
}

export default design
