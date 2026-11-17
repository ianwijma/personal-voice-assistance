/**
 * Previews of characters without a microphone, for the admin's look editor (docs/LOOKS-AND-VOICES.md §4).
 *
 * - `PREVIEW_SCRIPT` / `scriptedMode`: a short conversation through the five core modes. The voices come from the
 *   host's stand-ins (`voices.ts`, what an observer tab shows): the person talks while hearing, the room is open while
 *   listening, the assistant talks while speaking. So a preview moves the way the stage moves, with no audio at all.
 * - `createPreviewLoop`: many small previews on one animation loop (the picker's cards). Each preview is a `Runner` on
 *   its own canvas, stepped only while it is marked visible (the page uses an IntersectionObserver), at most 30 times
 *   a second, never while the tab is hidden. Under reduced motion every preview holds the speaking mode and is drawn
 *   four times a second (characters hold their poses under `reducedMotion`). A character that throws is disposed and
 *   reported; the others go on.
 *
 * The large preview of the selected character uses the real host (`startCharacterHost`) with the same script, so it
 * shows exactly what the stage would, falls back exactly as the stage would, and swaps in place.
 */
import type { Character, CoreMode, OptionValues, Palette } from "./contract.ts"
import { readPalette } from "./host.ts"
import { Runner } from "./runner.ts"
import { type StandInKind, standInAgent, standInUser } from "./voices.ts"

/** The scripted conversation: each core mode and how long it lasts (s). 14 s round. */
export const PREVIEW_SCRIPT: ReadonlyArray<readonly [CoreMode, number]> = [
  ["idle", 2],
  ["listening", 2.5],
  ["hearing", 3],
  ["thinking", 2.5],
  ["speaking", 4]
]
const ROUND = PREVIEW_SCRIPT.reduce((n, [, s]) => n + s, 0)

/** The scripted mode at `t` seconds into the conversation (it repeats). */
export const scriptedMode = (t: number): CoreMode => {
  let x = ((t % ROUND) + ROUND) % ROUND
  for (const [m, s] of PREVIEW_SCRIPT) {
    if (x < s) return m
    x -= s
  }
  return "idle"
}

/** What each stand-in voice does in a mode (as the host does for an observer tab). */
export const userKind = (m: CoreMode): StandInKind => (m === "hearing" ? "voice" : m === "listening" ? "room" : "silent")
export const agentKind = (m: CoreMode): StandInKind => (m === "speaking" ? "voice" : "silent")

/** The audio taps of a host with no audio: the preview's host draws from stand-ins only. */
export const NO_AUDIO = {
  readMic: () => false,
  micRate: () => 16000,
  analyser: () => null,
  interruptedAt: () => Number.NEGATIVE_INFINITY
} as const

export interface PreviewHandle {
  /** Step only while visible (in the viewport); a hidden preview costs nothing. */
  readonly setVisible: (visible: boolean) => void
  readonly setStored: (stored: OptionValues | undefined) => void
  readonly dispose: () => void
}

export interface PreviewLoop {
  readonly add: (canvas: HTMLCanvasElement, character: Character, stored: OptionValues | undefined, onFail: (message: string) => void) => PreviewHandle
  readonly stop: () => void
}

interface Entry {
  readonly runner: Runner
  readonly canvas: HTMLCanvasElement
  readonly onFail: (message: string) => void
  visible: boolean
  failed: boolean
  sized: boolean
}

/** A WebGL character's context is given back at once, not at garbage collection (browsers allow only a few). */
const releaseGl = (canvas: HTMLCanvasElement, character: Character) => {
  if (character.renderer !== "webgl2") return
  try {
    canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext()
  } catch {
    // already lost
  }
}

const FRAME_MS = 1000 / 30
const REDUCED_FRAME_MS = 250

export const createPreviewLoop = (): PreviewLoop => {
  const entries = new Set<Entry>()
  const probeCanvas = document.createElement("canvas")
  probeCanvas.width = probeCanvas.height = 1
  const probe = probeCanvas.getContext("2d", { willReadFrequently: true })
  const scheme = matchMedia("(prefers-color-scheme: light)")
  const motion = matchMedia("(prefers-reduced-motion: reduce)")
  let palette: Palette = readPalette(probe, !scheme.matches)
  let reduced = motion.matches
  const onScheme = () => {
    palette = readPalette(probe, !scheme.matches)
  }
  const onMotion = () => {
    reduced = motion.matches
  }
  scheme.addEventListener("change", onScheme)
  motion.addEventListener("change", onMotion)
  const user = standInUser()
  const agent = standInAgent()
  const pointer = { x: 0, y: 0, down: false, inside: false }
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((records) => {
    for (const r of records) for (const e of entries) if (e.canvas === r.target) e.sized = false
  })

  const fail = (e: Entry, error: unknown) => {
    e.failed = true
    e.runner.dispose()
    e.onFail(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
  const size = (e: Entry) => {
    const r = e.canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    e.runner.resize(Math.max(1, r.width), Math.max(1, r.height), dpr)
    e.sized = true
  }

  let raf = 0
  let clock = 0
  let last = 0
  let lastDraw = 0
  const anyVisible = () => [...entries].some((e) => e.visible && !e.failed)
  const tick = (now: number) => {
    raf = 0
    if (document.hidden || !anyVisible()) return
    raf = requestAnimationFrame(tick)
    clock += Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    if (now - lastDraw < (reduced ? REDUCED_FRAME_MS : FRAME_MS)) return
    const dt = Math.min(0.1, Math.max(1 / 60, (now - lastDraw) / 1000))
    lastDraw = now
    const mode: CoreMode = reduced ? "speaking" : scriptedMode(clock)
    const u = user.step(userKind(mode), clock, dt)
    const a = agent.step(agentKind(mode), clock, dt)
    for (const e of entries) {
      if (!e.visible || e.failed) continue
      try {
        if (!e.sized) size(e)
        e.runner.step({ mode, dt, user: u, agent: a, palette, reducedMotion: reduced, pointer, sinceInterrupt: Number.POSITIVE_INFINITY })
      } catch (err) {
        fail(e, err)
      }
    }
  }
  const start = () => {
    if (raf !== 0 || document.hidden || !anyVisible()) return
    last = performance.now()
    lastDraw = 0
    raf = requestAnimationFrame(tick)
  }
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf)
      raf = 0
    } else start()
  }
  document.addEventListener("visibilitychange", onVisibility)

  return {
    add: (canvas, character, stored, onFail) => {
      const runner = new Runner(character, canvas, stored)
      const e: Entry = { runner, canvas, onFail, visible: false, failed: false, sized: false }
      entries.add(e)
      try {
        runner.create()
        size(e)
      } catch (err) {
        fail(e, err)
      }
      ro?.observe(canvas)
      return {
        setVisible: (visible) => {
          e.visible = visible
          if (visible) start()
        },
        setStored: (s) => {
          if (!e.failed) runner.setStored(s)
        },
        dispose: () => {
          entries.delete(e)
          ro?.unobserve(canvas)
          runner.dispose()
          releaseGl(canvas, character)
        }
      }
    },
    stop: () => {
      cancelAnimationFrame(raf)
      raf = 0
      for (const e of entries) {
        e.runner.dispose()
        releaseGl(e.canvas, e.runner.character)
      }
      entries.clear()
      ro?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      scheme.removeEventListener("change", onScheme)
      motion.removeEventListener("change", onMotion)
    }
  }
}
