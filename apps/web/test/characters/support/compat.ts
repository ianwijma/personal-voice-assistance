/**
 * The compatibility suite (docs/CHARACTERS.md §6), written once and run against every character the registry
 * finds (`compat.test.ts`). `load` must return a freshly evaluated module each call (the tests reset the module
 * registry), so per-page state such as a figure's instance counter starts the same in every run and two runs
 * with the same input draw the same calls.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { CORE_MODES, EXTRA_MODES, type Character, type ExtraMode, type FrameExtensions, type Mode, type OptionSpec, type OptionValues } from "@/characters/contract.ts"
import { manifestProblems } from "@/characters/manifest.ts"
import { COMMON_OPTIONS, resolveAll } from "@/characters/options.ts"
import { coreOf, resolveMode } from "@/characters/runner.ts"
import { CONVERSATION, CONVERSATION_SECONDS, pinned, run, type RunOptions, type RunResult } from "./conversation.ts"
import { PALETTES } from "./palettes.ts"

/** Mean `frame()` time over the scripted conversation on the recording canvas (the real budget is 2 ms on a real canvas; this only catches pathological cost). */
export const MEAN_FRAME_BOUND_MS = 20
/** Canvas sizes from docs/CHARACTERS.md §2.4: the smallest cell and the largest stage, plus a high-DPI stage. */
const SIZES = [[160, 140, 1], [900, 420, 1], [720, 240, 2]] as const

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

const sameFrames = (a: RunResult, b: RunResult) => expect(a.frames.map((f) => f.digest)).toEqual(b.frames.map((f) => f.digest))

export const compatSuite = (id: string, load: () => Promise<unknown>) =>
  describe(`character "${id}"`, () => {
    let c: Character
    const fresh = async (): Promise<Character> => (await load()) as Character
    const runFresh = async (o: Omit<RunOptions, "palette"> & { readonly palette?: RunOptions["palette"] }): Promise<RunResult> =>
      run(await fresh(), { palette: PALETTES.dark, ...o })
    const is2d = () => c.renderer === "2d"

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
      await expect(lines.join("\n") + "\n").toMatchFileSnapshot(`./__snapshots__/${id}.digest`)
    })

    it("(8) keeps a sane frame cost over the conversation", async () => {
      const r = await runFresh({ script: CONVERSATION, seconds: CONVERSATION_SECONDS })
      expect(r.meanFrameMs).toBeLessThan(MEAN_FRAME_BOUND_MS)
    })
  })

/** All core and extra modes, for tests that walk them. */
export const ALL_MODES: ReadonlyArray<Mode> = [...CORE_MODES, ...EXTRAS]
