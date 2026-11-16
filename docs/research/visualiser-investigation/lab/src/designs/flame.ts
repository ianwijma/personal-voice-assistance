/**
 * Flame: a single flame on a wick. Idle it is a small, almost still pilot light. Listening, it
 * stands tall and narrow in the person's colour, holding its breath, and draws air in at its
 * base. Hearing, it flickers with the voice: small and trembling for a whisper, flaring for a
 * shout, slow broad billows for a deep voice and quick fine flicker for a high one, with motes
 * of air streaming in. Thinking, it sinks into a glowing ember with sparks drifting up. Speaking,
 * it is a steady dancing amber fire that throws sparks and licks of flame out of its tip.
 */
import type { Design, DesignInstance, Frame, Rgb } from "../contract.ts"
import { AttackRelease, TAU, approach, clamp, clamp01, clear2d, lerp, noise2, optChoice, optColor, optNumber, optToggle, rng, setup2d } from "../kit.ts"
import { BLACK, type Col, ModeMix, OptionGlide, WHITE, col, css, liftInto, mixInto, modeTone, sinkInto, voiceOf } from "./_matter.ts"

const M = 56 // outline samples per layer
const MAX_MOTES = 90
const MAX_LICKS = 6
/** Extra hue, used only as a small tint of the outer tongue toward red while the assistant burns, so it stays in the amber family. */
const EMBER_DARK: Rgb = [200, 70, 40]
const EMBER_LIGHT: Rgb = [150, 40, 20]
/** The "Flame tint" default, EMBER_DARK as hex; while it is chosen the light theme keeps its own deeper EMBER_LIGHT. */
const TINT_DEFAULT = "#c84628"
const STYLES = ["candle", "torch", "lantern"]
/** Per style: height, width, flicker, sway, extra tongues, tongue depth, glow, sparks, glass globe. */
const ST_H = [1, 1, 0.8]
const ST_W = [1, 1.45, 0.85]
const ST_FLICK = [1, 1.45, 0.35]
const ST_SWAY = [1, 1.3, 0.3]
const ST_TONGUES = [0, 1.5, -0.8]
const ST_TONGUE_K = [1, 1.15, 0.3]
const ST_GLOW = [1, 1.5, 1.25]
const ST_SPARKS = [1, 1.8, 0.3]
const ST_GLOBE = [0, 0, 1]

/**
 * Above `knee`, eases `x` toward `knee + room` instead of letting it grow. The knees sit above
 * what the default settings ever reach, so only stacked options (torch, flicker, width) are held
 * back from tearing the outline apart.
 */
const soft = (x: number, knee: number, room: number): number => (x <= knee ? x : knee + room * Math.tanh((x - knee) / room))

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1

  // Teardrop template: x = sin t · sin(t/2)^1.3, y = cos t (y up, tip at t = 0).
  const tx = new Float32Array(M)
  const ty = new Float32Array(M)
  for (let i = 0; i < M; i++) {
    const t = (i / M) * TAU
    tx[i] = Math.sin(t) * Math.pow(Math.abs(Math.sin(t / 2)), 1.3)
    ty[i] = Math.cos(t)
  }

  // Motes: air drawn in (−1), sparks thrown out (+1), embers drifting up (+2).
  const mx = new Float32Array(MAX_MOTES)
  const my = new Float32Array(MAX_MOTES)
  const mvx = new Float32Array(MAX_MOTES)
  const mvy = new Float32Array(MAX_MOTES)
  const mLife = new Float32Array(MAX_MOTES)
  const mMax = new Float32Array(MAX_MOTES)
  const mKind = new Int8Array(MAX_MOTES)
  const mR = new Float32Array(MAX_MOTES)
  const mG = new Float32Array(MAX_MOTES)
  const mB = new Float32Array(MAX_MOTES)
  let nextMote = 0

  // Licks: small tongues that tear off the tip and rise.
  const lx = new Float32Array(MAX_LICKS)
  const ly = new Float32Array(MAX_LICKS)
  const lAge = new Float32Array(MAX_LICKS).fill(9)
  const lSize = new Float32Array(MAX_LICKS)
  let nextLick = 0

  const mix = new ModeMix(0.45)
  const tone: Col = col()
  const cOut: Col = col()
  const cMid: Col = col()
  const cCore: Col = col()
  const tmp: Col = col()
  const level = new AttackRelease(0.035, 0.22)
  const flare = new AttackRelease(0.02, 0.25)
  let heightS = 0.3
  let widthS = 0.3
  let swayPh = 0
  let flickPh = 0
  let lean = 0
  let lastOnset = 0
  let moteAcc = 0
  let emberAcc = 0
  const rand = rng(29)

  // Options, eased toward the viewer's settings.
  const glide = new OptionGlide()
  let sizeK = 1
  let widthK = 1
  let flareK = 1
  let flickerK = 1
  const styleW = new Float32Array([1, 0, 0]) // candle, torch, lantern
  let tongueK = 1 // depth of the tongues along the edge (style)
  const tint: Col = col()

  const spawnMote = (kind: number, x: number, y: number, vx: number, vy: number, life: number, c: Col) => {
    const i = nextMote
    nextMote = (nextMote + 1) % MAX_MOTES
    mKind[i] = kind
    mx[i] = x
    my[i] = y
    mvx[i] = vx
    mvy[i] = vy
    mLife[i] = life
    mMax[i] = life
    mR[i] = c[0]
    mG[i] = c[1]
    mB[i] = c[2]
  }

  /** Build one flame layer's path. Units: px. `bx, by` is the base; heights grow upward. */
  const layer = (bx: number, by: number, hf: number, wf: number, swayA: number, flick: number, tongues: number, t: number, leanK: number) => {
    g.beginPath()
    for (let i = 0; i < M; i++) {
      const h01 = (ty[i]! + 1) * 0.5 // 0 base .. 1 tip
      const side = tx[i]! >= 0 ? 1 : -1
      let x = tx[i]! * wf
      // The flame bends more the higher you go: slow sway plus turbulent noise.
      const bend = Math.pow(h01, 1.7)
      x += hf * bend * (swayA * Math.sin(swayPh + h01 * 2.2) + swayA * 0.6 * noise2(h01 * 2 - t * 1.3, t * 0.7)) + hf * bend * leanK
      // Tongues: ripples along the edge that run upward, strongest near the top.
      x += side * wf * 0.22 * tongueK * flick * h01 * h01 * (1 - h01 * 0.6) * Math.sin(h01 * tongues * Math.PI - flickPh)
      // Each edge has its own turbulence, so the two sides never mirror.
      x += side * wf * 0.16 * flick * h01 * noise2(h01 * 3 - t * 2.6, side * 4.3 + t * 0.3)
      const y = by - h01 * hf * (1 + flick * 0.06 * Math.sin(flickPh * 1.7 + side))
      if (i === 0) g.moveTo(bx + x, y)
      else g.lineTo(bx + x, y)
    }
    g.closePath()
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
      widthK = glide.to(widthK, optNumber(o, "width"))
      flareK = glide.to(flareK, optNumber(o, "flare"))
      flickerK = glide.to(flickerK, optNumber(o, "flicker"))
      glide.weights(styleW, STYLES.indexOf(optChoice(o, "style")))
      const sw = styleW
      const blendS = (t: ReadonlyArray<number>) => t[0]! * sw[0]! + t[1]! * sw[1]! + t[2]! * sw[2]!
      const stH = blendS(ST_H)
      const stFlick = blendS(ST_FLICK) * flickerK
      const stSway = blendS(ST_SWAY) * flickerK
      const stGlow = blendS(ST_GLOW)
      const stSparks = blendS(ST_SPARKS)
      const globe = blendS(ST_GLOBE)
      tongueK = blendS(ST_TONGUE_K)
      const sparksOn = optToggle(o, "sparks")
      const airOn = optToggle(o, "air")
      // Flame tint: the default keeps the theme's own pair; any other colour is deepened a little on the light theme.
      const tintRaw = optColor(f, "tint")
      if (o["tint"] === TINT_DEFAULT) mixInto(tint, p.dark ? EMBER_DARK : EMBER_LIGHT, BLACK, 0)
      else mixInto(tint, tintRaw, BLACK, p.dark ? 0 : 0.28)

      const S = Math.min(H, W * 0.75) * sizeK // the size the flame is drawn against
      const cx = W / 2
      const baseY = H * 0.5 + S * 0.36
      const v = f.mode === "speaking" ? f.agent : f.user
      const on = f.mode === "hearing" || f.mode === "speaking"
      let lv = level.step(on ? v.level : 0, dt)
      if (reduced) lv = Math.round(clamp01(lv * 1.6) * 3) / 3 / 1.6
      if (on && v.onset > 0.55 && lastOnset <= 0.55 && !reduced) flare.value = Math.max(flare.value, (0.25 + v.level * 0.9) * flareK)
      const fl = reduced ? 0 : flare.step(0, dt)
      const pitch = voiceOf(f, mix, "pitch")
      const reg = voiceOf(f, mix, "register")
      const voiceHi = clamp01(reg * 0.6 + pitch * 0.4)
      const t = reduced ? 0 : f.t

      // Size: per-mode resting size, plus loudness and syllable flares.
      const hRest = mix.blend(0.16, 0.5, 0.34, 0.17, 0.32)
      const hVoice = (mix.hearing + mix.speaking) * (lv * 0.95 + fl * 0.22)
      const hTarget = (hRest + hVoice) * (1 + clamp(on ? v.pitchDelta / 12 : 0, -1, 1) * 0.08) * stH
      // Soft ceiling above 0.6 so a shout fills the frame without leaving it (never above 0.85; 0.62 inside the lantern's glass).
      const cap0 = 0.6 - 0.15 * globe
      const capR = 0.25 - 0.08 * globe
      const hCapped = hTarget < cap0 ? hTarget : cap0 + capR * Math.tanh((hTarget - cap0) / capR)
      heightS = reduced ? hCapped : approach(heightS, hCapped, dt, 0.06)
      // Width: narrow while listening (holding its breath), wider for a deep voice, round and low as an ember.
      const wRest = mix.blend(0.075, 0.07, 0.1, 0.14, 0.11)
      const wTarget = wRest * (1 + (mix.hearing + mix.speaking) * ((0.5 - voiceHi) * 0.9 + lv * 0.5 + fl * 0.2)) * soft(widthK * blendS(ST_W), 1.6, 0.6)
      widthS = reduced ? wTarget : approach(widthS, wTarget, dt, 0.08)
      const wf = widthS * S

      // Motion: a deep voice billows slowly, a high one flickers fast; the syllable rate quickens both.
      const rate = on ? clamp(v.syllableRate, 0, 7) : 0
      if (!reduced) {
        swayPh += dt * (mix.blend(0.6, 0.5, 1.6, 1.0, 2.2) + rate * 0.2) * lerp(0.7, 1.4, voiceHi)
        flickPh += dt * (mix.blend(2, 2.5, 7, 3, 9) + rate * 1.2 + lv * 6) * lerp(0.6, 1.6, voiceHi)
      }
      const swayA = reduced ? 0 : soft((mix.blend(0.02, 0.012, 0.05, 0.05, 0.06) + lv * 0.08 + fl * 0.05) * stSway, 0.2, 0.1)
      const flick = soft((reduced ? 0.25 * (mix.hearing + mix.speaking) : mix.blend(0.15, 0.1, 0.6, 0.35, 0.75) + lv * 0.9) * stFlick, 1.7, 0.5)
      const tongues = Math.max(1.4, lerp(2.2, 5.5, voiceHi) + blendS(ST_TONGUES))
      // Never past the top of the canvas, tongues included.
      const hf = Math.min(heightS * S, (baseY - H * 0.02) / (1 + flick * 0.06))

      // Pointer: hovering draws the flame toward it; a press blows it away from the finger.
      const pt = f.pointer
      let leanT = 0
      if (pt.inside) {
        const dx = clamp((pt.x - cx) / (S * 0.6), -1, 1)
        const side = dx >= 0 ? 1 : -1
        // Blowing is strongest close to the flame; hovering draws it gently toward the pointer.
        leanT = pt.down ? -side * 0.45 * clamp01(1.3 - Math.abs(dx)) : dx * 0.15
      }
      lean = reduced ? 0 : approach(lean, leanT, dt, pt.down ? 0.08 : 0.3)

      // Colours: outer tongue (deepest), body, and a hot core whose whiteness follows the brightness of the sound.
      // A higher voice burns hotter (a bigger, whiter core); a deep one deeper and more coloured.
      const hot = clamp01(0.35 + (on ? v.brightness * 0.5 + (voiceHi - 0.5) * 0.5 : 0) + fl * 0.3)
      if (p.dark) {
        mixInto(cOut, tone, tint, 0.18 * mix.giving)
        liftInto(cMid, tone, 0.35, p)
        mixInto(cCore, tone, WHITE, 0.6 + hot * 0.35)
      } else {
        mixInto(cOut, tone, tint, 0.15 * mix.giving)
        liftInto(cOut, cOut, 0.12, p)
        mixInto(cMid, tone, WHITE, 0.25)
        mixInto(cCore, tone, WHITE, 0.65 + hot * 0.3)
      }

      // ---- Glow (dark) or warm haze (light) behind the flame.
      const gy = baseY - hf * 0.45
      const gr = Math.max(hf, wf * 3) * 1.25
      const glow = g.createRadialGradient(cx, gy, 0, cx, gy, gr)
      glow.addColorStop(0, css(tone, (p.dark ? 0.16 : 0.14) * (0.45 + lv + fl * 0.5) * stGlow))
      glow.addColorStop(1, css(tone, 0))
      g.fillStyle = glow
      g.fillRect(cx - gr, gy - gr, gr * 2, gr * 2)

      // ---- Wick and its shadow: grounds the flame at every size.
      const wickH = S * 0.05
      g.strokeStyle = css(sinkInto(tmp, p.ink, 0.35, p), 0.8)
      g.lineWidth = Math.max(1.2, S / 160)
      g.lineCap = "round"
      g.beginPath()
      g.moveTo(cx, baseY + wickH)
      g.quadraticCurveTo(cx, baseY + wickH * 0.4, cx + S * 0.006, baseY - S * 0.004)
      g.stroke()
      g.fillStyle = css(sinkInto(tmp, p.ink, 0.6, p), 0.35)
      g.beginPath()
      g.ellipse(cx, baseY + wickH + S * 0.012, S * 0.09, S * 0.012, 0, 0, TAU)
      g.fill()

      // ---- Ember bed (thinking): a glowing coal at the wick that pulses slowly.
      const th = mix.thinking
      if (th > 0.02) {
        const pulse = reduced ? 0.7 : 0.6 + 0.4 * Math.sin(f.t * 2.2)
        const er = S * 0.05 * (0.8 + 0.2 * pulse)
        const eg = g.createRadialGradient(cx, baseY, 0, cx, baseY, er * 2.4)
        eg.addColorStop(0, css(cCore, th * pulse))
        eg.addColorStop(0.4, css(tone, th * 0.7 * pulse))
        eg.addColorStop(1, css(tone, 0))
        g.fillStyle = eg
        g.fillRect(cx - er * 2.4, baseY - er * 2.4, er * 4.8, er * 4.8)
      }

      // ---- The flame: three nested layers.
      const by = baseY + S * 0.01
      g.fillStyle = css(cOut, p.dark ? 0.85 : 0.9)
      layer(cx, by, hf, wf, swayA, flick, tongues, t, lean)
      g.fill()
      g.fillStyle = css(cMid, 0.92)
      layer(cx, by - hf * 0.02, hf * 0.78, wf * 0.7, swayA * 0.85, flick * 0.7, tongues, t + 0.4, lean * 0.8)
      g.fill()
      g.fillStyle = css(cCore, 0.95)
      layer(cx, by - hf * 0.04, hf * (0.38 + hot * 0.14), wf * (0.36 + hot * 0.1), swayA * 0.5, flick * 0.3, tongues, t + 0.9, lean * 0.5)
      g.fill()

      // ---- Licks: on loud syllables while speaking, a small tongue tears off the tip and rises.
      if (!reduced && sparksOn && f.mode === "speaking" && v.onset > 0.55 && lastOnset <= 0.55 && v.level > 0.3) {
        const k = nextLick
        nextLick = (nextLick + 1) % MAX_LICKS
        lx[k] = cx + (rand() - 0.5) * wf * 0.8
        ly[k] = baseY - hf * 0.85
        lAge[k] = 0
        lSize[k] = 0.25 + v.level * 0.35
      }
      g.fillStyle = css(cMid, 0.8)
      for (let k = 0; k < MAX_LICKS; k++) {
        if (lAge[k]! > 0.45) continue
        lAge[k] = lAge[k]! + dt
        const a = lAge[k]! / 0.45
        ly[k] = ly[k]! - S * 0.35 * dt
        const s = lSize[k]! * (1 - a)
        g.globalAlpha = 1 - a
        layer(lx[k]!, ly[k]!, hf * s, wf * s * 0.6, 0.02, 0.2, 2, t + k, lean)
        g.fill()
      }
      g.globalAlpha = 1

      // ---- Motes.
      if (!reduced) {
        // Air drawn in at the base while it takes sound in (more with loudness).
        const intake = !airOn ? 0 : f.mode === "listening" ? 5 : f.mode === "hearing" ? 6 + lv * 70 : 0
        moteAcc += intake * dt
        while (moteAcc >= 1) {
          moteAcc -= 1
          const side = rand() < 0.5 ? -1 : 1
          const x0 = cx + side * S * (0.25 + rand() * 0.2)
          const y0 = baseY - S * (0.02 + rand() * 0.22)
          const life = 0.9 + rand() * 0.5
          spawnMote(-1, x0, y0, (cx - x0) / life, (baseY - S * 0.03 - y0) / life, life, tone)
        }
        // Sparks out of the tip while speaking (onsets and loudness), embers drifting up while thinking.
        let sparks = f.mode === "speaking" ? lv * 30 : 0
        if (on && v.onset > 0.55 && lastOnset <= 0.55 && f.mode === "speaking") sparks += 30 * v.level * 4
        if (on && v.sibilance > 0.5) sparks += 25 * (v.sibilance - 0.5) * 2
        emberAcc += sparksOn ? (sparks * stSparks + th * 5) * dt : 0
        while (emberAcc >= 1) {
          emberAcc -= 1
          if (th > 0.5) spawnMote(2, cx + (rand() - 0.5) * S * 0.06, baseY - S * 0.02, (rand() - 0.5) * S * 0.08, -S * (0.12 + rand() * 0.12), 1.6 + rand(), tone)
          else spawnMote(1, cx + (rand() - 0.5) * wf * 0.6, baseY - hf * (0.7 + rand() * 0.2), (rand() - 0.5) * S * 0.6, -S * (0.4 + rand() * 0.5 + lv * 0.6), 0.5 + rand() * 0.4, tone)
        }
      }
      lastOnset = v.onset
      for (let i = 0; i < MAX_MOTES; i++) {
        if (mKind[i] === 0) continue
        if (!reduced) {
          mLife[i] = mLife[i]! - dt
          if (mLife[i]! <= 0) {
            mKind[i] = 0
            continue
          }
          const k = mKind[i]!
          if (k === 2) mvx[i] = mvx[i]! + Math.sin(f.t * 3 + i) * S * 0.2 * dt
          if (k === 1) mvy[i] = mvy[i]! + S * 0.5 * dt // sparks arc
          mx[i] = mx[i]! + mvx[i]! * dt
          my[i] = my[i]! + mvy[i]! * dt
        }
        const life01 = mLife[i]! / mMax[i]!
        const k = mKind[i]!
        tmp[0] = mR[i]!
        tmp[1] = mG[i]!
        tmp[2] = mB[i]!
        const a = k < 0 ? Math.sin(life01 * Math.PI) * 0.7 : life01
        if (k < 0) {
          // Air: a short dash pointing at the base.
          const len = S * 0.025
          const sp = Math.hypot(mvx[i]!, mvy[i]!) || 1
          g.strokeStyle = css(tmp, a)
          g.lineWidth = Math.max(1, S / 260)
          g.beginPath()
          g.moveTo(mx[i]! - (mvx[i]! / sp) * len, my[i]! - (mvy[i]! / sp) * len)
          g.lineTo(mx[i]!, my[i]!)
          g.stroke()
        } else {
          mixInto(tmp, tmp, WHITE, p.dark ? 0.5 * life01 : 0)
          g.fillStyle = css(tmp, a)
          g.beginPath()
          g.arc(mx[i]!, my[i]!, Math.max(0.8, S / 240) * (k === 2 ? 1.3 : 1), 0, TAU)
          g.fill()
        }
      }

      // Reduced motion: still marks for the direction (air dashes pointing in, or sparks above the tip).
      if (reduced) {
        if ((f.mode === "listening" || f.mode === "hearing") && airOn) {
          g.strokeStyle = css(tone, 0.6)
          g.lineWidth = Math.max(1, S / 260)
          for (let k = 0; k < 4; k++) {
            const side = k < 2 ? -1 : 1
            const y0 = baseY - S * (0.04 + (k % 2) * 0.1)
            const x0 = cx + side * S * 0.24
            g.beginPath()
            g.moveTo(x0, y0)
            g.lineTo(x0 - side * S * 0.06, y0 + S * 0.01)
            g.stroke()
          }
        } else if ((f.mode === "speaking" || f.mode === "thinking") && sparksOn) {
          g.fillStyle = css(tone, 0.8)
          for (let k = 0; k < 5; k++) {
            g.beginPath()
            g.arc(cx + (k - 2) * S * 0.04, baseY - hf - S * (0.04 + (k % 2) * 0.05), Math.max(1, S / 220), 0, TAU)
            g.fill()
          }
        }
      }

      // ---- Lantern: a glass globe round the flame, open at the top, with a faint reflection.
      if (globe > 0.01) {
        const gcy = baseY - S * 0.3
        const rx = S * 0.24 * lerp(1, Math.max(1, widthK), 0.7)
        const ry = S * 0.38
        g.lineWidth = Math.max(1, S / 200)
        g.strokeStyle = css(sinkInto(tmp, p.ink, 0.45, p), 0.45 * globe)
        g.beginPath()
        g.ellipse(cx, gcy, rx, ry, 0, -Math.PI / 2 + 0.42, (Math.PI * 3) / 2 - 0.42)
        g.stroke()
        // The collar the glass stands in.
        g.beginPath()
        g.moveTo(cx - rx * 0.55, gcy + ry * 0.92)
        g.lineTo(cx + rx * 0.55, gcy + ry * 0.92)
        g.stroke()
        g.strokeStyle = css(p.dark ? WHITE : p.ink, (p.dark ? 0.12 : 0.1) * globe)
        g.lineWidth = Math.max(1.5, S / 90)
        g.lineCap = "round"
        g.beginPath()
        g.ellipse(cx, gcy, rx * 0.78, ry * 0.8, 0, Math.PI * 1.08, Math.PI * 1.32)
        g.stroke()
      }
    },

    dispose() {}
  }
}

const design: Design = {
  id: "flame",
  name: "Flame",
  family: "abstract",
  summary: "A single flame on a wick: a still pilot light when idle, tall and drawing air in while listening, flickering with your voice, an ember while thinking, a dancing fire throwing sparks while it speaks.",
  inspiredBy:
    "Candle flames and the boric-acid green flame of school chemistry; the Humane Ai Pin's single trust light and HAL 9000's single eye as proof that one glowing thing can carry a whole state machine.",
  modes: {
    idle: "A small grey-blue pilot flame on the wick, almost still.",
    listening: "A tall, narrow mint flame holding still; motes of air drift in toward its base.",
    hearing: "The mint flame flickers with your voice: small and trembling for a whisper, flaring for a shout; air streams in faster when you are louder.",
    thinking: "It sinks into a low amber ember that pulses slowly at the wick, with sparks drifting up.",
    speaking: "A steady, dancing amber fire; sparks and torn-off licks of flame fly out of the tip on loud syllables."
  },
  mappings: [
    { signal: "active.level", effect: "Flame height (+95 % of size × level, softly capped at 85 %) and width; intake rate while hearing (6 + 70 × level motes/s), spark rate while speaking (30 × level/s)." },
    { signal: "active.onset (rising edge)", effect: "A flare: height and width jump and decay over 250 ms; while speaking also a spark burst and, above level 0.3, a lick of flame that tears off the tip." },
    { signal: "register (60 %) + pitch (40 %)", effect: "Character: a deep voice billows slowly and burns wider with 2 broad tongues; a high voice flickers fast and narrow, burns hotter (bigger white core), with up to 5.5 fine tongues." },
    { signal: "active.syllableRate", effect: "Speed of sway and flicker." },
    { signal: "active.brightness", effect: "Size and whiteness of the hot core (bright vowels burn hotter)." },
    { signal: "active.sibilance", effect: "Crackle: extra sparks thrown off on 's' sounds." },
    { signal: "active.pitchDelta", effect: "Rising intonation stretches the flame up to 8 % taller, falling shortens it." },
    { signal: "mode", effect: "Colour (grey-blue pilot, mint, amber), resting size and width, air drawn in at the base (taking in) vs sparks thrown out of the tip (speaking), ember and drifting sparks in thinking." },
    { signal: "pointer", effect: "Hovering draws the flame toward the pointer; pressing blows it away from the finger." },
    { signal: "options", effect: "size, width, syllable flare, flicker, sparks (and licks and embers), air drawn in, style (candle; torch: wider, wilder, more sparks; lantern: steady, smooth, inside a glass globe) and the tint the outer flame leans toward while the assistant burns; values glide (the style blends), all snap with reduced motion." },
    { signal: "reducedMotion", effect: "No flicker, sway or flying motes: a still flame per mode with fixed air dashes pointing in (taking in) or fixed sparks above the tip (thinking, speaking)." }
  ],
  serverNeeds: "none",
  renderer: "2d",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the flame and its wick are; at 1 a shout reaches the top of the canvas." },
    { id: "width", kind: "number", label: "Flame width", min: 0.6, max: 1.8, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How broad the flame burns, from a slim candle to a wide fire." },
    { id: "flare", kind: "number", label: "Syllable flare", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much each syllable makes the flame jump up and widen." },
    { id: "flicker", kind: "number", label: "Flicker", min: 0.2, max: 2, step: 0.1, default: 1, unit: "×", group: "Motion", help: "How much the flame sways and its edges flicker; low is calm, high is a draughty fire." },
    { id: "sparks", kind: "toggle", label: "Sparks", default: true, group: "Motion", help: "Sparks and torn-off licks of flame while it speaks, and embers drifting up while it thinks." },
    { id: "air", kind: "toggle", label: "Air drawn in", default: true, group: "Motion", help: "The motes of air that stream in at the base while it listens to you." },
    {
      id: "style",
      kind: "choice",
      label: "Style",
      choices: [
        { value: "candle", label: "Candle" },
        { value: "torch", label: "Torch" },
        { value: "lantern", label: "Lantern" }
      ],
      default: "candle",
      group: "Style",
      help: "A candle flame; a wider, wilder torch that throws more sparks; or a steady, smooth lantern flame inside a glass globe."
    },
    { id: "tint", kind: "color", label: "Flame tint", default: TINT_DEFAULT, group: "Style", help: "The hue the outer flame leans toward while the assistant thinks and speaks." }
  ],
  create
}

export default design
