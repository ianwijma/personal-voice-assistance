/**
 * Aurora ribbons: translucent lobes of light that bloom and fade along a horizon.
 *
 * A pool of ribbons, each a mirrored lens of light with its own centre, width, ripple and
 * lifetime. Like the multicolour Siri wave, they appear and fade at random so the shape never
 * repeats; unlike it, each ribbon is born from the voice: a syllable onset spawns one, the
 * speaker's register sets its width and ripple, a third of the spectrum sets its height, the
 * intonation tilts it up or down, and voicing decides whether it is filled light or a breathy
 * outline. Ribbons drift toward the centre while the person speaks (taken in) and away from it
 * while the assistant speaks (given out).
 */
import type { Character, CharacterInstance, Frame, Rgb, VoiceFeatures } from "../contract.ts"
import { AttackRelease, approach, clamp, clamp01, clear2d, lerp, optChoice, optNumber, optToggle, rng, setup2d, smoothstep } from "../kit.ts"
import { ChoiceMix, type Col, css, Glide, GlowSprite, hueShift, mixInto, ModeMix, ONSET } from "../shared/light.ts"

const POOL = 16
/** On the stage, how far past the box the ribbons may swell at full level (as in sine-lines). */
const REACH_SHARE = 0.25
const REACH_MIN = 48
const EDGE = 12
const WHITE: Rgb = [255, 255, 255]
/** Hue rotations along the register axis, deep → child: mint goes from sea-blue to spring green, amber from coral to gold. */
const YOU_SHIFT = [34, 17, 0, -16, -32]
const VOICE_SHIFT = [-24, -12, 0, 9, 18]
const STEP = 3 // px between samples
const FORMS = ["mirrored", "rising"] as const
const STYLES = ["soft", "outline"] as const

/** Per-ribbon state, struct-of-arrays so nothing is allocated per frame. */
class Pool {
  readonly alive = new Uint8Array(POOL)
  readonly age = new Float32Array(POOL)
  readonly life = new Float32Array(POOL)
  readonly c = new Float32Array(POOL) // centre, −1..1 across the width
  readonly vc = new Float32Array(POOL) // drift, units per second
  readonly sigma = new Float32Array(POOL)
  readonly k = new Float32Array(POOL)
  readonly phi = new Float32Array(POOL)
  readonly omega = new Float32Array(POOL)
  readonly amp = new Float32Array(POOL)
  readonly group = new Uint8Array(POOL) // 0 low, 1 mid, 2 high third of the spectrum
  readonly hue = new Uint8Array(POOL) // 0..2 colour variant
  readonly side = new Uint8Array(POOL) // 0 person, 1 assistant
  readonly pinch = new Float32Array(POOL)
}

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let CW = 1
  let CH = 1
  let W = 1
  let H = 1
  let dpr = 1
  let n = 2
  let tableW = -1 // the focus width the envelope tables were built for
  let envGather = new Float32Array(2)
  let envWide = new Float32Array(2)
  let env = new Float32Array(2)
  let top = new Float32Array(2)

  const pool = new Pool()
  const rand = rng(7)
  const mix = new ModeMix()

  // Options, eased. `count` is read as is: it only limits new ribbons, old ones fade out on their own.
  const glide = new Glide()
  const formMix = new ChoiceMix(FORMS)
  const styleMix = new ChoiceMix(STYLES)
  let count = POOL
  let size = 1
  let tiltK = 1
  let hazeK = 1
  let hueRange = 1
  let hueShown = -1
  let clock = -1 // ambient time at the "Motion speed"

  // Smoothed voice.
  const lvl = new AttackRelease(0.04, 0.25)
  let reg = 0.45
  let rise = 0
  let lively = 0.3 // how much the pitch moves (|pitchDelta|), smoothed
  let rate = 3
  let voiced = 0.7
  let bright = 0.45
  const band = new Float32Array(3)
  let prevOnset = 0
  let spawnDebt = 0
  let lastSide = 0

  // Colours (recomputed when the palette changes).
  let paletteRef: unknown = null
  const youFam: Col[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  const voiceFam: Col[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  const col: Col = [0, 0, 0]
  const haze = new GlowSprite(96)
  const hazeCol: Col = [0, 0, 0]
  const col2: Col = [0, 0, 0]
  const lineCol: Col = [0, 0, 0]

  const spawn = (side: number, f: Frame): void => {
    let s = -1
    let oldest = -1
    for (let i = 0; i < count; i++) {
      if (!pool.alive[i]) {
        s = i
        break
      }
      const left = pool.life[i]! - pool.age[i]!
      if (oldest < 0 || left < pool.life[oldest]! - pool.age[oldest]!) oldest = i
    }
    if (s < 0) {
      // Pool full. At the full count the oldest is recycled (the original behaviour); with fewer
      // ribbons asked for, the syllable is skipped instead, so no ribbon is cut short.
      if (count < POOL) return
      s = oldest
    }
    const sign = rand() < 0.5 ? -1 : 1
    const fast = clamp01((rate - 1.6) / 4)
    const m = f.coreMode
    pool.alive[s] = 1
    pool.age[s] = 0
    pool.side[s] = side
    pool.hue[s] = Math.floor(rand() * 3)
    pool.group[s] = Math.floor(rand() * 3)
    pool.phi[s] = rand() * 6.283
    pool.amp[s] = (0.45 + 0.55 * rand()) * lerp(0.72, 1.18, reg)
    // Register: deep voices make broad, slow-rippled lobes; high voices narrow, finely rippled ones.
    pool.sigma[s] = lerp(0.5, 0.13, reg) * (0.75 + 0.5 * rand())
    pool.k[s] = lerp(3.5, 11, reg) * lerp(0.75, 1.45, fast) * (0.8 + 0.4 * rand())
    pool.omega[s] = (1.2 + rate * 0.7) * (rand() < 0.5 ? -1 : 1)
    pool.life[s] = lerp(2.4, 0.75, fast) * (0.7 + 0.6 * rand())
    if (m === "speaking") {
      // Given out: born near the centre, travelling outward, plumes pinched apart.
      pool.c[s] = sign * 0.22 * rand()
      pool.vc[s] = sign * (0.28 + 0.3 * rand()) * (0.7 + fast * 0.8)
      pool.pinch[s] = 0.75
    } else if (m === "thinking") {
      // A shuttle: thin ribbons that cross the whole horizon, alternating side and direction.
      pool.c[s] = sign * 0.95
      pool.vc[s] = -sign * (0.9 + 0.3 * rand())
      pool.life[s] = 1.6 + 0.4 * rand()
      pool.sigma[s] = 0.16 + 0.06 * rand()
      pool.k[s] = 6
      pool.pinch[s] = 0.3
    } else {
      // Taken in: born toward the edges, travelling to the centre, smooth lenses.
      const listening = m === "listening"
      pool.c[s] = sign * (listening ? 0.55 + 0.3 * rand() : 0.4 + 0.45 * rand())
      pool.vc[s] = -sign * (listening ? 0.12 + 0.08 * rand() : (0.25 + 0.25 * rand()) * (0.7 + fast * 0.8))
      if (listening) pool.life[s] = 2.6 + rand()
      // Expressive speech (pitch moving a lot) splits the lenses into separate lobes; flat speech stays smooth.
      pool.pinch[s] = 0.08 + 0.55 * lively
    }
  }

  const paletteColours = (f: Frame): void => {
    const p = f.palette
    if (paletteRef === p && hueShown === hueRange) return
    paletteRef = p
    hueShown = hueRange
    // Extra hues stay close to the palette: the person's mint leans to sea-blue and spring green,
    // the assistant's amber to coral and gold. Index 0..2 is the deep → high register axis.
    // "Colour range" scales how far they lean (0: one colour per side).
    for (let i = 0; i < 5; i++) {
      hueShift(p.you, YOU_SHIFT[i]! * hueRange, youFam[i])
      hueShift(p.voice, VOICE_SHIFT[i]! * hueRange, voiceFam[i])
    }
  }

  /** Colour of a ribbon: its side's family, picked along the register axis and its own variant. */
  const ribbonColour = (side: number, hue: number, out: Col): Col => {
    const fam = side === 0 ? youFam : voiceFam
    const x = clamp(reg * 3 + (hue - 1) * 0.7, 0, 3.999)
    const i = Math.floor(x)
    const t = x - i
    const a = fam[i]!
    const b = fam[i + 1]!
    return mixInto(out, a, b, t)
  }

  return {
    resize(width, height, ratio) {
      CW = width
      CH = height
      dpr = ratio
      g = setup2d(canvas, dpr)
      // Sized for the widest focus there can be (the box is at most 720 px wide); used in part.
      const len = Math.floor(Math.max(CW, 760) / STEP) + 2
      envGather = new Float32Array(len)
      envWide = new Float32Array(len)
      env = new Float32Array(len)
      top = new Float32Array(len)
      tableW = -1
    },

    frame(f) {
      const fo = f.focus
      W = fo.width
      H = fo.height
      n = Math.min(env.length, Math.floor(W / STEP) + 2)
      if (tableW !== W) {
        tableW = W
        for (let j = 0; j < n; j++) {
          const u = ((j * STEP) / W) * 2 - 1
          const edge = Math.max(0, 1 - u * u)
          envGather[j] = Math.exp(-(u * u) / (0.62 * 0.62)) * edge
          envWide[j] = Math.pow(edge, 1.3)
        }
      }
      const dt = f.dt
      const reduced = f.reducedMotion
      const p = f.palette
      const o = f.options
      glide.begin(f)
      count = Math.round(optNumber(o, "count"))
      size = glide.to(size, optNumber(o, "size"))
      tiltK = glide.to(tiltK, optNumber(o, "intonation"))
      hazeK = glide.to(hazeK, optToggle(o, "haze") ? 1 : 0)
      hueRange = glide.to(hueRange, optNumber(o, "colourRange"), 0.25)
      const rising = formMix.step(glide, optChoice(o, "form"))[1]!
      const outlined = styleMix.step(glide, optChoice(o, "style"))[1]!
      const speed = optNumber(o, "speed")
      const sdt = dt * speed // ribbon time
      clock = clock < 0 ? f.t : clock + sdt
      paletteColours(f)
      mix.step(f, 0.35)

      // Which voice drives: the person except while the assistant speaks.
      const sp = mix.speaking
      const v: VoiceFeatures = f.coreMode === "speaking" ? f.agent : f.user
      const live = f.coreMode === "hearing" || f.coreMode === "speaking"
      const level = live ? v.level : 0
      const L = lvl.step(reduced ? Math.round(level * 4) / 4 : level, dt)
      // Reduced motion holds the pose: the register (width and ripple of the still lenses) stays where it is.
      if (!reduced) reg = approach(reg, v.register, dt, 0.6)
      if (live && v.speaking) {
        rise = approach(rise, clamp(v.pitchDelta / 7, -1, 1), dt, 0.3)
        lively = approach(lively, clamp01(Math.abs(v.pitchDelta) / 7), dt, 0.8)
        rate = approach(rate, v.syllableRate, dt, 0.6)
        voiced = approach(voiced, v.voicing, dt, 0.3)
        bright = approach(bright, v.brightness, dt, 0.2)
      } else rise = approach(rise, 0, dt, 0.6)
      const b = v.bands
      let lo = 0
      let mi = 0
      let hi = 0
      for (let i = 0; i < 8; i++) {
        lo += b[i]!
        mi += b[i + 8]!
        hi += b[i + 16]!
      }
      band[0] = approach(band[0]!, lo / 8, dt, 0.08)
      band[1] = approach(band[1]!, mi / 8, dt, 0.08)
      band[2] = approach(band[2]!, hi / 8, dt, 0.08)

      // Spawning: every syllable onset blooms a ribbon; a quiet background rate keeps it alive.
      if (!reduced) {
        const onsetHit = live && v.onset > ONSET && prevOnset <= ONSET
        if (onsetHit) {
          spawn(f.coreMode === "speaking" ? 1 : 0, f)
          if (rate > 4.2) spawn(f.coreMode === "speaking" ? 1 : 0, f)
        }
        const bg =
          f.coreMode === "listening" ? 1.1 : f.coreMode === "thinking" ? 2.2 : live ? (v.speaking ? 1.6 + 4 * L : 0.4) : 0
        spawnDebt += bg * dt
        while (spawnDebt >= 1) {
          spawnDebt -= 1
          const side = f.coreMode === "speaking" ? 1 : f.coreMode === "thinking" ? (lastSide = 1 - lastSide) : 0
          spawn(side, f)
        }
      } else {
        // Reduced motion: a fixed, still arrangement per mode (gathered for the person, spread for
        // the assistant), so the state reads from colour and shape alone.
        const side = f.coreMode === "speaking" ? 1 : 0
        for (let i = 0; i < POOL; i++) {
          const on = f.coreMode !== "idle" && i < Math.min(6, count)
          pool.alive[i] = on ? 1 : 0
          if (!on) continue
          const s = (i % 2 === 0 ? 1 : -1) * (Math.floor(i / 2) + 0.5)
          pool.side[i] = f.coreMode === "thinking" ? i % 2 : side
          pool.c[i] = s * (f.coreMode === "speaking" ? 0.22 : f.coreMode === "thinking" ? 0.26 : 0.09)
          pool.vc[i] = 0
          pool.age[i] = 1
          pool.life[i] = 2
          pool.sigma[i] = lerp(0.36, 0.16, reg)
          pool.k[i] = lerp(3.5, 11, reg)
          pool.phi[i] = i * 1.7
          pool.omega[i] = 0
          pool.amp[i] = 1 - Math.floor(i / 2) * 0.22
          pool.group[i] = i % 3
          pool.hue[i] = i % 3
          pool.pinch[i] = f.coreMode === "speaking" ? 0.75 : 0.12
        }
      }
      prevOnset = live ? v.onset : 0

      // Pointer: hovering swells the ribbons under it, pressing blooms one there.
      const px = f.pointer.x - fo.x
      const py = f.pointer.y - fo.y
      const over = f.pointer.inside && px >= 0 && px < W && py >= 0 && py < H
      const pu = over ? (px / W) * 2 - 1 : 9
      if (f.pointer.down && over && !reduced && rand() < dt * 6) {
        spawn(f.coreMode === "speaking" || f.coreMode === "thinking" ? 1 : 0, f)
      }

      // How much each side's ribbons are driven now (fades with the mode, so ribbons of the
      // previous turn sink back into the line instead of vanishing).
      const loud = 0.06 + 0.94 * Math.pow(Math.min(1, L * 1.6), 0.8)
      const driveYou = mix.listening * 0.1 + mix.hearing * loud + mix.thinking * 0.32
      const driveVoice = mix.speaking * loud + mix.thinking * 0.32
      // On the stage the ribbons may swell past the box's top and bottom at full level (level²), where the
      // page leaves room; zero when the box is the whole canvas.
      const reachUp = Math.max(0, Math.min(fo.y - EDGE, Math.max(REACH_SHARE * H, REACH_MIN)))
      const reachDn = Math.max(0, Math.min(CH - fo.y - H - EDGE, Math.max(REACH_SHARE * H, REACH_MIN)))
      const boost = 1 + (L * L * Math.min(reachUp, reachDn)) / (0.5 * H)
      const A = H * 0.48 * size * boost
      const gather = clamp01(mix.hearing + mix.listening + 0.5 * mix.thinking)
      for (let j = 0; j < n; j++) env[j] = lerp(envWide[j]!, envGather[j]!, gather / (gather + sp + 1e-3))
      // "Rising": the horizon sits low and the ribbons only grow upward, with the room that frees.
      const upS = (1 + 0.75 * rise * tiltK) * (1 + 1.0 * rising)
      const dnS = Math.max(0.1, 1 - 0.75 * rise * tiltK) * (1 - rising)
      const y0 = lerp(H / 2, H * 0.86, rising)
      // Ribbons never leave the room they have, whatever the size and tilt.
      const upMax = y0 - 3 + reachUp
      const dnMax = H - y0 - 3 + reachDn

      clear2d(g, dpr, fo)
      g.lineJoin = "round"

      // Haze: a soft glow behind the ribbons, tall and narrow while taking in, low and wide while
      // giving out. Its colour is the turn's colour.
      mixInto(hazeCol, p.you, p.voice, clamp01(sp + 0.5 * mix.thinking))
      haze.paint(hazeCol, 0, 1.6)
      const hazeA = (p.dark ? 0.22 : 0.14) * (mix.listening * 0.35 + (mix.hearing + sp) * (0.25 + 0.75 * loud) + mix.thinking * 0.3) * hazeK
      if (hazeA > 0.004) {
        const hw = W * lerp(0.32, 0.55, clamp01(sp + mix.thinking))
        const hh = H * lerp(0.08, 0.55, clamp01((mix.hearing + sp) * loud + mix.listening * 0.1)) * Math.min(1, size)
        g.globalAlpha = hazeA
        g.drawImage(haze.canvas, W / 2 - hw, y0 - hh * (1 + 0.3 * rise * tiltK + 0.5 * rising), hw * 2, hh * 2)
        g.globalAlpha = 1
      }

      // Ribbons.
      g.globalCompositeOperation = p.dark ? "lighter" : "source-over"
      for (let i = 0; i < POOL; i++) {
        if (!pool.alive[i]) continue
        if (!reduced) {
          pool.age[i] = pool.age[i]! + sdt
          pool.c[i] = pool.c[i]! + pool.vc[i]! * sdt
          pool.phi[i] = pool.phi[i]! + pool.omega[i]! * sdt
          if (pool.age[i]! >= pool.life[i]! || Math.abs(pool.c[i]!) > 1.15) {
            pool.alive[i] = 0
            continue
          }
        }
        const t = pool.age[i]! / pool.life[i]!
        const life = reduced ? 1 : smoothstep(0, 0.25, t) * (1 - smoothstep(0.55, 1, t))
        const side = pool.side[i]!
        const drive = side === 0 ? driveYou : driveVoice
        const bandGain = 0.6 + 0.8 * band[pool.group[i]!]!
        const amp = A * pool.amp[i]! * life * drive * (f.coreMode === "thinking" ? 1 : bandGain)
        if (amp < 0.4) continue
        const c = pool.c[i]!
        const sig = pool.sigma[i]!
        const k = pool.k[i]!
        const phi = pool.phi[i]!
        const pinch = pool.pinch[i]!
        // Hover swell.
        const near = Math.exp(-((pu - c) * (pu - c)) / 0.05)
        const ampH = amp * (1 + 0.35 * near)
        const u0 = Math.max(-1, c - 2.4 * sig)
        const u1 = Math.min(1, c + 2.4 * sig)
        const j0 = Math.max(0, Math.floor(((u0 + 1) / 2) * W / STEP))
        const j1 = Math.min(n - 1, Math.ceil(((u1 + 1) / 2) * W / STEP))
        if (j1 - j0 < 2) continue
        for (let j = j0; j <= j1; j++) {
          const u = ((j * STEP) / W) * 2 - 1
          const d = (u - c) / sig
          const cs = Math.cos(k * (u - c) + phi)
          const shape = Math.exp(-d * d) * ((1 - pinch) * (0.62 + 0.38 * cs) + pinch * Math.abs(cs))
          top[j] = ampH * shape * env[j]!
        }
        ribbonColour(side, pool.hue[i]!, col)
        // Light theme: a paler wash that deepens where ribbons overlap (multiply), like watercolour.
        if (!p.dark) mixInto(col, col, p.bg, 0.2)
        // Outer lens: filled when voiced, a thin outline when breathy (whisper, "s", "f").
        // The "Outline" style swaps the fills for thin lines of light.
        const fillA = (p.dark ? 0.2 : 0.26) * (0.12 + 0.88 * voiced) * (1 - outlined)
        for (let pass = 0; pass < 2; pass++) {
          const sc = pass === 0 ? 1 : 0.5
          g.beginPath()
          g.moveTo(j0 * STEP, y0)
          for (let j = j0; j <= j1; j++) g.lineTo(j * STEP, y0 - Math.min(upMax, top[j]! * sc * upS))
          for (let j = j1; j >= j0; j--) g.lineTo(j * STEP, y0 + Math.min(dnMax, top[j]! * sc * dnS))
          g.closePath()
          if (pass === 0) {
            if (fillA > 0.002) {
              g.fillStyle = css(col, fillA)
              g.fill()
            }
            const outline = 1 - voiced
            const lineA = Math.max(outline > 0.15 ? 0.25 + 0.55 * outline : 0, outlined * (0.5 + 0.3 * bright))
            if (lineA > 0.01) {
              g.lineWidth = 1 + 0.25 * outlined
              g.strokeStyle = css(col, lineA)
              g.stroke()
            }
          } else {
            // Bright core: brighter, whiter and fuller for bright vowels ("ee") than dark ones ("oo").
            if (p.dark) mixInto(col2, col, WHITE, 0.25 * bright)
            else ribbonColour(side, pool.hue[i]!, col2)
            if (fillA > 0.002) {
              g.fillStyle = css(col2, fillA * (0.35 + 0.6 * bright))
              g.fill()
            }
            if (outlined > 0.01) {
              g.lineWidth = 1
              g.strokeStyle = css(col2, outlined * (0.25 + 0.3 * bright))
              g.stroke()
            }
          }
        }
      }
      g.globalCompositeOperation = "source-over"

      // The horizon line: always there, so the ribbons have something to grow out of.
      const wIdle = mix.idle
      mixInto(lineCol, p.inkFaint, p.you, clamp01(mix.listening + mix.hearing + mix.thinking * 0.5))
      mixInto(lineCol, lineCol, p.voice, clamp01(sp + mix.thinking * 0.5))
      const breathe = reduced ? 1 : 0.8 + 0.2 * Math.sin(clock * 1.6)
      const lineA = wIdle * 0.8 + mix.listening * breathe + mix.hearing * 0.85 + mix.thinking * 0.7 + sp * 0.85
      const grad = g.createLinearGradient(0, 0, W, 0)
      // Listening and hearing gather light in the middle; speaking spreads it to the ends.
      const mid = 0.5
      const spread = lerp(0.18, 0.42, clamp01(sp + mix.idle))
      grad.addColorStop(0, css(lineCol, 0))
      grad.addColorStop(clamp01(mid - spread - 0.08), css(lineCol, lineA * 0.25))
      grad.addColorStop(mid, css(lineCol, lineA))
      grad.addColorStop(clamp01(mid + spread + 0.08), css(lineCol, lineA * 0.25))
      grad.addColorStop(1, css(lineCol, 0))
      g.strokeStyle = grad
      g.lineWidth = 1 + 0.6 * mix.listening + 0.4 * (mix.hearing + sp) * L
      g.beginPath()
      g.moveTo(0, y0)
      g.lineTo(W, y0)
      g.stroke()

      // Listening: two faint motes slide in along the line toward the middle, over and over: waiting to take in.
      if (mix.listening > 0.02 && !reduced) {
        g.fillStyle = css(lineCol, mix.listening * 0.8)
        for (let s = 0; s < 2; s++) {
          const ph = (clock * 0.45 + s * 0.5) % 1
          const x = ph * W * 0.42
          const a = Math.sin(ph * Math.PI)
          const r = 1.2 + 1.3 * a
          g.globalAlpha = a
          g.beginPath()
          g.arc(x, y0, r, 0, 6.2832)
          g.arc(W - x, y0, r, 0, 6.2832)
          g.fill()
        }
        g.globalAlpha = 1
      }
      // Thinking: a bright spot runs back and forth along the line with the shuttling ribbons.
      if (mix.thinking > 0.02 && !reduced) {
        const ph = 0.5 - 0.5 * Math.cos(clock * 2.4)
        const x = W * (0.12 + 0.76 * ph)
        haze.paint(hazeCol, 0, 1.6)
        const r = Math.max(8, H * 0.09)
        if (p.dark) haze.draw(g, x, y0, r, mix.thinking * 0.8 * (0.3 + 0.7 * hazeK))
        g.fillStyle = css(p.dark ? WHITE : lineCol, mix.thinking * 0.9)
        g.beginPath()
        g.arc(x, y0, p.dark ? 1.8 : 2.4, 0, 6.2832)
        g.fill()
      }
      if (reduced && mix.listening > 0.02) {
        g.fillStyle = css(lineCol, mix.listening * 0.9)
        g.beginPath()
        g.arc(W / 2, y0, 3, 0, 6.2832)
        g.fill()
      }
    },

    dispose() {}
  }
}

const character: Character = {
  id: "aurora-ribbons",
  name: "Aurora ribbons",
  version: "1.1.0",
  contract: 1,
  family: "abstract",
  renderer: "2d",
  canvas: "stage",
  summary: "Translucent lenses of light bloom and fade along a horizon; each one is born from a syllable and shaped by the voice that made it.",
  inspiredBy:
    "Siri's multicolour wave (iOS 9–13): random spawn and fade of curves under one amplitude, overlaps that glow. Taken further with per-syllable spawning, register, spectrum thirds and intonation, and Meta AI's inward-for-listening, outward-for-responding rule.",
  modes: {
    idle: "A faint grey horizon line, wide and still.",
    listening: "The line turns mint and gathers light in the middle; small motes slide in from both ends and low lenses drift inward.",
    hearing: "Mint and sea-blue lenses bloom on each syllable at the edges and drift to the centre, gathered into a tall bundle.",
    thinking: "Thin mint and amber ribbons shuttle across the whole horizon in alternating directions, low and quick.",
    speaking: "Amber, coral and gold plumes bloom at the centre and travel outward across the full width; lobes are pinched apart."
  },
  mappings: [
    { signal: "active.onset", effect: "Each syllable onset (rising past 0.3) spawns a ribbon; above 4.2 syllables/s it spawns two." },
    { signal: "active.level", effect: "Ribbon height, up to 48 % of the height (40 ms rise, 250 ms fall); background spawns while voiced (1.6 + 4·level per second); haze height." },
    { signal: "active.register", effect: "Ribbon width (deep: broad, σ 0.5; child: narrow, σ 0.13), height (×0.72 → ×1.18), ripple count (3.5 → 11 rad across) and hue (mint leans sea-blue for deep, spring-green for high; amber leans coral / gold)." },
    { signal: "active.bands (thirds)", effect: "Each ribbon is tied to the low, mid or high third of the spectrum; that third's energy scales its height 0.6–1.4×." },
    { signal: "active.pitchDelta", effect: "Intonation tilt: rising pitch lifts the lenses above the line (top up to ×1.75, bottom down to ×0.25), falling sinks them. Smoothed 300 ms." },
    { signal: "active.syllableRate", effect: "Ribbon lifetime (2.4 s slow → 0.75 s fast), ripple count (0.75 → 1.45×), drift and ripple speed: fast speech is many short-lived, finely rippled ribbons." },
    { signal: "|active.pitchDelta| (800 ms)", effect: "Liveliness: while you speak, expressive intonation pinches each lens into separate lobes (pinch 0.08 → 0.63); flat speech gives smooth lenses." },
    { signal: "active.voicing", effect: "Filled light when voiced; breathy speech (a whisper) leaves faint fills with bright outlines." },
    { signal: "active.brightness", effect: "Core of each ribbon: whiter (dark theme) or inkier (light theme) and denser for bright vowels." },
    { signal: "mode", effect: "Colour family (grey / mint / amber), drift direction (inward vs outward), spatial gather (centre bundle vs full width), lobe shape (smooth lenses vs pinched plumes); 350 ms crossfade." },
    { signal: "pointer", effect: "Hover swells ribbons under the pointer by up to 35 %; holding the button blooms new ribbons." },
    { signal: "options", effect: "Size, ribbon count, rising vs mirrored form, intonation tilt, motion speed, haze, soft vs outline style and colour range change every mode; they glide over about 0.2 s (snap under reduced motion). Ribbons keep the box's width and may swell past its top and bottom at full level, where the page has room." },
    { signal: "reducedMotion", effect: "No spawning, drift or ripple: six still lenses (fewer if the ribbon count is lower), gathered (person) or spread (assistant), height in quarter steps." }
  ],
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.4, max: 1.4, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How tall the ribbons grow." },
    { id: "count", kind: "number", label: "Ribbons", min: 3, max: 16, step: 1, default: 16, group: "Shape", help: "How many ribbons can be on screen at once; fewer is calmer and less busy." },
    {
      id: "form",
      kind: "choice",
      label: "Form",
      choices: [
        { value: "mirrored", label: "Mirrored" },
        { value: "rising", label: "Rising" }
      ],
      default: "mirrored",
      group: "Shape",
      help: "Lenses mirrored around a centre line, or light rising from a low horizon like an aurora."
    },
    { id: "intonation", kind: "number", label: "Follow intonation", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much a rising or falling voice tilts the ribbons up or down." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.3, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast ribbons drift, ripple and fade; lower is calmer." },
    { id: "haze", kind: "toggle", label: "Haze", default: true, group: "Motion", help: "The soft glow behind the ribbons." },
    {
      id: "style",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "soft", label: "Soft light" },
        { value: "outline", label: "Outline" }
      ],
      default: "soft",
      group: "Style",
      help: "Translucent filled lenses, or thin lines of light."
    },
    { id: "colourRange", kind: "number", label: "Colour range", min: 0, max: 3, step: 0.1, default: 1, unit: "×", group: "Style", help: "How far the ribbons stray from your colour and the assistant's: none is one colour per side, more is more varied." }
  ],
  create
}

export default character
