/**
 * Dot matrix: a face on a 27 × 13 LED matrix, the kind of display a small voice node could carry.
 * Pixel eyes, a pixel mouth, and two "ears": the edge columns light up in mint as a pitch-and-
 * loudness meter while you speak (the lit segment sits at the height of your pitch and grows
 * with your loudness), so the voice itself is visible in a still frame. The mouth lights amber
 * and takes the reply's shapes.
 *
 * Shapes are signed-distance fields rasterised onto the grid with one pixel of anti-aliasing, so
 * features glide between LEDs instead of jumping. LEDs are batched by colour and brightness level
 * into a handful of paths per frame.
 */
import type { Design, DesignInstance, Frame } from "../contract.ts"
import { approach, clamp01, clear2d, lerp, optChoice, optNumber, rng, setup2d, TAU } from "../kit.ts"
import {
  APPEARANCE,
  Blinker,
  Dip,
  EXPRESSIVENESS,
  type Five,
  FOLLOWS_POINTER,
  Gaze,
  Glide,
  Ink,
  instanceSeed,
  LIVELINESS,
  mixInto,
  ModeMix,
  Mouth,
  MOUTH_RANGE,
  nodsOption,
  Personality,
  Social,
  sizeOption,
  youDirection
} from "./_character.ts"

/** "Grid" choice → columns × rows. The face is laid out on the medium grid and scaled to the others. */
const GRIDS: { readonly [k: string]: readonly [cols: number, rows: number] } = { coarse: [19, 9], medium: [27, 13], fine: [39, 19] }
/** "LEDs" choice → square (0 round .. 1 square) and unlit LEDs shown (0..1). */
const LED_STYLES: { readonly [k: string]: readonly [square: number, unlit: number] } = { round: [0, 1], square: [1, 1], roundLit: [0, 0], squareLit: [1, 0] }
const LEVELS = 6 // brightness buckets per colour

//                          idle   listen hear   think  speak
const EYE_H: Five = [0.5, 2.2, 2.1, 1.3, 1.8] // half-height in pixels
const EYE_W: Five = [1.8, 1.5, 1.5, 1.5, 1.6]
const EYE_Y: Five = [-0.6, -1.6, -1.4, -1.8, -1.4]
const SMILE: Five = [0, 0.18, 0.08, 0, 0]
const BRIGHT: Five = [0.4, 1, 1, 0.9, 1]
const BLINK_MEAN: Five = [5, 4, 4.6, 2.5, 3.2]

/** Rounded-rectangle signed distance, in pixels. */
const sdBox = (px: number, py: number, hx: number, hy: number, r: number): number => {
  const qx = Math.abs(px) - hx + r
  const qy = Math.abs(py) - hy + r
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r
}
/** Anti-aliased coverage from a signed distance (one pixel wide). */
const cover = (d: number): number => clamp01(0.55 - d)

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  const seed = instanceSeed(13)
  const mix = new ModeMix()
  const social = new Social(seed)
  const blink = new Blinker(seed + 1)
  const gaze = new Gaze(seed + 2)
  const rand = rng(seed + 3)
  const mouth = new Mouth()
  const ink = new Ink()
  const you = { x: 0, y: 0 }
  const offRgb: [number, number, number] = [0, 0, 0]
  const onRgb: [number, number, number] = [0, 0, 0]
  // The grid (reallocated only when the "Grid" option changes) and its scale against the medium grid.
  let COLS = 27
  let ROWS = 13
  let CX = 13
  let CY = 6
  let kG = 1
  let gridFor = "medium"
  // Per-LED brightness per channel, then the bucket each LED falls in.
  let bInk = new Float32Array(COLS * ROWS)
  let bYou = new Float32Array(COLS * ROWS)
  let bVoice = new Float32Array(COLS * ROWS)
  const setGrid = (name: string): void => {
    const dims = GRIDS[name] ?? GRIDS.medium!
    gridFor = name
    COLS = dims[0]
    ROWS = dims[1]
    CX = (COLS - 1) / 2
    CY = (ROWS - 1) / 2
    kG = CX / 13
    bInk = new Float32Array(COLS * ROWS)
    bYou = new Float32Array(COLS * ROWS)
    bVoice = new Float32Array(COLS * ROWS)
  }
  const pers = new Personality()
  const gSize = new Glide(1)
  const gSquare = new Glide(0)
  const gUnlit = new Glide(1)
  const grid = new Dip<string>("medium")
  // One LED's path at (x, y): a dot, a square, or (while the shape glides) a rounded square.
  let rad = 1
  let sqK = 0
  let half = 1
  let corner = 1
  const led = (x: number, y: number): void => {
    if (sqK <= 0.001) {
      g.moveTo(x + rad, y)
      g.arc(x, y, rad, 0, TAU)
    } else if (sqK >= 0.999) g.rect(x - half, y - half, half * 2, half * 2)
    else g.roundRect(x - half, y - half, half * 2, half * 2, corner)
  }
  let pitchRow = 0
  let meter = 0
  let dotsPhase = 0
  let hS = 0.5
  let wS = 1.8
  let yS = -0.6
  let mouthW = 2
  let mouthH = 0.5
  let tiltS = 0
  // Colour strings per palette: the unlit LED and each brightness bucket of each channel.
  let cachedFor: Frame["palette"] | null = null
  let offCss = ""
  const bucketCss: string[] = new Array<string>(3 * (LEVELS + 1)).fill("")
  const glowCss: string[] = ["", "", ""]

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
      // Appearance options. A new grid fades the panel out, swaps, and fades it back in.
      grid.step(GRIDS[optChoice(f.options, "grid")] !== undefined ? optChoice(f.options, "grid") : "medium", f)
      if (grid.shown !== gridFor) setGrid(grid.shown)
      const fade = grid.alpha
      const style = LED_STYLES[optChoice(f.options, "ledStyle")] ?? LED_STYLES.round!
      const size = gSize.step(optNumber(f.options, "size"), f)
      sqK = gSquare.step(style[0], f, 0.18)
      const unlitA = gUnlit.step(style[1], f, 0.2)
      const hearW = mix.hearing
      const speakW = mix.speaking
      const thinkW = mix.thinking
      const k = reduced ? 0 : 1

      // Layout: LED pitch so the matrix fits with a margin (times the size option); centred.
      const pitch = Math.min((W * 0.94) / COLS, (H * 0.9) / ROWS) * size
      const x0 = W / 2 - (CX * pitch)
      const y0 = H / 2 - (CY * pitch)

      // Gaze, in pixels.
      youDirection(f, W / 2, H / 2, pitch * 12 * kG, you, pers.followsPointer)
      let gx = you.x
      let gy = you.y
      let spread = 0.1
      let hold = 1.3
      if (f.mode === "thinking") {
        gx = 0.8 * S.thinkSide
        gy = -0.7
        spread = 0.6
        hold = 0.3
      } else if (f.mode === "speaking") {
        gx = lerp(gx, 0.8 * S.lookSide, S.lookAway)
      } else if (f.mode === "idle") {
        gy = 0.4
        hold = 3
      }
      gaze.step(dt, gx, gy, spread, hold / pers.liveliness, reduced)
      if (gaze.saccade && rand() < 0.25) blink.trigger()
      if (S.ack) blink.trigger()
      const bl = blink.step(dt, mix.pick(BLINK_MEAN) / pers.liveliness, !reduced && mix.idle < 0.5)

      // ---- Pose.
      const lean = S.lean * hearW
      const hT = mix.pick(EYE_H) * (1 + hearW * (0.5 * (S.energy - 0.45) + 0.3 * Math.max(0, lean) - 0.45 * S.brace) - 0.5 * S.flinch) + speakW * 0.4 * (S.talkSlow - 0.3)
      hS = k ? approach(hS, hT, dt, 0.07) : hT
      const wT = mix.pick(EYE_W) * (1 + 0.25 * Math.max(0, lean) * hearW - 0.15 * S.brace * hearW)
      wS = k ? approach(wS, wT, dt, 0.1) : wT
      const yT = mix.pick(EYE_Y) + S.nod * 0.9 + (reduced ? 0 : -S.beat * 0.35 * speakW)
      yS = k ? approach(yS, yT, dt, 0.05) : yT
      const tiltT = hearW * S.question * (you.x < -0.1 ? -1 : 1) * 1.1 // eyes at different heights
      tiltS = k ? approach(tiltS, tiltT, dt, 0.2) : tiltT
      mouth.step(f, S.size, speakW, pers.mouthRange)
      const sizeK = 0.85 + 0.3 * S.size
      const mwT = (2.3 + speakW * (2.2 * mouth.wide - 1.3 * mouth.round + 0.8 * mouth.open) * sizeK + hearW * 0.6 * Math.max(0, S.energy - 0.5)) * (1 - 0.3 * thinkW)
      const mhT = 0.5 + speakW * (2.4 * mouth.open + 1.2 * mouth.round + 0.5 * mouth.teeth) * sizeK * (0.75 + 0.6 * S.talkSlow) + hearW * 0.7 * Math.max(0, lean)
      mouthW = k ? approach(mouthW, mwT, dt, 0.03) : mwT
      mouthH = k ? approach(mouthH, mhT, dt, 0.025) : mhT
      const smile = mix.pick(SMILE) + hearW * (0.08 * S.waiting - 0.12 * S.brace) + (S.ack ? 0.1 : 0)
      const bright = mix.pick(BRIGHT) * (reduced ? 1 : 1 + 0.08 * Math.sin(f.t * 0.9) * mix.idle)

      // Ear meters: lit segment at the person's pitch, as long as their voice is loud.
      const lvT = S.userTalking ? Math.max(0.1, f.user.level) : 0
      meter = reduced ? Math.round(lvT * 4) / 4 : approach(meter, lvT, dt, lvT > meter ? 0.04 : 0.2)
      const prT = lerp(4, -4, clamp01(f.user.pitch)) * kG // 70 Hz at the bottom, 400 Hz at the top
      pitchRow = reduced ? Math.round(prT) : approach(pitchRow, prT, dt, 0.08)

      // ---- Rasterise. The pose is in medium-grid pixels; kG scales it to the chosen grid, with
      // lines kept at least about one LED thick.
      const ex = gaze.x * 2.2 * kG
      const ey = (yS + gaze.y * 1.1) * kG
      const eh = Math.max(0.42, hS * kG * (1 - bl))
      const eW = wS * kG
      const mcx = (gaze.x * 0.8 + thinkW * 1.5 * S.thinkSide) * kG
      const mcy = (3.6 + S.nod * 0.6) * kG
      const mW = mouthW * kG
      const mH = mouthH * kG
      const thinkDots = thinkW > 0.02
      if (thinkDots && !reduced) dotsPhase = (dotsPhase + dt / 1.2) % 1
      for (let r = 0; r < ROWS; r++) {
        const v = r - CY
        for (let c = 0; c < COLS; c++) {
          const u = c - CX
          const i = r * COLS + c
          // Eyes (with a tilt for a question, a squint for a shout, sitting a little apart).
          let d = 99
          for (let e = -1; e <= 1; e += 2) {
            const cxE = e * 5 * kG + ex
            const cyE = ey + e * tiltS * 0.5 * kG
            const de = sdBox(u - cxE, v - cyE, eW, eh, Math.min(eW, eh) * 0.6)
            if (de < d) d = de
          }
          let ink1 = cover(d)
          // Mouth: a line, a smile or an opening; amber while speaking.
          const mu = u - mcx
          const mv = v - mcy
          let dm: number
          if (mouthH < 0.9) {
            const curve = smile * 2.2 * (mu * mu) / Math.max(1, mW * mW) * mW
            dm = sdBox(mu, mv + curve - smile * 1.2 * kG, mW, 0.42, 0.42)
          } else {
            dm = sdBox(mu, mv - mH * 0.35, mW, mH * 0.62, Math.min(mW, mH * 0.62) * 0.7)
          }
          const mc = cover(dm)
          ink1 = Math.max(ink1, mc * (1 - speakW))
          bInk[i] = ink1 * bright
          bVoice[i] = mc * speakW * (0.55 + 0.45 * clamp01(S.talk * 2.2))
          // Ears: edge columns as mint meters (and a faint standby pixel while listening).
          let you1 = 0
          if (c === 0 || c === COLS - 1 || ((c === 1 || c === COLS - 2) && meter > 0.55)) {
            const span = 0.5 + meter * 6 * kG
            const dv = Math.abs(v - pitchRow) - span
            you1 = hearW * cover(dv) * (0.35 + 0.65 * clamp01(meter * 2)) * (c === 0 || c === COLS - 1 ? 1 : 0.5)
            you1 = Math.max(you1, mix.listening * 0.5 * cover(Math.abs(v) - 0.5))
          }
          bYou[i] = you1
          // Thinking: "…" in the top corner on the side it looks, lit in turn (the top row on the coarse grid).
          if (thinkDots && r === (ROWS < 13 ? 0 : 1)) {
            const base = S.thinkSide > 0 ? COLS - 6 : 3
            const k3 = c - base
            if (k3 >= 0 && k3 <= 2) {
              const on = reduced ? 0.8 : clamp01((dotsPhase * 4 - k3) * 2) * (dotsPhase < 0.85 ? 1 : 0)
              bVoice[i] = Math.max(bVoice[i]!, thinkW * (0.25 + 0.75 * on))
            }
          }
        }
      }

      // ---- Draw: unlit LEDs first (one path), then buckets per colour and level.
      clear2d(g, dpr)
      if (cachedFor !== P) {
        cachedFor = P
        mixInto(offRgb, P.inkFaint, P.bg, P.dark ? 0.72 : 0.62)
        offCss = ink.css(offRgb, 1)
        for (let ch = 0; ch < 3; ch++) {
          const col = ch === 0 ? P.ink : ch === 1 ? P.you : P.voice
          glowCss[ch] = ink.css(col, 0.55)
          for (let lv = 1; lv <= LEVELS; lv++) bucketCss[ch * (LEVELS + 1) + lv] = ink.css(mixInto(onRgb, offRgb, col, lv / LEVELS), 1)
        }
      }
      rad = pitch * 0.36
      half = lerp(rad, pitch * 0.4, sqK)
      corner = lerp(half, half * 0.15, sqK)
      // Unlit LEDs (hidden for the "lit only" styles).
      if (unlitA > 0.01) {
        if (unlitA * fade < 1) g.globalAlpha = unlitA * fade
        g.fillStyle = offCss
        g.beginPath()
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) led(x0 + c * pitch, y0 + r * pitch)
        }
        g.fill()
      }
      if (unlitA > 0.01 && unlitA * fade < 1) g.globalAlpha = fade
      else if (fade < 1) g.globalAlpha = fade
      const glow = P.dark && !reduced && pitch > 7
      for (let ch = 0; ch < 3; ch++) {
        const arr = ch === 0 ? bInk : ch === 1 ? bYou : bVoice
        for (let lv = 1; lv <= LEVELS; lv++) {
          const lo = (lv - 0.5) / LEVELS
          const hi = (lv + 0.5) / LEVELS
          let any = false
          for (let i = 0; i < COLS * ROWS; i++) {
            const b = arr[i]!
            if (b < lo || b >= hi) continue
            // Only the brightest channel lights an LED.
            if (ch === 0 && (bYou[i]! > b || bVoice[i]! > b)) continue
            if (ch === 1 && (bVoice[i]! > b || bInk[i]! >= b)) continue
            if (ch === 2 && (bInk[i]! >= b || bYou[i]! >= b)) continue
            if (!any) {
              g.beginPath()
              any = true
            }
            led(x0 + (i % COLS) * pitch, y0 + Math.floor(i / COLS) * pitch)
          }
          if (!any) continue
          g.fillStyle = bucketCss[ch * (LEVELS + 1) + lv]!
          if (glow && lv >= LEVELS - 1) {
            g.shadowBlur = pitch * 0.6
            g.shadowColor = glowCss[ch]!
          }
          g.fill()
          g.shadowBlur = 0
        }
      }
      if (fade < 1 || (unlitA > 0.01 && unlitA < 1)) g.globalAlpha = 1
    },

    dispose() {}
  }
}

const design: Design = {
  id: "dot-matrix",
  name: "Dot matrix",
  family: "character",
  summary: "A face on a 27 × 13 LED matrix, as a small voice node could show it: pixel eyes and mouth, and edge 'ears' that meter your pitch and loudness in mint.",
  inspiredBy: "LED-matrix desk gadgets and device status faces, KITT's level bars (for the ears), Cozmo's saccade timing, Rhubarb-style mouth shapes reduced to pixels.",
  modes: {
    idle: "Dim, eyes closed to single lines, a short flat mouth, a slow brightness breath.",
    listening: "Full brightness, tall open eyes, a small pixel smile, one faint mint pixel in the middle of each edge: ears on.",
    hearing: "Edge columns light mint at the height of your pitch, as long as your voice is loud (two columns wide when shouting); eyes widen for a whisper and squint at a shout; a pixel nod at your pauses, eyes at different heights for a question.",
    thinking: "Eyes narrowed, darting up to one side; '…' lights pixel by pixel in that top corner in amber; mouth small and to the side.",
    speaking: "The mouth lights amber and opens, widens and rounds with the reply; the eyes hop a fraction of a pixel on syllables."
  },
  mappings: [
    { signal: "user.pitch", effect: "Ear meters: the lit segment's row, 70 Hz at the bottom to 400 Hz at the top (shows register and intonation)." },
    { signal: "user.level", effect: "Ear meter length (1 to 13 pixels) and brightness; a second column lights above level 0.55." },
    { signal: "user phrase end (pause after ≥ 0.6 s of speech)", effect: "A nod: eyes and mouth dip about a pixel and come back, with a blink." },
    { signal: "user.pitchDelta at phrase end (rising)", effect: "Eyes sit at different heights (a pixel tilt), fading over ~3 s." },
    { signal: "user.level over 0.5 s (and voicing)", effect: "Whisper: eyes taller and wider, mouth a small 'o'. Shout: eyes squint and narrow, smile drops." },
    { signal: "user.onset at level > 0.58", effect: "Flinch: eyes squeeze, habituating over 3 s." },
    { signal: "user.syllableRate and |pitchDelta|", effect: "Energy: eye height and a wider mouth for lively speech." },
    { signal: "agent.mouth.open / wide / round / sibilance", effect: "Amber mouth height (up to ~4 px), width (2–7 px), rounding." },
    { signal: "agent.level", effect: "Amber mouth brightness; over ~1 s (soft vs loud) eye height and mouth range." },
    { signal: "agent.register", effect: "Mouth size ×0.85..1.15 and smoothing: deep is bigger and slower." },
    { signal: "agent.onset", effect: "Eyes hop up a fraction of a pixel per syllable." },
    { signal: "mode", effect: "Pose blend over ~0.2 s: eye size and height, smile, brightness; mint ears, amber mouth and thinking dots." },
    { signal: "time (seeded)", effect: "Blinks, saccades (fast in thinking), idle breathing in brightness, thinking dots 1.2 s per cycle." },
    { signal: "reducedMotion", effect: "Held poses: no blinks, saccades, nods, hops, breathing or dot cycling; meters in quarter steps; mouth held half open while speaking." },
    {
      signal: "options",
      effect:
        "Size (shrinks the panel), grid 19 × 9, 27 × 13 or 39 × 19 (the face scales with it; a 0.3 s fade hides the swap), LEDs round or square (morph ~0.2 s) with or without the unlit ones; expressiveness scales nods, hops, tilt and squints; liveliness divides blink and saccade intervals; mouth range scales the opening; nods and pointer-following switch off."
    }
  ],
  serverNeeds:
    "None. Phoneme timings would give the pixel mouth exact closures. Because the whole face is a 27 × 13 brightness grid computed from the same features, a voice node with a real LED matrix could run this exact code on its own, or receive the grid from the server at about 350 bytes per frame.",
  renderer: "2d",
  options: [
    sizeOption(0.5, 1),
    {
      id: "grid",
      kind: "choice",
      label: "Grid",
      choices: [
        { value: "coarse", label: "Coarse" },
        { value: "medium", label: "Medium" },
        { value: "fine", label: "Fine" }
      ],
      default: "medium",
      group: APPEARANCE,
      help: "How many LEDs the panel has: 19 × 9, 27 × 13 or 39 × 19."
    },
    {
      id: "ledStyle",
      kind: "choice",
      label: "LEDs",
      choices: [
        { value: "round", label: "Round" },
        { value: "square", label: "Square" },
        { value: "roundLit", label: "Round, lit only" },
        { value: "squareLit", label: "Square, lit only" }
      ],
      default: "round",
      group: APPEARANCE,
      help: "Round dots or square pixels, with the unlit LEDs of the panel showing or hidden."
    },
    EXPRESSIVENESS,
    LIVELINESS,
    MOUTH_RANGE,
    nodsOption("Dips its eyes and mouth a pixel at the end of each of your phrases."),
    FOLLOWS_POINTER
  ],
  create
}

export default design
