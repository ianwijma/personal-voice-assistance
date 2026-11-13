import { describe, it } from "@effect/vitest"
import { Tts } from "@pva/core"
import { Effect, Stream } from "effect"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { layerConfig } from "../src/index.ts"

const wav = (pcm: Uint8Array, sampleRate: number): Buffer => {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// Opt-in: CARTESIA_API_KEY=... pnpm --filter @pva/tts-cartesia test live
describe.skipIf(!process.env.CARTESIA_API_KEY)("Cartesia live", () => {
  it.live("synthesises a two-clause reply", () =>
    Effect.gen(function*() {
      const tts = yield* Tts
      yield* Effect.sleep("1 second") // let the eager connection open, as at app startup
      const clauses = Stream.make("Sure, here is the forecast.").pipe(
        Stream.concat(Stream.fromEffect(Effect.as(Effect.sleep("150 millis"), "It will be sunny and warm tomorrow.")))
      )
      const start = performance.now()
      let first = -1
      const perClause = [0, 0]
      const chunks: Array<Uint8Array> = []
      yield* tts.synthesize(clauses).pipe(Stream.runForEach((c) =>
        Effect.sync(() => {
          if (first < 0) first = performance.now() - start
          perClause[c.clause] = (perClause[c.clause] ?? 0) + c.audio.length
          chunks.push(c.audio)
        })
      ))
      const pcm = Buffer.concat(chunks)
      const seconds = (bytes: number) => (bytes / 2 / tts.sampleRate).toFixed(2)
      const file = join(tmpdir(), `cartesia-live-${Date.now()}.wav`)
      writeFileSync(file, wav(pcm, tts.sampleRate))
      console.log(
        `time to first audio ${first.toFixed(0)} ms, total ${(performance.now() - start).toFixed(0)} ms, ` +
          `audio ${seconds(pcm.length)} s (clause 0: ${seconds(perClause[0]!)} s, clause 1: ${seconds(perClause[1]!)} s), ` +
          `${chunks.length} chunks → ${file}`
      )
      if (pcm.length === 0) throw new Error("no audio")
    }).pipe(Effect.provide(layerConfig)), 30_000)
})
