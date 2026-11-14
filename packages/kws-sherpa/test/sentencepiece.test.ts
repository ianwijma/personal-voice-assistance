import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { kwsModels, missingFile, modelPaths } from "../src/models.ts"
import { encode, parseBpeModel, WORD_START as W } from "../src/sentencepiece.ts"

// --- a tiny protobuf writer for hand-made ModelProtos ---
const varint = (n: number): Array<number> => {
  const out: Array<number> = []
  while (n > 127) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const lenField = (field: number, bytes: ReadonlyArray<number>) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]
const piece = (text: string, score: number, type = 1) => {
  const f = new Uint8Array(new Float32Array([score]).buffer)
  return lenField(1, [...lenField(1, [...new TextEncoder().encode(text)]), 2 * 8 + 5, ...f, 3 * 8, type])
}
const modelProto = (pieces: ReadonlyArray<readonly [string, number, number?]>, modelType = 1) =>
  new Uint8Array([...pieces.flatMap(([t, s, ty]) => piece(t, s, ty)), ...lenField(2, [3 * 8, modelType])])

describe("sentencepiece unigram encoder", () => {
  const model = parseBpeModel(modelProto([
    ["<unk>", 0, 2],
    ["<s>", 0, 3],
    [`${W}HE`, -2],
    ["Y", -3],
    [`${W}HEY`, -6], // worse than ▁HE + Y (−5): Viterbi must not take the longer piece
    [`${W}`, -4],
    ["H", -4],
    ["E", -4],
    [`${W}JE`, -3],
    ["FF", -2],
    ["F", -3]
  ]))

  it("picks the segmentation with the highest total score", () => {
    expect(encode(model, "HEY JEFF")).toEqual([`${W}HE`, "Y", `${W}JE`, "FF"])
  })

  it("collapses whitespace and gives every word a ▁", () => {
    expect(encode(model, "  HEY   JEFF ")).toEqual([`${W}HE`, "Y", `${W}JE`, "FF"])
  })

  it("returns code points no piece covers as themselves (scored as <unk>)", () => {
    expect(encode(model, "HEYQ")).toEqual([`${W}HE`, "Y", "Q"])
  })

  it("refuses a BPE (model_type 2) model", () => {
    expect(() => parseBpeModel(modelProto([[`${W}A`, -1]], 2))).toThrow(/not unigram/)
  })

  const giga = kwsModels["gigaspeech-bpe"]
  const missing = missingFile(giga)
  it.skipIf(missing !== undefined)(
    `matches the reference sentencepiece on the gigaspeech bpe.model${missing ? ` — SKIPPED: ${missing} is missing` : ""}`,
    () => {
      const real = parseBpeModel(readFileSync(modelPaths(giga).tokenizer))
      const reference = JSON.parse(
        readFileSync(new URL("./fixtures/sentencepiece-reference.json", import.meta.url), "utf8")
      ) as Record<string, Array<string>>
      for (const [text, pieces] of Object.entries(reference)) expect([text, encode(real, text)]).toEqual([text, pieces])
    }
  )
})
