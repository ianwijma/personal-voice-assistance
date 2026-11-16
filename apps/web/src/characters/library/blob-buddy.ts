/**
 * Blob buddy: a soft gumdrop creature with dot eyes, a small mouth and one curled antenna, animated
 * with squash and stretch. It sags and dozes when idle, perks up (antenna up) to listen, leans in
 * for a whisper and shrinks back from a shout, sways while it thinks, and puffs up and hops on
 * its syllables when it speaks. The antenna tip and a soft glow in its belly carry the colour of
 * whoever is talking: mint for you, amber for the assistant.
 *
 * The body is a superellipse resting on the ground (flatter below, rounder above), area-preserving
 * under squash, sheared toward where it leans, and rotated about its point of contact for a tilt.
 */
import type { Character, CharacterInstance, Frame } from "../contract.ts"
import { approach, clamp01, clear2d, lerp, noise2, optChoice, optColor, optNumber, remap, rng, setup2d, Spring, TAU } from "../kit.ts"
import {
  APPEARANCE,
  Blinker,
  EXPRESSIVENESS,
  type Five,
  fit,
  FOLLOWS_POINTER,
  Gaze,
  Glide,
  Ink,
  instanceSeed,
  lightness,
  LIVELINESS,
  mixInto,
  ModeMix,
  Mouth,
  MOUTH_RANGE,
  mouthPath,
  nodsOption,
  Personality,
  Social,
  sized,
  sizeOption,
  SoftSpot
} from "../shared/figure.ts"

const N = 48
const COS = new Float32Array(N)
const SIN = new Float32Array(N)
for (let i = 0; i < N; i++) {
  COS[i] = Math.cos((i / N) * TAU)
  SIN[i] = Math.sin((i / N) * TAU)
}

//                           idle   listen hear   think  speak
const STRETCH: Five = [0.84, 1.06, 1.02, 1, 1.03]
const PUFF: Five = [0.98, 1, 1, 0.98, 1.06]
const EYE_OPEN: Five = [0, 1, 1, 0.8, 0.95]
const SMILE: Five = [0.05, 0.4, 0.2, 0, 0.3]
const ANTENNA: Five = [1.15, 0.05, 0.08, 0, 0.05] // droop angle, radians
const BLINK_MEAN: Five = [5, 4, 4.6, 2.6, 3.2]
const ALERT: Five = [0, 1, 1, 1, 1]

/**
 * "Body shape" choice → half-width and half-height (units), superellipse exponent above and below
 * the middle, and how much wider it gets toward the ground.
 */
const SHAPES: { readonly [k: string]: readonly [a: number, b: number, up: number, down: number, widen: number] } = {
  gumdrop: [0.86, 0.72, 1, 0.78, 0.13],
  round: [0.8, 0.8, 1, 1, 0],
  tall: [0.62, 0.82, 0.92, 0.72, 0.08]
}
/** The "Body colour" default: a warm grey made from the theme's ink and background (its swatch shows the dark-theme value). */
const GREY = "#9d9789"

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  const seed = instanceSeed(9)
  const mix = new ModeMix()
  const social = new Social(seed)
  const blink = new Blinker(seed + 1)
  const gaze = new Gaze(seed + 2)
  const rand = rng(seed + 3)
  const mouth = new Mouth()
  const ink = new Ink()
  const hiSpot = new SoftSpot()
  const shadeSpot = new SoftSpot()
  const glowSpot = new SoftSpot()
  const you = { x: 0, y: 0 }
  const bodyRgb: [number, number, number] = [0, 0, 0]
  const featRgb: [number, number, number] = [0, 0, 0]
  const accRgb: [number, number, number] = [0, 0, 0]
  const px = new Float32Array(N)
  const py = new Float32Array(N)
  const squash = new Spring(0.12, 1, 0.55) // body stretch, wobbles back after a nod or flinch
  const lean = new Spring(0.25, 0, 0.2) // horizontal lean (shear)
  const tilt = new Spring(0.3, 0, 0.25)
  const antenna = new Spring(0.18, 1.15, 0.45)
  const pers = new Personality()
  const gSize = new Glide(1)
  const gA = new Glide(0.86)
  const gB = new Glide(0.72)
  const gUp = new Glide(1)
  const gDown = new Glide(0.78)
  const gWiden = new Glide(0.13)
  let size = 1
  let openS = 0
  let accent = 0
  const side = rand() < 0.5 ? -1 : 1

  return {
    resize(_width, _height, ratio) {
      dpr = ratio
      g = setup2d(canvas, dpr)
    },

    frame(f: Frame) {
      const fo = f.focus
      W = fo.width
      H = fo.height
      const dt = f.dt
      const P = f.palette
      const reduced = f.reducedMotion
      pers.read(f)
      mix.step(f, 0.25)
      social.step(f, pers)
      const S = social
      // Appearance options: the body morphs between shapes over ~0.25 s.
      const shape = SHAPES[optChoice(f.options, "bodyShape")] ?? SHAPES.gumdrop!
      const scale = gSize.step(optNumber(f.options, "size"), f)
      const shapeA = gA.step(shape[0], f, 0.25)
      const shapeB = gB.step(shape[1], f, 0.25)
      const eUp = gUp.step(shape[2], f, 0.25)
      const eDown = gDown.step(shape[3], f, 0.25)
      const widenK = gWiden.step(shape[4], f, 0.25)
      const hearW = mix.hearing
      const speakW = mix.speaking
      const thinkW = mix.thinking

      // Layout: 3.0 × 2.45 units; the body is about 1.7 wide and 1.45 tall, ground at +0.95 (lower
      // for a taller body, so its antenna keeps clear of the top). The size option only shrinks:
      // with its hops and antenna the creature already uses the height.
      const s = sized(fit(W, H, 3.0, 2.45, 0.94), scale, W, H, 2.6, 2.5)
      const cx = W / 2
      const ground = H / 2 + (0.95 + (shapeB - 0.72)) * s

      // Gaze.
      // The pointer is in canvas coordinates; the figure reacts to it only over its box, as before.
      const ptrX = f.pointer.x - fo.x
      const ptrY = f.pointer.y - fo.y
      const hover = f.pointer.inside && ptrX >= 0 && ptrX < W && ptrY >= 0 && ptrY < H
      if (hover && pers.followsPointer) {
        you.x = Math.max(-1, Math.min(1, (ptrX - cx) / (s * 2.2)))
        you.y = Math.max(-1, Math.min(1, (ptrY - H / 2) / (s * 2.2)))
      } else {
        you.x = 0
        you.y = 0.05
      }
      let gx = you.x
      let gy = you.y
      let spread = 0.08
      let hold = 1.3
      if (f.mode === "thinking") {
        gx = 0.7 * S.thinkSide
        gy = -0.7
        spread = 0.35
        hold = 0.5
      } else if (f.mode === "speaking") {
        gx = lerp(gx, 0.7 * S.lookSide, S.lookAway)
        gy = lerp(gy, -0.2, S.lookAway)
      } else if (f.mode === "idle") {
        gy = 0.5
        hold = 3
      }
      gaze.step(dt, gx, gy, spread, hold / pers.liveliness, reduced)
      if (gaze.saccade && rand() < 0.3) blink.trigger()
      if (S.ack) blink.trigger()
      const bl = blink.step(dt, mix.pick(BLINK_MEAN) / pers.liveliness, !reduced && mix.idle < 0.5)

      // ---- Body dynamics.
      const breathe = reduced ? 0 : Math.sin(f.t * (mix.idle > 0.5 ? 0.9 : 1.4)) * 0.6 + noise2(f.t * 0.3, 2.2) * 0.4
      const leanIn = Math.max(0, S.lean) * hearW // whisper: lean in
      const back = (S.brace + S.flinch) * hearW + S.flinch // shout: shrink back
      // It crouches a little for a high or child voice (down to eye level), stands taller for a deep one.
      const reg01 = remap(S.regard, 0.15, 0.82, 0, 1)
      const stretchT =
        mix.pick(STRETCH) + 0.06 * leanIn - 0.1 * back + hearW * (0.14 * (S.energy - 0.45) + 0.14 * (0.45 - reg01)) + speakW * 0.05 * (S.talkSlow - 0.3) + (reduced ? 0 : 0.012 * breathe)
      if (!reduced) {
        if (S.ack && S.nodsOn && hearW > 0.5) squash.velocity -= 1.2 * S.expr // a nod is a little squash
        squash.halfLife = lerp(0.1, 0.16, S.size * speakW)
      }
      const stretch = reduced ? stretchT : squash.step(stretchT, dt)
      // Hop on the assistant's syllables: up and stretched in the air, squashed on landing.
      const beat = reduced ? 0 : S.beat * speakW
      const hop = Math.max(0, beat) * (0.1 + 0.06 * S.size)
      const land = Math.min(0, beat) * 0.12
      const sizeT = mix.pick(PUFF) * (1 + 0.1 * leanIn - 0.1 * back + speakW * (0.1 * S.size - 0.03 + 0.15 * (S.talkSlow - 0.3)))
      size = reduced ? sizeT : approach(size, sizeT, dt, 0.18)
      // Lean toward the pointer (if any) or toward you in front: whisper leans further.
      const leanT = (hover ? you.x * 0.35 : 0) + thinkW * (reduced ? 0.12 * S.thinkSide : 0.16 * Math.sin(f.t * 0.8)) - (mix.idle > 0.5 ? 0.08 * side : 0)
      const ln = reduced ? leanT : lean.step(leanT, dt)
      const tiltT = hearW * 0.22 * S.question * (you.x < -0.1 ? -1 : 1) + mix.idle * 0.06 * side + thinkW * 0.05 * S.thinkSide
      const tl = reduced ? tiltT : tilt.step(tiltT, dt)

      // Body half-sizes (area-preserving squash).
      const st = stretch * (1 + 0.1 * Math.max(0, beat)) * (1 + land)
      const a = shapeA * s * size / Math.sqrt(st)
      const b = shapeB * s * size * st
      const nod = reduced ? 0 : S.nod * 0.06 * s

      // ---- Colours.
      const alert = mix.pick(ALERT)
      const bodyC = f.options.bodyColor
      if (bodyC === GREY || typeof bodyC !== "string") {
        mixInto(bodyRgb, P.bg, P.ink, (P.dark ? 0.5 : 0.12) + (P.dark ? 0.12 : 0.05) * alert)
        mixInto(bodyRgb, bodyRgb, P.voice, 0.07)
        if (P.dark) mixInto(featRgb, P.bg, [0, 0, 0], 0.55)
        else mixInto(featRgb, P.ink, P.ink, 0)
      } else {
        // A chosen colour, a little muted while dozing; dark features on a light body, light on a dark one.
        mixInto(bodyRgb, P.bg, optColor(f, "bodyColor"), 0.8 + 0.2 * alert)
        if (lightness(bodyRgb) > 0.45) mixInto(featRgb, bodyRgb, [0, 0, 0], 0.82)
        else mixInto(featRgb, bodyRgb, [255, 255, 255], 0.85)
      }
      const youLv = S.userTalking ? Math.max(0.15, f.user.level) : 0.1
      const accT = mix.listening * 0.35 + hearW * (0.35 + 0.65 * clamp01(youLv * 1.6)) + speakW * (0.35 + 0.65 * clamp01(S.talk * 1.8)) + thinkW * (reduced ? 0.4 : 0.3 + 0.2 * Math.sin(f.t * 3))
      accent = reduced ? Math.round(accT * 3) / 3 : approach(accent, accT, dt, accT > accent ? 0.04 : 0.2)
      const toVoice = speakW + thinkW
      mixInto(accRgb, P.you, P.voice, toVoice / Math.max(1e-3, toVoice + hearW + mix.listening))

      clear2d(g, dpr, fo)
      // Ground shadow: shrinks as it hops.
      g.fillStyle = ink.css(P.dark ? [0, 0, 0] : P.ink, (P.dark ? 0.35 : 0.1) * (1 - hop * 3))
      g.beginPath()
      g.ellipse(cx + ln * 0.3 * s, ground + 0.02 * s, a * (1.05 - hop * 2), 0.07 * s, 0, 0, TAU)
      g.fill()

      // Body frame: origin at the contact point, tilted about it, lifted by the hop. A hop never
      // lifts the antenna tip out of the frame (a big, animated hop on a tall pose in a small tile).
      const angPrev = antenna.value // last frame's antenna angle: close enough to bound the tip
      const reach = 2 * b - 0.02 * s + Math.cos(angPrev) * 0.42 * s * (0.95 + 0.1 * size) * (1 - 0.25 * Math.abs(Math.sin(angPrev))) + 0.075 * s
      // (The gumdrop at normal expressiveness keeps today's hop exactly, even where its tip grazes the top.)
      const asDesigned = shapeB === 0.72 ? (hop * s) / Math.max(1, S.expr) : 0
      const lift = Math.min(hop * s, Math.max(0, ground - 1 - reach, asDesigned))
      g.translate(cx, ground - lift)
      g.rotate(tl)
      for (let i = 0; i < N; i++) {
        const c = COS[i]!
        const sn = SIN[i]! // positive = below centre
        const e = sn > 0 ? eDown : eUp // rounder above, fuller below
        const widen = 1 + widenK * sn // a gumdrop: wider toward the ground
        let x = a * widen * (c < 0 ? -Math.pow(-c, e) : Math.pow(c, e))
        let y = b * (sn < 0 ? -Math.pow(-sn, e) : Math.pow(sn, e)) - b // centre at −b, bottom on the ground
        // Soft wobble of the outline, and shear toward the lean (top moves most).
        const wob = reduced ? 0 : noise2(c * 1.3 + f.t * 0.6, sn * 1.3 + 9) * 0.006 * s * (1 + 1.2 * Math.abs(beat))
        x += c * wob + ln * s * (-y / (2 * b)) * 0.45
        y += sn * wob
        px[i] = x
        py[i] = Math.min(0, y)
      }
      g.fillStyle = ink.css(bodyRgb, 1)
      g.beginPath()
      g.moveTo(px[0]!, py[0]!)
      for (let i = 1; i < N; i++) g.lineTo(px[i]!, py[i]!)
      g.closePath()
      g.fill()
      if (!P.dark) {
        g.strokeStyle = ink.css(P.inkFaint, 0.5)
        g.lineWidth = Math.max(1, 0.02 * s)
        g.stroke()
      }
      // Volume: a soft highlight up top (light from above) and a faint shade low down; the
      // belly glow in the accent colour. All three are soft radial spots clipped to the body.
      g.save()
      g.clip()
      hiSpot.draw(g, -a * 0.25 + ln * s * 0.3, -b * 1.5, a * 0.75, b * 0.5, -0.3, P.dark ? P.ink : [255, 255, 255], P.dark ? 0.2 : 0.6)
      shadeSpot.draw(g, 0, 0.1 * s, a * 1.5, b * 0.7, 0, [0, 0, 0], P.dark ? 0.35 : 0.12)
      glowSpot.draw(g, ln * s * 0.12, -b * 0.62, a * 0.62, b * 0.5, 0, accRgb, clamp01(accent) * (P.dark ? 0.75 : 0.7))
      g.restore()

      // Face: on the upper body, shifted by the lean, gaze and nod.
      const fx = ln * s * 0.3 + gaze.x * 0.12 * s
      const fy = -b * 1.18 + gaze.y * 0.06 * s + nod + leanIn * 0.05 * s
      const eyeR = (0.075 + 0.015 * leanIn) * s * (0.9 + 0.1 * size)
      const open = clamp01(mix.pick(EYE_OPEN) + hearW * (0.5 * (S.energy - 0.45) - 0.4 * back) + 0.12 * leanIn) * (1 - bl)
      const sep = 0.3 * s * size
      g.fillStyle = ink.css(featRgb, 1)
      g.strokeStyle = ink.css(featRgb, 1)
      g.lineCap = "round"
      g.lineWidth = Math.max(1.4, 0.035 * s)
      for (let e = -1; e <= 1; e += 2) {
        const x = fx + e * sep + gaze.x * 0.04 * s
        const y = fy
        if (open > 0.15) {
          g.beginPath()
          g.ellipse(x, y, eyeR * 0.9, eyeR * (0.4 + 0.75 * open), 0, 0, TAU)
          g.fill()
        } else {
          g.beginPath()
          g.moveTo(x - eyeR, y)
          g.quadraticCurveTo(x, y + eyeR * (mix.idle > 0.5 ? 0.9 : 0.3), x + eyeR, y)
          g.stroke()
        }
      }

      // Mouth.
      mouth.step(f, S.size, speakW, pers.mouthRange)
      const smile = mix.pick(SMILE) + hearW * (0.12 * S.waiting - 0.35 * back + 0.15 * Math.max(0, S.energy - 0.5))
      const mx = fx + 0.03 * s * gaze.x + thinkW * 0.06 * s * S.thinkSide
      const my = fy + 0.24 * s
      const mw = 0.13 * s * (1 + 0.5 * mouth.wide - 0.4 * mouth.round) * (0.85 + 0.3 * S.size) * (1 - 0.3 * thinkW)
      openS = reduced ? mouth.open : approach(openS, mouth.open + 0.6 * mouth.round * speakW + 0.4 * mouth.teeth, dt, 0.02)
      const mh = (0.26 * openS + 0.025 * thinkW) * s * (0.85 + 0.3 * S.size) * (0.8 + 0.6 * S.talkSlow * speakW)
      if (mh > 0.012 * s) {
        g.beginPath()
        mouthPath(g, mx, my, mw, mh * (0.25 + 0.5 * mouth.round + 0.5 * thinkW), mh * (0.8 - 0.2 * mouth.round), smile * 0.03 * s, 0.3 + 0.6 * mouth.wide)
        g.fill()
      } else {
        g.beginPath()
        g.moveTo(mx - mw, my - smile * 0.04 * s)
        g.quadraticCurveTo(mx, my + smile * 0.07 * s, mx + mw, my - smile * 0.04 * s)
        g.stroke()
      }

      // Antenna: a soft curl from the top, droops when dozing, stands to listen, quivers with your
      // voice, twirls while thinking, bounces along when speaking. Its tip carries the accent.
      const quiver = reduced ? 0 : hearW * clamp01(youLv * 1.5) * noise2(f.t * 9, 1.7) * 0.25
      const twirl = reduced ? 0 : thinkW * 0.45 * Math.sin(f.t * 2.4)
      const antT = mix.pick(ANTENNA) * side + quiver + twirl - ln * 0.6 - tl * 0.5 - back * 0.3 * side
      if (!reduced && speakW > 0.1 && Math.abs(beat) > 0.05) antenna.velocity += beat * 0.4
      const ang = reduced ? antT : antenna.step(antT, dt)
      const topX = ln * s * 0.45 + 0
      const topY = -2 * b + 0.02 * s
      const len = 0.42 * s * (0.95 + 0.1 * size)
      const tipX = topX + Math.sin(ang) * len
      const tipY = topY - Math.cos(ang) * len * (1 - 0.25 * Math.abs(Math.sin(ang)))
      // A stalk with a constant gentle curl.
      const curl = 0.22 * side
      const cxp = topX + Math.sin(ang * 0.4 + curl) * len * 0.55
      const cyp = topY - len * 0.6
      g.strokeStyle = ink.css(bodyRgb, 1)
      g.lineWidth = Math.max(2, 0.065 * s)
      g.beginPath()
      g.moveTo(topX, topY + 0.04 * s)
      g.quadraticCurveTo(cxp, cyp, tipX, tipY)
      g.stroke()
      // Tip: body-coloured bulb with an accent core.
      g.fillStyle = ink.css(bodyRgb, 1)
      g.beginPath()
      g.arc(tipX, tipY, 0.075 * s, 0, TAU)
      g.fill()
      g.fillStyle = ink.css(accRgb, clamp01(accent * 1.2))
      g.beginPath()
      g.arc(tipX, tipY, 0.075 * s * (0.45 + 0.35 * clamp01(accent)), 0, TAU)
      g.fill()
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
    },

    dispose() {}
  }
}

const character: Character = {
  id: "blob-buddy",
  name: "Blob buddy",
  version: "1.1.0",
  contract: 1,
  family: "figure",
  summary: "A soft gumdrop creature with one antenna curl, animated with squash and stretch: it leans in to listen, shrinks from a shout, sways to think and hops on its syllables.",
  inspiredBy: "Classic squash-and-stretch animation, Copilot's Mico (a soft blob between orb and character), Rabbit R1's ears-up listening pose, the Rapport Agent's pause-timed nods.",
  modes: {
    idle: "Sagging low and wide, eyes closed in soft arcs, antenna drooped to one side, slow breathing; colours muted.",
    listening: "Stretched up tall, eyes open, a small smile, antenna standing straight with a mint tip: ready, your turn.",
    hearing: "Mint belly glow and antenna tip as bright as your voice, antenna quivering with it; little squash-nods at your pauses, a tilt at questions, leans in and grows for a whisper, shrinks and squints at a shout.",
    thinking: "Sways slowly side to side, eyes up and to one side, mouth a small 'o', antenna twirling; a slow amber pulse.",
    speaking: "Puffed up, hopping and squashing on its syllables, mouth shaping the reply; amber belly glow and tip as bright as its voice."
  },
  mappings: [
    { signal: "agent.onset × level", effect: "A hop per syllable: up to 0.16 units in the air, stretched while up, squashed on landing; the antenna bounces." },
    { signal: "agent.register", effect: "Size +10 % for deep, −3 % for high; hops higher and slower for deep, small and quick for high." },
    { signal: "agent.level", effect: "Amber belly glow and antenna tip brightness; over ~1 s (soft vs loud) body puff ±5 % and mouth range." },
    { signal: "agent.mouth.open / wide / round / sibilance", effect: "Mouth opening, width and rounding (same estimate as the other faces)." },
    { signal: "agent.speaking start", effect: "Eyes glance aside for 0.5–1.2 s at 60 % of utterance starts." },
    { signal: "user.level (live)", effect: "Mint belly glow and antenna tip brightness; antenna quiver amplitude." },
    { signal: "user phrase end (pause after ≥ 0.6 s of speech)", effect: "A nod: the face dips and the body squashes and wobbles back, with a blink." },
    { signal: "user.pitchDelta at phrase end (rising)", effect: "Body tilts toward you (curious), fading over ~3 s." },
    { signal: "user.level over 0.5 s (and voicing)", effect: "Whisper: grows 10 %, stretches up, eyes bigger, face lower (leaning in). Shout: shrinks 10 %, squashes down, eyes squint, smile drops, antenna pulls back." },
    { signal: "user.onset at level > 0.58", effect: "Flinch: a quick shrink-squash that wobbles back, habituating over 3 s." },
    { signal: "user.syllableRate and |pitchDelta|", effect: "Energy: lively speech makes it taller with wider eyes and a bigger smile; flat speech settles it." },
    { signal: "user.register", effect: "Stance: it crouches up to 6 % for a high or child voice (down to eye level) and stands up to 6 % taller for a deep one." },
    { signal: "pointer (inside)", effect: "Leans and looks toward it." },
    { signal: "mode", effect: "Pose blend over ~0.25 s: stretch, puff, eye openness, smile, antenna angle, colour brightness, accent mint → amber." },
    { signal: "time (seeded)", effect: "Blinks, saccades, breathing in the stretch, outline wobble, thinking sway (0.8 rad/s) and antenna twirl." },
    { signal: "reducedMotion", effect: "Held poses: no hops, wobble, breathing, quiver, twirl, sway or blinks; accent brightness in thirds; mouth half open while speaking." },
    {
      signal: "options",
      effect:
        "Size (shrinks only), body shape (gumdrop, round, tall: morphs over ~0.25 s), body colour (features switch to light or dark for contrast); expressiveness scales hops, squash-nods, tilt, lean and shrink; liveliness divides blink and glance intervals; mouth range scales the opening; nods and pointer-following switch off."
    }
  ],
  uses: [
    { ext: "speech.words", gain: "It hops on words rather than detected syllables, which is calmer and more readable.", without: "It hops on detected syllable onsets." },
    { ext: "reply.expression", gain: "A sentiment cue picks a body pose: a bigger, bouncier hop for good news, a smaller one for an apology.", without: "One neutral speaking pose." }
  ],
  renderer: "2d",
  canvas: "stage",
  options: [
    sizeOption(0.5, 1),
    {
      id: "bodyShape",
      kind: "choice",
      label: "Body shape",
      choices: [
        { value: "gumdrop", label: "Gumdrop" },
        { value: "round", label: "Round" },
        { value: "tall", label: "Tall" }
      ],
      default: "gumdrop",
      group: APPEARANCE,
      help: "A gumdrop that widens toward the ground, a round ball, or a tall bean."
    },
    { id: "bodyColor", kind: "color", label: "Body colour", default: GREY, group: APPEARANCE, help: "The colour of its body; the default grey adapts to the theme." },
    EXPRESSIVENESS,
    LIVELINESS,
    MOUTH_RANGE,
    nodsOption("Gives a small squash-nod at the end of each of your phrases."),
    FOLLOWS_POINTER
  ],
  create
}

export default character
