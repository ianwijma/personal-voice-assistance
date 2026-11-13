/**
 * Opt-in live test against Deepgram. Runs only when both are set:
 *   DEEPGRAM_API_KEY=...  DEEPGRAM_TEST_AUDIO=/path/to/speech.wav  pnpm --filter @pva/stt-deepgram test
 * The file is a 16 kHz mono 16-bit WAV, or raw s16le PCM at that rate. It is
 * streamed in real time (20 ms chunks), followed by 3 s of silence so the end of
 * the last turn is detected. Every event is logged with its time since the
 * stream started and since the speech audio ended.
 */
import { assert, it } from "@effect/vitest"
import type { SttEvent } from "@pva/core"
import { Effect, Redacted, Stream } from "effect"
import { readFileSync } from "node:fs"
import { make } from "../src/index.ts"

const apiKey = process.env["DEEPGRAM_API_KEY"]
const audioPath = process.env["DEEPGRAM_TEST_AUDIO"]

const readPcm = (path: string): Uint8Array => {
  const file = readFileSync(path)
  if (file.toString("ascii", 0, 4) !== "RIFF") return new Uint8Array(file)
  let offset = 12
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4)
    const size = file.readUInt32LE(offset + 4)
    if (id === "fmt ") {
      const channels = file.readUInt16LE(offset + 10)
      const rate = file.readUInt32LE(offset + 12)
      const bits = file.readUInt16LE(offset + 22)
      if (channels !== 1 || rate !== 16000 || bits !== 16) {
        throw new Error(`need 16 kHz mono 16-bit, got ${rate} Hz, ${channels} ch, ${bits} bit`)
      }
    }
    if (id === "data") return new Uint8Array(file.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size + (size & 1)
  }
  throw new Error("no data chunk in WAV")
}

it.live.skipIf(!apiKey || !audioPath)("live: streams a file to Deepgram Flux and logs events", () =>
  Effect.gen(function*() {
    const speech = readPcm(audioPath!)
    const pcm = new Uint8Array(speech.length + 3 * 32000)
    pcm.set(speech)
    const chunks: Array<Uint8Array> = []
    for (let i = 0; i < pcm.length; i += 640) chunks.push(pcm.subarray(i, i + 640))

    const stt = make({ apiKey: Redacted.make(apiKey!) })
    const start = performance.now()
    const speechEndsAt = start + speech.length / 32
    const events: Array<SttEvent> = []
    // Paced against the wall clock so sleep drift does not accumulate.
    const audio = Stream.fromIterable(chunks).pipe(
      Stream.mapEffect((chunk, i) => {
        const wait = start + i * 20 - performance.now()
        return wait > 0 ? Effect.as(Effect.sleep(wait), chunk) : Effect.succeed(chunk)
      })
    )
    yield* stt.transcribe(audio).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event)
          const now = performance.now()
          const t = (now - start).toFixed(0).padStart(6)
          const rel = (now - speechEndsAt).toFixed(0).padStart(6)
          console.log(`${t} ms  (speech end ${rel} ms)  ${event._tag}${"text" in event ? `: ${event.text}` : ""}`)
        })
      )
    )
    assert.isTrue(events.some((e) => e._tag === "EndOfTurn"), "expected at least one EndOfTurn")
  }), 10 * 60_000)
