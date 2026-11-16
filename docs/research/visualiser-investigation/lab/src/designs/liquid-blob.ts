/**
 * Liquid blob: a glossy body of liquid held together by surface tension. The voice's spectrum
 * pushes its outline around (low frequencies at the bottom, high at the top). While it takes
 * sound in, the voice presses dents into it and droplets of the person's colour fly in and merge;
 * while it speaks, the outline swells outward and loud syllables bud droplets that stretch out on
 * a gooey neck and are pulled back. Thinking marbles the person's colour into the assistant's.
 * Pressing it dents it; hovering near it makes it reach for the pointer.
 */
import type { Design, DesignInstance, Frame, Rgb } from "../contract.ts"
import { AttackRelease, TAU, approach, clamp, clamp01, clear2d, lerp, noise2, optChoice, optNumber, optToggle, rng, setup2d } from "../kit.ts"
import { BLACK, type Col, ModeMix, OptionGlide, WHITE, bandShape, col, css, grow, liftInto, mixInto, modeTone, sinkInto, voiceOf } from "./_matter.ts"

const N = 96 // outline points
const MAX_DROPS = 10
const SOOT: Rgb = [40, 40, 40]
const FINISHES = ["glossy", "flat", "outline"]

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1

  // Outline springs: radius as a fraction of the base radius.
  const r = new Float32Array(N).fill(1)
  const vel = new Float32Array(N)
  const target = new Float32Array(N)
  const xs = new Float32Array(N)
  const ys = new Float32Array(N)
  const cosT = new Float32Array(N)
  const sinT = new Float32Array(N)
  const bandAt = new Float32Array(N) // fractional band index for each outline point (mirrored)
  for (let i = 0; i < N; i++) {
    const th = (i / N) * TAU
    cosT[i] = Math.cos(th)
    sinT[i] = Math.sin(th)
    // Angle from straight down (0) to straight up (π): low bands at the bottom, high at the top.
    const fromDown = Math.acos(clamp(sinT[i]!, -1, 1)) // sin = +1 is down on canvas
    bandAt[i] = (fromDown / Math.PI) * 23
  }

  // Droplets.
  const dAng = new Float32Array(MAX_DROPS)
  const dRho = new Float32Array(MAX_DROPS) // distance from centre, fraction of base radius
  const dVel = new Float32Array(MAX_DROPS)
  const dRad = new Float32Array(MAX_DROPS) // fraction of base radius
  const dKind = new Int8Array(MAX_DROPS) // +1 budding out (speaking), −1 flying in (taking in), 0 none
  const dAge = new Float32Array(MAX_DROPS)
  const dR = new Float32Array(MAX_DROPS)
  const dG = new Float32Array(MAX_DROPS)
  const dB = new Float32Array(MAX_DROPS)

  const mix = new ModeMix(0.38)
  const tone: Col = col()
  const c1: Col = col()
  const c2: Col = col()
  const c3: Col = col()
  const level = new AttackRelease(0.04, 0.3)
  const bandS = new Float32Array(24)
  let phase = 0
  let swirl = 0
  let lastOnset = 0
  let sinceDrop = 9
  let sinceSat = 0
  let stretch = 1
  const rand = rng(5)

  // Options, eased toward the viewer's settings.
  const glide = new OptionGlide()
  let sizeK = 1
  let wobbleK = 1
  let speedK = 1
  let reliefK = 1
  let pitchK = 1
  let dropsOn = true
  let glowK = 1
  const finishW = new Float32Array([1, 0, 0]) // glossy, flat, outline
  let clock = -1 // ambient-motion time, runs at the "Motion speed"

  // Per-frame drawing state shared with `pieces`.
  let cx = 0
  let cy = 0
  let R0 = 1
  let lis = 0
  let fill: CanvasGradient | string = ""
  let glossK = 1
  let fillA = 1
  const c4: Col = col()

  const spawnDrop = (kind: 1 | -1, ang: number, rho: number, vel0: number, rad: number, c: Col) => {
    let slot = -1
    for (let i = 0; i < MAX_DROPS; i++)
      if (dKind[i] === 0) {
        slot = i
        break
      }
    if (slot < 0) return
    dKind[slot] = kind
    dAng[slot] = ang
    dRho[slot] = rho
    dVel[slot] = vel0
    dRad[slot] = rad
    dAge[slot] = 0
    dR[slot] = c[0]
    dG[slot] = c[1]
    dB[slot] = c[2]
  }

  /** Outline radius (fraction) at an angle, interpolated. */
  const radiusAt = (ang: number): number => {
    let u = (((ang % TAU) + TAU) % TAU) / TAU * N
    const i0 = Math.floor(u) % N
    u -= Math.floor(u)
    return r[i0]! * (1 - u) + r[(i0 + 1) % N]! * u
  }

  /** Kick the outline near an angle (a merge or a bud leaving). */
  const kick = (ang: number, amount: number) => {
    const c = (((ang % TAU) + TAU) % TAU) / TAU * N
    for (let k = -6; k <= 6; k++) {
      const i = (Math.round(c) + k + N) % N
      vel[i] = vel[i]! + amount * Math.exp(-(k * k) / 10)
    }
  }

  /** Gooey neck between the body (a local circle) and a droplet: Hiroyuki Sato's metaball connector. */
  const neck = (cx: number, cy: number, r1: number, x2: number, y2: number, r2: number) => {
    const dx = x2 - cx
    const dy = y2 - cy
    const d = Math.hypot(dx, dy)
    const reach = r1 + r2 * 4.2
    if (d > reach || d <= Math.abs(r1 - r2) || r2 < 0.5) return
    let u1 = 0
    let u2 = 0
    if (d < r1 + r2) {
      u1 = Math.acos(clamp((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d), -1, 1))
      u2 = Math.acos(clamp((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d), -1, 1))
    }
    // The neck thins as it stretches, like syrup.
    const v = 0.5 * (1 - 0.55 * clamp01((d - r1 - r2) / (reach - r1 - r2)))
    const base = Math.atan2(dy, dx)
    const maxSpread = Math.acos(clamp((r1 - r2) / d, -1, 1))
    const a1 = base + u1 + (maxSpread - u1) * v
    const a2 = base - u1 - (maxSpread - u1) * v
    const a3 = base + Math.PI - u2 - (Math.PI - u2 - maxSpread) * v
    const a4 = base - Math.PI + u2 + (Math.PI - u2 - maxSpread) * v
    const p1x = cx + Math.cos(a1) * r1
    const p1y = cy + Math.sin(a1) * r1
    const p2x = cx + Math.cos(a2) * r1
    const p2y = cy + Math.sin(a2) * r1
    const p3x = x2 + Math.cos(a3) * r2
    const p3y = y2 + Math.sin(a3) * r2
    const p4x = x2 + Math.cos(a4) * r2
    const p4y = y2 + Math.sin(a4) * r2
    const total = r1 + r2
    const d2 = Math.min(v * 2.4, Math.hypot(p1x - p3x, p1y - p3y) / total) * Math.min(1, (d * 2) / total)
    const h1 = r1 * d2
    const h2 = r2 * d2
    const H = Math.PI / 2
    // Traced in the same turning direction as the outline and the droplets' arcs, so several
    // pieces in one path fill as their union (nonzero rule) instead of cancelling where they overlap.
    g.moveTo(p2x, p2y)
    g.bezierCurveTo(p2x + Math.cos(a2 + H) * h1, p2y + Math.sin(a2 + H) * h1, p4x + Math.cos(a4 - H) * h2, p4y + Math.sin(a4 - H) * h2, p4x, p4y)
    g.lineTo(p3x, p3y)
    g.bezierCurveTo(p3x + Math.cos(a3 + H) * h2, p3y + Math.sin(a3 + H) * h2, p1x + Math.cos(a1 - H) * h1, p1y + Math.sin(a1 - H) * h1, p1x, p1y)
    g.lineTo(cx + Math.cos(base) * r1 * 0.5, cy + Math.sin(base) * r1 * 0.5)
    g.closePath()
  }

  /**
   * The merged silhouette: body, droplets on their necks, the still droplet (reduced motion) and
   * the hovering droplets (listening). Pass 0 fills it (and glosses the droplets), pass 1 strokes
   * each piece (the outline finish), pass 2 fills it with whatever composite mode is set.
   * A see-through fill (the outline finish) traces everything in the body's colour as one path
   * and fills it once, so overlaps do not darken.
   */
  const pieces = (pass: 0 | 1 | 2, f: Frame, lv: number, tone: Col) => {
    const p = f.palette
    const reduced = f.reducedMotion
    const union = pass === 0 && fillA < 0.999
    const begin = () => {
      if (!union) g.beginPath()
    }
    const paint = () => {
      if (union) return
      if (pass === 1) g.stroke()
      else g.fill()
    }
    const sameTone = (i: number) => {
      c3[0] = dR[i]!
      c3[1] = dG[i]!
      c3[2] = dB[i]!
      return Math.abs(c3[0] - tone[0]) + Math.abs(c3[1] - tone[1]) + Math.abs(c3[2] - tone[2]) < 30
    }
    const drop = (i: number) => {
      const rb = radiusAt(dAng[i]!) * R0
      const x = cx + Math.cos(dAng[i]!) * dRho[i]! * R0
      const y = cy + Math.sin(dAng[i]!) * dRho[i]! * R0
      const rd = dRad[i]! * R0
      begin()
      neck(cx, cy, rb, x, y, rd)
      paint()
      begin()
      g.moveTo(x + rd, y)
      g.arc(x, y, rd, 0, TAU)
      paint()
      // Droplet highlight.
      if (pass === 0 && !union && glossK > 0.01) {
        g.fillStyle = css(WHITE, (p.dark ? 0.35 : 0.5) * glossK)
        g.beginPath()
        g.ellipse(x - rd * 0.35, y - rd * 0.4, rd * 0.32, rd * 0.2, -0.6, 0, TAU)
        g.fill()
      }
    }
    const bodyStyle = () => {
      if (pass === 0) g.fillStyle = fill
      else if (pass === 1) g.strokeStyle = css(tone)
      else g.fillStyle = "#000"
    }
    if (pass === 0) g.globalAlpha = fillA
    bodyStyle()
    g.beginPath()
    traceOutline()
    paint()
    // Droplets of another colour (mint arriving while the body turns amber) keep their own tint.
    for (let i = 0; i < MAX_DROPS; i++) {
      if (dKind[i] === 0) continue
      const same = sameTone(i)
      if (union && !same) continue // filled on their own below
      if (pass === 0) g.fillStyle = same ? fill : css(c3)
      else if (pass === 1) g.strokeStyle = css(same ? tone : c3)
      drop(i)
    }
    bodyStyle()

    // Reduced motion: one still droplet tells the direction (budding out while speaking, arriving while taking in).
    if (reduced && dropsOn && (f.mode === "speaking" || f.mode === "hearing" || f.mode === "listening")) {
      const out = f.mode === "speaking"
      const ang = out ? -Math.PI / 2 - 0.5 : -Math.PI / 2 + 0.9
      const rb = radiusAt(ang) * R0
      const rd = R0 * (out ? 0.12 + 0.1 * lv : 0.07 + 0.08 * lv)
      const dist = out ? rb + rd * 1.6 : rb + rd * 3.2
      const x = cx + Math.cos(ang) * dist
      const y = cy + Math.sin(ang) * dist
      begin()
      neck(cx, cy, rb, x, y, rd)
      paint()
      begin()
      g.moveTo(x + rd, y)
      g.arc(x, y, rd, 0, TAU)
      paint()
    }

    // Listening: three small droplets hover around the body, waiting to be taken in.
    // They stay with "Flying droplets" off: they are how listening reads apart from hearing.
    if (lis > 0.03) {
      for (let k = 0; k < 3; k++) {
        const ang = -Math.PI / 2 + (k - 1) * 1.15 + (reduced ? 0 : Math.sin(clock * 0.5 + k * 2) * 0.12)
        const rb = radiusAt(ang) * R0
        const bob = reduced ? 0 : Math.sin(clock * 1.3 + k * 1.7) * 0.06
        const rd = R0 * 0.075 * lis
        const dist = rb + R0 * (0.32 + bob) * (2 - lis)
        const x = cx + Math.cos(ang) * dist
        const y = cy + Math.sin(ang) * dist
        begin()
        g.moveTo(x + rd, y)
        g.arc(x, y, rd, 0, TAU)
        paint()
      }
    }
    if (union) {
      g.fill()
      for (let i = 0; i < MAX_DROPS; i++) {
        if (dKind[i] === 0 || sameTone(i)) continue
        g.fillStyle = css(c3)
        g.beginPath()
        drop(i)
        g.fill()
      }
    }
    g.globalAlpha = 1
  }

  const traceOutline = () => {
    let mx = (xs[N - 1]! + xs[0]!) / 2
    let my = (ys[N - 1]! + ys[0]!) / 2
    g.moveTo(mx, my)
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N
      mx = (xs[i]! + xs[j]!) / 2
      my = (ys[i]! + ys[j]!) / 2
      g.quadraticCurveTo(xs[i]!, ys[i]!, mx, my)
    }
    g.closePath()
  }

  const outlinePath = () => {
    g.beginPath()
    traceOutline()
  }

  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f: Frame) {
      const p = f.palette
      const dt = f.dt
      const reduced = f.reducedMotion
      mix.step(f)
      modeTone(tone, mix, p)
      clear2d(g, dpr)

      // Options.
      const o = f.options
      glide.begin(f)
      sizeK = glide.to(sizeK, optNumber(o, "size"))
      wobbleK = glide.to(wobbleK, optNumber(o, "wobble"))
      speedK = glide.to(speedK, optNumber(o, "speed"))
      reliefK = glide.to(reliefK, optNumber(o, "relief"))
      pitchK = glide.to(pitchK, optNumber(o, "pitch"))
      dropsOn = optToggle(o, "droplets")
      glowK = glide.to(glowK, optNumber(o, "glow"))
      glide.weights(finishW, FINISHES.indexOf(optChoice(o, "finish")))
      glossK = finishW[0]!
      const flatK = finishW[1]! + finishW[2]!
      const outlineK = finishW[2]!
      fillA = 1 - 0.85 * outlineK
      if (clock < 0) clock = f.t
      if (!reduced) clock += dt * speedK

      cx = W / 2
      cy = H / 2 + H * 0.02
      const S = Math.min(W * 0.62, H) // the size the blob is designed against
      const v = f.mode === "speaking" ? f.agent : f.user
      const on = f.mode === "hearing" || f.mode === "speaking"
      let lv = level.step(on ? v.level : 0, dt)
      if (reduced) lv = Math.round(clamp01(lv * 1.6) * 3) / 3 / 1.6
      const pitch = voiceOf(f, mix, "pitch")
      const reg = voiceOf(f, mix, "register")

      // Base radius: grows a little with attention and with loudness (more liquid when louder).
      // A size above 1 eases into the room left inside the canvas, so a loud reply never spills out.
      R0 = grow(S * (mix.blend(0.2, 0.25, 0.25, 0.235, 0.26) + 0.07 * lv), sizeK, Math.min(H * 0.48, W * 0.5) / 1.45)

      // Smoothed bands (shaped for contrast).
      for (let b = 0; b < 24; b++) bandS[b] = approach(bandS[b]!, on ? bandShape(v, b) : 0, dt, reduced ? 0.2 : 0.06)

      // Lobes: a deep voice rolls in 2–3 big lobes, a child's in 6–8 small ones. Speed follows the syllable rate.
      // "Pitch character" scales how far the voice moves this away from the middle.
      const voiceHi = clamp01(0.5 + (clamp01(reg * 0.6 + pitch * 0.4) - 0.5) * pitchK)
      const lobes = lerp(2, 9, voiceHi)
      const n0 = Math.floor(lobes)
      const nf = lobes - n0
      if (!reduced) phase += dt * (0.35 + 0.18 * clamp(v.syllableRate, 0, 7) * (on ? 1 : 0.3)) * speedK
      if (!reduced) swirl += dt * mix.blend(0.15, 0.25, 0.3, 0.9, 0.35) * speedK
      // Big slow lobes for a deep voice, small quick ones for a high voice.
      // "Wobble" scales only the wobble of its own; the part loudness adds is reaction and stays.
      const wob = (mix.blend(0.012, 0.012, 0.03, 0.02, 0.03) * wobbleK + lv * 0.09) * lerp(1.35, 0.7, voiceHi * (on ? 1 : 0))
      // Weight: a deep voice sags the liquid into a pear, a high one lifts it (sin > 0 is down).
      const sag = on ? (0.5 - voiceHi) * 0.16 : 0
      const pressIn = mix.hearing * reliefK // spectrum dents (taking in)
      const pushOut = mix.speaking * reliefK // spectrum bulges (giving out)
      const spin = mix.thinking
      const breathe = reduced ? 0 : Math.sin(clock * 1.6) * 0.012 * (mix.listening + mix.idle * 0.6) * wobbleK
      const sib = clamp01((v.sibilance - 0.3) * 1.5) * (on ? 1 : 0)
      const pd = on ? clamp((v.pitchDelta / 10) * pitchK, -1.5, 1.5) : 0
      stretch = approach(stretch, 1 + pd * 0.07 + spin * 0.0, dt, 0.25)

      // Pointer.
      const pt = f.pointer
      const pdx = pt.x - cx
      const pdy = pt.y - cy
      const pDist = Math.hypot(pdx, pdy) / R0
      const pAng = Math.atan2(pdy, pdx)
      const near = pt.inside ? clamp01(1.9 - pDist) : 0

      for (let i = 0; i < N; i++) {
        const th = (i / N) * TAU
        const b = bandAt[i]!
        const b0 = Math.floor(b)
        const band = bandS[b0]! * (1 - (b - b0)) + bandS[Math.min(23, b0 + 1)]! * (b - b0)
        let t = 1 + breathe
        t += wob * ((1 - nf) * Math.sin(n0 * th + phase * (n0 % 2 === 0 ? 1 : -1)) + nf * Math.sin((n0 + 1) * th - phase))
        t += wob * 0.6 * noise2(cosT[i]! * 1.3 + phase * 0.4, sinT[i]! * 1.3)
        t += band * (pushOut * 0.2 - pressIn * 0.15)
        t += sag * sinT[i]!
        t += sib * 0.025 * Math.sin(19 * th + f.t * 30)
        // Thinking: a slow two-lobed spin, like liquid swirled in a glass.
        t += spin * 0.07 * Math.cos(2 * (th - swirl * 1.4))
        // Pointer: press dents under the finger; hovering close makes it reach out toward it.
        let da = th - pAng
        da = Math.atan2(Math.sin(da), Math.cos(da))
        const fall = Math.exp(-(da * da) / 0.12)
        if (pt.down && pt.inside && pDist < 1.5) t -= 0.3 * fall * clamp01(1.6 - pDist)
        else t += 0.1 * near * fall
        target[i] = t
      }

      // Springs with surface tension (neighbour smoothing), in sub-steps.
      if (reduced) {
        for (let i = 0; i < N; i++) {
          r[i] = target[i]!
          vel[i] = 0
        }
      } else {
        const k = 160
        const damp = 7
        const tension = 90
        let left = dt
        while (left > 0) {
          const h = Math.min(left, 1 / 120)
          for (let i = 0; i < N; i++) {
            const lap = r[(i + N - 1) % N]! + r[(i + 1) % N]! - 2 * r[i]!
            vel[i] = vel[i]! + (k * (target[i]! - r[i]!) + tension * lap - damp * vel[i]!) * h
          }
          for (let i = 0; i < N; i++) r[i] = r[i]! + vel[i]! * h
          left -= h
        }
      }

      // ---- Droplets.
      sinceDrop += dt
      sinceSat += dt
      if (!reduced && dropsOn) {
        if (on && v.onset > 0.6 && lastOnset <= 0.6 && sinceDrop > 0.12) {
          if (f.mode === "speaking" && v.level > 0.22) {
            // Bud: leaves where the spectrum pushes hardest, upper half for high, lower for low.
            const ang = -Math.PI / 2 + (rand() - 0.5) * 2.6
            spawnDrop(1, ang, radiusAt(ang) - 0.05, 0.7 + v.level * 1.5, (0.08 + 0.13 * v.level) * lerp(1.25, 0.75, voiceHi), tone)
            kick(ang, 1.2)
            sinceDrop = 0
          } else if (f.mode === "hearing" && v.level > 0.04) {
            const ang = rand() * TAU
            spawnDrop(-1, ang, 1.9 + rand() * 0.25, -0.6, (0.05 + 0.14 * v.level) * lerp(1.25, 0.75, voiceHi), tone)
            sinceDrop = 0
          }
        }
        // Listening: a small mint droplet drifts in every 1.4 s; the body is waiting to take something in.
        if (f.mode === "listening" && sinceSat > 1.4) {
          spawnDrop(-1, rand() * TAU, 1.85, -0.25, 0.06, tone)
          sinceSat = 0
        }
      }
      lastOnset = v.onset

      // Outline positions.
      for (let i = 0; i < N; i++) {
        const rr = r[i]! * R0
        xs[i] = cx + cosT[i]! * rr / Math.sqrt(stretch)
        ys[i] = cy + sinT[i]! * rr * stretch
      }

      // ---- Ground: a contact shadow on light, a soft glow of the tone on dark.
      if (glowK > 0.01) {
        const glowR = R0 * 1.7
        const gg = g.createRadialGradient(cx, cy + (p.dark ? 0 : R0 * 0.25), R0 * 0.4, cx, cy + (p.dark ? 0 : R0 * 0.25), glowR)
        if (p.dark) {
          gg.addColorStop(0, css(tone, (0.16 + lv * 0.2) * glowK))
          gg.addColorStop(1, css(tone, 0))
        } else {
          sinkInto(c1, tone, 0.3, p)
          mixInto(c1, c1, SOOT, 0.5)
          gg.addColorStop(0, css(c1, (0.14 + lv * 0.08) * glowK))
          gg.addColorStop(1, css(c1, 0))
        }
        g.fillStyle = gg
        g.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2.3)
      }

      // Liquid fill: one gradient shared by body, necks and droplets so they merge seamlessly.
      liftInto(c1, tone, p.dark ? 0.45 : 0.0, p) // highlight side
      if (!p.dark) mixInto(c1, tone, WHITE, 0.35)
      mixInto(c2, tone, BLACK, p.dark ? 0.38 : 0.28) // shadow side
      // The gradient runs past the body and back to the plain tone, so droplets out there stay lit.
      // The flat and outline finishes ease both sides to the plain tone.
      const lg = g.createRadialGradient(cx - R0 * 0.35, cy - R0 * 0.45, R0 * 0.1, cx, cy, R0 * 2.4)
      lg.addColorStop(0, css(flatK > 0 ? mixInto(c3, c1, tone, flatK) : c1))
      lg.addColorStop(0.31, css(tone))
      lg.addColorStop(0.56, css(flatK > 0 ? mixInto(c4, c2, tone, flatK) : c2))
      lg.addColorStop(0.75, css(tone))
      fill = lg
      lis = mix.listening

      // Droplet physics.
      for (let i = 0; i < MAX_DROPS; i++) {
        const kind = dKind[i]!
        if (kind === 0) continue
        if (!reduced) {
          dAge[i] = dAge[i]! + dt
          const rb = radiusAt(dAng[i]!)
          if (kind > 0) {
            // Thrown out, slowed by the neck, pulled back in.
            const pull = 11 // the neck is a spring
            dVel[i] = dVel[i]! - pull * (dRho[i]! - rb) * dt - 1.8 * dVel[i]! * dt
            dRho[i] = dRho[i]! + dVel[i]! * dt
            if (dAge[i]! > 0.25 && dRho[i]! < rb - dRad[i]! * 0.4) {
              kick(dAng[i]!, -0.8)
              dKind[i] = 0
              continue
            }
          } else {
            // Drawn in, accelerating as surface tension takes hold.
            dVel[i] = dVel[i]! - (1.4 + 3 / Math.max(0.3, dRho[i]! - rb)) * dt
            dVel[i] = Math.max(dVel[i]!, -3.5)
            dRho[i] = dRho[i]! + dVel[i]! * dt
            if (dRho[i]! < rb - dRad[i]! * 0.3) {
              kick(dAng[i]!, -1.0 - dRad[i]! * 6)
              dKind[i] = 0
              continue
            }
          }
          if (dAge[i]! > 6) dKind[i] = 0
        }
      }

      // The merged silhouette. The outline finish first strokes every piece twice as wide as the
      // line, then erases the inside of the union, leaving one clean outline round body and drops.
      if (outlineK > 0.01) {
        g.lineWidth = Math.max(2.5, S / 90)
        g.lineJoin = "round"
        g.globalAlpha = outlineK
        pieces(1, f, lv, tone)
        g.globalCompositeOperation = "destination-out"
        pieces(2, f, lv, tone)
        g.globalCompositeOperation = "source-over"
      }
      pieces(0, f, lv, tone)

      // ---- Thinking: the person's colour marbles through the assistant's.
      const th = mix.thinking
      if (th > 0.02) {
        g.save()
        outlinePath()
        g.clip()
        g.lineCap = "round"
        liftInto(c3, p.you, 0.15, p)
        for (let k = 0; k < 5; k++) {
          g.beginPath()
          for (let s = 0; s <= 24; s++) {
            const u = s / 24
            const ang = swirl * (2.2 - k * 0.25) + (k * TAU) / 5 + u * (2.6 + k * 0.4)
            const rr = R0 * (0.12 + 0.75 * u)
            const x = cx + Math.cos(ang) * rr
            const y = cy + Math.sin(ang) * rr * stretch
            if (s === 0) g.moveTo(x, y)
            else g.lineTo(x, y)
          }
          g.lineWidth = R0 * (0.2 - k * 0.03)
          g.strokeStyle = css(c3, th * (0.3 - k * 0.04))
          g.stroke()
        }
        g.restore()
      }

      // ---- Gloss: a specular highlight and a thin rim of reflected light give it volume.
      if (glossK > 0.01) {
        g.fillStyle = css(WHITE, (p.dark ? 0.32 : 0.55) * glossK)
        g.beginPath()
        g.ellipse(cx - R0 * 0.36, cy - R0 * 0.48 * stretch, R0 * 0.26, R0 * 0.13, -0.55, 0, TAU)
        g.fill()
        g.fillStyle = css(WHITE, (p.dark ? 0.5 : 0.75) * glossK)
        g.beginPath()
        g.ellipse(cx - R0 * 0.08, cy - R0 * 0.66 * stretch, R0 * 0.06, R0 * 0.035, -0.2, 0, TAU)
        g.fill()
        g.save()
        outlinePath()
        g.clip()
        g.lineWidth = R0 * 0.07
        g.strokeStyle = css(liftInto(c3, tone, 0.5, p), (p.dark ? 0.35 : 0.25) * glossK)
        g.beginPath()
        g.arc(cx + R0 * 0.12, cy + R0 * 0.12, R0 * 0.98, 0.15, 1.45)
        g.stroke()
        g.restore()
      }

      // Edge: a crisp outline keeps the shape legible on the pale theme.
      if (!p.dark) {
        outlinePath()
        g.lineWidth = Math.max(1, S / 320)
        g.strokeStyle = css(c2, 0.5 * (1 - outlineK))
        g.stroke()
      }
    },

    dispose() {}
  }
}

const design: Design = {
  id: "liquid-blob",
  name: "Liquid blob",
  family: "abstract",
  summary: "A glossy body of liquid whose outline is pressed in by your voice and swells out with its own; droplets fly in while it listens and bud out while it speaks.",
  inspiredBy:
    "Microsoft's Mico (a soft blob between orb and character), OpenAI's 2023 voice circle that changes shape per phase, and the metaball droplets of 1990s lava lamps and liquid UI.",
  modes: {
    idle: "A small grey drop, round and glossy, barely wobbling.",
    listening: "Mint and a little larger, breathing; three small droplets hover above it, and another drifts in and merges every 1.4 s.",
    hearing: "Mint; your voice presses dents into the outline (low frequencies at the bottom, high at the top) and each syllable flings a droplet in from outside to merge.",
    thinking: "Amber, spinning slowly into two lobes, with mint marbling swirled through it: what you said being digested.",
    speaking: "Amber; the outline swells outward with the reply and loud syllables bud droplets on gooey necks that snap back."
  },
  mappings: [
    { signal: "active.bands (24)", effect: "Outline relief by angle, mirrored: band 0 at the bottom up to band 23 at the top. Pressed in (−15 % at full) while hearing, pushed out (+20 %) while speaking." },
    { signal: "active.level", effect: "Amount of liquid (base radius +7 % of size at full), wobble amplitude, droplet size; quantised to thirds with reduced motion." },
    { signal: "register (60 %) + pitch (40 %)", effect: "Character: 2 big slow lobes for a deep voice up to 9 small ones for a child's (wobble 1.35× down to 0.7×); a deep voice sags the body into a pear, a high one lifts it (±8 %); droplets 1.25× larger for deep, 0.75× for high." },
    { signal: "active.syllableRate", effect: "Speed the lobes roll around the body." },
    { signal: "active.onset (rising edge)", effect: "Speaking with level > 0.22: buds a droplet on a neck that thins as it stretches (size 0.08 + 0.13 × level, launch 0.7 + 1.5 × level) and is pulled back. Hearing: flings a droplet in from outside (size 0.05 + 0.14 × level). At most one per 120 ms." },
    { signal: "active.sibilance", effect: "Fine fast shimmer on the surface (19 ripples round the edge)." },
    { signal: "active.pitchDelta", effect: "Rising pitch stretches the body taller and narrower, falling pitch squats it (±7 %)." },
    { signal: "mode", effect: "Colour (grey, mint, amber), size, dents vs bulges, droplet direction, two-lobed spin with mint marbling in thinking." },
    { signal: "pointer", effect: "Pressing dents the surface under the finger; hovering near makes the edge reach toward it." },
    { signal: "options", effect: "size, wobble, motion speed, voice relief, pitch character, flying droplets, finish (glossy, flat, outline) and glow; numbers glide over about 0.2 s and the finish cross-fades, all snap with reduced motion." },
    { signal: "reducedMotion", effect: "No wobble or flight: the shape is set directly per mode; one still droplet shows the direction (budded out while speaking, waiting outside while taking in)." }
  ],
  serverNeeds: "none",
  renderer: "2d",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.25, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the body of liquid is; above 1 it grows only as far as the canvas allows." },
    { id: "relief", kind: "number", label: "Voice relief", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How deeply your voice dents the outline and how far the reply swells it." },
    { id: "pitch", kind: "number", label: "Pitch character", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much a deep or a high voice changes the shape: fewer or more lobes, sagging or lifting, stretching on a rising tone." },
    { id: "wobble", kind: "number", label: "Wobble", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Motion", help: "How much the surface rolls and breathes on its own; at 0 it is round in silence and moves only with the voice." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.3, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the lobes roll round the body and the thinking swirl turns." },
    { id: "droplets", kind: "toggle", label: "Flying droplets", default: true, group: "Motion", help: "Droplets that fly in on your syllables and bud out of it on loud ones of the reply; the three waiting above it while it listens stay." },
    {
      id: "finish",
      kind: "choice",
      label: "Finish",
      choices: [
        { value: "glossy", label: "Glossy" },
        { value: "flat", label: "Flat" },
        { value: "outline", label: "Outline" }
      ],
      default: "glossy",
      group: "Style",
      help: "Glossy liquid with highlights, a flat shape in one colour, or a clear body drawn as an outline."
    },
    { id: "glow", kind: "number", label: "Glow", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Style", help: "The soft light under the blob on the dark theme, or its shadow on the light one." }
  ],
  create
}

export default design
