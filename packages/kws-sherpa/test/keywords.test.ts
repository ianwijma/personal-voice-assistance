import { describe, expect, it } from "@effect/vitest"
import { keywordLine, keywordsText, makeTokenizer, normalizePhrase, phraseLabel, UnknownTokenError } from "../src/keywords.ts"
import { OovError, parseLexicon } from "../src/lexicon.ts"

const lexicon = parseLexicon(["HEY HH EY1", "JEFF JH EH1 F", "GEOFF JH EH1 F", "JEFF JH EH1 F F", "OK OW2 K EY2", ""].join("\n"))
const tokenSet = new Set(["HH", "EY1", "JH", "EH1", "F", "V", "OW2", "K"])
const phone = makeTokenizer("phone", { tokenSet, lexicon }, { jev: ["JH", "EH1", "V"] })

describe("phrases", () => {
  it("normalises what the owner types", () => {
    expect(normalizePhrase("  Hey, Jeff! ")).toBe("HEY JEFF")
    expect(normalizePhrase("it's  me")).toBe("IT'S ME")
    expect(phraseLabel("Hey, Jeff!")).toBe("hey_jeff")
  })

  it("looks words up in the lexicon (first pronunciation) and takes overrides", () => {
    expect(phone.tokens("hey jeff")).toEqual(["HH", "EY1", "JH", "EH1", "F"])
    expect(phone.tokens("Hey Jev")).toEqual(["HH", "EY1", "JH", "EH1", "V"])
  })

  it("names the words it cannot find", () => {
    expect(() => phone.tokens("hey jarvis now")).toThrow(OovError)
    try {
      phone.tokens("hey jarvis now")
    } catch (e) {
      expect((e as OovError).words).toEqual(["JARVIS", "NOW"])
    }
  })

  it("refuses tokens the model does not have", () => {
    expect(() => phone.tokens("ok")).toThrow(UnknownTokenError)
  })

  it("writes keyword lines with boost, threshold and label", () => {
    expect(keywordLine(phone, { text: "Hey Jeff" })).toBe("HH EY1 JH EH1 F @hey_jeff")
    expect(keywordLine(phone, { text: "hey jev", boost: 2, threshold: 0.3 })).toBe("HH EY1 JH EH1 V :2 #0.3 @hey_jev")
  })

  it("drops phrases that encode to the same tokens", () => {
    expect(keywordsText(phone, [{ text: "hey jeff" }, { text: "hey geoff" }, { text: "hey jev" }])).toBe(
      "HH EY1 JH EH1 F @hey_jeff\nHH EY1 JH EH1 V @hey_jev"
    )
  })
})
