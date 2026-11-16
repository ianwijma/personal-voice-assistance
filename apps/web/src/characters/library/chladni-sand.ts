/**
 * Chladni sand: sand on a vibrating square plate gathers on the nodal lines, the places that do
 * not move. The figure depends on the frequency, so the voice draws it: a deep voice settles the
 * sand into a simple cross of lines, a child's voice into a fine lattice. Loudness shakes the
 * plate harder (the sand jumps and the lines grow fuzzy and bold); a held vowel lets the lines
 * sharpen; fast speech keeps the figure moving. While the assistant takes sound in, the plate is
 * excited from its rim and each syllable sends a front of jumping sand inward; while it speaks, a
 * driver in the centre sends the fronts outward. Thinking turns the plate into a slow spiral.
 */
import type { Character, CharacterInstance, Frame } from "../contract.ts"
import { AttackRelease, TAU, approach, clamp, clamp01, clear2d, lerp, optChoice, optNumber, optToggle, rng, setup2d } from "../kit.ts"
import { type Col, ModeMix, OptionGlide, col, css, hash01, liftInto, mixInto, modeTone, sinkInto, voiceOf } from "../shared/matter.ts"

/** Grains a large stage gets at "Amount of sand" 1×; the option goes up to twice that. */
const BASE_GRAINS = 2400
const MAX_GRAINS = BASE_GRAINS * 2
const MAX_FRONTS = 5
/** Figure ranges per "Figures" choice (indices into the tables below): simple, full, intricate. */
const DETAILS = ["simple", "full", "intricate"]
const DETAIL_LO = [0, 0, 4]
const DETAIL_HI = [6, 11, 11]

/** Figures in rising complexity: (n, m, sign) for f = cos(nX)cos(mY) − s·cos(mX)cos(nY), X, Y ∈ [0, π]. */
const FIG_N = new Int8Array([1, 1, 2, 1, 3, 2, 1, 3, 2, 4, 3, 5])
const FIG_M = new Int8Array([2, 3, 3, 4, 4, 5, 6, 5, 7, 5, 7, 6])
const FIG_S = new Float32Array([1, -1, 1, 1, -1, 1, -1, 1, -1, 1, 1, -1])
const FIGS = FIG_N.length
/** Round-plate figures in the same order: a diameters and b rings, f = cos(aθ)·cos(bπr). */
const ROUND_A = new Int8Array([1, 2, 0, 3, 1, 2, 4, 3, 0, 4, 2, 5])
const ROUND_B = new Int8Array([1, 1, 2, 1, 2, 2, 1, 2, 3, 2, 3, 3])

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  let n = 1200

  const gu = new Float32Array(MAX_GRAINS) // plate coords −1..1
  const gv = new Float32Array(MAX_GRAINS)
  const fU = new Float32Array(MAX_FRONTS)
  const fV = new Float32Array(MAX_FRONTS)
  const fAge = new Float32Array(MAX_FRONTS).fill(99)
  const fDir = new Int8Array(MAX_FRONTS)
  const fStr = new Float32Array(MAX_FRONTS)
  let nextFront = 0

  const mix = new ModeMix(0.4)
  const tone: Col = col()
  const cA: Col = col()
  const cB: Col = col()
  const level = new AttackRelease(0.04, 0.3)
  const rand = rng(41)
  for (let i = 0; i < BASE_GRAINS; i++) {
    gu[i] = rand() * 2 - 1
    gv[i] = rand() * 2 - 1
  }
  // (Grains beyond the base count are placed when the "Amount of sand" option asks for them.)

  // Options, eased toward the viewer's settings.
  const glide = new OptionGlide()
  let sizeK = 1
  let grainsK = 1
  let grainSizeK = 1
  let shakeK = 1
  let pitchK = 1
  let loF = 0
  let hiF = FIGS - 1
  let roundK = 0 // 0 square plate .. 1 round
  let nBase = 1200
  let settle = 0 // seconds of extra settling after the plate or the figure range changed
  let lastPlate = ""
  let lastDetail = ""
  /** Show `count` grains; new ones start as copies of settled grains (a hair apart), so the sand thickens in place. */
  const setCount = (count: number) => {
    const next = Math.max(1, Math.min(MAX_GRAINS, Math.round(count)))
    for (let i = n; i < next; i++) {
      const j = Math.floor(hash01(i * 31 + 7) * n)
      gu[i] = clamp(gu[j]! + (hash01(i * 17 + 3) - 0.5) * 0.016, -0.985, 0.985)
      gv[i] = clamp(gv[j]! + (hash01(i * 13 + 5) - 0.5) * 0.016, -0.985, 0.985)
    }
    n = next
  }

  // Current and previous figure (cross-faded while the sand migrates).
  let figA = 0
  let figB = 0
  let figMix = 1 // 0 = figA, 1 = figB
  let figPos = 0.3 / (FIGS - 1) // 0..1 across the figure range
  let spiralPh = 0
  let lastOnset = 0
  let pressWas = false
  let lastShown = -1
  let lastMode = ""

  // Field evaluation, results in these (no allocation).
  let F = 0
  let FX = 0
  let FY = 0
  // cos(kX), sin(kX), cos(kY), sin(kY) for k = 0..7 by the angle-addition recurrence: 4 trig calls per grain, not 16.
  const CX = new Float32Array(8)
  const SX = new Float32Array(8)
  const CY = new Float32Array(8)
  const SY = new Float32Array(8)
  const tables = (X: number, Y: number) => {
    const c1 = Math.cos(X)
    const s1 = Math.sin(X)
    const d1 = Math.cos(Y)
    const t1 = Math.sin(Y)
    CX[0] = 1
    SX[0] = 0
    CY[0] = 1
    SY[0] = 0
    for (let k = 1; k < 8; k++) {
      CX[k] = CX[k - 1]! * c1 - SX[k - 1]! * s1
      SX[k] = SX[k - 1]! * c1 + CX[k - 1]! * s1
      CY[k] = CY[k - 1]! * d1 - SY[k - 1]! * t1
      SY[k] = SY[k - 1]! * d1 + CY[k - 1]! * t1
    }
  }
  const evalFig = (k: number, w: number) => {
    const a = FIG_N[k]!
    const b = FIG_M[k]!
    const s = FIG_S[k]!
    const caX = CX[a]!
    const cbY = CY[b]!
    const cbX = CX[b]!
    const caY = CY[a]!
    const saX = SX[a]!
    const sbY = SY[b]!
    const sbX = SX[b]!
    const saY = SY[a]!
    F += w * (caX * cbY - s * cbX * caY)
    FX += w * (-a * saX * cbY + s * b * sbX * caY)
    FY += w * (-b * caX * sbY + s * a * cbX * saY)
  }
  /** Round plate: cos(aθ)·cos(bπr), with cos/sin(kθ) by recurrence from u/r, v/r (no atan2). */
  const evalRound = (k: number, u: number, v: number, w: number) => {
    const a = ROUND_A[k]!
    const b = ROUND_B[k]!
    const r = Math.sqrt(u * u + v * v) + 1e-4
    const c1 = u / r
    const s1 = v / r
    let C = 1
    let Sn = 0
    for (let q = 0; q < a; q++) {
      const c = C * c1 - Sn * s1
      Sn = Sn * c1 + C * s1
      C = c
    }
    const P = Math.cos(b * Math.PI * r)
    const Q = Math.sin(b * Math.PI * r)
    F += w * C * P
    // The angular part's gradient grows as 1/r; held at r = 0.12 so grains near the centre are not flung.
    const re = Math.max(r, 0.12)
    const k2 = 2 / Math.PI
    FX += w * ((a * Sn * v) / (re * re) * P - C * b * Math.PI * Q * (u / r)) * k2
    FY += w * ((-a * Sn * u) / (re * re) * P - C * b * Math.PI * Q * (v / r)) * k2
  }
  const evalSpiral = (u: number, v: number, w: number) => {
    const r = Math.sqrt(u * u + v * v) + 1e-4
    const th = Math.atan2(v, u)
    const ph = r * 7 - 3 * th + spiralPh
    const c = Math.cos(ph)
    F += w * Math.sin(ph)
    // d/du of (7r − 3θ) = 7u/r + 3v/r², d/dv = 7v/r − 3u/r²; scaled to X, Y units (×2/π).
    const k = 2 / Math.PI
    FX += w * c * (7 * u / r + (3 * v) / (r * r)) * k
    FY += w * c * (7 * v / r - (3 * u) / (r * r)) * k
  }

  return {
    resize(width, height, ratio) {
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f: Frame) {
      const p = f.palette
      const dt = f.dt
      const reduced = f.reducedMotion
      mix.step(f)
      modeTone(tone, mix, p)
      const fo = f.focus
      clear2d(g, dpr, fo) // (0, 0) is the box's top-left corner; the plate lives in the box
      W = fo.width
      H = fo.height
      {
        const L0 = Math.min(W * 0.9, H * 0.9)
        nBase = Math.round(clamp(L0 * L0 * 0.024, 700, BASE_GRAINS))
      }

      // Options.
      const o = f.options
      glide.begin(f)
      sizeK = glide.to(sizeK, optNumber(o, "size"))
      const gkGoal = optNumber(o, "grains")
      grainsK = glide.to(grainsK, gkGoal, 0.3)
      if (Math.abs(grainsK - gkGoal) < 0.002) grainsK = gkGoal
      if (Math.round(nBase * grainsK) !== n) setCount(nBase * grainsK)
      grainSizeK = glide.to(grainSizeK, optNumber(o, "grainSize"))
      shakeK = glide.to(shakeK, optNumber(o, "shake"))
      pitchK = glide.to(pitchK, optNumber(o, "pitch"))
      const detail = optChoice(o, "detail")
      const di = Math.max(0, DETAILS.indexOf(detail))
      loF = glide.to(loF, DETAIL_LO[di]!, 0.3)
      hiF = glide.to(hiF, DETAIL_HI[di]!, 0.3)
      const plate = optChoice(o, "plate")
      roundK = glide.to(roundK, plate === "round" ? 1 : 0, 0.35)
      const frontsOn = optToggle(o, "fronts")
      // A new plate or figure range: let the sand resettle even on a silent plate.
      if ((lastPlate !== "" && plate !== lastPlate) || (lastDetail !== "" && detail !== lastDetail)) settle = 1.2
      settle = Math.max(0, settle - dt)

      const L = Math.min(W * 0.9, H * 0.9) * sizeK // plate side
      const half = L / 2
      const cx = W / 2
      const cy = H / 2
      const v = f.mode === "speaking" ? f.agent : f.user
      const on = f.mode === "hearing" || f.mode === "speaking"
      let lv = level.step(on ? v.level : 0, dt)
      if (reduced) lv = Math.round(clamp01(lv * 1.6) * 3) / 3 / 1.6
      const reg = voiceOf(f, mix, "register")
      const pitch = voiceOf(f, mix, "pitch")

      // Which figure the voice asks for: register sets the family, pitch moves within it.
      // (With reduced motion only the register counts, so the figure changes rarely and never flickers.)
      // "Pitch reaction" moves weight between the register (steady) and the pitch (lively); "Figures" sets the range.
      const want = clamp01(reduced ? reg : reg * (1 - 0.35 * pitchK) + pitch * 0.35 * pitchK)
      if (on) figPos = reduced ? want : approach(figPos, want, dt, 0.25)
      else if (f.mode === "listening") figPos = approach(figPos, 0, dt, reduced ? 0 : 0.8)
      const target = Math.round(loF + figPos * (hiF - loF))
      if (target !== figB && figMix > 0.6) {
        figA = figB
        figB = target
        figMix = 0
      }
      figMix = reduced ? 1 : Math.min(1, figMix + dt / 0.45)

      // Drive: how hard the plate shakes. Silence lets the sand rest where it is.
      const th = mix.thinking
      const drive = (mix.hearing + mix.speaking) * (0.15 + lv * 1.6 * shakeK) + mix.listening * 0.12 + th * 0.35
      if (!reduced) spiralPh += dt * 0.9 * th

      // Fronts: each syllable sends a ring of jumping sand inward (taking in) or outward (speaking).
      for (let q = 0; q < MAX_FRONTS; q++) fAge[q] = fAge[q]! + dt
      if (on && frontsOn && v.onset > 0.55 && lastOnset <= 0.55 && !reduced) {
        const q = nextFront
        nextFront = (nextFront + 1) % MAX_FRONTS
        fU[q] = 0
        fV[q] = 0
        fAge[q] = 0
        fDir[q] = f.mode === "speaking" ? 1 : -1
        fStr[q] = 0.3 + v.level
      }
      lastOnset = v.onset
      const pt = f.pointer
      const pu = (pt.x - fo.x - cx) / half
      const pv = (pt.y - fo.y - cy) / half
      const onPlate = pt.inside && Math.abs(pu) < 1 && Math.abs(pv) < 1
      if (pt.down && !pressWas && onPlate && !reduced) {
        const q = nextFront
        nextFront = (nextFront + 1) % MAX_FRONTS
        fU[q] = pu
        fV[q] = pv
        fAge[q] = 0
        fDir[q] = 1
        fStr[q] = 1.2
      }
      pressWas = pt.down

      // ---- Sand physics: random hops in proportion to the local vibration, and a drift toward the nodes.
      const wA = (1 - figMix) * (1 - th) * (1 - roundK)
      const wB = figMix * (1 - th) * (1 - roundK)
      const rA = (1 - figMix) * (1 - th) * roundK
      const rB = figMix * (1 - th) * roundK
      // The plate's corner radius in plate units (0.12 square .. 1 round), for keeping grains on it.
      const corner = lerp(0.12, 1, roundK) * 0.985
      const cc = 0.985 - corner
      const modeKey = f.mode
      let anyFront = false
      for (let q = 0; q < MAX_FRONTS; q++) if (fAge[q]! <= 1.2) anyFront = true
      // The first frame places the sand straight into a settled figure, so even a fresh idle plate shows one.
      const first = lastMode === ""
      const snap = first || (reduced && (lastShown !== figB || lastMode !== modeKey || lastPlate !== plate))
      const newton = reduced || first
      // A silent plate (idle) does not move, so the sand needs no simulation at all.
      const resting = drive < 0.02 && !anyFront && !(onPlate && !pt.down) && settle <= 0
      const iters = snap ? 14 : reduced || resting ? 0 : 1
      const h = reduced ? 0.03 : dt
      if (snap) {
        // Re-strew the sand evenly first, so the projection covers the whole figure instead of bunching.
        for (let i = 0; i < n; i++) {
          gu[i] = rand() * 2 - 1
          gv[i] = rand() * 2 - 1
        }
      }
      for (let it = 0; it < iters; it++) {
        for (let i = 0; i < n; i++) {
          const u = gu[i]!
          const w = gv[i]!
          const X = (u + 1) * 1.5707963
          const Y = (w + 1) * 1.5707963
          F = 0
          FX = 0
          FY = 0
          if (wA > 0.01 || wB > 0.01) tables(X, Y)
          if (wA > 0.01) evalFig(figA, wA)
          if (wB > 0.01) evalFig(figB, wB)
          if (rA > 0.01) evalRound(figA, u, w, rA)
          if (rB > 0.01) evalRound(figB, u, w, rB)
          if (th > 0.01) evalSpiral(u, w, th)
          const amp = Math.abs(F)
          let hop = reduced ? 0 : drive * amp * 0.9
          // Fronts.
          for (let q = 0; anyFront && q < MAX_FRONTS; q++) {
            const age = fAge[q]!
            if (age > 1.2) continue
            const du = u - fU[q]!
            const dv = w - fV[q]!
            const r = Math.sqrt(du * du + dv * dv)
            const rf = fDir[q]! > 0 ? age * 1.6 : 1.45 - age * 1.4
            const d = r - rf
            if (d > -0.09 && d < 0.09) hop += fStr[q]! * 1.6 * (1 - age / 1.2)
          }
          // Hover: a finger above the plate nudges sand away.
          let nu = 0
          let nv = 0
          if (onPlate && !pt.down && !reduced) {
            const du = u - pu
            const dv = w - pv
            const r2 = du * du + dv * dv
            if (r2 < 0.04) {
              nu = (du / (Math.sqrt(r2) + 0.01)) * 0.4 * h
              nv = (dv / (Math.sqrt(r2) + 0.01)) * 0.4 * h
            }
          }
          let uu: number
          let ww: number
          if (newton) {
            // Newton step onto the nodal line (f = 0): lands each grain on the figure in a few iterations.
            const g2 = FX * FX + FY * FY + 0.05
            uu = u - ((F * FX) / g2) * 0.6366 * 0.8
            ww = w - ((F * FY) / g2) * 0.6366 * 0.8
          } else {
            // The spiral's gradient is steeper than the plate figures', so it is pulled more gently.
            const pull = (0.5 + drive * 1.2) * h * (1 - 0.75 * th)
            uu = u - F * FX * pull + (rand() - 0.5) * hop * h * 2 + nu
            ww = w - F * FY * pull + (rand() - 0.5) * hop * h * 2 + nv
            if (settle > 0) {
              // Resettling after a plate or range change: a gentle Newton step each frame slides the sand onto the new lines.
              const g2 = FX * FX + FY * FY + 0.05
              const k = 0.6366 * 0.8 * 0.14
              uu -= ((F * FX) / g2) * k
              ww -= ((F * FY) / g2) * k
            }
          }
          if (uu < -0.985) uu = -0.985
          else if (uu > 0.985) uu = 0.985
          if (ww < -0.985) ww = -0.985
          else if (ww > 0.985) ww = 0.985
          // Rounded (or round) plate: keep grains inside the corner arcs.
          if (roundK > 0.001) {
            const au = Math.abs(uu)
            const av = Math.abs(ww)
            if (au > cc && av > cc) {
              const du = au - cc
              const dv = av - cc
              const d = Math.sqrt(du * du + dv * dv)
              if (d > corner) {
                uu = Math.sign(uu) * (cc + (du * corner) / d)
                ww = Math.sign(ww) * (cc + (dv * corner) / d)
              }
            }
          }
          gu[i] = uu
          gv[i] = ww
        }
      }
      lastShown = figB
      lastMode = modeKey
      lastPlate = plate
      lastDetail = detail

      // ---- Plate.
      const rr = L * lerp(0.06, 0.5, roundK)
      sinkInto(cA, mixInto(cB, p.surface, tone, 0.08 + mix.taking * 0.04), 0.0, p)
      g.fillStyle = css(cA, p.dark ? 0.9 : 0.75)
      g.beginPath()
      g.roundRect(cx - half, cy - half, L, L, rr)
      g.fill()
      // Rim: lit by the person's voice while taking in (the plate is bowed from its edge).
      const rimLit = mix.listening * 0.5 + mix.hearing * (0.45 + lv * 1.1)
      g.lineWidth = Math.max(1, L / 300) * (1 + rimLit * 2.2)
      g.strokeStyle = css(sinkInto(cB, tone, 0.6 - rimLit * 0.55, p), 0.6 + rimLit * 0.4)
      g.beginPath()
      g.roundRect(cx - half, cy - half, L, L, rr)
      g.stroke()

      // Driver: a puck in the centre that pulses while the assistant speaks.
      const sp = mix.speaking
      if (sp > 0.02) {
        const pr = L * (0.03 + 0.06 * lv)
        g.fillStyle = css(sinkInto(cB, p.voice, p.dark ? 0.35 : 0.15, p), sp * 0.9)
        g.beginPath()
        g.arc(cx, cy, pr, 0, TAU)
        g.fill()
        g.strokeStyle = css(p.voice, sp * 0.8)
        g.lineWidth = Math.max(1, L / 260)
        g.beginPath()
        g.arc(cx, cy, pr * 1.6, 0, TAU)
        g.stroke()
      }

      // ---- Sand: one path. Grains are a touch bigger and bolder when the plate is loud.
      liftInto(cA, tone, p.dark ? 0.3 : 0.25, p)
      const gs = Math.max(1, L / 300) * (1 + lv * 0.6) * grainSizeK
      g.fillStyle = css(cA, mix.blend(0.55, 0.85, 0.95, 0.9, 0.95))
      g.beginPath()
      for (let i = 0; i < n; i++) g.rect(cx + gu[i]! * half - gs * 0.5, cy + gv[i]! * half - gs * 0.5, gs, gs)
      g.fill()

      // Fronts drawn faintly too, so the direction reads in a still frame.
      g.lineWidth = Math.max(1, L / 320)
      for (let q = 0; q < MAX_FRONTS; q++) {
        const age = fAge[q]!
        if (age > 1.0 || reduced) continue
        const rf = (fDir[q]! > 0 ? age * 1.6 : 1.45 - age * 1.4) * half
        if (rf <= 1) continue
        g.save()
        g.beginPath()
        g.roundRect(cx - half, cy - half, L, L, rr)
        g.clip()
        g.strokeStyle = css(tone, 0.22 * (1 - age))
        g.beginPath()
        g.arc(cx + fU[q]! * half, cy + fV[q]! * half, rf, 0, TAU)
        g.stroke()
        g.restore()
      }
    },

    dispose() {}
  }
}

const character: Character = {
  id: "chladni-sand",
  version: "1.1.0",
  contract: 1,
  name: "Chladni sand",
  family: "abstract",
  summary: "Sand on a vibrating plate gathers into Chladni figures: the voice's pitch picks the figure, its loudness shakes the plate.",
  inspiredBy:
    "Ernst Chladni's 1787 sand figures and the cymatics demonstrations they inspired; Google Home's idea that a pattern grammar, not just loudness, can carry state.",
  modes: {
    idle: "A still grey plate; the sand rests in the last figure it was shaken into.",
    listening: "The rim glows mint and the plate hums softly; the sand settles into the simplest figure, waiting.",
    hearing: "Mint sand; your pitch picks the figure (a deep voice a simple cross, a child's a fine lattice), loudness shakes it; each syllable sends a front of jumping sand in from the rim.",
    thinking: "Amber; the plate turns the sand into a slowly rotating three-armed spiral.",
    speaking: "Amber sand around a pulsing driver in the centre; the reply's pitch picks the figure and each syllable sends a front outward."
  },
  mappings: [
    { signal: "register (65 %) + pitch (35 %)", effect: "Which of 12 figures the sand forms, from (1, 2) for a deep voice to (5, 6) for a child's; follows in 250 ms, cross-fades over 450 ms while the sand migrates." },
    { signal: "active.level", effect: "How hard the plate shakes (hop size ∝ 0.15 + 1.6 × level at antinodes), so a shout scatters the sand and a whisper barely stirs it; grain size +60 % at full." },
    { signal: "active.onset (rising edge)", effect: "A front of jumping sand: inward from the rim while hearing, outward from the centre while speaking; strength 0.3 + level." },
    { signal: "user.level (hearing)", effect: "Brightness and width of the lit rim." },
    { signal: "agent.level (speaking)", effect: "Size of the central driver puck." },
    { signal: "mode", effect: "Colour (grey, mint, amber), lit rim (taking in) vs centre driver (speaking), spiral figure while thinking, resting sand when idle." },
    { signal: "pointer", effect: "A press on the plate sends a strong front out from the finger; hovering nudges sand away from under it." },
    { signal: "options", effect: "size, amount of sand (new grains start on the figure), grain size, figure range (simple, full, intricate), shake, pitch reaction (register vs melody), syllable fronts, and a square or round plate (the plate morphs and the sand resettles into round figures: diameters and rings); values glide, all snap with reduced motion." },
    { signal: "reducedMotion", effect: "Sand does not hop or drift: when the figure, mode or plate changes it is placed straight into the settled figure, then holds still." }
  ],
  renderer: "2d",
  canvas: "stage",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the plate is; at 1 it nearly fills the height." },
    { id: "grains", kind: "number", label: "Amount of sand", min: 0.3, max: 2, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How much sand lies on the plate: a sparse sprinkle or thick, bold lines." },
    { id: "grainSize", kind: "number", label: "Grain size", min: 0.5, max: 2.5, step: 0.1, default: 1, unit: "×", group: "Shape", help: "How big each grain of sand is drawn." },
    {
      id: "detail",
      kind: "choice",
      label: "Figures",
      choices: [
        { value: "simple", label: "Simple" },
        { value: "full", label: "Full range" },
        { value: "intricate", label: "Intricate" }
      ],
      default: "full",
      group: "Shape",
      help: "Which figures the voices can draw: only the simpler crosses and grids, all of them, or only the finer lattices."
    },
    { id: "shake", kind: "number", label: "Shake", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How hard loudness shakes the plate: low keeps the lines crisp, high scatters the sand on every loud word." },
    { id: "pitch", kind: "number", label: "Pitch reaction", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much the melody of the voice changes the figure; at 0 only the voice's usual register picks it, so it changes rarely." },
    { id: "fronts", kind: "toggle", label: "Syllable fronts", default: true, group: "Motion", help: "The ring of jumping sand each syllable sends in from the rim or out from the centre." },
    {
      id: "plate",
      kind: "choice",
      label: "Plate",
      choices: [
        { value: "square", label: "Square" },
        { value: "round", label: "Round" }
      ],
      default: "square",
      group: "Style",
      help: "A square plate with crossing lines, or a round one whose figures are diameters and rings."
    }
  ],
  create
}

export default character
