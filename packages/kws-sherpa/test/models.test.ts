import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { isKwsModelName, kwsModelNames, kwsModels, missingFile, modelPaths } from "../src/models.ts"

describe("models", () => {
  it("knows its models by name, and each is registered under its own name", () => {
    expect(kwsModelNames).toEqual(["gigaspeech-bpe", "zh-en-phone", "zh-en-phone-chunk8"])
    for (const name of kwsModelNames) expect(kwsModels[name].name).toBe(name)
    expect(isKwsModelName("zh-en-phone")).toBe(true)
    expect(isKwsModelName("whisper")).toBe(false)
    expect(isKwsModelName("")).toBe(false)
  })

  it("pairs each tokenizer kind with the file that feeds it, and downloads from the kws-models release", () => {
    expect(kwsModels["gigaspeech-bpe"].tokenizer).toBe("bpe")
    expect(kwsModels["gigaspeech-bpe"].files.tokenizer).toBe("bpe.model")
    for (const name of ["zh-en-phone", "zh-en-phone-chunk8"] as const) {
      expect(kwsModels[name].tokenizer).toBe("phone")
      expect(kwsModels[name].files.tokenizer).toBe("en.phone")
    }
    for (const model of Object.values(kwsModels)) {
      expect(model.url).toBe(`https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${model.dir}.tar.bz2`)
    }
  })

  it("resolves every file under <modelDir>/<model dir>", () => {
    const paths = modelPaths(kwsModels["zh-en-phone"], "/m")
    expect(paths.encoder).toBe("/m/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx")
    expect(paths.tokens).toBe("/m/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/tokens.txt")
    expect(paths.tokenizer).toBe("/m/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/en.phone")
  })

  it("reports the first missing file, and nothing once all are there", () => {
    const root = mkdtempSync(join(tmpdir(), "pva-kws-models-"))
    try {
      const model = kwsModels["zh-en-phone"]
      expect(missingFile(model, root)).toBe(modelPaths(model, root).encoder)
      mkdirSync(join(root, model.dir), { recursive: true })
      const paths = modelPaths(model, root)
      for (const file of [paths.encoder, paths.decoder, paths.joiner, paths.tokens]) writeFileSync(file, "")
      expect(missingFile(model, root)).toBe(paths.tokenizer)
      writeFileSync(paths.tokenizer, "")
      expect(missingFile(model, root)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
