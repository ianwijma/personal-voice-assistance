import { describe, expect, it } from "vitest"
import { editDistance, joinSpelledLetters, normalizePhrase, normalizeWord, phoneticKey, phoneticWord, stem, words } from "../src/TextMatching.ts"

describe("normalising", () => {
  it("lower-cases, removes diacritics and apostrophes", () => {
    expect(normalizeWord("Hé")).toBe("he")
    expect(normalizeWord("What's")).toBe("whats")
    expect(normalizeWord("CAFÉ’S")).toBe("cafes")
  })

  it("splits words and keeps their place in the text", () => {
    const text = "Hey, Jev! Turn it on."
    expect(words(text).map((w) => [w.norm, text.slice(w.start, w.end)])).toEqual([
      ["hey", "Hey"],
      ["jev", "Jev"],
      ["turn", "Turn"],
      ["it", "it"],
      ["on", "on"]
    ])
    expect(normalizePhrase("  Hey,   JEV!! ")).toBe("hey jev")
  })

  it("joins a spelled-out name", () => {
    const text = "Hi J. E. V. lights on"
    const joined = joinSpelledLetters(words(text))
    expect(joined.map((w) => w.norm)).toEqual(["hi", "jev", "lights", "on"])
    expect(text.slice(joined[1]!.start, joined[1]!.end)).toBe("J. E. V")
    // a lone letter or digits are left alone
    expect(joinSpelledLetters(words("I need 2 3 lights")).map((w) => w.norm)).toEqual(["i", "need", "2", "3", "lights"])
  })
})

describe("phoneticWord", () => {
  it.each([
    ["jev", "jef"],
    ["jeff", "jef"],
    ["jef", "jef"],
    ["jeph", "jef"],
    ["gef", "jef"],
    ["claude", "klad"],
    ["cloud", "klod"],
    ["codex", "kodeks"],
    ["codecs", "kodeks"],
    ["hey", "he"],
    ["hay", "ha"],
    ["chef", "xef"]
  ])("%s → %s", (word, key) => {
    expect(phoneticWord(word)).toBe(key)
  })

  it("keys a phrase word by word", () => {
    expect(phoneticKey("Hey Jeff")).toBe("he jef")
  })
})

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions and adjacent swaps", () => {
    expect(editDistance("jev", "jev")).toBe(0)
    expect(editDistance("jev", "jef")).toBe(1)
    expect(editDistance("claude", "cluade")).toBe(1)
    expect(editDistance("router", "rooter")).toBe(1)
    expect(editDistance("kitten", "sitting")).toBe(3)
  })

  it("stops at the limit", () => {
    expect(editDistance("assistant", "jev", 1)).toBe(2)
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3)
  })
})

describe("stem", () => {
  it("drops a plural s from longer words only", () => {
    expect(stem("lights")).toBe("light")
    expect(stem("rooms")).toBe("room")
    expect(stem("gas")).toBe("gas")
    expect(stem("glass")).toBe("glass")
  })
})
