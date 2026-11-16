/**
 * Pitch ink: a seismograph pen on slowly moving paper, two staves like a duet score. The
 * person writes in the upper stave in their colour, the assistant in the lower one in its own.
 * The height of the line is the melody of the voice (pitch on a log scale), its thickness the
 * loudness; it breaks where the voice is unvoiced, goes to dry stipple for a whisper and spatters
 * on "s" sounds. The recent past stays on the paper, so a question's rising tail and the
 * assistant's flatter answer sit one above the other: the only design that shows intonation.
 */
import type { Character, CharacterInstance, Frame } from "../contract.ts"
import { TAU, approach, clamp, clamp01, clear2d, lerp, optChoice, optNumber, optToggle, remap, setup2d } from "../kit.ts"
import { type Col, ModeMix, OptionGlide, col, css, hash01, liftInto, mixInto, modeTone, sinkInto } from "../shared/matter.ts"

const COLS = 1400 // ring buffer of paper columns
const STEP = 2 // px of paper per column

// Column owners.
const NONE = 0
const YOU = 1
const AGENT = 2
const THINK = 3 // the dotted hand-off line
const WAIT = 4 // the dotted "pen hovering" line while listening
const NO_DASH: Array<number> = []
const PENS = ["pen", "brush", "fine"]
/** Per pen: displayed half-width = (A + (w − 0.6) · B) for the recorded width w; the nib's offset direction (X, Y); brush tapers. */
const PEN_A = [0.6, 0.9, 0.6]
const PEN_B = [1, 1.45, 0.18]
const NIB_X = [0, Math.sin(0.61), 0]
const NIB_Y = [1, Math.cos(0.61), 1]

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1 // the focus (the box) while drawing
  let H = 1
  let CH = 1 // the whole canvas's height, from resize
  let dpr = 1
  let reachF = 0 // how far past the stave's ends the pen may swing, as a fraction of H (0 when the box is the whole canvas)

  const cPos = new Float64Array(COLS) // paper position of the column (px)
  const cOwn = new Uint8Array(COLS)
  const cY = new Float32Array(COLS) // fraction of the height, within the stave
  const cO = new Float32Array(COLS) // how far the pen swung on past the stave's end (fraction of the height, up positive), added after the stave is laid out
  const cW = new Float32Array(COLS) // half-width, px at a 420 px tall stage
  const cDry = new Float32Array(COLS) // whisper stipple strength
  const cSpat = new Float32Array(COLS) // sibilance spatter strength
  const cHz = new Float32Array(COLS)
  const cSide = new Float32Array(COLS) // which stave the pen was in (0 yours .. 1 the assistant's), for re-laying the page out
  let head = 0 // next column to write
  let count = 0

  const mix = new ModeMix(0.35)
  const tone: Col = col()
  const cA: Col = col()
  const cB: Col = col()
  let paper = 0 // total paper travel, px
  let lastCol = -1e9
  let speed = 0
  let penX = 0
  let penY = 0.5
  let penO = 0
  let loY = 0 // the lowest and highest the pen and ink may show (px, box coordinates): inside the canvas
  let hiY = 1
  let width = 0
  let pitchS = 0.4
  let laneSide = 0 // 0 top (you) .. 1 bottom (assistant), eased
  let unvoicedFor = 0
  let started = false
  let dash: Array<number> = [2, 4]
  let holdKey = -1 // reduced motion: what the paper was last stepped for

  // Options, eased toward the viewer's settings.
  const glide = new OptionGlide()
  let paperK = 1
  let thickK = 1
  let zoomK = 1
  let shareK = 0 // 0 two staves .. 1 one shared stave
  let spatK = 1
  let linesK = 1
  const penW = new Float32Array([1, 0, 0]) // pen, brush, fine
  let penA = 0.6
  let penB = 1
  let nibX = 0
  let nibY = 1

  // Lane geometry, fractions of the height.
  const TOP0 = 0.08
  const TOP1 = 0.45
  const BOT0 = 0.55
  const BOT1 = 0.92
  const laneY = (side: number, pitch: number): number => {
    const raw = (pitch - 0.1) / 0.82
    const u = raw < 0 ? 0 : raw > 1 ? 1 : raw
    const top = lerp(TOP0, BOT0, side)
    const bot = lerp(TOP1, BOT1, side)
    return bot - u * (bot - top)
  }
  /** On the stage a pitch beyond the stave's ends (a wide melody zoom) swings on past them, softly saturating (fraction of the height, up positive). */
  const overOf = (pitch: number): number => {
    const raw = (pitch - 0.1) / 0.82
    const over = raw < 0 ? raw : raw > 1 ? raw - 1 : 0
    return over === 0 ? 0 : Math.sign(over) * (1 - Math.exp(-2.5 * Math.abs(over))) * reachF
  }
  /** Where a stave height and its overshoot show (px): the overshoot is added after the stave is laid out, and the result stays inside the canvas. */
  const showY = (y: number, side: number, o: number): number => {
    const v = (mapY(y, side) - o) * H
    return v < loY ? loY : v > hiY ? hiY : v
  }
  /**
   * Where a height written in the two-stave layout shows now: with "One shared stave" both
   * staves stretch to the full height. Applied when drawing, so the whole page re-lays out.
   */
  const mapY = (y: number, side: number): number => {
    if (shareK < 0.001) return y
    const top2 = lerp(TOP0, BOT0, side)
    const top = lerp(top2, TOP0, shareK)
    const span = lerp(TOP1 - TOP0, BOT1 - TOP0, shareK)
    return top + ((y - top2) * span) / (TOP1 - TOP0)
  }
  const yOf = (j: number): number => showY(cY[j]!, cSide[j]!, cO[j]!)
  /** Displayed half-width (px) of a recorded width, for the chosen pen and thickness. */
  const inkW = (w: number, scale: number): number => Math.max(0, penA + (w - 0.6) * penB) * thickK * scale

  const write = (own: number, y: number, o: number, w: number, dry: number, spat: number, hz: number) => {
    cPos[head] = paper
    cOwn[head] = own
    cY[head] = y
    cO[head] = o
    cW[head] = w
    cDry[head] = dry
    cSpat[head] = spat
    cHz[head] = hz
    cSide[head] = laneSide
    head = (head + 1) % COLS
    if (count < COLS) count++
  }

  return {
    resize(_width, height, ratio) {
      CH = height
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f: Frame) {
      const p = f.palette
      const dt = f.dt
      const reduced = f.reducedMotion
      mix.step(f)
      modeTone(tone, mix, p)
      // The whole canvas is cleared and (0, 0) is the box's corner: the drawing below is in box coordinates.
      const fo = f.focus
      clear2d(g, dpr, fo)
      W = fo.width
      H = fo.height
      if (!started) penX = W * 0.8
      started = true
      {
        const sc = Math.max(0.42, Math.min(1.4, H / 420))
        if (dash[0] !== 2 * sc) dash = [2 * sc, 4 * sc]
      }
      // Room beyond the box (above and below) the pen may swing into.
      const room = Math.min(fo.y, CH - fo.y - fo.height) - 12
      reachF = room > 0 ? Math.min(room, Math.max(0.25 * H, 48)) / H : 0
      // Nothing is shown closer than 12 px to the canvas edge (the box itself is always allowed).
      loY = Math.min(0, 12 - fo.y)
      hiY = Math.max(H, CH - fo.y - 12)

      // Options.
      const opts = f.options
      glide.begin(f)
      paperK = glide.to(paperK, optNumber(opts, "paper"), 0.3)
      thickK = glide.to(thickK, optNumber(opts, "thickness"))
      zoomK = glide.to(zoomK, optNumber(opts, "zoom"))
      shareK = glide.to(shareK, optChoice(opts, "staves") === "shared" ? 1 : 0, 0.35)
      spatK = glide.to(spatK, optToggle(opts, "spatter") ? 1 : 0)
      linesK = glide.to(linesK, optToggle(opts, "lines") ? 1 : 0)
      glide.weights(penW, PENS.indexOf(optChoice(opts, "pen")))
      penA = penB = nibX = nibY = 0
      for (let k = 0; k < 3; k++) {
        penA += PEN_A[k]! * penW[k]!
        penB += PEN_B[k]! * penW[k]!
        nibX += NIB_X[k]! * penW[k]!
        nibY += NIB_Y[k]! * penW[k]!
      }
      const brushK = penW[1]!

      const scale = clamp(H / 420, 0.42, 1.4)
      const mode = f.mode
      const speaking = mode === "speaking"
      const v = speaking ? f.agent : f.user
      const on = mode === "hearing" || speaking

      // Paper speed per mode (px/s). Idle stops the paper; listening creeps.
      const full = Math.max(40, W * 0.12)
      const target = full * (mode === "idle" ? 0 : mode === "listening" ? 0.3 : mode === "thinking" ? 0.45 : 1) * paperK
      // Reduced motion holds the pose: the paper never scrolls on its own; it steps (below) when the voice or mode changes.
      speed = reduced ? 0 : approach(speed, target, dt, 0.4)
      paper += speed * dt

      // Pen: in the person's stave while taking in, the assistant's while speaking, travelling down while thinking.
      const sideTarget = mode === "speaking" || mode === "thinking" ? 1 : mode === "idle" ? 0.5 : 0
      laneSide = reduced ? sideTarget : approach(laneSide, sideTarget, dt, mode === "thinking" ? 0.45 : 0.25)
      // Voiced, with a 60 ms bridge so a consonant inside a word does not lift the pen.
      const voicedNow = v.voicing > 0.4 && v.pitchHz > 0
      unvoicedFor = voicedNow ? 0 : unvoicedFor + dt
      const voiced = voicedNow || (unvoicedFor < 0.06 && v.speaking && v.level > 0.05)
      if (voicedNow) {
        // Slew-limited (1.6 per second, about 48 semitones/s) so octave slips of the pitch tracker don't spike the line.
        const want = approach(pitchS, v.pitch, dt, 0.03)
        const lim = 1.6 * dt
        pitchS += clamp(want - pitchS, -lim, lim)
      }
      const reg = speaking || mode === "thinking" ? f.agent.register : f.user.register
      if (!on) pitchS = reduced ? reg : approach(pitchS, reg, dt, 0.5)
      // Reduced motion: the pitch moves in eighths, the loudness in thirds.
      const pS = reduced ? Math.round(pitchS * 8) / 8 : pitchS
      const lvQ = reduced ? (on && v.speaking && voiced ? Math.min(3, 1 + Math.floor(v.level * 3)) : 0) : 0
      // "Melody zoom" stretches the pitch scale around the voice's own register.
      const zp = reg + (pS - reg) * zoomK
      let y = laneY(laneSide, zp)
      let yo = overOf(zp)
      if (mode === "idle") {
        y = lerp(y, 0.5, mix.idle)
        yo *= 1 - mix.idle
      }
      if (mode === "thinking" && !reduced) y += Math.sin(f.t * 6.5) * 0.05 * mix.thinking
      penY = reduced ? y : approach(penY, y, dt, 0.035)
      penO = reduced ? yo : approach(penO, yo, dt, 0.035)
      const wTarget = on && v.speaking ? (voiced ? 0.6 + 13 * Math.pow(v.level, 1.2) : 0) : 0
      width = reduced ? (lvQ === 0 ? 0 : 0.6 + 4 * lvQ) : approach(width, wTarget, dt, wTarget > width ? 0.03 : 0.08)

      // Write columns as the paper moves.
      if (reduced) {
        // Stepped: when the mode, the quantised loudness or the quantised pitch changes, a short run of
        // columns appears at once (a dotted line when listening or thinking); nothing moves in between.
        const sib = v.sibilance > 0.45 && lvQ > 0 ? 1 : 0
        const key = on ? (lvQ === 0 && v.speaking && !voiced && v.level > 0.02 ? 500 : lvQ * 40 + Math.round(pitchS * 8) * 2 + sib) + (speaking ? 1000 : 0) : mode === "listening" ? 2000 : mode === "thinking" ? 3000 : 4000
        if (key !== holdKey) {
          holdKey = key
          const stepped = on ? (lvQ > 0 || key === 500 || key === 1500 ? 8 : 0) : mode === "idle" ? 0 : 120
          for (let m = 0; m < stepped; m++) {
            paper += STEP
            let own = NONE
            let dry = 0
            let spat = 0
            if (on) {
              own = speaking ? AGENT : YOU
              if (!voiced) dry = clamp01(v.level * 4)
              spat = sib * 0.6
            } else if (mode === "thinking") own = Math.floor(paper / (STEP * 3)) % 2 === 0 ? THINK : NONE
            else own = Math.floor(paper / (STEP * 4)) % 3 === 0 ? WAIT : NONE
            lastCol = paper
            write(own, penY, penO, own === YOU || own === AGENT ? (voiced ? width : 0) : 0, dry, spat, voiced ? v.pitchHz : 0)
          }
        }
      } else if (paper - lastCol >= STEP) {
        lastCol = paper
        let own = NONE
        let dry = 0
        let spat = 0
        if (on && v.speaking && v.level > 0.02) {
          own = speaking ? AGENT : YOU
          if (!voiced) dry = clamp01(v.level * 4)
          if (v.sibilance > 0.45) spat = clamp01((v.sibilance - 0.45) * 2.2) * clamp01(v.level * 3)
        } else if (mode === "thinking") own = Math.floor(paper / (STEP * 3)) % 2 === 0 ? THINK : NONE
        else if (mode === "listening") own = Math.floor(paper / (STEP * 4)) % 3 === 0 ? WAIT : NONE
        write(own, penY, penO, own === YOU || own === AGENT ? (voiced ? width : 0) : 0, dry, spat, voiced ? v.pitchHz : 0)
      }

      // Reduced motion: the pen stays put at its place on the page.
      penX = reduced ? W * 0.8 : approach(penX, W * 0.8, dt, 0.5)

      // ---- Staves.
      const hair = Math.max(1, scale)
      g.lineWidth = hair
      // With one shared stave, the upper stave's lines take the whole height and the lower one's fade.
      for (let lane = 0; lane < 2 && linesK > 0.01; lane++) {
        const fade = lane === 0 ? 1 : 1 - shareK
        if (fade < 0.01) continue
        const own = lane === 0 ? (shareK > 0 ? mixInto(cB, p.you, tone, shareK) : p.you) : p.voice
        const active = lane === 0 ? mix.taking + mix.giving * shareK : mix.giving
        sinkInto(cA, mixInto(cB, p.inkFaint, own, 0.25 + active * 0.5), p.dark ? 0.55 - active * 0.25 : 0.5 - active * 0.25, p)
        g.strokeStyle = css(cA, (0.3 + active * 0.3) * linesK * fade)
        for (let k = 0; k < 3; k++) {
          const yy = mapY(laneY(lane, 0.2 + k * 0.3), lane) * H
          g.beginPath()
          g.moveTo(W * 0.03, yy)
          g.lineTo(W * 0.97, yy)
          g.stroke()
        }
      }
      // The centre rule between the staves.
      const rule = linesK * (1 - shareK)
      if (rule > 0.01) {
        g.strokeStyle = css(sinkInto(cA, p.inkFaint, 0.5, p), 0.6 * rule)
        g.setLineDash(dash)
        g.beginPath()
        g.moveTo(W * 0.03, H * 0.5)
        g.lineTo(W * 0.97, H * 0.5)
        g.stroke()
        g.setLineDash(NO_DASH)
      }

      // ---- Ink.
      const now = paper
      const fadeL = W * 0.02
      const xOf = (j: number) => penX - (now - cPos[j]!)
      const idleDim = 1 - mix.idle * 0.45
      const lead = fo.x > 0 ? Math.min(fadeL, fo.x) : 0
      const cutX = -lead - 10

      for (let pass = 0; pass < 2; pass++) {
        const owner = pass === 0 ? YOU : AGENT
        const baseC = owner === YOU ? p.you : p.voice
        liftInto(cA, baseC, p.dark ? 0.12 : 0.1, p)
        // Past the box's left edge the ink fades out over the same distance, so it never ends in a visible cut.
        const grad = g.createLinearGradient(lead > 0 ? -lead : fadeL, 0, penX, 0)
        if (lead > 0) {
          const span = penX + lead
          grad.addColorStop(0, css(cA, 0))
          grad.addColorStop(lead / span, css(cA, 0.18 * idleDim))
          grad.addColorStop(Math.min(1, (lead + fadeL) / span), css(cA, 0.18 * idleDim))
        } else grad.addColorStop(0, css(cA, 0.18 * idleDim))
        grad.addColorStop(1, css(cA, idleDim))
        g.fillStyle = grad
        // Walk the visible columns oldest to newest, filling each contiguous inked run as a ribbon.
        let runStart = -1
        let runLen = 0
        for (let k = count - 1; k >= -1; k--) {
          const j = k >= 0 ? (head - 1 - k + COLS * 2) % COLS : -1
          const inked = j >= 0 && cOwn[j] === owner && cW[j]! > 0.05 && xOf(j) > cutX
          if (inked) {
            if (runStart < 0) {
              runStart = j
              runLen = 0
            }
            runLen++
            continue
          }
          if (runStart >= 0 && runLen > 0) {
            // The nib offsets each edge along (nibX, nibY): straight up and down for a round pen,
            // slanted for the brush, so its stroke thins on rising lines; the brush also tapers.
            g.beginPath()
            for (let m = 0; m < runLen; m++) {
              const jj = (runStart + m) % COLS
              const wd = inkW(cW[jj]!, scale) * (brushK > 0.01 ? lerp(1, Math.min(1, (m + 1) / 7, (runLen - m) / 7), brushK) : 1)
              const x = xOf(jj) + nibX * wd
              const yy = yOf(jj) - nibY * wd
              if (m === 0) g.moveTo(x, yy)
              else g.lineTo(x, yy)
            }
            for (let m = runLen - 1; m >= 0; m--) {
              const jj = (runStart + m) % COLS
              const wd = inkW(cW[jj]!, scale) * (brushK > 0.01 ? lerp(1, Math.min(1, (m + 1) / 7, (runLen - m) / 7), brushK) : 1)
              g.lineTo(xOf(jj) - nibX * wd, yOf(jj) + nibY * wd)
            }
            g.closePath()
            g.fill()
            // Round caps so the strokes start and end like a pen lifting.
            const j0 = runStart
            const j1 = (runStart + runLen - 1) % COLS
            const end = lerp(1, Math.min(1, 1 / 7, runLen / 7), brushK) * (1 - 0.2 * brushK)
            const r0 = inkW(cW[j0]!, scale) * end
            const r1 = inkW(cW[j1]!, scale) * end
            g.beginPath()
            g.arc(xOf(j0), yOf(j0), r0, 0, TAU)
            g.moveTo(xOf(j1) + r1, yOf(j1))
            g.arc(xOf(j1), yOf(j1), r1, 0, TAU)
            g.fill()
          }
          runStart = -1
          runLen = 0
        }

        // Dry stipple (whisper, unvoiced) and spatter ("s" sounds): deterministic per column, so it never flickers.
        // Spatter is its own pass so the "Spatter" option can fade it.
        for (let part = 0; part < 2; part++) {
          if (part === 1 && spatK < 0.01) break
          g.globalAlpha = part === 1 ? spatK : 1
          g.beginPath()
          for (let k = 0; k < count; k++) {
            const j = (head - 1 - k + COLS * 2) % COLS
            if (cOwn[j] !== owner) continue
            const x = xOf(j)
            if (x < cutX) break
            const id = Math.floor(cPos[j]! / STEP)
            const yj = yOf(j)
            if (part === 0) {
              const dry = cDry[j]!
              if (dry <= 0.05) continue
              const n = 2 + Math.floor(dry * 3)
              for (let q = 0; q < n; q++) {
                const h1 = hash01(id * 13 + q * 7)
                const h2 = hash01(id * 31 + q * 11 + 5)
                if (h1 > 0.5 + dry * 0.4) continue
                const r = (0.8 + h2 * 1.3) * scale
                g.rect(x + (h2 - 0.5) * 3, yj + (h1 - 0.5) * (6 + dry * 22) * scale, r, r)
              }
            } else {
              const sp = cSpat[j]!
              if (sp <= 0.05) continue
              const n = 1 + Math.floor(sp * 3)
              for (let q = 0; q < n; q++) {
                const h1 = hash01(id * 17 + q * 3 + 1)
                const h2 = hash01(id * 23 + q * 5 + 9)
                if (h1 > 0.25 + sp * 0.4) continue
                const a = h2 * TAU
                const d = (4 + h1 * 26 * sp) * scale * Math.sqrt(thickK)
                const r = (0.6 + h1 * 1.6 * sp) * scale * Math.sqrt(thickK)
                const px = x + Math.cos(a) * d
                const py = yj + Math.sin(a) * d
                g.moveTo(px + r, py)
                g.arc(px, py, r, 0, TAU)
              }
            }
          }
          g.fill()
        }
        g.globalAlpha = 1
      }

      // Dotted lines: the hovering pen (listening) and the hand-off (thinking).
      g.beginPath()
      for (let k = 0; k < count; k++) {
        const j = (head - 1 - k + COLS * 2) % COLS
        const o = cOwn[j]!
        if (o !== THINK && o !== WAIT) continue
        const x = xOf(j)
        if (x < cutX) break
        const r = Math.max(1, (o === THINK ? 1.5 : 0.9) * scale)
        const yj = yOf(j)
        g.moveTo(x + r, yj)
        g.arc(x, yj, r, 0, TAU)
      }
      g.fillStyle = css(sinkInto(cA, tone, 0.15, p), 0.75 * idleDim)
      g.fill()

      // ---- The pen: a nib with a halo that closes in or opens out, and a faint guide of where it will write.
      const nx = penX
      const ny = showY(penY, laneSide, penO)
      liftInto(cA, tone, 0.25, p)
      g.strokeStyle = css(sinkInto(cB, tone, 0.5, p), 0.45)
      g.lineWidth = hair
      g.setLineDash(dash)
      g.beginPath()
      g.moveTo(nx + 10 * scale, ny)
      g.lineTo(W * 0.97, ny)
      g.stroke()
      g.setLineDash(NO_DASH)
      // Halo: rings close in on the nib while taking in, open out from it while speaking.
      const flow = mix.flow
      if (Math.abs(flow) > 0.05) {
        const base = Math.max(10, 16 * scale)
        for (let k = 0; k < 2; k++) {
          const frac = reduced ? 0.5 + k * 0.25 : (f.t * 0.9 + k * 0.5) % 1
          const rr = flow > 0 ? base * (0.3 + frac) : base * (1.3 - frac)
          const a = (flow > 0 ? 1 - frac : frac) * Math.abs(flow) * 0.55
          g.strokeStyle = css(tone, a)
          g.lineWidth = hair * 1.2
          g.beginPath()
          g.arc(nx, ny, rr, 0, TAU)
          g.stroke()
        }
      }
      // Nib.
      const nibR = Math.max(3, 2.6 * scale, inkW(width, scale))
      g.fillStyle = css(cA, 1)
      g.beginPath()
      g.arc(nx, ny, nibR, 0, TAU)
      g.fill()
      g.fillStyle = css(p.dark ? p.bg : p.surface, 0.9)
      g.beginPath()
      g.arc(nx, ny, nibR * 0.38, 0, TAU)
      g.fill()

      // ---- Hover: a hairline and the pitch under the pointer.
      const pt = f.pointer
      const ptx = pt.x - fo.x
      const pty = pt.y - fo.y
      if (pt.inside && ptx >= 0 && ptx < W && pty >= 0 && pty < H && ptx < penX) {
        g.strokeStyle = css(p.inkFaint, 0.6)
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(ptx, H * 0.04)
        g.lineTo(ptx, H * 0.96)
        g.stroke()
        // The column whose recorded paper position is nearest the pointer (columns are not always STEP apart).
        const want = now - (penX - ptx)
        let lo = 0
        let hi = count - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (cPos[(head - count + mid + COLS) % COLS]! < want) lo = mid + 1
          else hi = mid
        }
        // Between the first and the last recorded column the ribbon is continuous, however far apart the columns are
        // (a slow frame rate writes them wide apart): take the nearest. Beyond either end, only one that is close.
        const first = count > 0 ? cPos[(head - count + COLS) % COLS]! : 0
        const last = count > 0 ? cPos[(head - 1 + COLS) % COLS]! : 0
        let bestK = -1
        let bestD = count > 0 && want >= first && want <= last ? Infinity : STEP * 1.5
        for (let k = Math.max(0, lo - 1); k <= Math.min(count - 1, lo); k++) {
          const d = Math.abs(cPos[(head - count + k + COLS) % COLS]! - want)
          if (d < bestD) {
            bestD = d
            bestK = k
          }
        }
        if (bestK >= 0) {
          const j = (head - count + bestK + COLS) % COLS
          const hz = cHz[j]!
          if (hz > 0 && (cOwn[j] === YOU || cOwn[j] === AGENT)) {
            g.font = `${Math.round(11 * clamp(scale, 0.8, 1.2))}px ui-monospace, monospace`
            g.fillStyle = css(cOwn[j] === YOU ? p.you : p.voice, 1)
            g.fillText(`${Math.round(hz)} Hz`, ptx + 6, yOf(j) - 10)
          }
        }
      }
    },

    dispose() {}
  }
}

const character: Character = {
  id: "pitch-ink",
  name: "Pitch ink",
  version: "1.1.1",
  contract: 1,
  family: "abstract",
  summary: "A seismograph pen writes the melody of each voice on moving paper: you in the upper stave, the assistant in the lower; height is pitch, thickness is loudness.",
  inspiredBy:
    "Seismographs and chart recorders, pitch-tracking tools like the browser pitch detectors in the survey, and handwriting: Siri's classic waveform turned from loudness into intonation.",
  modes: {
    idle: "The paper stops; the pen rests grey on the centre rule and the last exchange stays, dimmed.",
    listening: "The pen hovers in your stave at your usual pitch, leaving a dotted line; rings close in on the nib.",
    hearing: "Mint ink in your stave: height follows your pitch, thickness your loudness; gaps on unvoiced sounds, dry stipple for a whisper, spatter on 's'.",
    thinking: "The pen travels down to the assistant's stave, leaving a dotted, looping hand-off line.",
    speaking: "Amber ink in the lower stave traces the assistant's melody; rings open out from the nib."
  },
  mappings: [
    { signal: "active.pitch", effect: "Height of the line within its stave (log scale, about 83 Hz at the bottom to 350 Hz at the top); 30 ms smoothing, slew-limited so tracker octave slips do not spike; only while voiced." },
    { signal: "active.level", effect: "Ink thickness: half-width 0.6 + 13 × level^1.2 px at stage size (30 ms rise, 80 ms fall)." },
    { signal: "active.voicing / pitchHz", effect: "The line breaks where voicing < 0.4 or no pitch is found for more than 60 ms (unvoiced consonants, pauses)." },
    { signal: "active.level while unvoiced", effect: "Dry stipple at the last pitch height (a whisper writes only this), spread ∝ level." },
    { signal: "active.sibilance", effect: "Ink spatter around the line where sibilance > 0.45 (count, size and spread ∝ excess × level)." },
    { signal: "register", effect: "Where the pen hovers while listening and thinking, so a deep and a child's voice sit at different heights before a word is said." },
    { signal: "active.pitchHz (hover)", effect: "Pointer over the paper shows a hairline and the pitch in Hz of the ink under it." },
    { signal: "mode", effect: "Stave the pen is in (yours on top, the assistant's below), paper speed (stopped, creeping, full), dotted listening and hand-off lines, halo direction (in for taking in, out for speaking), colour." },
    { signal: "options", effect: "paper speed (how many seconds stay in view), ink thickness, melody zoom (pitch scale stretched around each voice's register, for new ink), pen (round pen, slanted tapering brush, fine line), spatter, stave lines, and two staves or one shared stave; the page re-lays out when drawn, so thickness, pen, spatter, lines and staves restyle the ink already on it. Values glide, and snap with reduced motion." },
    { signal: "reducedMotion", effect: "Holds the pose: the paper never scrolls and the pen stays put. The trace advances in steps only when the voice changes (loudness in thirds, pitch in eighths); listening and thinking show their dotted line at once; halos stand still." }
  ],
  renderer: "2d",
  canvas: "stage",
  options: [
    { id: "thickness", kind: "number", label: "Ink thickness", min: 0.4, max: 2.5, step: 0.1, default: 1, unit: "×", group: "Shape", help: "How thick the ink is at every loudness." },
    { id: "zoom", kind: "number", label: "Melody zoom", min: 0.5, max: 3, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "Stretches the pitch scale around each voice's usual pitch, so small rises and falls show bigger." },
    { id: "paper", kind: "number", label: "Paper speed", min: 0.2, max: 2.5, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the paper moves; slower keeps more of the conversation in view, about twice as many seconds at 0.5×." },
    {
      id: "pen",
      kind: "choice",
      label: "Pen",
      choices: [
        { value: "pen", label: "Pen" },
        { value: "brush", label: "Brush" },
        { value: "fine", label: "Fine line" }
      ],
      default: "pen",
      group: "Style",
      help: "A round pen, a broad brush whose stroke thins on rising lines and tapers at the ends, or a fine line of almost even width."
    },
    { id: "spatter", kind: "toggle", label: "Spatter", default: true, group: "Style", help: "Ink spattered around the line on 's' and 'sh' sounds." },
    { id: "lines", kind: "toggle", label: "Stave lines", default: true, group: "Style", help: "The faint ruled lines of the staves and the dotted rule between them." },
    {
      id: "staves",
      kind: "choice",
      label: "Staves",
      choices: [
        { value: "two", label: "Two staves" },
        { value: "shared", label: "One shared stave" }
      ],
      default: "two",
      group: "Behaviour",
      help: "You above and the assistant below, or both voices on one full-height stave so their pitches compare directly."
    }
  ],
  create
}

export default character
