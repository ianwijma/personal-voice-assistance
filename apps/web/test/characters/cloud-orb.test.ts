/**
 * What is particular to the cloud orb, read off the uniforms it sends to its shader through the runner on the
 * fake WebGL2 context (the shader's own pixels are not run). The shared suites (`compat.test.ts`, `isolation.test.ts`)
 * already cover its manifest, every mode, option extremes, garbage in storage, reduced-motion stillness, the
 * recorded digest and the stage placement; this adds the design's own promises, as `modes`, `mappings` and
 * `options` declare them:
 *   - the orb sits on the focus box and never leaves it, whatever the size and swell; pressing shrinks it 5 %;
 *   - your loudness swells it (unless Size reaction is 0), and the options scale it, its grain, its halo and its pace;
 *   - clouds flow in while listening and hearing, out while speaking; a syllable sends a ring in (you) or out (it);
 *   - the inner light follows the pointer and, while a voice speaks, its pitch (unless Follow pitch is 0);
 *   - under reduced motion nothing flows, churns, swirls or rings;
 *   - the colour says the mode, and thinking marbles two colours.
 */
import { describe, expect, it } from "vitest"
import type { Focus, Mode, Palette, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import cloudOrb from "@/characters/library/cloud-orb.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const CANVAS: readonly [number, number] = [1280, 800]
const BOX: Focus = { x: 280, y: 197, width: 720, height: 240 }
const DPR = 2
const DT = 1 / 60
type Stored = Record<string, number | boolean | string>

const voice = (over: Partial<VoiceFeatures> = {}): VoiceFeatures => ({ ...createVoiceFeatures(), ...over })
const LOUD = { level: 0.8, rms: 0.1, speaking: true, voicing: 0.8, brightness: 0.5 } satisfies Partial<VoiceFeatures>

interface Drive {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  /** Called before each frame (to pulse an onset, say), with the frame number from 0. */
  readonly each?: (i: number, user: VoiceFeatures, agent: VoiceFeatures) => void
  readonly palette?: Palette
  readonly reduced?: boolean
  readonly pointer?: { x: number; y: number; down: boolean; inside: boolean }
  readonly focus?: Focus
}

/** An orb on a canvas whose WebGL calls are recorded: `u(name)` is the last value sent for a uniform. */
const orb = (stored: Stored = {}) => {
  const canvas = document.createElement("canvas")
  const real = canvas.getContext.bind(canvas) as (type: string, ...rest: Array<unknown>) => unknown
  const latest = new Map<string, Array<number>>()
  canvas.getContext = ((type: string, ...rest: Array<unknown>) => {
    const ctx = real(type, ...rest)
    if (type !== "webgl2" || ctx === null) return ctx
    return new Proxy(ctx as object, {
      get(target, prop) {
        const value = (target as Record<string, unknown>)[prop as string]
        if (typeof prop !== "string" || typeof value !== "function" || !prop.startsWith("uniform")) return value
        return (...args: Array<unknown>) => {
          const loc = args[0] as { uniform?: string } | null
          if (loc?.uniform !== undefined) latest.set(loc.uniform, args.slice(1) as Array<number>)
          return (value as (...a: Array<unknown>) => unknown)(...args)
        }
      }
    })
  }) as never
  const runner = new Runner(cloudOrb, canvas, stored)
  runner.create()
  runner.resize(CANVAS[0], CANVAS[1], DPR)
  const user = voice()
  const agent = voice()
  const api = {
    /** `frames` frames in `mode`; the voices are the ones in `d`, or silent. */
    run(mode: Mode, frames: number, d: Drive = {}) {
      const u = d.user ?? user
      const a = d.agent ?? agent
      for (let i = 0; i < frames; i++) {
        d.each?.(i, u, a)
        runner.step({ mode, dt: DT, user: u, agent: a, palette: d.palette ?? PALETTES.dark, reducedMotion: d.reduced === true, pointer: d.pointer ?? { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity, focus: d.focus ?? BOX })
      }
      return api
    },
    /** The number last sent for a one-number uniform. */
    u: (name: string): number => latest.get(name)![0]!,
    /** The values last sent for a vector uniform. */
    v: (name: string): ReadonlyArray<number> => latest.get(name)!,
    setStored: (s: Stored) => runner.setStored(s)
  }
  return api
}

/** One orb, pinned in `mode` from its first frame (so there is no crossfade), the number a uniform holds after `frames`. */
const read = (name: string, mode: Mode, frames: number, d: Drive = {}, stored: Stored = {}): number => orb(stored).run(mode, frames, d).u(name)

const CAP = 0.48 * Math.min(BOX.width, BOX.height) * DPR // the orb's largest radius, device px
const MODES: ReadonlyArray<Mode> = ["idle", "listening", "hearing", "thinking", "speaking"]

describe("cloud orb: where it is and how big", () => {
  it("is centred on the focus box (device px, y up), and follows it when it moves", () => {
    const o = orb().run("idle", 3)
    expect(o.v("uCen")).toEqual([(BOX.x + BOX.width / 2) * DPR, (CANVAS[1] - BOX.y - BOX.height / 2) * DPR])
    const moved: Focus = { x: 100, y: 400, width: 300, height: 300 }
    expect(o.run("idle", 1, { focus: moved }).v("uCen")).toEqual([(100 + 150) * DPR, (CANVAS[1] - 400 - 150) * DPR])
  })

  it("never leaves the box: at the biggest size and reaction with a loud voice it stops at 48 % of the short side", () => {
    const big: Stored = { size: 1.25, swell: 2 }
    for (const [mode, d] of [["hearing", { user: voice(LOUD) }], ["speaking", { agent: voice(LOUD) }], ["listening", {}], ["idle", {}]] as const) {
      const r = read("uR", mode, 90, d, big)
      expect(r, mode).toBeLessThanOrEqual(CAP + 1e-6)
    }
    expect(read("uR", "hearing", 90, { user: voice(LOUD) }, big)).toBeCloseTo(CAP, 6)
    // And on a tall, narrow box, the short side is the width.
    const narrow: Focus = { x: 20, y: 100, width: 200, height: 600 }
    expect(read("uR", "hearing", 90, { user: voice(LOUD), focus: narrow }, big)).toBeCloseTo(0.48 * 200 * DPR, 6)
  })

  it("the size option scales it (below the cap)", () => {
    const radius = (size: number) => read("uR", "idle", 5, { reduced: true }, { size })
    expect(radius(0.5)).toBeCloseTo(0.5 * radius(1), 6)
    expect(radius(1)).toBeLessThan(CAP)
  })

  it("is smallest at rest: idle is smaller than every other mode", () => {
    const idle = read("uR", "idle", 5, { reduced: true })
    for (const m of MODES.filter((m) => m !== "idle")) expect(read("uR", m, 5, { reduced: true }), m).toBeGreaterThan(idle)
  })

  it("swells with your loudness while hearing, and not at all with Size reaction at 0", () => {
    const loud = { user: voice(LOUD), reduced: true }
    const quiet = read("uR", "hearing", 5, { reduced: true })
    expect(read("uR", "hearing", 5, loud)).toBeGreaterThan(1.1 * quiet)
    expect(read("uR", "hearing", 5, loud, { swell: 0 })).toBeCloseTo(read("uR", "hearing", 5, { reduced: true }, { swell: 0 }), 6)
    // Its own loudness does not swell it while you are the one talking.
    expect(read("uR", "hearing", 5, { agent: voice(LOUD), reduced: true })).toBeCloseTo(quiet, 6)
  })

  it("shrinks 5 % while the pointer presses it, and only when the press is on the box", () => {
    const at = { x: BOX.x + 10, y: BOX.y + 10 }
    const rest = read("uR", "idle", 5, { reduced: true })
    expect(read("uR", "idle", 5, { reduced: true, pointer: { ...at, down: true, inside: true } })).toBeCloseTo(0.95 * rest, 6)
    expect(read("uR", "idle", 5, { reduced: true, pointer: { x: 5, y: 5, down: true, inside: true } })).toBeCloseTo(rest, 6) // pressed elsewhere on the stage
    expect(read("uR", "idle", 5, { reduced: true, pointer: { ...at, down: true, inside: false } })).toBeCloseTo(rest, 6)
  })

  it("still shrinks 5 % under a press at the largest size and reaction, where the cap applies", () => {
    const big: Stored = { size: 1.25, swell: 2 }
    const at = { x: BOX.x + 10, y: BOX.y + 10 }
    const d = { user: voice(LOUD), reduced: true }
    const rest = read("uR", "hearing", 5, d, big)
    expect(rest).toBeCloseTo(CAP, 6)
    expect(read("uR", "hearing", 5, { ...d, pointer: { ...at, down: true, inside: true } }, big)).toBeCloseTo(0.95 * CAP, 6)
  })

  it("draws nothing, rather than a zero radius, for a degenerate focus box (the shader divides by the radius)", () => {
    const centre = { x: 0, y: 0, down: false, inside: true }
    for (const focus of [{ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 200 }, { x: 0, y: 0, width: 200, height: 0 }]) {
      const o = orb().run("idle", 3, { focus, pointer: centre })
      expect(() => o.u("uR"), `${focus.width}x${focus.height}`).toThrow() // the uniform was never sent: no draw
    }
    // A normal box with the pointer at its exact centre sends a finite light position.
    const mid = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2, down: false, inside: true }
    const light = orb().run("idle", 3, { pointer: mid }).v("uLight")
    expect(light.every(Number.isFinite)).toBe(true)
    expect(orb().run("idle", 3).u("uR")).toBeGreaterThan(0)
  })
})

describe("cloud orb: which way the clouds flow", () => {
  /** How far the flow phase moves in one second, after a second to get going. */
  const flow = (mode: Mode, d: Drive = {}, stored: Stored = {}) => {
    const o = orb(stored).run(mode, 60, d)
    const before = o.u("uZoom")
    return o.run(mode, 60, d).u("uZoom") - before
  }

  it("inward while it listens and hears (the phase rises), outward while it speaks (it falls)", () => {
    expect(flow("listening")).toBeGreaterThan(0)
    expect(flow("hearing")).toBeGreaterThan(0)
    expect(flow("speaking")).toBeLessThan(0)
  })

  it("flows faster the louder you are while hearing, and the louder the reply while speaking (up to the curve's peak)", () => {
    expect(flow("hearing", { user: voice(LOUD) })).toBeGreaterThan(1.5 * flow("hearing"))
    const reply = (level: number) => Math.abs(flow("speaking", { agent: voice({ ...LOUD, level }) }))
    // After ElevenLabs' curve, 0.1 + 0.9·(1 − (l − 1)²): a quiet reply is slow, a firm one fast.
    expect(reply(0.5)).toBeGreaterThan(reply(0.02))
  })

  it("Motion speed scales the flow, the churn and the swirl together", () => {
    const slow = orb({ speed: 0.5 }).run("thinking", 60)
    const fast = orb({ speed: 2 }).run("thinking", 60)
    for (const name of ["uZoom", "uChurn", "uSwirl"]) expect(fast.u(name), name).toBeCloseTo(4 * slow.u(name), 6)
  })

  it("under reduced motion nothing flows, churns or swirls, however long it runs and whatever Motion speed is", () => {
    for (const mode of MODES) {
      const o = orb({ speed: 2 }).run(mode, 120, { reduced: true, user: voice(LOUD), agent: voice(LOUD) })
      expect([o.u("uZoom"), o.u("uChurn"), o.u("uSwirl")], mode).toEqual([0, 0, 0])
    }
    expect(read("uChurn", "thinking", 120)).toBeGreaterThan(0) // while with motion they run
  })
})

describe("cloud orb: syllable rings", () => {
  /** An onset pulse on frame 1 of `side` (a rising edge past the threshold, then back down). */
  const pulse = (side: "user" | "agent") => (i: number, user: VoiceFeatures, agent: VoiceFeatures) => {
    const v = side === "user" ? user : agent
    v.onset = i === 1 ? 1 : 0
  }
  const ring = (mode: Mode, frames: number, side: "user" | "agent", stored: Stored = {}, reduced = false) => {
    const o = orb(stored).run(mode, frames, { user: voice(LOUD), agent: voice(LOUD), each: pulse(side), reduced })
    return o.v("uRing")
  }

  it("a syllable of yours sends a ring in from the rim, which then moves toward the centre", () => {
    const [r1, s1] = ring("hearing", 3, "user")
    const [r2] = ring("hearing", 12, "user")
    expect(s1).toBeGreaterThan(0.3)
    expect(r1).toBeGreaterThan(0.85)
    expect(r2).toBeLessThan(r1!)
  })

  it("a syllable of the assistant's sends a ring out from the centre, which then moves toward the rim", () => {
    const [r1, s1] = ring("speaking", 3, "agent")
    const [r2] = ring("speaking", 12, "agent")
    expect(s1).toBeGreaterThan(0.3)
    expect(r1).toBeLessThan(0.15)
    expect(r2).toBeGreaterThan(r1!)
  })

  it("the ring fades away on its own", () => {
    expect(ring("hearing", 150, "user")[1]).toBeLessThan(0.02)
  })

  it("only the active voice makes one: the assistant's syllables while you talk send nothing", () => {
    expect(ring("hearing", 3, "agent")[1]).toBe(0)
    expect(ring("listening", 3, "user")[1]).toBe(0)
  })

  it("Syllable rings off, or reduced motion, sends none", () => {
    expect(ring("hearing", 3, "user", { rings: false })[1]).toBe(0)
    expect(ring("hearing", 3, "user", {}, true)[1]).toBe(0)
    expect(ring("speaking", 3, "agent", {}, true)[1]).toBe(0)
  })
})

describe("cloud orb: the light inside and the look of the clouds", () => {
  const inside = (dx: number) => ({ x: BOX.x + BOX.width / 2 + dx, y: BOX.y + BOX.height / 2, down: false, inside: true })

  it("the inner light follows the pointer: right of the middle is positive, left negative, and it stays within 0.7 radii (a pointer near the box edge)", () => {
    const x = (dx: number, inside_ = true) => orb().run("idle", 5, { reduced: true, pointer: { ...inside(dx), inside: inside_ } }).v("uLight")[0]!
    expect(x(40)).toBeGreaterThan(0)
    expect(x(-40)).toBeLessThan(0)
    expect(x(-40)).toBeCloseTo(-x(40), 6)
    expect(x(350)).toBeCloseTo(0.7, 6)
    expect(x(-350)).toBeCloseTo(-0.7, 6)
    expect(x(40, false)).toBe(0) // pointer elsewhere: the light rests in the middle
  })

  it("while a voice speaks the light pools high for a high pitch and low for a low one; Follow pitch at 0 ignores it", () => {
    const y = (pitch: number, stored: Stored = {}) => orb(stored).run("speaking", 5, { reduced: true, agent: voice({ ...LOUD, pitch }) }).v("uLight")[1]!
    expect(y(0.95)).toBeGreaterThan(y(0.05) + 0.3)
    expect(y(0.95, { pitch: 0 })).toBeCloseTo(y(0.05, { pitch: 0 }), 6)
    expect(y(0.95, { pitch: 2 }) - y(0.05, { pitch: 2 })).toBeGreaterThan(y(0.95) - y(0.05))
  })

  it("the clouds' grain follows the register: broad for a deep voice (0.45), fine for a child's (1.9); Cloud grain scales it", () => {
    const grain = (register: number, stored: Stored = {}) => orb(stored).run("speaking", 5, { reduced: true, agent: voice({ ...LOUD, register }) }).u("uDetail")
    expect(grain(0.1)).toBeCloseTo(0.45, 6)
    expect(grain(0.95)).toBeCloseTo(1.9, 6)
    expect(grain(0.5)).toBeGreaterThan(grain(0.1))
    expect(grain(0.95, { grain: 2 })).toBeCloseTo(2 * grain(0.95), 6)
    expect(grain(0.95, { grain: 0.5 })).toBeCloseTo(0.5 * grain(0.95), 6)
  })

  it("Look picks the clouds, the contour bands or the smooth ball", () => {
    const look = (look: string) => {
      const o = orb({ look }).run("idle", 5, { reduced: true })
      return [o.u("uBands"), o.u("uSmooth")]
    }
    expect(look("clouds")).toEqual([0, 0])
    expect(look("bands")).toEqual([1, 0])
    expect(look("smooth")).toEqual([0, 1])
  })

  it("the Halo option scales the light around the orb, and 0 turns it off", () => {
    const halo = (halo: number) => read("uHalo", "listening", 5, { reduced: true }, { halo })
    expect(halo(0)).toBe(0)
    expect(halo(1)).toBeGreaterThan(0)
    expect(halo(1.5)).toBeCloseTo(1.5 * halo(1), 6)
  })

  it("tells the theme to the shader", () => {
    expect(read("uDark", "idle", 2, { palette: PALETTES.dark })).toBe(1)
    expect(read("uDark", "idle", 2, { palette: PALETTES.light })).toBe(0)
  })
})

describe("cloud orb: the colour says the mode", () => {
  const body = (mode: Mode, palette: Palette = PALETTES.dark) => orb().run(mode, 120, { reduced: true, palette }).v("uB") // the orb's body tone, 0..1
  const dist = (a: ReadonlyArray<number>, c: ReadonlyArray<number>) => Math.hypot(a[0]! - c[0]! / 255, a[1]! - c[1]! / 255, a[2]! - c[2]! / 255)

  it("thinking marbles both colours; no other mode does", () => {
    for (const m of MODES) expect(read("uTwoTone", m, 60, { reduced: true }), m).toBeCloseTo(m === "thinking" ? 0.85 : 0, 6)
  })

  it("speaks in the assistant's amber, hears in your mint, and rests in grey", () => {
    for (const palette of [PALETTES.dark, PALETTES.light]) {
      const [you, voiceC] = [palette.you, palette.voice]
      const speaking = body("speaking", palette)
      const hearing = body("hearing", palette)
      const idle = body("idle", palette)
      expect(dist(speaking, voiceC), "speaking is nearer amber than mint").toBeLessThan(dist(speaking, you))
      expect(dist(hearing, you), "hearing is nearer mint than amber").toBeLessThan(dist(hearing, voiceC))
      expect(dist(idle, palette.inkFaint), "idle is nearer the faint grey than either").toBeLessThan(Math.min(dist(idle, you), dist(idle, voiceC)))
    }
  })

  it("the second colour family is always the assistant's amber, so thinking can marble to it", () => {
    const o = orb().run("thinking", 60, { reduced: true })
    expect(o.v("uB2")).toEqual(orb().run("speaking", 60, { reduced: true }).v("uB")) // speaking's own body tone is the amber
  })
})
