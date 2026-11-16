// @vitest-environment node
/** The runner's frame building and mode resolution (src/characters/runner.ts), with a plain recording character. */
import { describe, expect, it } from "vitest"
import type { Character, CharacterInstance, Focus, Frame, Mode, OptionSpec, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import { areaOf, coreOf, resolveMode, Runner, type StepInput } from "@/characters/runner.ts"
import { PALETTES } from "./support/palettes.ts"

interface Spy {
  readonly character: Character
  readonly frames: Array<Frame & { readonly snapshot: { mode: Mode; prevMode: Mode; modeAge: number; focus: Focus; options: Record<string, unknown>; youColour: ReadonlyArray<number>; pointer: { x: number; y: number; down: boolean; inside: boolean } } }>
  readonly calls: Array<string>
}

const MODES = { idle: "i", listening: "l", hearing: "h", thinking: "t", speaking: "s" }

/** A character that records what the runner hands it. Frame fields are copied: the runner reuses its frame object. */
const spy = (over: Partial<Character> = {}, instance: Partial<CharacterInstance> = {}): Spy => {
  const frames: Spy["frames"] = []
  const calls: Array<string> = []
  const character: Character = {
    id: "spy",
    name: "Spy",
    version: "1.0.0",
    contract: 1,
    family: "abstract",
    summary: "s",
    inspiredBy: "i",
    modes: MODES,
    mappings: [{ signal: "a", effect: "b" }],
    renderer: "2d",
    create: () => ({
      resize: (w, h, dpr) => calls.push(`resize ${w}x${h}@${dpr}`),
      frame: (f) => {
        frames.push({ ...f, snapshot: { mode: f.mode, prevMode: f.prevMode, modeAge: f.modeAge, focus: { ...f.focus }, options: { ...f.options }, youColour: [...f.palette.you], pointer: { ...f.pointer } } })
      },
      dispose: () => calls.push("dispose"),
      ...instance
    }),
    ...over
  }
  return { character, frames, calls }
}

const canvas = () => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement
const quiet = createVoiceFeatures()
const input = (over: Partial<StepInput> = {}): StepInput => ({
  mode: "idle",
  dt: 0.016,
  user: quiet,
  agent: quiet,
  palette: PALETTES.dark,
  reducedMotion: false,
  pointer: { x: 0, y: 0, down: false, inside: false },
  sinceInterrupt: Infinity,
  ...over
})
const started = (s: Spy, stored?: Record<string, number | boolean | string>, size: readonly [number, number, number] = [300, 200, 1]) => {
  const r = new Runner(s.character, canvas(), stored)
  r.create()
  r.resize(...size)
  return r
}

describe("resolveMode / coreOf / areaOf", () => {
  it("a mode a character declares is handed as is, and a core mode always is", () => {
    for (const m of ["idle", "listening", "hearing", "thinking", "speaking"] as const) expect(resolveMode(m, undefined)).toBe(m)
    expect(resolveMode("error", { error: "red" })).toBe("error")
    expect(resolveMode("error", {})).toBe("idle")
  })

  it("does not mistake an inherited property name for a declared mode", () => {
    // `extraModes` is a plain object: "constructor" is on its prototype, but the mode "muted" must not be found there.
    expect(resolveMode("muted", Object.create({ muted: "inherited" }))).toBe("idle")
  })

  it("coreOf gives the end of the fallback chain, and unknown input ends at idle", () => {
    expect(coreOf("muted")).toBe("idle")
    expect(coreOf("speaking")).toBe("speaking")
    expect(coreOf("nonsense" as Mode)).toBe("idle")
  })

  it("areaOf is the box unless a character asks for the stage", () => {
    expect(areaOf({})).toBe("box")
    expect(areaOf({ canvas: "box" })).toBe("box")
    expect(areaOf({ canvas: "stage" })).toBe("stage")
    expect(areaOf({ canvas: "page" as never })).toBe("box")
  })
})

describe("Runner.step: modes", () => {
  it("starts with prevMode equal to the mode and modeAge 0, then ages in the same mode", () => {
    const s = spy()
    const r = started(s)
    r.step(input({ mode: "hearing", dt: 0.05 }))
    r.step(input({ mode: "hearing", dt: 0.05 }))
    r.step(input({ mode: "hearing", dt: 0.05 }))
    expect(s.frames.map((f) => f.snapshot.mode)).toEqual(["hearing", "hearing", "hearing"])
    expect(s.frames.map((f) => f.snapshot.prevMode)).toEqual(["hearing", "hearing", "hearing"])
    expect(s.frames.map((f) => f.snapshot.modeAge)).toEqual([0, 0.05, 0.1])
  })

  it("a change of mode records the old one and restarts the age", () => {
    const s = spy()
    const r = started(s)
    r.step(input({ mode: "idle" }))
    r.step(input({ mode: "idle" }))
    r.step(input({ mode: "speaking" }))
    r.step(input({ mode: "speaking" }))
    expect(s.frames.map((f) => [f.snapshot.prevMode, f.snapshot.mode, f.coreMode])).toEqual([
      ["idle", "idle", "idle"],
      ["idle", "idle", "idle"],
      ["idle", "speaking", "speaking"],
      ["idle", "speaking", "speaking"]
    ])
    expect(s.frames[2]!.snapshot.modeAge).toBe(0)
    expect(s.frames[3]!.snapshot.modeAge).toBeCloseTo(0.016, 12)
  })

  it("two application modes that resolve to the same mode for this character are not a change", () => {
    const s = spy()
    const r = started(s)
    r.step(input({ mode: "muted" }))
    r.step(input({ mode: "asleep" })) // both are "idle" for a character without extra modes
    r.step(input({ mode: "error" }))
    expect(s.frames.map((f) => f.snapshot.mode)).toEqual(["idle", "idle", "idle"])
    expect(s.frames.map((f) => f.snapshot.modeAge)).toEqual([0, 0.016, 0.032])
    // And a character that declares them sees the change, with coreMode still "idle".
    const t = spy({ extraModes: { muted: "m", asleep: "a" } })
    const r2 = started(t)
    r2.step(input({ mode: "muted" }))
    r2.step(input({ mode: "asleep" }))
    expect(t.frames.map((f) => [f.snapshot.mode, f.coreMode, f.snapshot.prevMode])).toEqual([["muted", "idle", "muted"], ["asleep", "idle", "muted"]])
  })

  it("clamps dt to 0..0.1 (a stalled tab or a negative step must not jump the animation)", () => {
    const s = spy()
    const r = started(s)
    r.step(input({ dt: 5 }))
    r.step(input({ dt: -1 }))
    r.step(input({ dt: 0.04 }))
    expect(s.frames.map((f) => f.dt)).toEqual([0.1, 0, 0.04])
    expect(s.frames.map((f) => f.t)).toEqual([0.1, 0.1, 0.14])
  })
})

describe("Runner.step: before create, after dispose", () => {
  it("does nothing until the character exists", () => {
    const s = spy()
    const r = new Runner(s.character, canvas(), undefined)
    r.step(input())
    r.resize(100, 100, 1) // no instance yet: sizes the canvas, tells nobody
    expect(s.frames).toHaveLength(0)
    expect(s.calls).toEqual([])
    expect(r.canvas.width).toBe(100)
  })

  it("dispose releases the instance once, stops frames, and never throws even if the character's dispose does", () => {
    const s = spy({}, { dispose: () => { throw new Error("boom") } })
    const r = started(s)
    r.step(input())
    expect(() => r.dispose()).not.toThrow()
    expect(() => r.dispose()).not.toThrow()
    r.step(input())
    expect(s.frames).toHaveLength(1)
    const t = spy()
    const r2 = started(t)
    r2.dispose()
    r2.dispose()
    expect(t.calls.filter((c) => c === "dispose")).toHaveLength(1)
  })

  it("create and frame errors reach the caller (the host turns them into the baseline fallback)", () => {
    const s = spy({ create: () => { throw new Error("no gl") } })
    const r = new Runner(s.character, canvas(), undefined)
    expect(() => r.create()).toThrow("no gl")
    const t = spy({}, { frame: () => { throw new Error("bad frame") } })
    expect(() => started(t).step(input())).toThrow("bad frame")
  })
})

describe("Runner.resize", () => {
  it("sets the backing store in device pixels (rounded, at least 1) and tells the character CSS pixels and the ratio", () => {
    const s = spy()
    const r = started(s, undefined, [100.4, 50.2, 1.5])
    expect(r.canvas.width).toBe(Math.round(100.4 * 1.5))
    expect(r.canvas.height).toBe(Math.round(50.2 * 1.5))
    expect(s.calls).toEqual(["resize 100.4x50.2@1.5"])
    r.resize(0, 0, 2)
    expect([r.canvas.width, r.canvas.height]).toEqual([1, 1])
  })

  it("without a given focus, a box character's focus is the whole canvas at the size last set", () => {
    const s = spy()
    const r = started(s, undefined, [320, 180, 2])
    r.step(input())
    expect(s.frames[0]!.snapshot.focus).toEqual({ x: 0, y: 0, width: 320, height: 180 })
    r.resize(640, 360, 1)
    r.step(input())
    expect(s.frames[1]!.snapshot.focus).toEqual({ x: 0, y: 0, width: 640, height: 360 })
  })
})

describe("Runner.step: focus (docs/CHARACTERS.md §2.6)", () => {
  const box: Focus = { x: 280, y: 200, width: 720, height: 240 }

  it("a stage character gets the host's focus; a box character always gets the whole canvas", () => {
    const stage = spy({ canvas: "stage" })
    started(stage, undefined, [1280, 800, 1]).step(input({ focus: box }))
    expect(stage.frames[0]!.snapshot.focus).toEqual(box)
    const plain = spy()
    started(plain, undefined, [1280, 800, 1]).step(input({ focus: box }))
    expect(plain.frames[0]!.snapshot.focus).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  })

  it("a stage character with no focus, or a focus that is not a finite rectangle, gets the whole canvas", () => {
    const s = spy({ canvas: "stage" })
    const r = started(s, undefined, [900, 500, 1])
    r.step(input())
    for (const bad of [{ ...box, x: Number.NaN }, { ...box, width: Infinity }, { ...box, y: -Infinity }, { ...box, height: Number.NaN }]) r.step(input({ focus: bad }))
    for (const f of s.frames) expect(f.snapshot.focus).toEqual({ x: 0, y: 0, width: 900, height: 500 })
    expect(s.frames).toHaveLength(5)
  })

  it("a focus with no area is held to at least 1 × 1, and follows the host from frame to frame", () => {
    const s = spy({ canvas: "stage" })
    const r = started(s, undefined, [900, 500, 1])
    r.step(input({ focus: { x: 10, y: 20, width: 0, height: -5 } }))
    r.step(input({ focus: { x: 30, y: 40, width: 100, height: 50 } }))
    expect(s.frames[0]!.snapshot.focus).toEqual({ x: 10, y: 20, width: 1, height: 1 })
    expect(s.frames[1]!.snapshot.focus).toEqual({ x: 30, y: 40, width: 100, height: 50 })
  })
})

describe("Runner.step: voices, palette and options", () => {
  const voice = (level: number): VoiceFeatures => {
    const f = createVoiceFeatures()
    f.level = level
    f.rms = level / 10
    f.low = level
    f.bands[0] = level
    f.speaking = true
    return f
  }

  it("active is the assistant's voice while speaking and the person's otherwise", () => {
    const s = spy()
    const r = started(s)
    const user = voice(0.2)
    const agent = voice(0.7)
    for (const mode of ["listening", "hearing", "thinking", "idle", "speaking", "muted"] as const) r.step(input({ mode, user, agent }))
    expect(s.frames.map((f) => f.active === f.agent)).toEqual([false, false, false, false, true, false])
    expect(s.frames[4]!.agent.level).toBe(0.7)
  })

  it("at sensitivity 1 the features are passed through untouched; otherwise scaled copies, clamped, never the input itself", () => {
    const user = voice(0.4)
    const agent = voice(0.5)
    const plain = spy()
    started(plain).step(input({ user, agent }))
    expect(plain.frames[0]!.user).toBe(user)
    expect(plain.frames[0]!.agent).toBe(agent)

    const loud = spy()
    started(loud, { $sensitivity: 2 }).step(input({ user, agent }))
    const f = loud.frames[0]!
    expect(f.user).not.toBe(user)
    expect(f.user.level).toBeCloseTo(0.8, 6)
    expect(f.agent.level).toBe(1)
    expect(f.user.bands[0]).toBeCloseTo(0.8, 6)
    expect(user.level).toBe(0.4)
    expect(f.user.speaking).toBe(true)

    const soft = spy()
    started(soft, { $sensitivity: 0.5 }).step(input({ user, agent }))
    expect(soft.frames[0]!.user.level).toBeCloseTo(0.2, 6)
  })

  it("recolours you and voice from the host-level options, and only rebuilds the palette when something changed", () => {
    const s = spy()
    const r = started(s, { $you: "#ff0000", $voice: "#0000ff" })
    r.step(input())
    r.step(input())
    expect(s.frames[0]!.palette.you).toEqual([255, 0, 0])
    expect(s.frames[0]!.palette.voice).toEqual([0, 0, 255])
    expect(s.frames[0]!.palette.ink).toBe(PALETTES.dark.ink)
    expect(s.frames[1]!.palette).toBe(s.frames[0]!.palette)
    // A new base palette (the theme changed) is recoloured again.
    r.step(input({ palette: PALETTES.light }))
    expect(s.frames[2]!.palette).not.toBe(s.frames[0]!.palette)
    expect(s.frames[2]!.palette.ink).toBe(PALETTES.light.ink)
    expect(s.frames[2]!.palette.you).toEqual([255, 0, 0])
    // Default recolouring hands the page's palette through as is.
    const d = spy()
    started(d).step(input())
    expect(d.frames[0]!.palette).toBe(PALETTES.dark)
  })

  it("copies the pointer, reduced motion, sinceInterrupt and extensions each frame, and an absent ext is an empty object", () => {
    const s = spy()
    const r = started(s)
    const ext = { lipsync: { open: 1 } } as never
    r.step(input({ pointer: { x: 5, y: 6, down: true, inside: true }, reducedMotion: true, sinceInterrupt: 0.25, ext }))
    r.step(input())
    const [a, b] = s.frames
    expect(a!.snapshot.pointer).toEqual({ x: 5, y: 6, down: true, inside: true })
    expect(b!.snapshot.pointer).toEqual({ x: 0, y: 0, down: false, inside: false })
    expect(a!.reducedMotion).toBe(true)
    expect(a!.sinceInterrupt).toBe(0.25)
    expect(a!.ext).toBe(ext)
    expect(b!.reducedMotion).toBe(false)
    expect(b!.sinceInterrupt).toBe(Infinity)
    expect(b!.ext).toEqual({})
    expect(Object.isFrozen(b!.ext)).toBe(true)
  })

  const SPECS: ReadonlyArray<OptionSpec> = [
    { id: "count", kind: "number", label: "Count", min: 1, max: 10, step: 1, default: 3 },
    { id: "ring", kind: "toggle", label: "Ring", default: false }
  ]

  it("validates the stored options against the declaration, and setStored applies new ones from the next frame", () => {
    const s = spy({ options: SPECS })
    const r = started(s, { count: 99, ring: "maybe", ghost: 1 })
    r.step(input())
    expect(s.frames[0]!.snapshot.options).toEqual({ count: 10, ring: false })
    r.setStored({ count: 4.4, ring: true })
    r.step(input())
    expect(s.frames[1]!.snapshot.options).toEqual({ count: 4, ring: true })
    r.setStored(undefined)
    r.step(input())
    expect(s.frames[2]!.snapshot.options).toEqual({ count: 3, ring: false })
    expect(r.options.values).toEqual({ count: 3, ring: false })
  })

  it("setStored with new host-level colours recolours on the next frame even though the page palette is the same object", () => {
    const s = spy()
    const r = started(s)
    r.step(input())
    expect(s.frames[0]!.snapshot.youColour).toEqual([...PALETTES.dark.you])
    r.setStored({ $you: "#123456" })
    r.step(input())
    expect(s.frames[1]!.snapshot.youColour).toEqual([0x12, 0x34, 0x56])
  })

  it("changes the options' version on every setStored, so characters can tell a change from none", () => {
    const s = spy({ options: SPECS })
    const r = started(s)
    const v0 = r.options.version
    r.setStored({ count: 2 })
    const v1 = r.options.version
    r.setStored({ count: 2 })
    expect(v1).toBeGreaterThan(v0)
    expect(r.options.version).toBeGreaterThan(v1)
  })
})
