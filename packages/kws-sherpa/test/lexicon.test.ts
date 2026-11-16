import { describe, expect, it } from "@effect/vitest"
import { builtinOverrides, OovError, parseLexicon, phones } from "../src/lexicon.ts"

describe("parseLexicon", () => {
  it("keys words in upper case, keeps the first pronunciation, and skips blank and phone-less lines", () => {
    const lexicon = parseLexicon("hey HH EY1\nHEY HH AY1\n\n  \nLONELY\n  GO   G OW1  \n")
    expect(lexicon.get("HEY")).toEqual(["HH", "EY1"])
    expect(lexicon.get("GO")).toEqual(["G", "OW1"])
    expect(lexicon.has("LONELY")).toBe(false)
    expect(lexicon.size).toBe(2)
  })
})

describe("phones", () => {
  const lexicon = parseLexicon("HEY HH EY1\nJEFF JH EH1 F")

  it("has the assistant's name built in, and an override beats the lexicon", () => {
    expect(builtinOverrides["JEV"]).toEqual(["JH", "EH1", "V"])
    expect(phones(lexicon, ["HEY", "JEV"])).toEqual(["HH", "EY1", "JH", "EH1", "V"])
    expect(phones(lexicon, ["JEFF"], { jeff: ["JH", "EH1", "F", "F"] })).toEqual(["JH", "EH1", "F", "F"])
  })

  it("names every word that is missing, not just the first", () => {
    const error = (() => {
      try {
        phones(lexicon, ["HEY", "ZORP", "JEFF", "QUUX"])
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(OovError)
    expect((error as OovError).words).toEqual(["ZORP", "QUUX"])
    expect((error as OovError).message).toContain("ZORP, QUUX")
  })

  it("gives no phones for no words", () => {
    expect(phones(lexicon, [])).toEqual([])
  })
})
