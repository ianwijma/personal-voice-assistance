/**
 * Edge glow: light that lives on the edge of the screen and leaves the middle free for captions,
 * after the Apple Intelligence screen-edge glow and Gemini Live. It is a stage character that ignores
 * `focus` for its shape: the whole canvas is its frame, so on the voice page the light runs along the
 * window's edge, and in a box (another host, the tests) along the box's.
 *
 * The glow is one conic gradient through two smooth falloff masks (a tight and a deep layer), so its
 * brightness and colour can change all the way around the frame. While you speak, the light pools
 * where your pitch is: along the bottom edge for a deep voice, climbing the sides to the top for a
 * high one, wider and deeper the louder you are; each syllable sends a pulse from the border
 * inward. While the assistant speaks, the whole frame glows amber with the reply's spectrum laid
 * around it (low at the bottom, high at the top), and each syllable sends a pulse outward to the
 * border. Thinking is two comets chasing around the edge.
 */
import type { Character, CharacterInstance, Rgb, VoiceFeatures } from "../contract.ts"
import { AttackRelease, TAU, approach, clamp, clamp01, clear2d, lerp, optChoice, optNumber, optToggle, setup2d, smoothstep } from "../kit.ts"
import { ChoiceMix, type Col, css, Glide, hueShift, mixInto, ModeMix, ONSET } from "../shared/light.ts"

const STOPS = 120 // colour stops around the frame (72 showed as faint radial lines on a page-sized frame)
const PULSES = 5
const WHITE: Rgb = [255, 255, 255]
/** "Lit edges" choices, in the order of the per-stop maps below. */
const EDGES = ["all", "bottom", "sides", "topBottom"] as const
const STYLES = ["soft", "crisp", "line"] as const
/** Seconds an option that reshapes the masks must hold still before they are rebuilt, and the crossfade after. */
const MASK_SETTLE = 0.15
const MASK_FADE = 0.3
/**
 * Pixels of the glow's work surface per CSS pixel, whatever the device pixel ratio: at most half, and
 * fewer on a large canvas so the surface stays within GLOW_BUDGET pixels (the largest box, 720 × 240, gets 0.43;
 * the whole 1920 × 1080 page gets 0.12). The glow and the pulses are soft (the tightest falloff spans
 * about 6 % of the short side), so they are composited on that surface and scaled up once, and only the
 * band along the border where there is light is drawn; the shape's edge (the rounded corners) is cut at
 * full resolution by a clip, and the border line and chevrons are drawn at full resolution.
 * Rasterising the layers at full device resolution cost about 3 ms a frame in the 720 × 240 box and
 * 5.5 ms (1280 × 800) to 10.8 ms (1920 × 1080) on the whole page.
 */
const GLOW_SCALE = 0.5
const GLOW_BUDGET = 32_000
/** Strokes that make one pulse's soft profile (a triangle across its width, so it shows no bands). */
const PULSE_STEPS = 8
/** The border line's lowest alpha at any stop (0.12 × 0.25). */
const LINE_FLOOR = 0.03

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  let gk = 1 // work-surface pixels per CSS pixel
  let D0 = 20 // glow depth at "Glow depth" 1
  let CR0 = 12 // corner radius at "Corner roundness" 1
  let D = 20 // glow depth (eased option applied)
  let CR = 12 // corner radius (eased option applied)
  // Off-screen work surfaces: one layer at a time is cut out on `work`, and the layers and pulses are
  // composited on `acc`, which is scaled up onto the canvas once.
  let work = new OffscreenCanvas(1, 1)
  let wg = work.getContext("2d")!
  let acc = new OffscreenCanvas(1, 1)
  let ag = acc.getContext("2d")!
  let prevDs = 1 // depth the previous masks were built for, while they fade out
  // The masks depend on depth and corner radius. They are rebuilt (once, when the option settles)
  // and crossfaded from the previous pair, so changing them never pops and never costs per frame.
  // Two pairs are kept (allocated on resize) and swap roles on a rebuild.
  let masks = new MaskPair(1, 1)
  let spare = new MaskPair(1, 1)
  let prev: MaskPair | null = null
  let maskFade = 1
  let maskDs = 1
  let maskCs = 1
  let wantDs = 1
  let wantCs = 1
  let wantAge = 0
  // Per stop: its angle from the centre (for the conic gradient) and its elevation
  // (0 at the bottom centre, 1 at the top centre, the same on both sides).
  const stopAngle = new Float32Array(STOPS)
  const stopElev = new Float32Array(STOPS)
  const stopX = new Float32Array(STOPS)
  const stopY = new Float32Array(STOPS)
  // Per-stop intensity and colour for this frame.
  const inten = new Float32Array(STOPS)
  const warm = new Float32Array(STOPS) // 0 = side colour, 1 = amber (comets)
  // Per "Lit edges" choice and stop (choice-major): how lit the stop is, its elevation along the
  // lit part (0 deep .. 1 high) and its position along the lit path (for the comets).
  const mapLit = new Float32Array(EDGES.length * STOPS)
  const mapElev = new Float32Array(EDGES.length * STOPS)
  const mapPath = new Float32Array(EDGES.length * STOPS)
  // The same, blended by the eased choice weights, for this frame.
  const eLit = new Float32Array(STOPS)
  const eElev = new Float32Array(STOPS)
  const ePath = new Float32Array(STOPS)

  // Options, eased.
  const glide = new Glide()
  const edgeMix = new ChoiceMix(EDGES)
  const styleMix = new ChoiceMix(STYLES)
  let depthG = 1
  let cornerG = 1
  let poolK = 1
  let lineOpt = 1
  let clock = -1 // ambient time at the "Motion speed"

  const mix = new ModeMix()
  const lvl = new AttackRelease(0.04, 0.3)
  let elev = 0.4
  let voiced = 0.8
  let bright = 0.4
  let rate = 3
  let rise = 0
  let prevOnset = 0
  let chase = 0
  const bands = new Float32Array(24)
  const pulsePos = new Float32Array(PULSES).fill(9) // 0 border .. 1 deepest layer
  const pulseDir = new Float32Array(PULSES)
  const pulseGain = new Float32Array(PULSES)
  let pulseHead = 0

  let paletteRef: unknown = null
  const youDeep: Col = [0, 0, 0]
  const youHigh: Col = [0, 0, 0]
  const side: Col = [0, 0, 0]
  const c: Col = [0, 0, 0]
  const tmp: Col = [0, 0, 0]

  /** Perimeter point at fraction s (0 = right middle, clockwise on screen), inset by `m`. */
  const layout = (): void => {
    const m = 1
    const w = W - 2 * m
    const h = H - 2 * m
    const per = 2 * (w + h)
    for (let i = 0; i < STOPS; i++) {
      // Start at the right middle and go clockwise (down first, as canvas angles grow).
      let d = (i / STOPS) * per
      let x: number
      let y: number
      if (d < h / 2) {
        x = w
        y = h / 2 + d
      } else if ((d -= h / 2) < w) {
        x = w - d
        y = h
      } else if ((d -= w) < h) {
        x = 0
        y = h - d
      } else if ((d -= h) < w) {
        x = d
        y = 0
      } else {
        d -= w
        x = w
        y = d
      }
      stopX[i] = x + m
      stopY[i] = y + m
      let a = Math.atan2(y + m - H / 2, x + m - W / 2)
      if (a < 0) a += TAU
      stopAngle[i] = a
      // Elevation by path length from the bottom centre, normalised by half the perimeter.
      const fromBottom = Math.abs(((i / STOPS) * per - (h / 2 + w / 2) + per * 1.5) % per - per / 2)
      stopElev[i] = fromBottom / (per / 2)
    }
    // Lit-edge maps. Each lit region keeps the design's rules: elevation runs deep → high along
    // what is lit, and the comets travel along it clockwise.
    for (let i = 0; i < STOPS; i++) {
      const x = stopX[i]!
      const y = stopY[i]!
      const ax = Math.abs(x - W / 2) / (W / 2) // 0 centre .. 1 side
      const ay = Math.abs(y - H / 2) / (H / 2)
      // All round.
      mapLit[i] = 1
      mapElev[i] = stopElev[i]!
      mapPath[i] = i / STOPS
      // Bottom only: deep at the bottom centre, high toward the corners.
      let k = STOPS + i
      mapLit[k] = smoothstep(0.5 * H, 0.9 * H, y)
      mapElev[k] = clamp01(ax)
      mapPath[k] = clamp01((W - x) / W)
      // Sides: deep at the bottom of both sides, high at the top.
      k = 2 * STOPS + i
      mapLit[k] = smoothstep(0.64, 0.96, ax)
      mapElev[k] = clamp01(1 - y / H)
      mapPath[k] = x > W / 2 ? 0.5 * clamp01(y / H) : 0.5 + 0.5 * clamp01(1 - y / H)
      // Top and bottom: deep at the bottom centre, out to the bottom corners, then the top corners in to the top centre.
      k = 3 * STOPS + i
      mapLit[k] = smoothstep(0.6, 0.92, ay)
      mapElev[k] = y > H / 2 ? 0.5 * clamp01(ax) : 1 - 0.5 * clamp01(ax)
      mapPath[k] = y > H / 2 ? 0.5 * clamp01((W - x) / W) : 0.5 + 0.5 * clamp01(x / W)
    }
  }

  const buildMasks = (ds: number, cs: number): void => {
    const pw = work.width
    const ph = work.height
    const cr = cornerRadius(cs)
    if (masks.near.width !== pw || masks.near.height !== ph) {
      masks = new MaskPair(pw, ph)
      spare = new MaskPair(pw, ph)
    }
    prevDs = maskDs
    masks.build(cr * gk, D0 * ds * gk * 0.38, 1.8, D0 * ds * gk * 1.15, 2.4)
    masks.cr = cr
    maskDs = ds
    maskCs = cs
  }
  const cornerRadius = (cs: number): number => Math.min(CR0 * cs, Math.min(W, H) / 2 - 2)

  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
      D0 = Math.max(10, Math.min(W, H) * 0.17)
      CR0 = Math.max(6, Math.min(W, H) * 0.07)
      D = D0 * depthG
      CR = cornerRadius(cornerG)
      layout()
      gk = Math.min(dpr, GLOW_SCALE, Math.sqrt(GLOW_BUDGET / (W * H)))
      const pw = Math.max(1, Math.round(W * gk))
      const ph = Math.max(1, Math.round(H * gk))
      work = new OffscreenCanvas(pw, ph)
      wg = work.getContext("2d")!
      acc = new OffscreenCanvas(pw, ph)
      ag = acc.getContext("2d")!
      prev = null
      buildMasks(wantDs, wantCs)
      maskFade = 1
    },

    frame(f) {
      const dt = f.dt
      const p = f.palette
      const dark = p.dark
      const reduced = f.reducedMotion
      mix.step(f, 0.3)

      // Options.
      const o = f.options
      glide.begin(f)
      const tDs = optNumber(o, "depth")
      const tCs = optNumber(o, "corners")
      depthG = glide.to(depthG, tDs)
      cornerG = glide.to(cornerG, tCs)
      D = D0 * depthG
      CR = cornerRadius(cornerG)
      poolK = glide.to(poolK, optNumber(o, "poolWidth"))
      lineOpt = glide.to(lineOpt, optNumber(o, "line"))
      const ew = edgeMix.step(glide, optChoice(o, "edges"))
      const st = styleMix.step(glide, optChoice(o, "style"))
      const crisp = st[1]!
      const lineOnly = st[2]!
      const pulsesOn = optToggle(o, "pulses")
      const speed = optNumber(o, "speed")
      clock = clock < 0 ? f.t : clock + dt * speed
      if (tDs !== wantDs || tCs !== wantCs) {
        wantDs = tDs
        wantCs = tCs
        wantAge = 0
      } else wantAge += dt
      if ((wantDs !== maskDs || wantCs !== maskCs) && (glide.snapping || wantAge > MASK_SETTLE)) {
        prev = masks
        masks = spare
        spare = prev
        buildMasks(wantDs, wantCs)
        maskFade = glide.snapping ? 1 : 0
      }
      maskFade = Math.min(1, maskFade + dt / MASK_FADE)
      if (maskFade >= 1) prev = null
      for (let i = 0; i < STOPS; i++) {
        let l = 0
        let e = 0
        let q = 0
        for (let c = 0; c < EDGES.length; c++) {
          const wc = ew[c]!
          if (wc < 1e-4) continue
          const k = c * STOPS + i
          l += wc * mapLit[k]!
          e += wc * mapElev[k]!
          q += wc * mapPath[k]!
        }
        eLit[i] = l
        eElev[i] = e
        ePath[i] = q
      }

      if (paletteRef !== p) {
        paletteRef = p
        hueShift(p.you, 26, youDeep)
        hueShift(p.you, -20, youHigh)
      }

      const speaking = f.mode === "speaking"
      const live = f.mode === "hearing" || speaking
      const v: VoiceFeatures = speaking ? f.agent : f.user
      let raw = live ? v.level : 0
      if (reduced) raw = Math.round(raw * 4) / 4
      const L = lvl.step(raw, dt)
      const loud = clamp01(L * 1.6)
      if (live && v.speaking) {
        if (v.voicing > 0.3) elev = approach(elev, reduced ? Math.round(clamp01((v.pitch - 0.1) / 0.8) * 6) / 6 : clamp01((v.pitch - 0.1) / 0.8), dt, reduced ? 0.25 : 0.1)
        voiced = approach(voiced, v.voicing, dt, 0.25)
        bright = approach(bright, v.brightness, dt, 0.15)
        rate = approach(rate, v.syllableRate, dt, 0.5)
        rise = approach(rise, clamp(v.pitchDelta / 8, -1, 1), dt, 0.3)
      } else rise = approach(rise, 0, dt, 0.5)
      for (let i = 0; i < 24; i++) bands[i] = approach(bands[i]!, live ? v.bands[i]! : 0, dt, 0.07)

      // Pulses: inward from the border for you, outward to the border for the assistant.
      const hit = live && !reduced && v.onset > ONSET && prevOnset <= ONSET
      prevOnset = live ? v.onset : 0
      if (hit && pulsesOn) {
        pulsePos[pulseHead] = speaking ? 1 : 0
        pulseDir[pulseHead] = speaking ? -1 : 1
        pulseGain[pulseHead] = 0.35 + 0.65 * loud
        pulseHead = (pulseHead + 1) % PULSES
      }
      const travel = lerp(0.75, 0.4, clamp01((rate - 2) / 3.5)) / speed // seconds border ↔ depth: faster speech, quicker pulses
      for (let i = 0; i < PULSES; i++) pulsePos[i] = pulsePos[i]! + (pulseDir[i]! * dt) / travel
      if (!reduced) chase += dt * 0.32 * speed

      // Intensity around the frame.
      const listenBreath = reduced ? 1 : 0.85 + 0.15 * Math.sin(clock * 1.7)
      const ambient = mix.of(0.2, 0.62 * listenBreath, 0.1, 0.08, 0.3 + 0.25 * loud)
      const poolW = (0.05 + 0.2 * loud) * poolK // half-width in elevation units
      const poolA = mix.hearing * (0.5 + 1.0 * loud)
      const pointerOn = f.pointer.inside
      // With only some edges lit the comets' path is shorter, so their tails take a larger share of it.
      const tailLen = 0.22 + 0.18 * (1 - ew[0]!)
      const noseLen = 0.015 * (2 - ew[0]!)
      for (let i = 0; i < STOPS; i++) {
        const e = eElev[i]!
        let I = ambient
        // Hearing: the pool at your pitch (mirrored on both sides because elevation is).
        const de = (e - elev) / poolW
        I += poolA * Math.exp(-de * de)
        // Speaking: the spectrum laid around the frame, low at the bottom, high at the top.
        if (mix.speaking > 0.01) {
          const x = e * 23
          const k = Math.floor(x)
          const b = bands[k]! + (bands[Math.min(23, k + 1)]! - bands[k]!) * (x - k)
          I += mix.speaking * (0.15 + 1.1 * loud) * b * b
        }
        // Thinking: two comets chasing clockwise, amber heads with mint tails.
        let wm = 0
        if (mix.thinking > 0.01) {
          const s = ePath[i]!
          for (let q = 0; q < 2; q++) {
            const head = (chase + q * 0.5) % 1
            const behind = (head - s + 1) % 1 // 0 at the head, growing along the tail
            const tail = behind < tailLen ? Math.pow(1 - behind / tailLen, 2) : 0
            const ahead = (s - head + 1) % 1
            const nose = ahead < noseLen ? 1 - ahead / noseLen : 0
            const k = Math.max(tail, nose)
            I += mix.thinking * 1.05 * k
            wm = Math.max(wm, k * (behind < 0.08 || nose > 0 ? 1 : 0.35))
          }
        }
        if (pointerOn) {
          const dx = stopX[i]! - f.pointer.x
          const dy = stopY[i]! - f.pointer.y
          I += 0.5 * Math.exp(-(dx * dx + dy * dy) / (D0 * D0 * 4))
        }
        inten[i] = Math.min(1.4, I) * eLit[i]!
        warm[i] = wm
      }

      // Side colour: grey → mint (hue by register) → amber.
      mixInto(side, youDeep, youHigh, clamp01((f.user.register - 0.2) / 0.65))
      mixInto(c, p.inkFaint, side, clamp01(mix.listening + mix.hearing + mix.thinking))
      mixInto(side, c, p.voice, clamp01(mix.speaking))

      clear2d(g, dpr)
      const cx = W / 2
      const cy = H / 2
      // How far the light reaches in: further when loud.
      const reach = clamp01(mix.listening * 0.45 + (mix.hearing + mix.speaking) * (0.2 + 0.8 * loud) + mix.thinking * 0.35 + mix.idle * 0.05)
      // Two layers through smooth pre-computed falloff masks (no banding): a tight one that follows
      // the intensity, and a deep one that follows its square, so bright parts reach further in.
      const PW = work.width
      const PH = work.height
      ag.setTransform(1, 0, 0, 1, 0, 0)
      ag.globalCompositeOperation = "source-over"
      ag.globalAlpha = 1
      ag.clearRect(0, 0, PW, PH)
      // The band along the border where there is light, in work pixels: the deep layer, the pulses, and
      // (points within d of a rounded corner are within d + 0.3 × radius of a straight edge) the corners.
      // Every pass on the work surfaces is clipped to it, as the middle of a page-sized surface is empty
      // and would be most of the cost.
      let pulseReach = 0
      for (let q = 0; q < PULSES; q++) {
        const pp = pulsePos[q]!
        if (pp >= 0 && pp <= 1) pulseReach = Math.max(pulseReach, 2 + pp * D * 0.85 + Math.max(1, D * 0.42) / 2)
      }
      const deepest = 1.15 * D0 * Math.max(maskDs, prev !== null ? prevDs : 0)
      const bandCss = Math.max(deepest, pulseReach) + 0.3 * Math.max(masks.cr, prev !== null ? prev.cr : 0)
      const b = Math.ceil(bandCss * gk) + 2
      const whole = 2 * b >= PW || 2 * b >= PH
      wg.save()
      ag.save()
      if (!whole) {
        // Integer rectangles, so the ring is a pixel-exact clip.
        wg.beginPath()
        wg.rect(0, 0, PW, PH)
        wg.rect(b, b, PW - 2 * b, PH - 2 * b)
        wg.clip("evenodd")
        ag.beginPath()
        ag.rect(0, 0, PW, PH)
        ag.rect(b, b, PW - 2 * b, PH - 2 * b)
        ag.clip("evenodd")
      }
      // As 1.0, the pulses and the border line take the glow's blend only when a glow layer was drawn.
      let blend: GlobalCompositeOperation = "source-over"
      // Style: "Crisp" drops the deep layer, "Line" drops both and leaves the border line.
      for (let layer = 0; layer < 2; layer++) {
        const weight = layer === 0 ? 1 - lineOnly : reach * Math.max(0, 1 - crisp - lineOnly)
        if (weight < 0.01) continue
        const gr = wg.createConicGradient(0, PW / 2, PH / 2)
        for (let i = 0; i <= STOPS; i++) {
          const j = i % STOPS
          const at = i === STOPS ? 1 : stopAngle[j]! / TAU
          const I = inten[j]!
          mixInto(tmp, side, p.voice, warm[j]!)
          if (dark) mixInto(tmp, tmp, WHITE, clamp01(I - 0.9) * 0.5 + bright * 0.12 * (mix.hearing + mix.speaking))
          gr.addColorStop(at, css(tmp, layer === 0 ? Math.min(1, I) : Math.min(1, I * I)))
        }
        const passes = prev !== null ? 2 : 1
        for (let pass = 0; pass < passes; pass++) {
          const pair = pass === 0 || prev === null ? masks : prev
          const mask = layer === 0 ? pair.near : pair.far
          const share = passes === 1 ? 1 : pass === 0 ? maskFade : 1 - maskFade
          wg.globalCompositeOperation = "copy"
          wg.fillStyle = gr
          wg.fillRect(0, 0, PW, PH)
          wg.globalCompositeOperation = "destination-in"
          wg.drawImage(mask, 0, 0)
          blend = dark ? "lighter" : "source-over"
          ag.globalCompositeOperation = blend
          ag.globalAlpha = Math.min(1, weight * (dark ? 0.95 : 0.85)) * share
          ag.drawImage(work, 0, 0)
        }
      }
      ag.globalAlpha = 1

      // Pulses: a soft line of light travelling through the glow, in for you, out for the assistant.
      // Drawn on the work surface with the glow, as a stack of strokes narrowing to the middle so the
      // profile across it is a smooth ramp rather than visible steps. When only some edges are lit,
      // the pulses are stroked through a gradient that fades with them.
      const pulseCol = dark ? mixInto(tmp, side, WHITE, 0.25) : side
      const partial = ew[0]! < 0.999
      let pulseGrad: CanvasGradient | null = null
      ag.setTransform(PW / W, 0, 0, PH / H, 0, 0)
      ag.globalCompositeOperation = blend
      for (let q = 0; q < PULSES; q++) {
        const pp = pulsePos[q]!
        if (pp < 0 || pp > 1) continue
        const inset = 2 + pp * D * 0.85
        const a = pulseGain[q]! * Math.sin(Math.PI * Math.min(1, pp * 1.2 + 0.1)) * (1 - 0.5 * pp) * (1 - 0.6 * lineOnly)
        // The three strokes of 1.0 (0.42, 0.29, 0.16 of the depth at one alpha each) as a ramp of the same peak.
        const peak = clamp01(3 * a * (dark ? 0.065 : 0.055))
        const step = peak / PULSE_STEPS
        if (partial && pulseGrad === null) {
          pulseGrad = ag.createConicGradient(0, cx, cy)
          for (let i = 0; i <= STOPS; i++) {
            const j = i % STOPS
            pulseGrad.addColorStop(i === STOPS ? 1 : stopAngle[j]! / TAU, css(pulseCol, eLit[j]!))
          }
        }
        const wMax = Math.max(1, D * 0.42)
        for (let k = 0; k < PULSE_STEPS; k++) {
          ag.lineWidth = Math.max(1, wMax * (1 - k / PULSE_STEPS))
          if (pulseGrad !== null) {
            ag.strokeStyle = pulseGrad
            ag.globalAlpha = step
          } else ag.strokeStyle = css(pulseCol, step)
          ag.beginPath()
          ag.roundRect(inset, inset, W - 2 * inset, H - 2 * inset, CR + inset * 0.3)
          ag.stroke()
        }
      }
      ag.globalAlpha = 1
      wg.restore()
      ag.restore()

      // The composited glow onto the canvas, scaled up, only along the band. The masks run on past the
      // rounded corners, so scaling them up cannot soften the corner edge; the clip cuts it at full
      // resolution instead.
      const sx = W / PW
      const sy = H / PH
      g.save()
      g.beginPath()
      g.roundRect(0, 0, W, H, Math.max(masks.cr, prev !== null ? prev.cr : 0))
      g.clip()
      if (whole) g.drawImage(acc, 0, 0, W, H)
      else {
        g.drawImage(acc, 0, 0, PW, b, 0, 0, W, b * sy)
        g.drawImage(acc, 0, PH - b, PW, b, 0, (PH - b) * sy, W, b * sy)
        g.drawImage(acc, 0, b, b, PH - 2 * b, 0, b * sy, b * sx, (PH - 2 * b) * sy)
        g.drawImage(acc, PW - b, b, b, PH - 2 * b, (PW - b) * sx, b * sy, b * sx, (PH - 2 * b) * sy)
      }
      g.restore()
      g.globalCompositeOperation = blend

      // The crisp border line: defines the frame in every mode. Every stop has at least LINE_FLOOR alpha,
      // so that floor is stroked first in one solid colour and the gradient on top carries the rest
      // (the same line; the solid part is what marks the frame as the shape).
      const gb = g.createConicGradient(0, cx, cy)
      const rest = dark ? 1 : 1 - LINE_FLOOR // "lighter" adds; source-over: floor + a′ (1 − floor) = a
      for (let i = 0; i <= STOPS; i++) {
        const j = i % STOPS
        mixInto(tmp, side, p.voice, warm[j]!)
        const la = Math.min(1, 0.12 * (0.25 + 0.75 * eLit[j]!) + 0.9 * inten[j]!)
        gb.addColorStop(i === STOPS ? 1 : stopAngle[j]! / TAU, css(tmp, (la - LINE_FLOOR) / rest))
      }
      // A breathy voice (a whisper) shimmers as dotted light instead of a solid line.
      const dotted = live && voiced < 0.35
      // "Border line" scales it (0 hides it), but the "Line" style always keeps one to draw with.
      const lineK = Math.max(lineOpt, 0.6 * lineOnly) * (1 + 0.6 * crisp + 1.5 * lineOnly)
      const lw = Math.max(1, Math.min(W, H) / 200) * (1 + 1.2 * loud * (mix.hearing + mix.speaking)) * lineK
      if (dotted) g.setLineDash([1.5 * Math.max(1, lineK), 4 * Math.max(1, lineK)])
      g.globalAlpha = (dark ? 0.9 : 0.85) * Math.min(1, lineK * 4)
      g.lineWidth = Math.max(0.5, lw)
      const li = 1 + Math.max(0, lw / 2 - 1) * clamp01(lineK - 1) // a thicker line moves inward so it stays inside the canvas
      g.beginPath()
      g.roundRect(li, li, W - 2 * li, H - 2 * li, Math.max(0, CR - li + 1))
      if (lineK > 0.02) {
        g.strokeStyle = css(side, LINE_FLOOR)
        g.stroke()
        g.strokeStyle = gb
        g.stroke()
      }
      g.setLineDash([])
      g.globalAlpha = 1
      g.globalCompositeOperation = "source-over"

      // Reduced motion: the turn needs a still cue beyond colour, so mark the direction with
      // four corner chevrons (pointing in for you, out for the assistant).
      if (reduced && (mix.hearing + mix.listening + mix.speaking) > 0.3) {
        const inward = !speaking
        const s = Math.min(W, H) * 0.05
        const off = D * 0.9
        g.strokeStyle = css(side, 0.8)
        g.lineWidth = Math.max(1.2, s * 0.15)
        for (let q = 0; q < 4; q++) {
          const sx = q % 2 === 0 ? 1 : -1
          const sy = q < 2 ? 1 : -1
          const x = q % 2 === 0 ? off : W - off
          const y = q < 2 ? off : H - off
          const dir = inward ? 1 : -1
          g.beginPath()
          g.moveTo(x + sx * s * dir, y)
          g.lineTo(x, y)
          g.lineTo(x, y + sy * s * dir)
          g.stroke()
        }
      }
    },

    dispose() {}
  }
}

/**
 * Two alpha masks that are opaque at the border of a rounded rectangle and fade smoothly inward as
 * (1 − d/depth)^power, one per (depth, power) pair: `near` (tight) and `far` (deep). They stay opaque
 * outside the rounded rectangle (in the corners), so the shape is cut by a clip at draw time. The canvases
 * and pixel buffers are allocated once per size; `build` is run on resize and when the depth or
 * corner options settle. The shape is symmetric, so one quadrant is computed and mirrored, and only
 * the band within the deeper depth of the border is visited.
 */
class MaskPair {
  readonly near: OffscreenCanvas
  readonly far: OffscreenCanvas
  private readonly gNear: OffscreenCanvasRenderingContext2D
  private readonly gFar: OffscreenCanvasRenderingContext2D
  private readonly iNear: ImageData
  private readonly iFar: ImageData
  /** Corner radius (CSS px) of the shape the masks were built for, for the clip. */
  cr = 0
  constructor(w: number, h: number) {
    this.near = new OffscreenCanvas(w, h)
    this.far = new OffscreenCanvas(w, h)
    this.gNear = this.near.getContext("2d")!
    this.gFar = this.far.getContext("2d")!
    this.iNear = this.gNear.createImageData(w, h)
    this.iFar = this.gFar.createImageData(w, h)
  }
  build(cr: number, depthA: number, powerA: number, depthB: number, powerB: number): void {
    const w = this.near.width
    const h = this.near.height
    const da = this.iNear.data
    const db = this.iFar.data
    da.fill(0)
    db.fill(0)
    const lutA = falloffLut(powerA)
    const lutB = falloffLut(powerB)
    const kA = LUT_SIZE / depthA
    const kB = LUT_SIZE / depthB
    const hx = w / 2
    const hy = h / 2
    const band = Math.ceil(Math.max(depthA, depthB)) + 1
    const soft = 0.3 * Math.max(depthA, depthB)
    const edge = Math.max(band, Math.ceil(cr))
    const qw = Math.ceil(w / 2)
    const qh = Math.ceil(h / 2)
    for (let y = 0; y < qh; y++) {
      // Rows clear of the top band and the corner arc only need the side band.
      const xEnd = y >= edge ? Math.min(qw, band) : qw
      const y2 = h - 1 - y
      for (let x = 0; x < xEnd; x++) {
        // Signed distance to the rounded rectangle's border (negative inside).
        const qx = hx - x - 0.5 - (hx - cr)
        const qy = hy - y - 0.5 - (hy - cr)
        const ox = qx > 0 ? qx : 0
        const oy = qy > 0 ? qy : 0
        // A smooth maximum where the plain one has a crease along the corner's diagonal, which showed
        // as a dark line in the glow at full-screen size.
        const qd = qx - qy
        const sd = Math.sqrt(ox * ox + oy * oy) + Math.min((qx + qy + Math.sqrt(qd * qd + soft * soft)) / 2, 0) - cr
        const d = -sd // distance inside
        const va = d > depthA ? 0 : lutA[d < 0 ? 0 : Math.round(d * kA)]!
        const vb = d > depthB ? 0 : lutB[d < 0 ? 0 : Math.round(d * kB)]!
        if (va === 0 && vb === 0) continue
        const x2 = w - 1 - x
        const i0 = (y * w + x) * 4 + 3
        const i1 = (y * w + x2) * 4 + 3
        const i2 = (y2 * w + x) * 4 + 3
        const i3 = (y2 * w + x2) * 4 + 3
        da[i0] = da[i1] = da[i2] = da[i3] = va
        db[i0] = db[i1] = db[i2] = db[i3] = vb
      }
    }
    this.gNear.putImageData(this.iNear, 0, 0)
    this.gFar.putImageData(this.iFar, 0, 0)
  }
}

const LUT_SIZE = 4096
const luts = new Map<number, Uint8ClampedArray>()
/** (1 − u)^power for u in 0..1, as 0..255, so the mask build needs no `pow` per pixel. Cached per power. */
const falloffLut = (power: number): Uint8ClampedArray => {
  const hit = luts.get(power)
  if (hit !== undefined) return hit
  const t = new Uint8ClampedArray(LUT_SIZE + 1)
  for (let i = 0; i <= LUT_SIZE; i++) t[i] = Math.round(Math.pow(1 - i / LUT_SIZE, power) * 255)
  luts.set(power, t)
  return t
}

const character: Character = {
  id: "edge-glow",
  name: "Edge glow",
  version: "1.1.0",
  contract: 1,
  family: "abstract",
  renderer: "2d",
  canvas: "stage",
  summary: "Light on the edge of the screen, leaving the middle for captions: it pools where your pitch is and pulses inward as you speak, glows amber all round and pulses outward as the assistant replies.",
  inspiredBy:
    "The Apple Intelligence screen-edge glow and Gemini Live's screen glow (light on the frame, content left visible), Gemini's sharp-front, soft-tail gradients for the thinking comets, and Meta AI's inward-for-listening, outward-for-responding rule.",
  modes: {
    idle: "A faint grey hairline around the frame.",
    listening: "An even mint glow all round, breathing slowly: the frame is open.",
    hearing: "The mint light pools where your pitch is (bottom edge for a deep voice, up the sides to the top for a high one), wider when louder; pulses run from the border inward.",
    thinking: "Two comets with amber heads and mint tails chase clockwise around the frame.",
    speaking: "The whole frame glows amber, brighter where the reply's spectrum is strong (low at the bottom, high at the top); pulses run outward to the border."
  },
  mappings: [
    { signal: "user.pitch (hearing)", effect: "Where the light pools: elevation along the frame, from the bottom centre (deep) up both sides to the top centre (high); 100 ms, only while voiced." },
    { signal: "active.level", effect: "Pool width and brightness, how far the glow reaches in (weight of the deep layer, which fades over 115 % of 17 % of the short side), border line weight; 40 ms rise, 300 ms fall." },
    { signal: "active.onset", effect: "A pulse of light through the glow layers: border → inside for you, inside → border for the assistant; strength from loudness." },
    { signal: "active.syllableRate", effect: "Pulse travel time, 0.75 s for slow speech to 0.4 s for fast." },
    { signal: "agent.bands (speaking)", effect: "Brightness around the frame: band 1 at the bottom centre up to band 24 at the top centre, both sides." },
    { signal: "active.voicing", effect: "Below 0.35 (a whisper) the border line breaks into dotted light." },
    { signal: "active.brightness", effect: "Whiter glow (dark theme) for bright vowels." },
    { signal: "user.register", effect: "Mint hue: sea-blue for deep voices, spring green for high ones." },
    { signal: "mode", effect: "Colour (grey / mint / amber), pool vs even vs spectrum vs comets, pulse direction, glow depth; 300 ms crossfade." },
    { signal: "pointer", effect: "The frame lights up near the pointer." },
    { signal: "options", effect: "Glow depth, corner roundness, lit edges, pool width, syllable pulses, motion speed, style and border line change every mode. Depth and corners rebuild the falloff masks once the value has held for 0.15 s and crossfade over 0.3 s; the rest glide over about 0.2 s (all snap under reduced motion). With fewer edges lit, the pool, the spectrum and the comets run along the lit edges only." },
    { signal: "reducedMotion", effect: "No pulses, chase or breathing; levels in quarter steps, pool position in sixths; corner chevrons point in (your turn) or out (assistant's turn)." }
  ],
  options: [
    { id: "depth", kind: "number", label: "Glow depth", min: 0.5, max: 2, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How far the light reaches in from the border." },
    { id: "corners", kind: "number", label: "Corner roundness", min: 0, max: 3, step: 0.1, default: 1, unit: "×", group: "Shape", help: "Square corners at 0, rounder as it goes up." },
    { id: "poolWidth", kind: "number", label: "Pool width", min: 0.5, max: 2.5, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How wide the light pools around your pitch while you speak." },
    { id: "pulses", kind: "toggle", label: "Syllable pulses", default: true, group: "Motion", help: "A ring of light runs in (you) or out (the assistant) on every syllable." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.3, max: 2.5, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the thinking comets chase, the frame breathes and the pulses travel." },
    {
      id: "style",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "soft", label: "Soft" },
        { value: "crisp", label: "Crisp" },
        { value: "line", label: "Line only" }
      ],
      default: "soft",
      group: "Style",
      help: "A deep soft glow, a tight bright band, or just a line of light around the frame."
    },
    { id: "line", kind: "number", label: "Border line", min: 0, max: 3, step: 0.1, default: 1, unit: "×", group: "Style", help: "How thick the crisp line on the border is; 0 hides it." },
    {
      id: "edges",
      kind: "choice",
      label: "Lit edges",
      choices: [
        { value: "all", label: "All round" },
        { value: "bottom", label: "Bottom" },
        { value: "sides", label: "Sides" },
        { value: "topBottom", label: "Top and bottom" }
      ],
      default: "all",
      group: "Behaviour",
      help: "Which edges of the screen carry the light."
    }
  ],
  create
}

export default character
