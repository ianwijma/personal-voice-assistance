// Runs the real models. Skipped (with a message) when a preset's files are not downloaded.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { existsSync } from "node:fs"
import { defaultModelDir, make, presets } from "../src/index.ts"
import { silentRuns } from "../src/Pcm.ts"
import { presetFiles } from "../src/Presets.ts"

const texts: Record<string, ReadonlyArray<string>> = {
  "nl_NL-pim-medium": ["Ja, dat kan ik doen.", "De vergadering is verplaatst naar morgenmiddag half vier."],
  default: ["Sure, I can do that.", "The meeting has been moved to three thirty tomorrow afternoon."]
}

// One run per distinct engine set-up (archive and lexicon), not per speaker: the 28 Kokoro voices share one model, and
// loading it 28 times would only repeat the US and GB runs with another speaker id.
const setups = new Map<string, (typeof presets)[string]>()
for (const preset of Object.values(presets)) {
  const key = `${preset.dir}|${preset.files.lexicon ?? ""}`
  if (!setups.has(key)) setups.set(key, preset)
}

for (const preset of setups.values()) {
  const present = Object.values(presetFiles(preset, defaultModelDir)).every((f) => existsSync(f))
  const skip = `model not downloaded, run: pnpm --filter @pva/tts-sherpa download ${preset.name}`
  if (!present) console.warn(`Skipping real-model test for ${preset.name}: ${skip}`)
  describe.skipIf(!present)(`real model ${preset.name}${present ? "" : ` (SKIPPED: ${skip})`}`, () => {
    it.live("speaks a two-clause reply with a plausible duration and controlled joins", () =>
      Effect.gen(function*() {
        const tts = yield* make({ preset: preset.name })
        assert.strictEqual(tts.sampleRate, preset.sampleRate)
        const clauses = texts[preset.name] ?? texts.default!
        const chunks = [...yield* Stream.runCollect(tts.synthesize(Stream.fromIterable(clauses)))]
        assert.deepStrictEqual([...new Set(chunks.map((c) => c.clause))], [0, 1])
        const bytes = Buffer.concat(chunks.map((c) => c.audio))
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
        const seconds = pcm.length / tts.sampleRate
        const words = clauses.join(" ").split(/\s+/).length
        // Conversational speech is roughly 2–4 words per second.
        assert.isAbove(seconds, words / 5)
        assert.isBelow(seconds, words / 1.5)
        // No silence anywhere longer than the sentence pause (300 ms) plus a little slack.
        const longest = Math.max(...silentRuns(pcm, tts.sampleRate).map((r) => r.ms))
        assert.isBelow(longest, 340)
      }).pipe(Effect.scoped), 60_000)
  })
}
