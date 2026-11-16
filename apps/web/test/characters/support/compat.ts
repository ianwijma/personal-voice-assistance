/**
 * The compatibility suite (docs/CHARACTERS.md §6), written once and run against every character the registry
 * finds (`compat.test.ts`). `load` must return a freshly evaluated module each call (the tests reset the module
 * registry), so per-page state such as a figure's instance counter starts the same in every run and two runs
 * with the same input draw the same calls.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { CORE_MODES, EXTRA_MODES, type Character, type CoreMode, type ExtraMode, type Focus, type FrameExtensions, type Mode, type OptionSpec, type OptionValues } from "@/characters/contract.ts"
import { manifestProblems } from "@/characters/manifest.ts"
import { COMMON_OPTIONS, resolveAll } from "@/characters/options.ts"
import { coreOf, resolveMode } from "@/characters/runner.ts"
import { CONVERSATION, CONVERSATION_SECONDS, pinned, run, type RunOptions, type RunResult } from "./conversation.ts"
import { PALETTES } from "./palettes.ts"

/** Mean `frame()` time over the scripted conversation on the recording canvas (the real budget is 2 ms on a real canvas; this only catches pathological cost). */
export const MEAN_FRAME_BOUND_MS = 20
/** Canvas sizes from docs/CHARACTERS.md §2.4: the smallest cell and the largest stage, plus a high-DPI stage. */
const SIZES = [[160, 140, 1], [900, 420, 1], [720, 240, 2]] as const
/**
 * For `"stage"` characters (docs/CHARACTERS.md §2.6): the full-stage canvas of the voice page at desktop and phone
 * size, with the focus where the page puts the box (smaller than the canvas and offset inside it).
 */
export const STAGES: ReadonlyArray<{ readonly label: string; readonly size: readonly [number, number, number]; readonly focus: Focus }> = [
  { label: "desktop", size: [1280, 800, 1], focus: { x: 280, y: 200, width: 720, height: 240 } },
  { label: "phone", size: [390, 844, 2], focus: { x: 16, y: 240, width: 358, height: 160 } }
]
/** A focus that moves and changes size every frame (the chat panel sliding, the layout scaling, the page scrolling). */
const moving = (base: Focus) => (t: number): Focus => ({
  x: base.x + 0.3 * base.width * Math.sin(t * 3),
  y: base.y + 0.25 * base.height * Math.sin(t * 2.1),
  width: base.width * (0.8 + 0.2 * Math.sin(t * 1.3)),
  height: base.height * (0.8 + 0.2 * Math.cos(t * 1.7))
})
const fmt = (n: number) => n.toFixed(1)

const EXTRAS = Object.keys(EXTRA_MODES) as Array<ExtraMode>

/** Numbers at min (or max), toggles off (on), the first (last) choice, black (white); host-level settings too. */
export const extremes = (specs: ReadonlyArray<OptionSpec>, high: boolean): OptionValues => {
  const out: { [id: string]: number | boolean | string } = {}
  for (const s of [...COMMON_OPTIONS, ...specs]) {
    switch (s.kind) {
      case "number":
        out[s.id] = high ? s.max : s.min
        break
      case "toggle":
        out[s.id] = high
        break
      case "choice":
        out[s.id] = (high ? s.choices[s.choices.length - 1] : s.choices[0])!.value
        break
      case "color":
        out[s.id] = high ? "#ffffff" : "#000000"
        break
    }
  }
  return out
}

const GARBAGE: ReadonlyArray<unknown> = ["", "NaN", null, {}, [], -1e9, 1e9, "#zzz", true, "x", Number.NaN, "1e999", -0, "__proto__"]

export const garbage = (specs: ReadonlyArray<OptionSpec>): Record<string, unknown> => {
  const out: Record<string, unknown> = { notAnOption: 3, "": "x" }
  ;[...COMMON_OPTIONS, ...specs].forEach((s, i) => {
    out[s.id] = GARBAGE[i % GARBAGE.length]
  })
  return out
}

/**
 * Each core mode, pinned, paints something (a call that puts pixels on the canvas, not only clears or state), and
 * what it paints differs between every two modes (`RunResult.lastPaint`: state set after the last paint does not
 * count). `runMode` runs one pinned mode. Returns the problems; empty when the modes are tellable apart.
 */
export const coreModeProblems = async (runMode: (m: CoreMode) => Promise<RunResult>): Promise<Array<string>> => {
  const problems: Array<string> = []
  const shown = new Map<CoreMode, string>()
  for (const m of CORE_MODES) {
    const r = await runMode(m)
    if (r.lastPaints === 0) problems.push(`${m} paints nothing (${r.lastCalls} calls, none of them puts pixels on a canvas)`)
    shown.set(m, r.lastPaint)
  }
  for (const a of CORE_MODES) for (const b of CORE_MODES) if (a < b && shown.get(a) === shown.get(b)) problems.push(`${a} and ${b} paint the same`)
  return problems
}

const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

const sameFrames = (a: RunResult, b: RunResult) => expect(a.frames.map((f) => f.digest)).toEqual(b.frames.map((f) => f.digest))

export const compatSuite = (id: string, load: () => Promise<unknown>) =>
  describe(`character "${id}"`, () => {
    let c: Character
    const fresh = async (): Promise<Character> => (await load()) as Character
    const runFresh = async (o: Omit<RunOptions, "palette"> & { readonly palette?: RunOptions["palette"] }): Promise<RunResult> =>
      run(await fresh(), { palette: PALETTES.dark, ...o })
    const is2d = () => c.renderer === "2d"
    const isStage = () => c.canvas === "stage"

    beforeAll(async () => {
      c = await fresh()
    })

    it("(7) has a complete, valid manifest", () => {
      expect(manifestProblems(c, id)).toEqual([])
    })

    it("(1) runs a conversation on the core alone, and draws something different in each core mode", async () => {
      const conv = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS })
      expect(conv.calls).toBeGreaterThan(0)
      const lasts = new Map<string, string>()
      for (const m of CORE_MODES) {
        const r = await runFresh({ script: pinned(m), seconds: 2 })
        expect(r.lastCalls, `${m} draws`).toBeGreaterThan(0)
        lasts.set(m, r.last)
      }
      for (const a of CORE_MODES) for (const b of CORE_MODES) if (a < b) expect(lasts.get(a), `${a} and ${b} look different`).not.toBe(lasts.get(b))
      // Real output: every core mode paints, and what it paints differs (clears and unused state changes do not count).
      expect(await coreModeProblems((m) => runFresh({ script: pinned(m), seconds: 2 }))).toEqual([])
    })

    it("(2) draws every extra mode; one it did not declare looks exactly like its fallback", async () => {
      for (const m of EXTRAS) {
        const r = await runFresh({ script: pinned(m), seconds: 1.5 })
        expect(r.lastCalls, `${m} draws`).toBeGreaterThan(0)
        const handed = resolveMode(m, c.extraModes)
        if (handed !== m) {
          const fallback = await runFresh({ script: pinned(handed), seconds: 1.5 })
          sameFrames(r, fallback)
        }
      }
      expect(coreOf("asleep")).toBe("idle")
    })

    it("(3) ignores unknown extensions and versions it does not know, and copes with extensions coming and going", async () => {
      const seconds = 7
      const core = await runFresh({ script: CONVERSATION, seconds })
      const unknown: FrameExtensions = { "no.such.extension": { v: 1 }, "speech.phonemes": { v: 999 }, "reply.expression": { v: 999 } }
      sameFrames(await runFresh({ script: CONVERSATION, seconds, ext: () => unknown }), core)
      await runFresh({ script: CONVERSATION, seconds, ext: (t) => (Math.floor(t * 3) % 2 === 0 ? unknown : undefined) })
    })

    it("(4) works with every option at its extremes, every choice, and garbage from storage", async () => {
      const specs = c.options ?? []
      const runs: Array<{ label: string; stored: OptionValues | Record<string, unknown>; size?: readonly [number, number, number] }> = []
      for (const high of [false, true]) for (const size of SIZES) runs.push({ label: `${high ? "max" : "min"} at ${size.join("×")}`, stored: extremes(specs, high), size })
      for (const s of specs) if (s.kind === "choice") for (const ch of s.choices) runs.push({ label: `${s.id}=${ch.value}`, stored: { [s.id]: ch.value } })
      runs.push({ label: "garbage", stored: garbage(specs) })
      for (const r of runs) {
        const resolved = resolveAll(specs, r.stored, 1)
        expect(Object.keys(resolved.values).sort(), r.label).toEqual(specs.map((s) => s.id).sort())
        const out = await runFresh({ script: CONVERSATION, seconds: 6, stored: r.stored as OptionValues, ...(r.size !== undefined ? { size: r.size } : {}) })
        expect(out.calls, r.label).toBeGreaterThan(0)
      }
    })

    it("(5) holds still under reduced motion in a pinned, silent mode", async () => {
      for (const m of CORE_MODES) {
        const r = await runFresh({ script: pinned(m), seconds: 4, silent: true, reducedMotion: true, checkpoints: [3, 4] })
        expect(r.frames[0]!.digest, `${m}: frames 1 s apart`).toBe(r.frames[1]!.digest)
      }
    })

    it("(6) draws the same at default settings as when its digest was recorded", async () => {
      const lines = [`# ${id} ${c.version}: frame digests of a scripted conversation at default settings (docs/CHARACTERS.md §6.6).`]
      lines.push("# A change here must be deliberate: check the look, then update with `pnpm --filter @pva/web exec vitest run test/characters -u`.")
      for (const [name, palette] of Object.entries(PALETTES)) {
        const r = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS, palette })
        for (const f of r.frames) lines.push(`${name} ${f.t.toFixed(1).padStart(4)} ${f.mode.padEnd(9)} ${String(f.calls).padStart(5)} ${f.digest}`)
      }
      // How far solid drawing goes past the canvas edge (CSS px) at each size: recorded, not judged (particles and
      // sparks may leave the frame on purpose), so a change in reach shows up in review.
      if (is2d())
        for (const size of SIZES) {
          const r = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS, size })
          lines.push(`overflow ${size.join("×")} ${r.overflow.toFixed(1)} px`)
        }
      // A stage character also on the desktop stage (§2.6): its frames, and where its solid drawing reached. Not
      // written for a box character, so their digests are exactly what they were before stage characters existed.
      if (isStage()) {
        const st = STAGES[0]!
        const fo = st.focus
        const r = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS, size: st.size, focus: fo })
        for (const f of r.frames) lines.push(`stage ${f.t.toFixed(1).padStart(4)} ${f.mode.padEnd(9)} ${String(f.calls).padStart(5)} ${f.digest}`)
        const e = r.extent
        lines.push(`stage ${st.size.join("×")} focus ${fo.width}×${fo.height} at ${fo.x},${fo.y}: solid drawing ${e === null ? "none" : `x ${fmt(e.minX)}..${fmt(e.maxX)}, y ${fmt(e.minY)}..${fmt(e.maxY)}`}`)
      }
      await expect(lines.join("\n") + "\n").toMatchFileSnapshot(`./__snapshots__/${id}.digest`)
    })

    it("(9) on the whole stage (stage characters): an offset focus, a moving focus, option extremes; centred on the focus", async () => {
      if (!isStage()) return // a box character: nothing new to check, and nothing it is run with has changed
      for (const st of STAGES) {
        const conv = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS, size: st.size, focus: st.focus })
        expect(conv.calls, st.label).toBeGreaterThan(0)
        if (is2d()) {
          // The solid drawing is centred inside the focus, or (a character that lights the screen's edge) surrounds it.
          const e = conv.extent
          expect(e, `${st.label}: draws something solid`).not.toBeNull()
          const f = st.focus
          const cx = (e!.minX + e!.maxX) / 2
          const cy = (e!.minY + e!.maxY) / 2
          const centred = cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height
          const surrounds = e!.minX <= f.x && e!.maxX >= f.x + f.width && e!.minY <= f.y && e!.maxY >= f.y + f.height
          expect(centred || surrounds, `${st.label}: drawing x ${fmt(e!.minX)}..${fmt(e!.maxX)}, y ${fmt(e!.minY)}..${fmt(e!.maxY)}; focus ${f.width}×${f.height} at ${f.x},${f.y}`).toBe(true)
        }
      }
      const desk = STAGES[0]!
      const lasts = new Map<string, string>()
      for (const m of CORE_MODES) {
        const r = await runFresh({ script: pinned(m), seconds: 2, size: desk.size, focus: desk.focus })
        expect(r.lastCalls, `${m} draws on the stage`).toBeGreaterThan(0)
        lasts.set(m, r.last)
      }
      for (const a of CORE_MODES) for (const b of CORE_MODES) if (a < b) expect(lasts.get(a), `${a} and ${b} look different on the stage`).not.toBe(lasts.get(b))
      expect(await coreModeProblems((m) => runFresh({ script: pinned(m), seconds: 2, size: desk.size, focus: desk.focus })), "on the stage").toEqual([])
      for (const st of STAGES) {
        const r = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS, size: st.size, focus: moving(st.focus) })
        expect(r.lastCalls, `${st.label}: draws with a moving focus`).toBeGreaterThan(0)
      }
      const specs = c.options ?? []
      for (const high of [false, true]) {
        const r = await runFresh({ script: CONVERSATION, seconds: 6, size: desk.size, focus: moving(desk.focus), stored: extremes(specs, high) })
        expect(r.calls, `${high ? "max" : "min"} on the stage`).toBeGreaterThan(0)
      }
    })

    it("(10) copes with a 1 × 1 canvas (and focus) and with a focus partly outside the canvas: no throw, finite coordinates", async () => {
      const cases: Array<{ readonly label: string; readonly size: readonly [number, number, number]; readonly focus?: Focus }> = [
        { label: "a 1 × 1 canvas", size: [1, 1, 1] },
        { label: "a 1 × 1 canvas at ratio 2", size: [1, 1, 2] }
      ]
      if (isStage()) {
        const desk = STAGES[0]!
        const phone = STAGES[1]!
        cases.push(
          { label: "a 1 × 1 canvas and focus", size: [1, 1, 1], focus: { x: 0, y: 0, width: 1, height: 1 } },
          { label: "a 1 × 1 focus on the desktop stage", size: desk.size, focus: { x: 640, y: 400, width: 1, height: 1 } },
          { label: "a focus partly above the desktop stage", size: desk.size, focus: { ...desk.focus, y: -desk.focus.height / 2 } },
          { label: "a focus partly above the phone stage", size: phone.size, focus: { ...phone.focus, y: -40 } }
        )
      }
      for (const k of cases) {
        let r: RunResult
        try {
          r = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS, size: k.size, ...(k.focus !== undefined ? { focus: k.focus } : {}) })
        } catch (e) {
          throw new Error(`${k.label}: ${describeError(e)}`, { cause: e })
        }
        expect(r.nonFinite, `${k.label}: drawing calls given a non-finite number (a browser skips them)`).toBe(0)
      }
    })

    it("(8) keeps a sane frame cost over the conversation", async () => {
      const r = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS })
      expect(r.meanFrameMs).toBeLessThan(MEAN_FRAME_BOUND_MS)
    })
  })

/** All core and extra modes, for tests that walk them. */
export const ALL_MODES: ReadonlyArray<Mode> = [...CORE_MODES, ...EXTRAS]
