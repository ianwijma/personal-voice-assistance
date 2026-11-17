import { describe, expect, it } from "@effect/vitest"
import { sliceText, tokenize } from "../src/Tokens.ts"

describe("tokenize", () => {
  const norms = (text: string) => tokenize(text).map((t) => t.norm)
  it("lowers case, strips accents and apostrophes", () => {
    expect(norms("Één kop, TWEEËNTWINTIG")).toEqual(["een", "kop", "tweeentwintig"])
    expect(norms("five o'clock")).toEqual(["five", "oclock"])
    expect(norms("'s Avonds")).toEqual(["s", "avonds"])
  })
  it("keeps numbers with separators whole and splits digits from letters", () => {
    expect(norms("7:30 pm")).toEqual(["7:30", "pm"])
    expect(norms("250g")).toEqual(["250", "g"])
    expect(norms("7pm")).toEqual(["7", "pm"])
    expect(norms("2,5 liter")).toEqual(["2,5", "liter"])
    expect(norms("19u30")).toEqual(["19", "u", "30"])
  })
  it("joins a.m., p.m. and ordinals", () => {
    expect(norms("7 a.m.")).toEqual(["7", "am"])
    expect(norms("7 P.M.")).toEqual(["7", "pm"])
    expect(norms("the 3rd of March")).toEqual(["the", "3rd", "of", "march"])
    expect(norms("de 3e")).toEqual(["de", "3e"])
    expect(norms("twenty-five")).toEqual(["twenty", "five"])
  })
  it("knows where the words were", () => {
    const text = "call mum at 5 pm"
    const toks = tokenize(text)
    expect(sliceText(text, toks, 3, 5)).toBe("5 pm")
    expect(sliceText(text, toks, 2, 2)).toBe("")
  })
})
