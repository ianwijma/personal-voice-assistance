/**
 * Particle sphere: a sphere of points in 3D projection that breathes and turns. The voice
 * displaces its surface (low frequencies near the bottom, high near the top); while it takes
 * sound in, the side facing you ripples and loose particles stream into it; while it speaks,
 * the whole surface swells and particles stream out of it. Thinking pulls the points into
 * spinning latitude rings. A press sends a ripple across the surface from the finger.
 */
import type { Character, CharacterInstance, Frame } from "../contract.ts"
import { AttackRelease, TAU, approach, clamp, clamp01, clear2d, lerp, optChoice, optNumber, rng, setup2d } from "../kit.ts"
import { type Col, ModeMix, OptionGlide, bandShape, col, css, hash01, liftInto, modeTone, sinkInto, voiceOf } from "../shared/matter.ts"

/** The most points the "Points" option can ask for (2 × the 1100 a large stage gets by default). */
const MAX_POINTS = 2200
const MAX_STREAKS = 320
const STYLES = ["dots", "dashes", "spines"]
const MAX_RIPPLES = 4
const BUCKETS = 5

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  let n = 400
  let nBase = 400 // points for this canvas size at "Points" 1×
  let nShown = 400 // fractional point count the lattice is laid out for (glides with the option)

  // Unit positions (Fibonacci sphere) and per-point constants.
  const cosA = new Float32Array(MAX_POINTS)
  const sinA = new Float32Array(MAX_POINTS)
  const lonA = new Float32Array(MAX_POINTS)
  const ux = new Float32Array(MAX_POINTS)
  const uy = new Float32Array(MAX_POINTS) // up is +1
  const uz = new Float32Array(MAX_POINTS)
  const lon = new Float32Array(MAX_POINTS)
  const seed = new Float32Array(MAX_POINTS)
  // Projected, per frame.
  const sx = new Float32Array(MAX_POINTS)
  const sy = new Float32Array(MAX_POINTS)
  const sr = new Float32Array(MAX_POINTS)
  const sb = new Uint8Array(MAX_POINTS) // depth bucket
  // Line ends for the "dashes" (along the spin) and "spines" (outward) point styles, screen px.
  const dtx = new Float32Array(MAX_POINTS)
  const dty = new Float32Array(MAX_POINTS)
  const spx = new Float32Array(MAX_POINTS)
  const spy = new Float32Array(MAX_POINTS)

  // Streaks: free particles moving radially in world space.
  const kx = new Float32Array(MAX_STREAKS)
  const ky = new Float32Array(MAX_STREAKS)
  const kz = new Float32Array(MAX_STREAKS)
  const kRho = new Float32Array(MAX_STREAKS)
  const kSpd = new Float32Array(MAX_STREAKS)
  const kDir = new Int8Array(MAX_STREAKS) // +1 out, −1 in, 0 dead
  const kTw = new Float32Array(MAX_STREAKS) // spiral twist (incoming only)
  const kR = new Float32Array(MAX_STREAKS)
  const kG = new Float32Array(MAX_STREAKS)
  const kB = new Float32Array(MAX_STREAKS)
  let nextStreak = 0

  // Ripples from the pointer (world space).
  const qx = new Float32Array(MAX_RIPPLES)
  const qy = new Float32Array(MAX_RIPPLES)
  const qz = new Float32Array(MAX_RIPPLES)
  const qAge = new Float32Array(MAX_RIPPLES).fill(99)
  let nextRipple = 0

  const mix = new ModeMix(0.4)
  const tone: Col = col()
  const front: Col = col()
  const back: Col = col()
  const tmp: Col = col()
  const level = new AttackRelease(0.03, 0.22)
  const kickEnv = new AttackRelease(0.02, 0.18)
  const bandS = new Float32Array(24)
  let yaw = 0
  let ringSpin = 0
  let phase = 0
  let spawnAcc = 0
  let lastOnset = 0
  let pressWas = false
  let tilt = 0.38
  let grainS = 0.5
  const rand = rng(17)

  // Options, eased toward the viewer's settings.
  const glide = new OptionGlide()
  let sizeK = 1
  let pointsK = 1
  let reliefK = 1
  let pitchK = 1
  let streamK = 1
  let speedK = 1
  let glowK = 1
  const styleW = new Float32Array([1, 0, 0]) // dots, dashes, spines
  let clock = -1 // ambient-motion time, runs at the "Motion speed"

  // The golden-angle spiral: point i keeps its longitude whatever the count, so a fractional,
  // gliding count only slides the points along their meridians and new ones grow from the pole.
  {
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < MAX_POINTS; i++) {
      const a = i * golden
      cosA[i] = Math.cos(a)
      sinA[i] = Math.sin(a)
      lonA[i] = Math.atan2(sinA[i]!, cosA[i]!)
      seed[i] = hash01(i * 7 + 3)
    }
  }
  const build = (count: number) => {
    nShown = count
    n = Math.min(MAX_POINTS, Math.floor(count))
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / count
      const rr = Math.sqrt(1 - y * y)
      ux[i] = cosA[i]! * rr
      uy[i] = y
      uz[i] = sinA[i]! * rr
      lon[i] = lonA[i]!
    }
  }
  build(n)

  const spawnStreak = (dir: 1 | -1, spd: number, twist: number, c: Col) => {
    const i = nextStreak
    nextStreak = (nextStreak + 1) % MAX_STREAKS
    // Uniform direction.
    const y = rand() * 2 - 1
    const a = rand() * TAU
    const rr = Math.sqrt(1 - y * y)
    kx[i] = Math.cos(a) * rr
    ky[i] = y
    kz[i] = Math.sin(a) * rr
    kRho[i] = dir > 0 ? 1.02 : 1.6 + rand() * 0.4
    kTw[i] = twist
    kSpd[i] = spd * (0.7 + rand() * 0.6)
    kDir[i] = dir
    kR[i] = c[0]
    kG[i] = c[1]
    kB[i] = c[2]
  }

  return {
    resize(width, height, ratio) {
      dpr = ratio
      g = setup2d(canvas, dpr)
      // The layout comes from the focus each frame; force the point count to be recomputed.
      W = 0
      H = 0
    },

    frame(f: Frame) {
      const p = f.palette
      const dt = f.dt
      const reduced = f.reducedMotion
      mix.step(f)
      modeTone(tone, mix, p)
      const fo = f.focus
      clear2d(g, dpr, fo) // (0, 0) is the box's top-left corner; glow and streaks may go beyond it
      if (fo.width !== W || fo.height !== H) {
        W = fo.width
        H = fo.height
        const R0 = Math.min(W * 0.3, H * 0.36)
        nBase = Math.round(clamp(R0 * R0 * 0.045, 300, 1100))
        build(Math.min(MAX_POINTS, nBase * pointsK))
      }

      // Options.
      const o = f.options
      glide.begin(f)
      sizeK = glide.to(sizeK, optNumber(o, "size"))
      reliefK = glide.to(reliefK, optNumber(o, "relief"))
      pitchK = glide.to(pitchK, optNumber(o, "pitch"))
      streamK = glide.to(streamK, optNumber(o, "streams"))
      speedK = glide.to(speedK, optNumber(o, "speed"))
      glowK = glide.to(glowK, optNumber(o, "glow"))
      glide.weights(styleW, STYLES.indexOf(optChoice(o, "points")))
      const pkGoal = optNumber(o, "density")
      pointsK = glide.to(pointsK, pkGoal, 0.3)
      if (Math.abs(pointsK - pkGoal) < 0.002) pointsK = pkGoal
      const count = Math.min(MAX_POINTS, nBase * pointsK)
      if (count !== nShown) build(count)
      if (clock < 0) clock = f.t
      if (!reduced) clock += dt * speedK

      const cx = W / 2
      const cy = H / 2
      const v = f.mode === "speaking" ? f.agent : f.user
      const on = f.mode === "hearing" || f.mode === "speaking"
      let lv = level.step(on ? v.level : 0, dt)
      if (reduced) lv = Math.round(clamp01(lv * 1.6) * 3) / 3 / 1.6
      const pitch = voiceOf(f, mix, "pitch")
      const reg = voiceOf(f, mix, "register")
      const voiceHi = clamp01(0.5 + (clamp01(reg * 0.6 + pitch * 0.4) - 0.5) * pitchK)
      for (let b = 0; b < 24; b++) bandS[b] = approach(bandS[b]!, on ? bandShape(v, b) : 0, dt, 0.07)
      if (on && v.onset > 0.6 && lastOnset <= 0.6) kickEnv.value = Math.max(kickEnv.value, 0.4 + v.level)
      const kick = reduced ? 0 : kickEnv.step(0, dt)

      // Size and motion per mode.
      const Rbase = Math.min(W * 0.3, H * 0.36) * sizeK
      const breathe = reduced ? 0 : Math.sin(clock * 1.3) * mix.blend(0.012, 0.03, 0.0, 0.02, 0.0)
      const R = Rbase * (mix.blend(0.72, 0.9, 0.92, 0.8, 0.95) + breathe + lv * 0.1 + kick * 0.05)
      if (!reduced) {
        yaw += dt * (mix.blend(0.12, 0.22, 0.3, 0.5, 0.35) + (on ? 0.06 * clamp(v.syllableRate, 0, 7) : 0)) * speedK
        ringSpin += dt * 1.4 * mix.thinking * speedK
        phase += dt * (1.2 + 0.4 * clamp(v.syllableRate, 0, 7)) * speedK
      }
      const pd = on ? clamp((v.pitchDelta / 10) * pitchK, -1.5, 1.5) : 0
      tilt = approach(tilt, 0.38 - pd * 0.25, dt, 0.3)
      const cyaw = Math.cos(yaw)
      const syaw = Math.sin(yaw)
      const ct = Math.cos(tilt)
      const st = Math.sin(tilt)
      const D = 3.4 // camera distance in radii
      const lumps = Math.round(lerp(2, 9, voiceHi))
      const dispAmp = (lv * 0.32 + kick * 0.06) * reliefK
      const lumpAmp = lerp(1.0, 0.35, voiceHi)
      grainS = approach(grainS, voiceHi, dt, 0.4)
      const keep = lerp(0.42, 1, grainS)
      // A smaller sphere or fewer points shrink the points less than in proportion, so they stay visible.
      const grain = lerp(1.75, 0.8, grainS) * Math.pow(sizeK, -0.5) * Math.pow(pointsK, -0.35)
      const faceW = mix.hearing + mix.listening * 0.5 // patent idea: ripple mostly the side facing the voice
      const outW = mix.speaking
      const th = mix.thinking
      const sib = on ? clamp01((v.sibilance - 0.35) * 1.5) : 0
      const wDash = styleW[1]!
      const wSpine = styleW[2]!

      // Ripples age.
      for (let q = 0; q < MAX_RIPPLES; q++) qAge[q] = qAge[q]! + (reduced ? 99 : dt)
      const pt = f.pointer
      const pnx = (pt.x - fo.x - cx) / R
      const pny = (pt.y - fo.y - cy) / R
      const pIn = pt.inside && pnx * pnx + pny * pny < 1
      if (pt.down && !pressWas && pIn && !reduced) {
        const q = nextRipple
        nextRipple = (nextRipple + 1) % MAX_RIPPLES
        qx[q] = pnx
        qy[q] = pny
        qz[q] = Math.sqrt(Math.max(0, 1 - pnx * pnx - pny * pny))
        qAge[q] = 0
      }
      pressWas = pt.down

      // ---- Points.
      for (let i = 0; i < n; i++) {
        // Grain: a deep voice shows the sphere as fewer, heavier points; a high voice as fine dust.
        if (seed[i]! > keep) {
          sb[i] = 255
          continue
        }
        let x = ux[i]!
        let y = uy[i]!
        let z = uz[i]!
        // Thinking: latitudes gather into seven rings; alternate rings turn opposite ways.
        if (th > 0.001) {
          const ringY = Math.round(y * 3) / 3
          const ny = lerp(y, ringY * 0.92, th)
          const rr = Math.sqrt(Math.max(0, 1 - ny * ny))
          const ringIndex = Math.round(y * 3)
          const spin = ringSpin * (ringIndex % 2 === 0 ? 1 : -1.3) * th
          const a = lon[i]! + spin
          x = Math.cos(a) * rr
          z = Math.sin(a) * rr
          y = ny
        }
        // Surface displacement (radius factor).
        const lat01 = (y + 1) * 0.5 // 0 bottom .. 1 top
        const bi = lat01 * 23
        const b0 = Math.floor(bi)
        const band = bandS[b0]! * (1 - (bi - b0)) + bandS[Math.min(23, b0 + 1)]! * (bi - b0)
        // World z after rotation (for facing weight), computed cheaply ahead.
        const xr = x * cyaw - z * syaw
        const zr = x * syaw + z * cyaw
        const yr = y * ct - zr * st
        const zw = y * st + zr * ct
        const facing = clamp01(zw * 0.8 + 0.4)
        let d = 1
        d += dispAmp * band * (outW + faceW * facing * 1.3)
        // Lumps: a deep voice heaves the sphere in two or three big lobes, a child's voice in many small bumps.
        d += dispAmp * lumpAmp * Math.sin(lumps * lon[i]! + phase) * Math.cos(lumps * 0.8 * y + phase * 0.5) * (outW + faceW * facing)
        d += sib * 0.05 * (seed[i]! - 0.5)
        d += 0.015 * Math.sin(clock * 0.9 + seed[i]! * TAU) * (reduced ? 0 : 1)
        // Pointer ripples: rings that run across the surface from the press.
        for (let q = 0; q < MAX_RIPPLES; q++) {
          const age = qAge[q]!
          if (age > 2.2) continue
          const dot = xr * qx[q]! - yr * qy[q]! + zw * qz[q]!
          const ang = Math.acos(clamp(dot, -1, 1))
          const front = ang - age * 2.6
          if (front > 0.6 || front < -1.6) continue
          d += 0.24 * Math.sin(front * 9) * Math.exp(-front * front * 5) * (1 - age / 2.2)
        }
        // Hover: points under the pointer lift toward it.
        if (pIn && !pt.down) {
          const dxp = xr - pnx
          const dyp = yr + pny
          const near = Math.exp(-(dxp * dxp + dyp * dyp) * 18) * clamp01(zw + 0.2)
          d += 0.07 * near
        }
        const X = xr * d
        const Y = yr * d
        const Z = zw * d
        const persp = D / (D - Z)
        sx[i] = cx + X * R * persp
        sy[i] = cy - Y * R * persp
        const depth = clamp01((Z + 1) * 0.5) // 0 back .. 1 front
        sb[i] = Math.min(BUCKETS - 1, Math.floor(depth * BUCKETS))
        const big = 1 + (seed[i]! > 0.93 ? 0.8 * clamp01(v.brightness * 1.4) * (on ? 1 : 0) : 0)
        sr[i] = (R / 110) * persp * (0.55 + 0.75 * depth) * (0.85 + lv * 0.9) * big * grain * (1 + 0.45 * th)
        if (wDash > 0.01) {
          // Along the spin: the tangent of the point's latitude circle, turned like the point.
          const tx = -z
          const tz = x
          const txr = tx * cyaw - tz * syaw
          const tzr = tx * syaw + tz * cyaw
          const k = R * persp * 0.05 * (0.85 + lv * 0.9) * grain * d
          dtx[i] = txr * k
          dty[i] = tzr * st * k
        }
        if (wSpine > 0.01) {
          // Outward from the centre; longer where the voice pushes the surface out.
          const k = R * persp * (0.05 * grain + 0.55 * Math.max(0, d - 1))
          spx[i] = X * k
          spy[i] = -Y * k
        }
      }

      // A soft body of light behind the points so the sphere reads as one object at any size.
      const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.25)
      sinkInto(tmp, tone, p.dark ? 0.75 : 0.82, p)
      glow.addColorStop(0, css(tmp, mix.blend(0.25, 0.5, 0.6, 0.45, 0.6) * (p.dark ? 0.8 : 1) * glowK))
      glow.addColorStop(1, css(tmp, 0))
      if (glowK > 0.01) {
        g.fillStyle = glow
        g.fillRect(cx - R * 1.3, cy - R * 1.3, R * 2.6, R * 2.6)
      }

      // Draw back to front, one path per depth bucket and point style (styles cross-fade when changed).
      liftInto(front, tone, 0.35, p)
      sinkInto(back, tone, p.dark ? 0.6 : 0.45, p)
      const wDot = styleW[0]!
      g.lineCap = "round"
      for (let b = 0; b < BUCKETS; b++) {
        const k = b / (BUCKETS - 1)
        tmp[0] = back[0] + (front[0] - back[0]) * k
        tmp[1] = back[1] + (front[1] - back[1]) * k
        tmp[2] = back[2] + (front[2] - back[2]) * k
        const a = lerp(0.35, 1, k)
        if (wDot > 0.01) {
          g.fillStyle = css(tmp, a * wDot)
          g.beginPath()
          for (let i = 0; i < n; i++) {
            if (sb[i] !== b) continue
            const rr = sr[i]!
            if (rr < 1.1) g.rect(sx[i]! - rr, sy[i]! - rr, rr * 2, rr * 2)
            else {
              g.moveTo(sx[i]! + rr, sy[i]!)
              g.arc(sx[i]!, sy[i]!, rr, 0, TAU)
            }
          }
          g.fill()
        }
        if (wDash > 0.01 || wSpine > 0.01) {
          // Lines are as thick as a point of this depth is wide.
          g.lineWidth = Math.max(0.9, (R / 110) * (0.55 + 0.75 * (b + 0.5) / BUCKETS) * (0.85 + lv * 0.9) * grain * (1 + 0.45 * th) * (wSpine > wDash ? 1 : 1.3))
          for (let s = 1; s <= 2; s++) {
            const w = s === 1 ? wDash : wSpine
            if (w <= 0.01) continue
            const ex = s === 1 ? dtx : spx
            const ey = s === 1 ? dty : spy
            g.strokeStyle = css(tmp, a * w)
            g.beginPath()
            for (let i = 0; i < n; i++) {
              if (sb[i] !== b) continue
              if (s === 1) g.moveTo(sx[i]! - ex[i]!, sy[i]! - ey[i]!)
              else g.moveTo(sx[i]!, sy[i]!)
              g.lineTo(sx[i]! + ex[i]!, sy[i]! + ey[i]!)
            }
            g.stroke()
          }
        }
      }

      // ---- Streaks: in while taking in, out while speaking.
      const dir: 1 | -1 = f.mode === "speaking" ? 1 : -1
      if (!reduced) {
        // Mostly syllable-driven, so fast speech fills the air and slow speech leaves it sparse.
        const rate = f.mode === "hearing" ? 4 + 40 * lv : f.mode === "speaking" ? 6 + 60 * lv : f.mode === "listening" ? 7 : 0
        spawnAcc += rate * dt * streamK
        if (on && v.onset > 0.6 && lastOnset <= 0.6) spawnAcc += (2 + v.level * 40) * streamK
        const rateK = 0.75 + 0.07 * clamp(v.syllableRate, 0, 7)
        const spd = (dir > 0 ? 0.9 + lv * 1.6 : f.mode === "listening" ? 0.45 : 0.7 + lv * 1.1) * rateK
        while (spawnAcc >= 1) {
          spawnAcc -= 1
          spawnStreak(dir, spd, lerp(0.6, 2.8, voiceHi), tone)
        }
      }
      lastOnset = v.onset
      g.lineCap = "round"
      const lw = Math.max(1, R / 110)
      for (let i = 0; i < MAX_STREAKS; i++) {
        const d = kDir[i]!
        if (d === 0) continue
        if (!reduced) {
          kRho[i] = kRho[i]! + d * kSpd[i]! * dt
          if ((d > 0 && kRho[i]! > 2.5) || (d < 0 && kRho[i]! < 1.03)) {
            kDir[i] = 0
            continue
          }
        }
        const rho = kRho[i]!
        // Fade near the far end; the head is where the particle is going.
        const life = d > 0 ? 1 - clamp01((rho - 1.1) / 1.4) : clamp01((2.05 - rho) / 0.4)
        // Incoming particles spiral in like water to a drain (the twist grows with distance);
        // outgoing ones fly straight out as rays. The two read apart even in a still frame.
        const len = d > 0 ? 0.1 + kSpd[i]! * 0.12 : 0.35
        const twist = d > 0 ? 0 : kTw[i]!
        tmp[0] = kR[i]!
        tmp[1] = kG[i]!
        tmp[2] = kB[i]!
        const behind = kz[i]! < 0 && kx[i]! * kx[i]! + ky[i]! * ky[i]! < 1 / (rho * rho) ? 0.3 : 1
        g.strokeStyle = css(tmp, life * (d > 0 ? 0.6 : 0.32) * behind)
        g.lineWidth = d > 0 ? lw * (0.8 + lv) : lw
        g.beginPath()
        let hx = 0
        let hy = 0
        const steps = d > 0 ? 1 : 5
        for (let s = 0; s <= steps; s++) {
          const rr = rho - d * len * (s / steps)
          const persp = D / (D - kz[i]! * rr)
          const bx = kx[i]! * rr * R * persp
          const by = -ky[i]! * rr * R * persp
          const phi = twist * (rr - 1)
          const c = Math.cos(phi)
          const sn = Math.sin(phi)
          const x = cx + bx * c - by * sn
          const y = cy + bx * sn + by * c
          if (s === 0) {
            hx = x
            hy = y
            g.moveTo(x, y)
          } else g.lineTo(x, y)
        }
        g.stroke()
        liftInto(tmp, tmp, 0.3, p)
        g.fillStyle = css(tmp, life * behind)
        g.beginPath()
        g.arc(hx, hy, lw * (d > 0 ? 1.2 + lv : 1.1), 0, TAU)
        g.fill()
      }

      // Reduced motion: a still fan of streaks shows the direction (heads toward the sphere while taking in).
      if (reduced && streamK > 0.01 && (f.mode === "hearing" || f.mode === "speaking" || f.mode === "listening")) {
        const count = Math.max(3, Math.round((f.mode === "listening" ? 8 : 10 + Math.round(lv * 20)) * Math.min(1.5, streamK)))
        g.strokeStyle = css(tone, 0.5)
        g.fillStyle = css(liftInto(tmp, tone, 0.3, p), 0.9)
        g.lineWidth = lw
        for (let j = 0; j < count; j++) {
          const a = (j / count) * TAU + 0.3
          const r0 = dir > 0 ? 1.15 : 1.25
          const r1 = r0 + 0.3
          const hr = dir > 0 ? r1 : r0
          // Incoming streaks curve like the live spiral; outgoing ones are straight rays.
          const tw = dir > 0 ? 0 : 1.5
          g.beginPath()
          for (let s = 0; s <= 4; s++) {
            const rr = r0 + (r1 - r0) * (s / 4)
            const aa = a + tw * (rr - 1)
            if (s === 0) g.moveTo(cx + Math.cos(aa) * rr * R, cy + Math.sin(aa) * rr * R)
            else g.lineTo(cx + Math.cos(aa) * rr * R, cy + Math.sin(aa) * rr * R)
          }
          g.stroke()
          const ha = a + tw * (hr - 1)
          g.beginPath()
          g.arc(cx + Math.cos(ha) * hr * R, cy + Math.sin(ha) * hr * R, lw * 1.4, 0, TAU)
          g.fill()
        }
      }
    },

    dispose() {}
  }
}

const character: Character = {
  id: "particle-sphere",
  name: "Particle sphere",
  family: "abstract",
  version: "1.1.0",
  contract: 1,
  summary: "A turning sphere of points: the voice displaces its surface; particles stream into it while it listens and out of it while it speaks.",
  inspiredBy:
    "Perplexity's dot sphere that ripples under a finger, Spotify's patent that ripples only the side facing the voice, and Meta AI's ring that moves inward when listening and outward when responding.",
  modes: {
    idle: "A small grey sphere of fine points, turning slowly.",
    listening: "Mint, larger and breathing; a few particles drift in on a slow spiral.",
    hearing: "Mint; your voice ripples the side facing you and particles spiral into the sphere like water into a drain, more and faster when louder.",
    thinking: "Amber; the points gather into seven latitude rings that spin in alternating directions.",
    speaking: "Amber; the reply swells the whole surface and particles fly straight out of it as rays, more, faster and thicker when louder."
  },
  mappings: [
    { signal: "active.bands (24)", effect: "Surface displacement by latitude: band 0 at the bottom pole up to band 23 at the top; in hearing weighted toward the side facing you." },
    { signal: "active.level", effect: "Displacement amplitude (up to +32 % radius), sphere size (+10 %), dot size, continuous stream rate (4 + 40 × level per second in, 6 + 60 × level out), stream speed and ray thickness." },
    { signal: "register (60 %) + pitch (40 %)", effect: "Grain and shape: a deep voice shows 42 % of the points at 1.75× size, heaving in 2 big lumps, with incoming particles on a loose spiral; a child's voice shows every point at 0.8× size, 9 small lumps, a tight spiral (twist 0.6 to 2.8 rad)." },
    { signal: "active.syllableRate", effect: "Rotation speed, how fast the lumps travel, and stream speed (×0.75 + 0.07 × rate)." },
    { signal: "active.onset (rising edge)", effect: "A quick swell of the whole sphere (+5 %) and a burst of 2 + 40 × level extra particles, so fast speech fills the air and slow speech leaves it sparse." },
    { signal: "active.brightness", effect: "One point in fifteen grows (up to 1.8×) on bright sounds, a sparkle." },
    { signal: "active.sibilance", effect: "Grain: each point jitters its radius a little on 's' sounds." },
    { signal: "active.pitchDelta", effect: "Tilts the axis: the sphere nods up on rising intonation and down on falling." },
    { signal: "mode", effect: "Colour (grey, mint, amber), size, stream direction and form (spiralling in vs straight rays out), latitude rings in thinking." },
    { signal: "pointer", effect: "A press sends a ripple across the surface from the finger; hovering lifts the points under it." },
    { signal: "options", effect: "size, number of points (glides: points slide along their meridians and grow from the pole), point style (dots, dashes, spines; cross-fades), voice relief, pitch character, stream amount, motion speed and glow; numbers glide over about 0.2 s, all snap with reduced motion." },
    { signal: "reducedMotion", effect: "No rotation, streaming or ripples: a still sphere per mode with a fixed fan of streaks (heads toward the sphere while taking in, away while speaking)." }
  ],
  renderer: "2d",
  canvas: "stage",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.4, max: 1, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the sphere is; at 1 it fills the height with room for the voice to swell it." },
    { id: "density", kind: "number", label: "Points", min: 0.3, max: 2, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How many points make up the sphere: fewer reads as a loose cloud, more as a fine dusty surface." },
    { id: "relief", kind: "number", label: "Voice relief", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How far the voice pushes the surface in and out." },
    { id: "pitch", kind: "number", label: "Pitch character", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much a deep or a high voice changes the sphere: big lumps and heavy points, or fine bumps and dust, and the nod on a rising tone." },
    { id: "streams", kind: "number", label: "Streams", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Motion", help: "How many loose particles spiral in while it listens and fly out while it speaks; 0 turns them off." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.3, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the sphere turns, the lumps travel and the thinking rings spin." },
    {
      id: "points",
      kind: "choice",
      label: "Point style",
      choices: [
        { value: "dots", label: "Dots" },
        { value: "dashes", label: "Dashes" },
        { value: "spines", label: "Spines" }
      ],
      default: "dots",
      group: "Style",
      help: "Round dots, short dashes that follow the spin, or spines that stand out from the surface and lengthen as the voice swells it."
    },
    { id: "glow", kind: "number", label: "Glow", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Style", help: "The soft body of light behind the points." }
  ],
  create
}

export default character
