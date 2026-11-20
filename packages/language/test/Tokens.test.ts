import { describe, expect, it } from "@effect/vitest"
import { sliceText, tokenize } from "../src/Tokens.ts"

describe("tokenize", () => {
  const norms = (text: string) => tokenize(text)?.map((t) => t.norm)
  it("lowers case and strips accents; an apostrophe inside a word is kept (round 4, finding 14), one before Dutch s is a gap", () => {
    expect(norms("Één kop, TWEEËNTWINTIG")).toEqual(["een", "kop", "tweeentwintig"])
    expect(norms("five o'clock")).toEqual(["five", "o'clock"])
    expect(norms("five o’clock")).toEqual(["five", "o'clock"])
    expect(norms("tw'o")).toEqual(["tw'o"])
    expect(norms("'s Avonds")).toEqual(["s", "avonds"])
  })
  it("keeps numbers with separators whole and splits digits from letters; a word never runs into digits", () => {
    expect(norms("7:30 pm")).toEqual(["7:30", "pm"])
    expect(norms("250g")).toEqual(["250", "g"])
    expect(norms("7pm")).toEqual(["7", "pm"])
    expect(norms("2,5 liter")).toEqual(["2,5", "liter"])
    for (const text of ["19u30", "1e3", "x3", "3x4", "-5", "3-5", "½", "<5", "a/b", "(7)", "\"seven\"", "seven-", "'flour'", "２"]) expect(norms(text), text).toBeUndefined()
  })
  it("joins a.m., p.m. and ordinals, and reads a decomposed accent as part of its word (round 3, finding 24)", () => {
    expect(norms("7 a.m.")).toEqual(["7", "am"])
    expect(norms("7 P.M.")).toEqual(["7", "pm"])
    expect(norms("the 3rd of March")).toEqual(["the", "3rd", "of", "march"])
    expect(norms("de 3e")).toEqual(["de", "3e"])
    expect(norms("twenty-five")).toEqual(["twenty", "five"])
    expect(norms("tweeënhalf".normalize("NFD"))).toEqual(["tweeenhalf"])
  })
  it("knows where the words were", () => {
    const text = "call mum at 5 pm"
    const toks = tokenize(text)!
    expect(sliceText(text, toks, 3, 5)).toBe("5 pm")
    expect(sliceText(text, toks, 2, 2)).toBe("")
  })
  it("refuses more than 200 characters or 40 words", () => {
    expect(tokenize("a ".repeat(41))).toBeUndefined()
    expect(tokenize("x".repeat(201))).toBeUndefined()
  })
})
