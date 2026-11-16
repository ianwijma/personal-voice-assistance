// @vitest-environment node
/** What the host checks before it creates a character (src/characters/manifest.ts), rule by rule. */
import { describe, expect, it } from "vitest"
import { CONTRACT_VERSION } from "@/characters/contract.ts"
import { manifestProblems, SERVED_CANVASES, SERVED_CONTRACTS, SERVED_RENDERERS } from "@/characters/manifest.ts"
import baseline from "@/characters/library/sine-lines.ts"

/** A manifest that passes, to break one thing at a time. */
const good = (): Record<string, unknown> => ({
  id: "my-char",
  name: "My character",
  version: "1.0.0",
  contract: CONTRACT_VERSION,
  family: "abstract",
  summary: "A summary",
  inspiredBy: "Nothing",
  modes: { idle: "a", listening: "b", hearing: "c", thinking: "d", speaking: "e" },
  mappings: [{ signal: "level", effect: "size" }],
  renderer: "2d",
  create: () => ({})
})
const problems = (over: Record<string, unknown>, id = "my-char") => manifestProblems({ ...good(), ...over }, id)
/** `over` with `key` removed (an `undefined` value is "present but undefined", which is the same to the checker). */
const without = (key: string) => {
  const c = good()
  delete c[key]
  return manifestProblems(c, "my-char")
}

describe("manifestProblems", () => {
  it("accepts a complete manifest and the real baseline", () => {
    expect(manifestProblems(good(), "my-char")).toEqual([])
    expect(manifestProblems(baseline, "sine-lines")).toEqual([])
  })

  it("serves the current contract, both renderers and both canvas areas", () => {
    expect(SERVED_CONTRACTS).toContain(CONTRACT_VERSION)
    expect([...SERVED_RENDERERS]).toEqual(["2d", "webgl2"])
    expect([...SERVED_CANVASES]).toEqual(["box", "stage"])
  })

  it("says what is wrong when there is no object at all", () => {
    for (const v of [undefined, null, 3, "x"]) expect(manifestProblems(v, "x")).toEqual(["no default export (export default a Character)"])
  })

  it("the id must equal the file name, and be kebab-case", () => {
    expect(problems({ id: "other" })).toEqual(['id is "other", must equal the file name "my-char"'])
    expect(without("id")[0]).toContain("id is undefined")
    for (const bad of ["MyChar", "my_char", "1abc", "-a", "a-", "a--b", "a b", ""]) {
      expect(manifestProblems({ ...good(), id: bad }, bad), bad).toContain(bad === "" ? 'id "" must be kebab-case' : `id "${bad}" must be kebab-case`)
    }
    for (const ok of ["a", "a1", "a-b", "a1-b2-c3"]) expect(manifestProblems({ ...good(), id: ok }, ok), ok).toEqual([])
  })

  it("name, summary and inspiredBy must be non-blank strings", () => {
    for (const k of ["name", "summary", "inspiredBy"]) {
      for (const v of ["", "   ", 7, null, undefined]) expect(problems({ [k]: v }), `${k}=${String(v)}`).toEqual([`${k} must be a non-empty string`])
    }
  })

  it("version must be a semantic version", () => {
    for (const ok of ["0.0.1", "1.2.3", "10.20.30", "1.0.0-beta.1", "1.0.0+build.5", "1.0.0-rc.1+sha.abc"]) expect(problems({ version: ok }), ok).toEqual([])
    for (const bad of ["1", "1.0", "01.0.0", "1.0.0.0", "v1.0.0", "1.0.0-", "", 1, null]) expect(problems({ version: bad }), String(bad)).toHaveLength(1)
    expect(problems({ version: "1.0" })[0]).toContain("must be a semantic version")
  })

  it("contract must be a number the host serves", () => {
    for (const bad of [2, 0, "1", null]) expect(problems({ contract: bad })[0], String(bad)).toContain("is not served")
    expect(problems({ contract: 99 })[0]).toContain(`this host serves ${SERVED_CONTRACTS.join(", ")}`)
  })

  it("family must be one of baseline, abstract, figure", () => {
    for (const ok of ["baseline", "abstract", "figure"]) expect(problems({ family: ok })).toEqual([])
    for (const bad of ["blob", "", 3, undefined]) expect(problems({ family: bad }), String(bad)).toEqual(["family must be one of baseline, abstract, figure"])
  })

  it("renderer must be 2d or webgl2", () => {
    expect(problems({ renderer: "webgl2" })).toEqual([])
    for (const bad of ["svg", "webgl", "2D", undefined]) expect(problems({ renderer: bad })[0], String(bad)).toContain("is not served")
  })

  it("canvas may be left out, and otherwise must be box or stage", () => {
    expect(problems({ canvas: undefined })).toEqual([])
    expect(problems({ canvas: "box" })).toEqual([])
    expect(problems({ canvas: "stage" })).toEqual([])
    expect(problems({ canvas: "page" })[0]).toContain('canvas "page" is not served')
    expect(problems({ canvas: null })[0]).toContain("canvas null is not served")
  })

  it("create must be a function", () => {
    expect(problems({ create: "nope" })).toEqual(["create(canvas) is missing"])
    expect(without("create")).toEqual(["create(canvas) is missing"])
  })

  it("every core mode needs a description, and says which is missing", () => {
    const modes = good().modes as Record<string, string>
    expect(problems({ modes: { ...modes, hearing: "" } })).toEqual(["modes.hearing is missing"])
    expect(problems({ modes: { ...modes, thinking: "  " } })).toEqual(["modes.thinking is missing"])
    const { speaking: _s, ...rest } = modes
    expect(problems({ modes: rest })).toEqual(["modes.speaking is missing"])
    expect(problems({ modes: undefined })).toHaveLength(5)
    expect(problems({ modes: "idle" })).toHaveLength(5)
    expect(problems({ modes: null })).toHaveLength(5)
  })

  it("extraModes must be an object of the contract's extra modes, each saying how it looks", () => {
    expect(problems({ extraModes: { muted: "flat", error: "red" } })).toEqual([])
    expect(problems({ extraModes: [] })).toEqual([]) // an array is an object; it has no entries
    expect(problems({ extraModes: "muted" })).toEqual(["extraModes must be an object"])
    expect(problems({ extraModes: { sleepy: "zzz" } })[0]).toContain("extraModes.sleepy is not a mode of the contract")
    expect(problems({ extraModes: { idle: "calm" } })[0]).toContain("extraModes.idle is not a mode of the contract")
    expect(problems({ extraModes: { muted: "" } })).toEqual(["extraModes.muted must say how it looks"])
    expect(problems({ extraModes: { muted: 3 } })).toEqual(["extraModes.muted must say how it looks"])
    // An inherited name is not an own mode.
    expect(problems({ extraModes: { toString: "x" } })[0]).toContain("extraModes.toString is not a mode")
  })

  it("mappings must list at least one signal → effect pair", () => {
    expect(problems({ mappings: [] })).toEqual(["mappings must list at least one signal → effect"])
    expect(problems({ mappings: undefined })).toEqual(["mappings must list at least one signal → effect"])
    expect(problems({ mappings: "level" })).toEqual(["mappings must list at least one signal → effect"])
    expect(problems({ mappings: [{ signal: "level", effect: "size" }, { signal: "", effect: "x" }, null, { signal: "a" }] })).toEqual(["mappings[1] needs a signal and an effect", "mappings[2] needs a signal and an effect", "mappings[3] needs a signal and an effect"])
  })

  it("uses is optional; each entry needs ext, gain and without", () => {
    expect(problems({ uses: undefined })).toEqual([])
    expect(problems({ uses: [{ ext: "lipsync", gain: "real mouth", without: "guesses" }] })).toEqual([])
    expect(problems({ uses: "lipsync" })).toEqual(["uses must be an array"])
    expect(problems({ uses: [{ ext: "lipsync", gain: "x" }] })).toEqual(["uses[0] needs ext, gain and without (what it does when the extension is absent)"])
    expect(problems({ uses: [{ ext: "a", gain: "b", without: "c" }, 5] })).toEqual(["uses[1] needs ext, gain and without (what it does when the extension is absent)"])
  })

  it("lists the problems of the options declaration, and checks reserved ids only once it is well formed", () => {
    expect(problems({ options: [{ id: "size", kind: "number", label: "Size", min: 0.5, max: 2, step: 0.1, default: 1 }] })).toEqual([])
    const reservedWrongDefault = [{ id: "size", kind: "number", label: "Size", min: 0.5, max: 2, step: 0.1, default: 1.5 }]
    expect(problems({ options: reservedWrongDefault })).toEqual(["options.size: a reserved number's default must be 1 (the designed look), not 1.5"])
    const malformed = [{ id: "a", kind: "number", label: "", min: 0, max: 1, step: 0.1, default: 0 }, ...reservedWrongDefault]
    const out = problems({ options: malformed })
    expect(out.length).toBeGreaterThan(0)
    expect(out.some((p) => p.includes("reserved"))).toBe(false)
    expect(problems({ options: "many" }).length).toBeGreaterThan(0)
  })

  it("reports every problem at once, not just the first", () => {
    const out = manifestProblems({ id: "x", name: "", version: "x", contract: 9, family: "?", renderer: "?", create: 1, modes: {}, mappings: [] }, "x")
    expect(out.length).toBeGreaterThanOrEqual(10)
  })
})
