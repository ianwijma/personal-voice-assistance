import { encodeWav } from "@pva/audio-file"
import { makeResampler, Tts } from "@pva/core"
import { Effect, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** User turns for the live benchmark: short, mixed, and one that needs a tool. */
export const benchSentences = [
  "Hello, can you hear me?",
  "What time is it in Tokyo right now?",
  "Give me one fun fact about octopuses.",
  "What's the weather like in Amsterdam today?",
  "Thanks, that's all for now."
]

/**
 * Synthesise each sentence with the configured TTS into `directory` as 16 kHz
 * WAVs (the STT input rate), resampling from the engine's own rate.
 */
export const makeBenchWavs = (directory: string, sentences: ReadonlyArray<string> = benchSentences) =>
  Effect.gen(function*() {
    const tts = yield* Tts
    mkdirSync(directory, { recursive: true })
    const written: Array<string> = []
    for (const [i, sentence] of sentences.entries()) {
      const resample = makeResampler(tts.sampleRate, 16_000)
      const chunks = yield* Stream.runCollect(tts.synthesize(Stream.make(sentence)))
      const data = Buffer.concat(chunks.map((c) => resample(c.audio)))
      const slug = sentence.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)
      const path = join(directory, `${String(i + 1).padStart(2, "0")}-${slug}.wav`)
      writeFileSync(path, encodeWav({ sampleRate: 16_000, channels: 1, data }))
      written.push(path)
      yield* Effect.logInfo(`wrote ${path} (${(data.length / 32_000).toFixed(1)} s)`)
    }
    return written
  })
