/**
 * A throwaway character for tests only (not in `library/`, so never in the app): a row of dots. It exists to prove
 * the host's path for a character other than the baseline: lazy loading, swapping, options (one of each kind,
 * including a reserved id), an opted-in extra mode, and the compatibility suite running on more than one character.
 */
import type { Character, CharacterInstance, Rgb } from "@/characters/contract.ts"
import { approach, clamp01, clear2d, optChoice, optColor, optNumber, optToggle, rgba, setup2d } from "@/characters/kit.ts"

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  let level = 0
  let phase = 0
  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
    },
    frame(f) {
      clear2d(g, dpr)
      const voice = f.coreMode === "speaking" ? f.agent : f.user
      level = approach(level, f.coreMode === "hearing" || f.coreMode === "speaking" ? voice.level : 0, f.dt, 0.08)
      if (!f.reducedMotion) phase += f.dt * (f.coreMode === "thinking" ? 4 : 1)
      const n = Math.round(optNumber(f.options, "count"))
      const size = optNumber(f.options, "size")
      const square = optChoice(f.options, "shape") === "square"
      const base: Rgb =
        f.mode === "muted" ? f.palette.danger : f.coreMode === "idle" ? f.palette.inkFaint : f.coreMode === "thinking" || f.coreMode === "speaking" ? optColor(f, "tint") : f.palette.you
      const gap = W / (n + 1)
      const r0 = Math.min(gap * 0.4, H * 0.2) * size
      for (let i = 0; i < n; i++) {
        const x = gap * (i + 1)
        const wobble = f.reducedMotion ? 0 : Math.sin(phase * 3 + i) * 0.15
        // Stays inside the canvas at every size and option: the dot, its ring and the thinking hop fit in H / 2.
        const room = Math.min(H / 4, gap / 2) / (optToggle(f.options, "ring") ? 1.3 : 1)
        const r = Math.min(room, Math.max(1, r0 * (0.5 + clamp01(level + wobble + (f.coreMode === "listening" ? 0.2 : 0)))))
        const y = H / 2 - (f.coreMode === "thinking" && i === Math.floor(phase) % n ? r : 0)
        g.fillStyle = rgba(base, f.coreMode === "idle" ? 0.5 : 1)
        g.beginPath()
        if (square) g.rect(x - r, y - r, 2 * r, 2 * r)
        else g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()
        if (optToggle(f.options, "ring")) {
          g.strokeStyle = rgba(base, 0.4)
          g.lineWidth = 1
          g.beginPath()
          g.arc(x, y, r * 1.3, 0, Math.PI * 2)
          g.stroke()
        }
      }
    },
    dispose() {}
  }
}

const character: Character = {
  id: "test-dots",
  name: "Test dots",
  version: "0.1.0",
  contract: 1,
  family: "abstract",
  summary: "A row of dots, for tests.",
  inspiredBy: "Nothing; a fixture.",
  modes: {
    idle: "Faint grey dots.",
    listening: "Mint dots, a little larger.",
    hearing: "Mint dots that grow with your voice.",
    thinking: "Tinted dots; one hops at a time.",
    speaking: "Tinted dots that grow with the reply."
  },
  extraModes: { muted: "Dots in the danger colour." },
  mappings: [{ signal: "user.level / agent.level", effect: "Dot size." }],
  uses: [{ ext: "test.nothing", gain: "Nothing; it proves `uses` is read.", without: "The same dots." }],
  renderer: "2d",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.5, step: 0.05, default: 1 },
    { id: "count", kind: "number", label: "Dots", min: 1, max: 9, step: 1, default: 5 },
    { id: "ring", kind: "toggle", label: "Rings", default: false },
    { id: "shape", kind: "choice", label: "Shape", choices: [{ value: "circle", label: "Circles" }, { value: "square", label: "Squares" }], default: "circle" },
    { id: "tint", kind: "color", label: "Tint", default: "voice" }
  ],
  create
}

export default character
