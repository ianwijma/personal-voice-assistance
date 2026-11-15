/**
 * The character host (src/characters/host.ts): loading and swapping, mode resolution, options validation on load,
 * the isolation rules of docs/CHARACTERS.md §4.6, and what it puts in the frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Character, CharacterChoice, Frame, Mode } from "@/characters/contract.ts"
import { type AudioTaps, type CharacterHost, type HostInput, type HostOptions, startCharacterHost } from "@/characters/host.ts"
import { BASELINE_ID, registry as appRegistry, type Registry } from "@/characters/registry.ts"
import { installFakeCanvas } from "./support/fakeCanvas.ts"
import { installPage, type Page } from "./support/page.ts"
import testDots from "./support/test-dots.ts"

installFakeCanvas()

/** A character that keeps a copy of what each frame told it, and can be told to fail or to be slow. */
const spy = (over: Partial<Character> & { readonly onFrame?: (f: Frame) => void; readonly onCreate?: () => void; readonly onResize?: () => void } = {}) => {
  const seen: Array<{ mode: Mode; coreMode: string; prevMode: Mode; modeAge: number; sinceInterrupt: number; ext: object; reduced: boolean; userLevel: number; userSpeaking: boolean; agentLevel: number; agentRms: number; options: object; you: readonly number[] }> = []
  let disposed = 0
  const { onFrame, onCreate, onResize, ...manifest } = over
  const c: Character = {
    id: "spy",
    name: "Spy",
    version: "1.0.0",
    contract: 1,
    family: "abstract",
    summary: "Records frames.",
    inspiredBy: "Tests.",
    modes: { idle: "a", listening: "b", hearing: "c", thinking: "d", speaking: "e" },
    mappings: [{ signal: "everything", effect: "recorded" }],
    renderer: "2d",
    create: (canvas) => {
      onCreate?.()
      canvas.getContext(c.renderer === "webgl2" ? "webgl2" : "2d")
      return {
        resize: () => onResize?.(),
        frame: (f) => {
          seen.push({ mode: f.mode, coreMode: f.coreMode, prevMode: f.prevMode, modeAge: f.modeAge, sinceInterrupt: f.sinceInterrupt, ext: f.ext, reduced: f.reducedMotion, userLevel: f.user.level, userSpeaking: f.user.speaking, agentLevel: f.agent.level, agentRms: f.agent.rms, options: { ...f.options }, you: [...f.palette.you] })
          onFrame?.(f)
        },
        dispose: () => {
          disposed++
        }
      }
    },
    ...manifest
  }
  return { character: c, seen, disposed: () => disposed }
}

/** A registry with the real baseline and the given characters, each loaded lazily through a spy. */
const registryOf = (chars: { readonly [id: string]: unknown }) => {
  const load = vi.fn((id: string) => (id === BASELINE_ID ? Promise.resolve(appRegistry.baseline) : Object.hasOwn(chars, id) ? Promise.resolve(chars[id]) : undefined))
  const reg: Registry = { ids: [BASELINE_ID, ...Object.keys(chars)].sort(), baseline: appRegistry.baseline, load }
  return { reg, load }
}

const silentTaps = (over: Partial<AudioTaps> = {}): AudioTaps => ({ readMic: () => false, micRate: () => 16000, analyser: () => null, interruptedAt: () => -Infinity, ...over })

let page: Page
let canvas: HTMLCanvasElement
let warn: ReturnType<typeof vi.fn<(m: string, e?: unknown) => void>>
const hosts: Array<CharacterHost> = []

beforeEach(() => {
  page = installPage()
  const stage = document.createElement("div")
  canvas = document.createElement("canvas")
  canvas.className = "stage-canvas"
  stage.append(canvas)
  document.body.append(stage)
  warn = vi.fn<(m: string, e?: unknown) => void>()
})

afterEach(() => {
  for (const h of hosts.splice(0)) h.stop()
  document.body.innerHTML = ""
  page.restore()
})

const start = (input: HostInput, choice: CharacterChoice | undefined, options: HostOptions) => {
  const h = startCharacterHost(canvas, input, choice, { taps: silentTaps(), warn, ...options })
  hosts.push(h)
  return h
}

describe("loading and swapping", () => {
  it("draws the baseline at once and loads another character only when chosen, as its own load", async () => {
    const { reg, load } = registryOf({ "test-dots": testDots })
    const host = start({ state: "idle", owner: false }, undefined, { registry: reg })
    expect(host.debug()).toMatchObject({ id: BASELINE_ID, requested: BASELINE_ID, loading: null, fallback: null, frames: 1 })
    page.frames(3)
    expect(host.debug().frames).toBe(4)
    expect(load).not.toHaveBeenCalled()

    host.setChoice({ character: "test-dots" })
    expect(host.debug()).toMatchObject({ id: BASELINE_ID, requested: "test-dots", loading: "test-dots" })
    page.frames(2) // the baseline keeps drawing meanwhile
    expect(host.debug().id).toBe(BASELINE_ID)
    await host.ready()
    // Swapped inside the load's own task: the new character has drawn its first frame, no blank frame between.
    expect(host.debug()).toMatchObject({ id: "test-dots", loading: null, fallback: null, frames: 1, renderer: "2d" })
    expect(load).toHaveBeenCalledTimes(1)

    host.setChoice(undefined)
    expect(host.debug().id).toBe(BASELINE_ID)
    host.setChoice({ character: "test-dots" })
    expect(host.debug().id).toBe("test-dots") // loaded once, kept
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("the real registry: the baseline is bundled, every other id is a lazy loader", async () => {
    expect(appRegistry.ids).toContain(BASELINE_ID)
    expect(await appRegistry.load(BASELINE_ID)).toBe(appRegistry.baseline)
    expect(appRegistry.load("no-such-character")).toBeUndefined()
    for (const id of appRegistry.ids) expect(appRegistry.load(id)).toBeInstanceOf(Promise)
  })

  it("a choice that arrives while another is loading wins", async () => {
    let resolveSlow: (c: Character) => void = () => undefined
    const slow = new Promise<Character>((r) => (resolveSlow = r))
    const fast = spy({ id: "fast" })
    const reg: Registry = { ids: [BASELINE_ID, "fast", "slow"], baseline: appRegistry.baseline, load: (id) => (id === "slow" ? slow : id === "fast" ? Promise.resolve(fast.character) : undefined) }
    const host = start({ state: "idle", owner: false }, { character: "slow" }, { registry: reg })
    host.setChoice({ character: "fast" })
    await host.ready()
    expect(host.debug().id).toBe("fast")
    resolveSlow(spy({ id: "slow" }).character)
    await Promise.resolve()
    expect(host.debug().id).toBe("fast")
  })

  it("follows option changes of the current character without reloading it", async () => {
    const s = spy()
    const { reg, load } = registryOf({ spy: s.character })
    const host = start({ state: "idle", owner: false }, { character: "spy" }, { registry: reg })
    await host.ready()
    host.setChoice({ character: "spy", options: { $you: "#102030" } })
    page.frames(1)
    expect(s.seen.at(-1)!.you).toEqual([16, 32, 48])
    expect(load).toHaveBeenCalledTimes(1)
    expect(s.disposed()).toBe(0)
  })
})

describe("options on load (docs/CHARACTERS.md §4.4)", () => {
  it("validates stored values against the declaration: clamped, snapped, unknown dropped, garbage replaced", async () => {
    const { reg } = registryOf({ "test-dots": testDots })
    const host = start({ state: "idle", owner: false }, { character: "test-dots", options: { count: "99", size: 1.333, ring: "yes", shape: "hexagon", tint: "#ABCDEF", bogus: 1, $sensitivity: 0 } }, { registry: reg })
    await host.ready()
    expect(host.debug().options).toEqual({ size: 1.35, count: 9, ring: true, shape: "circle", tint: "#abcdef" })
    expect(host.debug().hostOptions).toEqual({ $you: "you", $voice: "voice", $sensitivity: 0.4 })
  })

  it("a fallback baseline keeps the host-level settings and none of the other character's options", () => {
    const { reg } = registryOf({})
    const host = start({ state: "idle", owner: false }, { character: "gone", options: { speed: 2, $sensitivity: 2 } }, { registry: reg })
    expect(host.debug().options).toMatchObject({ speed: 1 })
    expect(host.debug().hostOptions).toMatchObject({ $sensitivity: 2 })
  })
})

describe("modes (docs/CHARACTERS.md §4.3)", () => {
  it("hands a character only modes it declared, walking the fallbacks, with coreMode, prevMode and modeAge", async () => {
    const s = spy({ extraModes: { muted: "Crossed out." } })
    const { reg } = registryOf({ spy: s.character })
    const input: HostInput = { state: "listening", owner: false }
    const host = start(input, { character: "spy" }, { registry: reg })
    await host.ready()
    page.frames(2)
    input.state = "asleep"
    page.frames(1)
    expect(s.seen.at(-1)).toMatchObject({ mode: "idle", coreMode: "idle", prevMode: "listening", modeAge: 0 })
    page.frames(3)
    expect(s.seen.at(-1)!.modeAge).toBeCloseTo(3 / 60)
    input.state = "not-started" // also idle for this character: no mode change
    page.frames(1)
    expect(s.seen.at(-1)).toMatchObject({ mode: "idle", prevMode: "listening" })
    expect(s.seen.at(-1)!.modeAge).toBeCloseTo(4 / 60)
    input.state = "muted"
    page.frames(1)
    expect(s.seen.at(-1)).toMatchObject({ mode: "muted", coreMode: "idle", prevMode: "idle", modeAge: 0 })
    input.state = "error"
    page.frames(1)
    expect(s.seen.at(-1)).toMatchObject({ mode: "idle", coreMode: "idle", prevMode: "muted" })
    expect(s.seen.every((f) => ["idle", "listening", "hearing", "thinking", "speaking", "muted"].includes(f.mode))).toBe(true)
  })
})

describe("the frame", () => {
  it("fills sinceInterrupt, reduced motion, an empty ext and the host-level colours", async () => {
    let interruptedAt = -Infinity
    const s = spy()
    const { reg } = registryOf({ spy: s.character })
    const host = start({ state: "speaking", owner: true }, { character: "spy", options: { $you: "#ff0000" } }, { registry: reg, taps: silentTaps({ interruptedAt: () => interruptedAt }) })
    await host.ready()
    page.frames(1)
    expect(s.seen.at(-1)).toMatchObject({ sinceInterrupt: Infinity, ext: {}, reduced: false, you: [255, 0, 0] })
    interruptedAt = performance.now()
    page.frames(6, 50)
    expect(s.seen.at(-1)!.sinceInterrupt).toBeCloseTo(0.3)
    page.setReducedMotion(true)
    page.frames(1)
    expect(s.seen.at(-1)!.reduced).toBe(true)
  })

  it("an observer gets moving stand-in voices: the person while hearing, the assistant while speaking", async () => {
    const s = spy()
    const { reg } = registryOf({ spy: s.character })
    const input: HostInput = { state: "hearing", owner: false }
    const host = start(input, { character: "spy" }, { registry: reg })
    await host.ready()
    page.frames(30)
    const levels = s.seen.slice(-20).map((f) => f.userLevel)
    expect(s.seen.at(-1)!.userSpeaking).toBe(true)
    expect(Math.min(...levels)).toBeGreaterThan(0.2)
    expect(Math.max(...levels)).toBeGreaterThan(Math.min(...levels)) // it moves
    expect(s.seen.at(-1)!.agentLevel).toBe(0)
    input.state = "speaking"
    page.frames(60)
    expect(s.seen.at(-1)!.agentLevel).toBeGreaterThan(0.2)
    expect(s.seen.at(-1)!.userLevel).toBe(0) // the side that is not on decays to silence
    // The old visualiser's observer level, 0.35 + 0.15·noise(t), comes back through the baseline's √(rms·5).
    const back = Math.sqrt(s.seen.at(-1)!.agentRms * 5)
    expect(back).toBeGreaterThan(0.19)
    expect(back).toBeLessThan(0.51)
  })

  it("the owner's person comes from the microphone ring, only while the microphone matters", async () => {
    const s = spy()
    const { reg } = registryOf({ spy: s.character })
    let n = 0
    const tone = (out: Float32Array) => {
      for (let i = 0; i < out.length; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * 150 * (n + i)) / 16000)
      n += 267
      return true
    }
    const input: HostInput = { state: "hearing", owner: true }
    const host = start(input, { character: "spy" }, { registry: reg, taps: silentTaps({ readMic: tone }) })
    await host.ready()
    page.frames(30)
    expect(s.seen.at(-1)!.userLevel).toBeGreaterThan(0.5)
    input.state = "thinking"
    page.frames(60)
    expect(s.seen.at(-1)!.userLevel).toBe(0)
  })
})

describe("isolation (docs/CHARACTERS.md §4.6)", () => {
  it("an unknown id falls back to the baseline, warns once and leaves the choice untouched", () => {
    const { reg } = registryOf({})
    const choice = Object.freeze({ character: "gone-away", version: "2.0.0", options: Object.freeze({ a: 1 }) })
    const host = start({ state: "idle", owner: false }, choice, { registry: reg })
    expect(host.debug()).toMatchObject({ id: BASELINE_ID, requested: "gone-away", fallback: { id: "gone-away", reason: "unknown" } })
    host.setChoice(choice)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(choice).toEqual({ character: "gone-away", version: "2.0.0", options: { a: 1 } })
  })

  for (const phase of ["create", "resize", "frame"] as const) {
    it(`a character that throws in ${phase} is replaced by the baseline for the rest of the page, with one warning`, async () => {
      const boom = () => {
        throw new Error(`${phase} broke`)
      }
      let frames = 0
      const s = spy({
        ...(phase === "create" ? { onCreate: boom } : {}),
        ...(phase === "resize" ? { onResize: boom } : {}),
        onFrame: () => {
          if (phase === "frame" && ++frames > 3) boom()
        }
      })
      const { reg } = registryOf({ spy: s.character })
      const host = start({ state: "idle", owner: false }, { character: "spy" }, { registry: reg })
      await host.ready()
      page.frames(10)
      expect(host.debug()).toMatchObject({ id: BASELINE_ID, requested: "spy", fallback: { id: "spy", reason: phase }, failed: ["spy"] })
      expect(host.debug().fallback!.message).toContain(`${phase} broke`)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('"spy"')
      // Chosen again on the same page: still the baseline, no second warning.
      host.setChoice(undefined)
      host.setChoice({ character: "spy" })
      await host.ready()
      expect(host.debug().id).toBe(BASELINE_ID)
      expect(warn).toHaveBeenCalledTimes(1)
      const before = host.debug().frames
      page.frames(5)
      expect(host.debug().frames).toBe(before + 5)
    })
  }

  it("refuses a character written for a contract or a renderer this host does not serve, or with a broken manifest", async () => {
    const bad = {
      newer: { ...spy({ id: "newer" }).character, contract: 2 },
      svg: { ...spy({ id: "svg" }).character, renderer: "svg" },
      misnamed: spy({ id: "something-else" }).character,
      nothing: undefined
    }
    const { reg } = registryOf(bad)
    const host = start({ state: "idle", owner: false }, undefined, { registry: reg })
    for (const [id, word] of [["newer", "contract"], ["svg", "renderer"], ["misnamed", "file name"], ["nothing", "default export"]] as const) {
      host.setChoice({ character: id })
      await host.ready()
      expect(host.debug(), id).toMatchObject({ id: BASELINE_ID, fallback: { id, reason: "invalid" } })
      expect(host.debug().fallback!.message).toContain(word)
    }
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it("a character that fails to load falls back", async () => {
    const reg: Registry = { ids: [BASELINE_ID, "broken"], baseline: appRegistry.baseline, load: (id) => (id === "broken" ? Promise.reject(new Error("chunk failed")) : undefined) }
    const host = start({ state: "idle", owner: false }, { character: "broken" }, { registry: reg })
    await host.ready()
    expect(host.debug()).toMatchObject({ id: BASELINE_ID, fallback: { id: "broken", reason: "load" } })
  })

  it("stops a character that persistently exceeds the frame budget, but not over a pause or a tab in the background", async () => {
    let cost = 0
    const s = spy({ onFrame: () => page.spend(cost) })
    const { reg } = registryOf({ spy: s.character })
    const host = start({ state: "idle", owner: false }, { character: "spy" }, { registry: reg, budgetMs: 4, budgetWindows: 3, windowFrames: 10 })
    await host.ready()
    // One very long frame (a GC pause) among cheap ones counts at most 16 ms: under the limit.
    page.frames(30) // warm-up
    cost = 500
    page.frames(1)
    cost = 0.5
    page.frames(60)
    expect(host.debug().id).toBe("spy")
    // Expensive for two windows, then cheap: not persistent.
    cost = 6
    page.frames(20)
    cost = 0.5
    page.frames(10)
    expect(host.debug().id).toBe("spy")
    // Expensive, but the tab goes to the background and comes back between: the warm-up starts again.
    cost = 6
    page.frames(25)
    page.setHidden(true)
    page.frames(100)
    page.setHidden(false)
    page.frames(30)
    expect(host.debug().id).toBe("spy")
    page.frames(30)
    expect(host.debug()).toMatchObject({ id: BASELINE_ID, fallback: { id: "spy", reason: "budget" } })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("never stops the baseline for its cost", () => {
    const { reg } = registryOf({})
    const host = start({ state: "idle", owner: false }, undefined, { registry: reg, budgetMs: -1, budgetWindows: 1, windowFrames: 5 })
    page.frames(100)
    expect(host.debug()).toMatchObject({ id: BASELINE_ID, fallback: null })
  })
})

describe("the loop and the canvas", () => {
  it("pauses while the tab is hidden", () => {
    const host = start({ state: "idle", owner: false }, undefined, {})
    page.frames(5)
    page.setHidden(true)
    page.frames(5)
    expect(host.debug().frames).toBe(6)
    page.setHidden(false)
    page.frames(5)
    expect(host.debug().frames).toBe(11)
  })

  it("gives a webgl2 character a canvas of its own and gives the page's canvas back after it", async () => {
    const gl = spy({ id: "gl", renderer: "webgl2" })
    const { reg } = registryOf({ gl: gl.character })
    const host = start({ state: "idle", owner: false }, undefined, { registry: reg })
    const stage = canvas.parentElement!
    host.setChoice({ character: "gl" })
    await host.ready()
    expect(host.debug()).toMatchObject({ id: "gl", renderer: "webgl2" })
    expect(stage.querySelectorAll("canvas")).toHaveLength(2)
    expect(canvas.style.visibility).toBe("hidden")
    expect(stage.querySelectorAll("canvas")[1]!.className).toBe("stage-canvas")
    host.setChoice(undefined)
    expect(gl.disposed()).toBe(1)
    expect(stage.querySelectorAll("canvas")).toHaveLength(1)
    expect(canvas.style.visibility).toBe("")
    expect(host.debug().id).toBe(BASELINE_ID)
  })

  it("disposes everything on stop", async () => {
    const s = spy()
    const { reg } = registryOf({ spy: s.character })
    const host = start({ state: "idle", owner: false }, { character: "spy" }, { registry: reg })
    await host.ready()
    host.stop()
    expect(s.disposed()).toBe(1)
    const n = s.seen.length
    page.frames(5)
    expect(s.seen.length).toBe(n)
  })
})
