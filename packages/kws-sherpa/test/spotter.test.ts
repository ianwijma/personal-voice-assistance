/**
 * The real spotter on the real recordings that ship with the model (LibriSpeech-style read speech). Skipped (with
 * a message) when the model is not in `models/` (or KWS_MODEL_DIR): `pnpm --filter @pva/kws-sherpa download-models`.
 */
import { describe, expect, it } from "@effect/vitest"
import { join } from "node:path"
import { defaultModelDir, kwsModels, missingFile } from "../src/models.ts"
import { createSpotter } from "../src/spotter.ts"
import { readWav16k } from "../scripts/wav.ts"

const feed = (s: ReturnType<typeof createSpotter>, x: Float32Array) => {
  const fires = []
  for (let i = 0; i < x.length; i += 320) fires.push(...s.accept(x.subarray(i, i + 320)))
  fires.push(...s.accept(new Float32Array(16000)))
  return fires
}

for (const [name, wav] of [["gigaspeech-bpe", "test_wavs/0.wav"], ["zh-en-phone", "test_wavs/en_0.wav"]] as const) {
  const model = kwsModels[name]
  const missing = missingFile(model)
  describe.skipIf(missing !== undefined)(`${name} spotter${missing ? ` — SKIPPED: ${missing} is missing` : ""}`, () => {
    // 0.wav: "AFTER EARLY NIGHTFALL THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE …"
    const audio = () => readWav16k(join(defaultModelDir, model.dir, wav))

    it("fires on a recording that contains the phrase, once, near where it is said", () => {
      const s = createSpotter({ model, phrases: [{ text: "light up" }, { text: "hey jeff" }] })
      const fires = feed(s, audio())
      expect(fires.map((f) => f.keyword)).toEqual(["light_up"])
      // "light up" is said at about 4 s of 6.6 s
      expect(fires[0]!.at).toBeGreaterThan(3)
      expect(fires[0]!.at).toBeLessThan(5.5)
    })

    it("does not fire on a recording without the phrase", () => {
      const s = createSpotter({ model, phrases: [{ text: "hey jeff" }, { text: "hey jev" }] })
      expect(feed(s, audio())).toEqual([])
    })
  })
}
