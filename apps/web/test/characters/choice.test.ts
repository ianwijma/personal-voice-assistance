// @vitest-environment node
/** The stored character choice: lenient parsing from storage and from the address bar (src/characters/choice.ts, prefs.ts). */
import { describe, expect, it } from "vitest"
import { BASELINE_ID, choiceFromSearch, parseCharacterChoice } from "@/characters/choice.ts"
import { CORE_MODES, EXTRA_MODES, type Mode } from "@/characters/contract.ts"
import { coreOf, resolveMode } from "@/characters/runner.ts"
import { defaultPrefs, parsePrefs } from "@/lib/prefs.ts"

describe("parseCharacterChoice", () => {
  it("keeps a valid choice, with only plain option values", () => {
    expect(parseCharacterChoice({ character: "flame", version: "1.2.0", options: { size: 0.8, style: "lantern", sparks: false, bad: { x: 1 }, worse: [1], nan: Number.NaN } })).toEqual({
      character: "flame",
      version: "1.2.0",
      options: { size: 0.8, style: "lantern", sparks: false }
    })
  })
  it("rejects what is not a choice", () => {
    for (const v of [null, 3, "flame", [], {}, { character: "" }, { character: 7 }, { character: "x".repeat(65) }]) expect(parseCharacterChoice(v)).toBeUndefined()
    expect(parseCharacterChoice({ character: "flame", version: 3, options: "nope" })).toEqual({ character: "flame" })
  })
})

describe("prefs.character", () => {
  it("defaults to none (the baseline) and parses leniently next to the other preferences", () => {
    expect(defaultPrefs.character).toBeUndefined()
    expect(parsePrefs(JSON.stringify({ shortcuts: false })).character).toBeUndefined()
    expect(parsePrefs(JSON.stringify({ shortcuts: false, character: { character: "lips", options: { mouthRange: 1.2 } } }))).toMatchObject({ shortcuts: false, character: { character: "lips", options: { mouthRange: 1.2 } } })
    expect(parsePrefs(JSON.stringify({ shortcuts: false, character: "lips" }))).toEqual({ ...defaultPrefs, shortcuts: false })
  })
  it("keeps a choice for a character this build does not have (the host falls back; the choice survives)", () => {
    expect(parsePrefs(JSON.stringify({ character: { character: "from-the-future", version: "9.0.0" } })).character).toEqual({ character: "from-the-future", version: "9.0.0" })
  })
})

describe("choiceFromSearch (?character=<id>&opt.<id>=<value>)", () => {
  it("replaces the choice and strips its parameters, keeping the others", () => {
    const r = choiceFromSearch("?ws=ws%3A%2F%2Fh%3A1%2Fws&character=flame&opt.size=0.8&opt.$you=%23ff0000&opt.sparks=0", { character: "lips", options: { a: 1 } })
    expect(r).toEqual({ choice: { character: "flame", options: { size: "0.8", $you: "#ff0000", sparks: "0" } }, search: "?ws=ws%3A%2F%2Fh%3A1%2Fws" })
  })
  it("opt.* alone changes the current choice's options", () => {
    expect(choiceFromSearch("?opt.lines=5", { character: "sine-lines", options: { glow: false } })).toEqual({ choice: { character: "sine-lines", options: { glow: false, lines: "5" } }, search: "" })
    expect(choiceFromSearch("?opt.lines=5", undefined)).toEqual({ choice: { character: BASELINE_ID, options: { lines: "5" } }, search: "" })
  })
  it("an empty id means the baseline; nothing about characters means no change", () => {
    expect(choiceFromSearch("?character=", undefined)?.choice).toEqual({ character: BASELINE_ID, options: {} })
    expect(choiceFromSearch("?ws=x&debug=1", { character: "flame" })).toBeUndefined()
    expect(choiceFromSearch("", undefined)).toBeUndefined()
  })
})

describe("mode resolution (docs/CHARACTERS.md §4.3)", () => {
  it("every extra mode's fallback chain ends at a core mode", () => {
    for (const m of Object.keys(EXTRA_MODES) as Array<Mode>) expect(CORE_MODES).toContain(coreOf(m))
    for (const m of CORE_MODES) expect(coreOf(m)).toBe(m)
  })
  it("a declared extra mode is handed as is, an undeclared one as its fallback", () => {
    expect(resolveMode("muted", { muted: "x" })).toBe("muted")
    expect(resolveMode("muted", undefined)).toBe("idle")
    expect(resolveMode("asleep", { muted: "x" })).toBe("idle")
    expect(resolveMode("hearing", {})).toBe("hearing")
  })
})
