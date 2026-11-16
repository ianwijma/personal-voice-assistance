/**
 * Ripple pond: a round basin of still water seen from above. Every syllable drops a ripple.
 * While the assistant takes sound in, the basin wall is excited and the rings converge on the
 * centre, where what was said gathers as a small upwelling. While it speaks, drops fall in the
 * centre and the rings run outward to the wall. Thinking turns the water into a slow whirlpool.
 *
 * Signals: onsets drop rings, loudness is ring strength and the number of crests, register and
 * pitch are the wavelength (a deep voice makes wide, slow swells; a child's voice a tight fine
 * ripple), syllable rate is ring speed, sibilance is a fizz of tiny drops on the surface.
 */
import type { Design, DesignInstance, Frame } from "../contract.ts"
import { AttackRelease, TAU, approach, clamp, clamp01, clear2d, optChoice, optNumber, optToggle, rng, setup2d } from "../kit.ts"
import { BLACK, type Col, ModeMix, OptionGlide, WHITE, col, css, liftInto, mixInto, modeTone, setCol, sinkInto, voiceOf } from "./_matter.ts"

const MAX_RINGS = 56
const MAX_FIZZ = 40
const LOOKS = ["water", "lines", "soft"]
/** Per look: opacity and width of the soft swell, opacity and width of the crisp crest, opacity of the trough. */
const SWELL_A = [1, 0, 2.6]
const SWELL_W = [1, 1, 1.6]
const CREST_A = [1, 1, 0.12]
const CREST_W = [1, 0.8, 1]
const TROUGH_A = [1, 0, 0.4]

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1

  // Ring pool (structure of arrays).
  const rBorn = new Float32Array(MAX_RINGS) // seconds
  const rX = new Float32Array(MAX_RINGS) // origin, fraction of the pool radius (−1..1)
  const rY = new Float32Array(MAX_RINGS)
  const rDir = new Int8Array(MAX_RINGS) // +1 outward, −1 inward, 0 dead
  const rA = new Float32Array(MAX_RINGS) // strength 0..1
  const rLam = new Float32Array(MAX_RINGS) // wavelength, fraction of pool radius
  const rSpd = new Float32Array(MAX_RINGS) // pool radii per second
  const rCrest = new Uint8Array(MAX_RINGS)
  const rR = new Float32Array(MAX_RINGS)
  const rG = new Float32Array(MAX_RINGS)
  const rB = new Float32Array(MAX_RINGS)
  let nextRing = 0

  // Fizz: tiny short-lived drops for sibilance.
  const fBorn = new Float32Array(MAX_FIZZ)
  const fX = new Float32Array(MAX_FIZZ)
  const fY = new Float32Array(MAX_FIZZ)
  const fLive = new Uint8Array(MAX_FIZZ)
  let nextFizz = 0

  const mix = new ModeMix(0.4)
  const tone: Col = col()
  const c1: Col = col()
  const c2: Col = col()
  const level = new AttackRelease(0.03, 0.25)
  const rim = new AttackRelease(0.05, 0.5)
  let sink = 0 // energy gathered at the centre (hearing)
  let splash = 0 // drop splash at the centre (speaking)
  let lastOnset = 0
  let sinceRing = 9
  let sinceIdle = 3
  let sinceListen = 0
  let fizzAcc = 0
  let swirl = 0
  let pointerWas = false
  let lastPX = 0
  let lastPY = 0
  let trailAcc = 0
  const rand = rng(7)

  // Options, eased toward the viewer's settings.
  const glide = new OptionGlide()
  let sizeK = 1
  let armsF = 3
  let strengthK = 1
  let pitchK = 1
  let speedK = 1
  let wallK = 1
  const lookW = new Float32Array([1, 0, 0]) // water, lines, soft

  const spawn = (f: Frame, x: number, y: number, dir: 1 | -1, a: number, lam: number, spd: number, crests: number, c: Col) => {
    const i = nextRing
    nextRing = (nextRing + 1) % MAX_RINGS
    rBorn[i] = f.t
    rX[i] = x
    rY[i] = y
    rDir[i] = dir
    rA[i] = a
    rLam[i] = lam
    rSpd[i] = spd
    rCrest[i] = crests
    rR[i] = c[0]
    rG[i] = c[1]
    rB[i] = c[2]
  }

  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f) {
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
      armsF = glide.to(armsF, optNumber(o, "arms"), 0.3)
      if (Math.abs(armsF - Math.round(armsF)) < 0.003) armsF = Math.round(armsF)
      strengthK = glide.to(strengthK, optNumber(o, "strength"))
      pitchK = glide.to(pitchK, optNumber(o, "pitch"))
      speedK = glide.to(speedK, optNumber(o, "speed"))
      wallK = glide.to(wallK, optToggle(o, "wall") ? 1 : 0)
      const fizzOn = optToggle(o, "fizz")
      glide.weights(lookW, LOOKS.indexOf(optChoice(o, "look")))
      let swellA = 0
      let swellW = 0
      let crestA = 0
      let crestW = 0
      let troughK = 0
      for (let k = 0; k < 3; k++) {
        swellA += SWELL_A[k]! * lookW[k]!
        swellW += SWELL_W[k]! * lookW[k]!
        crestA += CREST_A[k]! * lookW[k]!
        crestW += CREST_W[k]! * lookW[k]!
        troughK += TROUGH_A[k]! * lookW[k]!
      }

      const cx = W / 2
      const cy = H / 2
      const R = Math.min(W * 0.47, H * 0.45) * sizeK // pool radius, px
      const px1 = Math.max(1, R / 110) // a hairline that scales with size

      // Voice of the side that is "on".
      const v = f.mode === "speaking" ? f.agent : f.user
      const on = f.mode === "hearing" || f.mode === "speaking"
      const lv = level.step(on ? v.level : 0, dt)
      const reg = voiceOf(f, mix, "register")
      const pitch = voiceOf(f, mix, "pitch")
      // Wavelength (fraction of R): 0.2 for a deep voice down to 0.04 for a child's (geometric).
      // "Pitch reaction" scales how far the voice moves it from the middle.
      const lam = 0.2 * Math.pow(0.2, clamp01(0.5 + (clamp01(reg * 0.5 + pitch * 0.5) - 0.5) * pitchK))
      const speed = (0.38 + 0.06 * clamp(v.syllableRate, 0, 7)) * speedK
      const dir: 1 | -1 = f.mode === "speaking" ? 1 : -1

      // ---- Spawning (all motion, so none with reduced motion).
      sinceRing += dt
      sinceIdle += dt
      if (!reduced) {
        if (on && v.onset > 0.55 && lastOnset <= 0.55 && sinceRing > 0.07 && v.level > 0.03) {
          const a = clamp01(0.18 + v.level * 1.25)
          // Louder: more crests; a shorter wavelength packs more of them into the same packet.
          const byLevel = v.level < 0.15 ? 1 : v.level < 0.4 ? 2 : v.level < 0.62 ? 3 : 4
          const crests = Math.min(7, Math.max(1, Math.round(byLevel * Math.sqrt(0.09 / lam))))
          // Inward rings start at the wall; outward ones at the centre, a little off for life.
          const jx = (rand() - 0.5) * (dir > 0 ? 0.035 : 0)
          const jy = (rand() - 0.5) * (dir > 0 ? 0.035 : 0)
          spawn(f, jx, jy, dir, a, lam, speed, crests, tone)
          sinceRing = 0
          if (dir > 0) splash = Math.max(splash, 0.35 + v.level)
        }
        // Listening: a faint, slow inward ring every 1.7 s: the basin is attentive.
        if (f.mode === "listening") {
          sinceListen += dt
          if (sinceListen > 1.7) {
            spawn(f, 0, 0, -1, 0.22, 0.085, 0.3 * speedK, 1, tone)
            sinceListen = 0
          }
        } else sinceListen = 1.2
        // Idle: a lone grey ring every 5 s somewhere on the water, like a leaf touching down.
        if (f.mode === "idle" && sinceIdle > 5) {
          const ang = rand() * TAU
          const rad = 0.2 + rand() * 0.45
          spawn(f, Math.cos(ang) * rad, Math.sin(ang) * rad, 1, 0.22, 0.07, 0.18 * speedK, 1, setCol(c1, p.inkFaint))
          sinceIdle = 0
        }
        // Sibilance fizz.
        fizzAcc += on && fizzOn ? clamp01((v.sibilance - 0.35) * 1.6) * dt * 40 * (0.3 + v.level) : 0
        while (fizzAcc >= 1) {
          fizzAcc -= 1
          const i = nextFizz
          nextFizz = (nextFizz + 1) % MAX_FIZZ
          const ang = rand() * TAU
          const rad = Math.sqrt(rand()) * 0.9
          fX[i] = Math.cos(ang) * rad
          fY[i] = Math.sin(ang) * rad
          fBorn[i] = f.t
          fLive[i] = 1
        }
        // Pointer: a press drops a big ring where the finger is; moving over the water trails small ones.
        const pt = f.pointer
        const pxN = (pt.x - cx) / R
        const pyN = (pt.y - cy) / R
        const inPool = pt.inside && pxN * pxN + pyN * pyN < 1
        if (pt.down && !pointerWas && inPool) spawn(f, pxN, pyN, 1, 0.9, lam * 1.2, 0.5 * speedK, 3, tone)
        if (inPool && !pt.down) {
          const moved = Math.hypot(pt.x - lastPX, pt.y - lastPY)
          trailAcc += moved
          if (trailAcc > R * 0.12) {
            spawn(f, pxN, pyN, 1, 0.35, lam * 0.6, 0.35 * speedK, 1, tone)
            trailAcc = 0
          }
        }
        pointerWas = pt.down
        lastPX = pt.x
        lastPY = pt.y
      }
      lastOnset = v.onset

      // ---- Pool body: a faint basin so the water reads as an object at every size.
      const deep = p.dark ? 0.9 : 0.86
      sinkInto(c1, tone, deep, p)
      const grad = g.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.05, cx, cy, R)
      // Without the wall the water fades out toward its edge instead of darkening against it.
      grad.addColorStop(0, css(c1, p.dark ? 0.55 : 0.5))
      grad.addColorStop(0.75, css(c1, (p.dark ? 0.35 : 0.3) * (0.4 + 0.6 * wallK)))
      grad.addColorStop(1, css(c1, (p.dark ? 0.7 : 0.65) * wallK))
      g.fillStyle = grad
      g.beginPath()
      g.arc(cx, cy, R, 0, TAU)
      g.fill()

      // Rim: lit by the person's voice while taking in (the wall is where sound arrives).
      const rimTarget = mix.listening * 0.45 + mix.hearing * (0.35 + lv * 1.2)
      const rimLit = rim.step(reduced ? Math.round(rimTarget * 3) / 3 : rimTarget, dt)
      if (wallK > 0.01) {
        g.lineWidth = px1 * (1 + rimLit * 2.5)
        sinkInto(c2, tone, 0.55 - rimLit * 0.5, p)
        g.strokeStyle = css(c2, (0.55 + rimLit * 0.45) * wallK)
        g.beginPath()
        g.arc(cx, cy, R, 0, TAU)
        g.stroke()
      }
      if (rimLit > 0.05) {
        // Inner halo of the lit rim. It stays without the wall (a little stronger), so listening and hearing still glow at the edge.
        g.lineWidth = px1 * (4 + rimLit * 8)
        g.strokeStyle = css(tone, rimLit * 0.18 * (1.5 - 0.5 * wallK))
        g.beginPath()
        g.arc(cx, cy, R - px1 * (2 + rimLit * 4), 0, TAU)
        g.stroke()
      }

      g.save()
      g.beginPath()
      g.arc(cx, cy, R - px1 * 0.5, 0, TAU)
      g.clip()

      // ---- Rings.
      const crestRgb = c1
      const troughA = p.dark ? 0.55 : 0.75
      if (!reduced) {
        for (let i = 0; i < MAX_RINGS; i++) {
          const d = rDir[i]!
          if (d === 0) continue
          const age = f.t - rBorn[i]!
          const lamPx = rLam[i]! * R
          const nC = rCrest[i]!
          let lead: number // leading crest radius (px)
          let strength: number
          if (d > 0) {
            lead = age * rSpd[i]! * R
            const reach = lead / R
            strength = rA[i]! * Math.exp(-age * 0.45) * (1 - clamp01((reach - 0.75) / 0.6)) * clamp01(age * 8)
            if (reach > 1.6 || (age > 0.3 && strength < 0.01)) {
              rDir[i] = 0
              continue
            }
          } else {
            lead = R * 1.02 - age * rSpd[i]! * R
            const reach = lead / R
            // Converging waves focus: strength grows toward the centre, then vanishes into it.
            strength = rA[i]! * (0.55 + 0.45 * (1 - reach)) * clamp01(age * 5) * clamp01(lead / (lamPx * 1.2))
            if (lead <= 0) {
              sink = Math.min(1.4, sink + rA[i]! * 0.5)
              rDir[i] = 0
              continue
            }
          }
          const ox = cx + rX[i]! * R
          const oy = cy + rY[i]! * R
          const ringRgb = c2
          ringRgb[0] = rR[i]!
          ringRgb[1] = rG[i]!
          ringRgb[2] = rB[i]!
          liftInto(crestRgb, ringRgb, 0.3, p)
          for (let j = 0; j < nC; j++) {
            // Crests trail behind the leading edge: outside it for inward rings, inside for outward.
            const rr = lead - d * j * lamPx
            if (rr <= 0.5) continue
            const aj = strength * (1 - j / (nC + 0.6)) * strengthK
            const w = px1 * (0.6 + aj * 2.4) * (0.55 + rLam[i]! * 5)
            // A soft swell under a crisp crest line: reads as water, not as a vector circle.
            if (swellA > 0.01) {
              g.lineWidth = w * 3.2 * swellW
              g.strokeStyle = css(ringRgb, aj * 0.16 * swellA)
              g.beginPath()
              g.arc(ox, oy, rr, 0, TAU)
              g.stroke()
            }
            g.lineWidth = w * crestW
            g.strokeStyle = css(crestRgb, Math.min(1, aj * 1.15) * crestA)
            g.beginPath()
            g.arc(ox, oy, rr, 0, TAU)
            g.stroke()
            const tr = rr - d * lamPx * 0.5
            if (tr > 0.5 && troughK > 0.01) {
              g.lineWidth = w * 1.3
              g.strokeStyle = p.dark ? css(p.bg, aj * troughA * troughK) : css(WHITE, aj * troughA * troughK)
              g.beginPath()
              g.arc(ox, oy, tr, 0, TAU)
              g.stroke()
            }
          }
        }

        // Fizz: tiny rings that open and fade in 0.35 s.
        g.lineWidth = px1 * 0.8
        for (let i = 0; i < MAX_FIZZ; i++) {
          if (fLive[i] === 0) continue
          const age = f.t - fBorn[i]!
          if (age > 0.35 || !fizzOn) {
            fLive[i] = 0
            continue
          }
          const k = age / 0.35
          liftInto(crestRgb, tone, 0.25, p)
          g.strokeStyle = css(crestRgb, (1 - k) * 0.8)
          g.beginPath()
          g.arc(cx + fX[i]! * R, cy + fY[i]! * R, px1 * (1 + k * 5), 0, TAU)
          g.stroke()
        }
      } else {
        // Reduced motion: a still picture of the mode. Inward modes put the strongest crest
        // innermost; speaking puts it outermost; loudness (in thirds) sets how many crests show.
        const steps = Math.round(clamp01(lv * 1.6) * 3)
        const nRings = f.mode === "hearing" || f.mode === "speaking" ? 2 + steps : f.mode === "listening" ? 1 : 0
        liftInto(crestRgb, tone, 0.3, p)
        const lamPx = lam * R
        for (let j = 0; j < nRings; j++) {
          const k = (j + 1) / (nRings + 1)
          const rr = R * k * 0.92
          const a = (f.mode === "speaking" ? 0.25 + 0.7 * k : 0.25 + 0.7 * (1 - k)) * strengthK
          if (swellA > 0.01) {
            g.lineWidth = px1 * (0.8 + a * 2.2) * 3.2 * swellW
            g.strokeStyle = css(crestRgb, a * 0.16 * swellA * lookW[2]!)
            g.beginPath()
            g.arc(cx, cy, rr, 0, TAU)
            g.stroke()
          }
          g.lineWidth = px1 * (0.8 + a * 2.2) * crestW
          g.strokeStyle = css(crestRgb, Math.min(1, a) * Math.max(crestA, 0.35 * lookW[2]!))
          g.beginPath()
          g.arc(cx, cy, rr, 0, TAU)
          g.stroke()
          g.lineWidth = px1 * (1 + a * 2.6)
          g.strokeStyle = p.dark ? css(p.bg, a * troughA * troughK) : css(WHITE, a * troughA * troughK)
          g.beginPath()
          g.arc(cx, cy, Math.max(0.5, rr - lamPx * 0.5), 0, TAU)
          g.stroke()
        }
      }

      // ---- Thinking: the water turns. Three spiral arms wind into a central dimple.
      const th = mix.thinking
      if (th > 0.02) {
        if (!reduced) swirl += dt * 0.9 * speedK
        liftInto(crestRgb, tone, 0.25, p)
        // A fractional count (while the option glides) spaces the arms evenly and fades the last one in.
        const arms = Math.ceil(armsF - 0.001)
        for (let a = 0; a < arms; a++) {
          const base = swirl + (a * TAU) / armsF
          const fadeIn = a < Math.floor(armsF) ? 1 : armsF - Math.floor(armsF)
          for (let pass = 0; pass < 2; pass++) {
            g.beginPath()
            for (let s = 0; s <= 40; s++) {
              const u = s / 40 // 0 centre .. 1 outside
              const rr = R * (0.08 + 0.82 * u)
              const ang = base + (pass === 1 ? 0.18 : 0) + Math.log(1 + 6 * u) * 2.2
              const x = cx + Math.cos(ang) * rr
              const y = cy + Math.sin(ang) * rr
              if (s === 0) g.moveTo(x, y)
              else g.lineTo(x, y)
            }
            if (pass === 0) {
              g.lineWidth = px1 * 1.6
              g.strokeStyle = css(crestRgb, th * 0.75 * fadeIn)
            } else {
              g.lineWidth = px1 * 2
              g.strokeStyle = p.dark ? css(p.bg, th * 0.5 * fadeIn) : css(WHITE, th * 0.7 * fadeIn)
            }
            g.stroke()
          }
        }
        // The dimple.
        g.fillStyle = css(sinkInto(c2, tone, p.dark ? 0.75 : 0.2, p), th * 0.85)
        g.beginPath()
        g.arc(cx, cy, R * 0.07, 0, TAU)
        g.fill()
      }

      g.restore()

      // ---- Centre: the upwelling where incoming rings meet (hearing), or the drop point (speaking).
      sink = reduced ? (f.mode === "hearing" ? 0.3 + lv : 0) : approach(sink, 0, dt, 0.5)
      splash = reduced ? (f.mode === "speaking" ? 0.3 + lv : 0) : approach(splash, 0, dt, 0.18)
      const listenDot = mix.listening * 0.5
      const cDot = Math.max(sink, listenDot)
      if (cDot > 0.02) {
        // A soft mound that swells as what was said gathers.
        liftInto(c1, p.you, 0.15, p)
        const rr = R * (0.025 + 0.06 * Math.min(1, cDot))
        const gg = g.createRadialGradient(cx, cy, 0, cx, cy, rr * 2.2)
        gg.addColorStop(0, css(c1, Math.min(1, cDot)))
        gg.addColorStop(0.45, css(c1, Math.min(1, cDot) * 0.45))
        gg.addColorStop(1, css(c1, 0))
        g.fillStyle = gg
        g.beginPath()
        g.arc(cx, cy, rr * 2.2, 0, TAU)
        g.fill()
      }
      const speakDot = mix.speaking * 0.35 + splash
      if (speakDot > 0.02) {
        // The drop: a bright bead with a crown ring when a syllable lands.
        mixInto(c1, p.voice, p.dark ? WHITE : BLACK, 0.18)
        g.fillStyle = css(c1, Math.min(1, speakDot))
        g.beginPath()
        g.arc(cx, cy, R * (0.02 + 0.035 * Math.min(1, splash)), 0, TAU)
        g.fill()
        if (splash > 0.1) {
          g.lineWidth = px1 * 1.2
          g.strokeStyle = css(c1, Math.min(1, splash) * 0.8)
          g.beginPath()
          g.arc(cx, cy, R * (0.05 + 0.08 * (1 - Math.min(1, splash))), 0, TAU)
          g.stroke()
        }
      }

      // Idle: a still reflection highlight, the only mark on calm water.
      const id = mix.idle + mix.listening * 0.4
      if (id > 0.02) {
        g.lineWidth = px1 * 1.4
        g.lineCap = "round"
        liftInto(c1, p.inkFaint, 0.2, p)
        g.strokeStyle = css(c1, id * (p.dark ? 0.35 : 0.45))
        g.beginPath()
        g.arc(cx, cy, R * 0.8, -2.5, -1.9)
        g.stroke()
        g.beginPath()
        g.arc(cx, cy, R * 0.8, -1.75, -1.6)
        g.stroke()
      }
    },

    dispose() {}
  }
}

const design: Design = {
  id: "ripple-pond",
  name: "Ripple pond",
  family: "abstract",
  summary: "A round basin of water seen from above: rings converge on the centre while it listens and run out from a falling drop while it speaks.",
  inspiredBy:
    "Meta AI's ring (inward when listening, outward when responding), Gemini's radial ripples for voice and inner churn for thinking, and real ripple tanks where waves reflected from a round wall focus on the centre.",
  modes: {
    idle: "Calm grey water; one faint ring every few seconds and a still reflection.",
    listening: "The basin wall glows mint; a faint ring slides in toward a small mint mound in the centre every 1.7 s.",
    hearing: "Each of your syllables leaves the wall as a mint ring and converges inward; the centre mound swells as they arrive.",
    thinking: "Amber whirlpool: three spiral arms turn slowly around a dimple; no rings.",
    speaking: "Amber drops fall in the centre, one per syllable, and their rings run outward to the wall."
  },
  mappings: [
    { signal: "active.onset (rising edge)", effect: "Drops one ring per syllable (at most one per 70 ms): inward from the wall while hearing, outward from the centre while speaking." },
    { signal: "active.level at the onset", effect: "Ring strength (opacity and line width, 0.18 + 1.25 × level) and crest count: 1 under 0.15, 2 under 0.4, 3 under 0.62, 4 above, times √(0.09 ÷ wavelength), at most 7." },
    { signal: "register (50 %) + pitch (50 %)", effect: "Wavelength between crests, geometric from 20 % of the pool radius (deep) down to 4 % (child); a short wavelength also packs in more crests and draws them thinner, so a deep voice makes a few broad swells and a child's a fine ripple." },
    { signal: "active.syllableRate", effect: "Ring speed: 0.38 + 0.06 × rate pool radii per second, so fast speech also travels faster." },
    { signal: "active.sibilance", effect: "Fizz: tiny rings pop up across the surface on 's', 'sh' and 'f' (rate ∝ (sibilance − 0.35) × (0.3 + level))." },
    { signal: "user.level (hearing)", effect: "Brightness and width of the lit basin wall (50 ms rise, 500 ms fall)." },
    { signal: "rings reaching the centre", effect: "Grow the mint mound in the middle (decays over 0.5 s)." },
    { signal: "mode", effect: "Ring direction (in / out), colour (grey, mint, amber; 0.4 s blend), lit wall in listening and hearing, whirlpool in thinking." },
    { signal: "pointer", effect: "A press drops a strong ring where the finger is; moving over the water trails small rings." },
    { signal: "options", effect: "size, whirlpool arms, ring strength, pitch reaction (how far the voice moves the wavelength), ring speed (new rings and the whirlpool), fizz, the basin wall, and the look of a ring (water: swell, crest and trough; lines: crisp crests only; soft: broad swells); values glide (the look cross-fades), all snap with reduced motion." },
    { signal: "reducedMotion", effect: "Nothing moves: a still ring set per mode (strongest crest inside while taking in, outside while speaking; crest count from loudness in thirds), a still spiral for thinking." }
  ],
  serverNeeds: "none",
  renderer: "2d",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the basin is; at 1 it nearly fills the height." },
    { id: "arms", kind: "number", label: "Whirlpool arms", min: 2, max: 6, step: 1, default: 3, group: "Shape", help: "How many spiral arms the water turns into while it thinks." },
    { id: "strength", kind: "number", label: "Ring strength", min: 0.3, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How bright and broad the ring each syllable drops is." },
    { id: "pitch", kind: "number", label: "Pitch reaction", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much a deep or a high voice changes the ripples: wide slow swells or a fine tight ripple; at 0 every voice ripples alike." },
    { id: "speed", kind: "number", label: "Ring speed", min: 0.4, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast new rings travel across the water and the whirlpool turns." },
    { id: "fizz", kind: "toggle", label: "Fizz", default: true, group: "Motion", help: "Tiny drops that pop up across the surface on 's' and 'sh' sounds." },
    {
      id: "look",
      kind: "choice",
      label: "Ripples",
      choices: [
        { value: "water", label: "Water" },
        { value: "lines", label: "Lines" },
        { value: "soft", label: "Soft" }
      ],
      default: "water",
      group: "Style",
      help: "Water with a swell, crest and trough; crisp lines only; or soft broad swells without a hard edge."
    },
    { id: "wall", kind: "toggle", label: "Basin wall", default: true, group: "Behaviour", help: "The wall round the water; without it the water fades out at its edge and only a soft glow there shows it listening." }
  ],
  create
}

export default design
