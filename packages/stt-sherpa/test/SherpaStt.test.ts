/**
 * The real models on real audio, fed at real-time pace. Skipped (with a
 * message) when the model files or test WAVs are not in `models/`.
 */
import { assert, describe, it } from "@effect/vitest"
import type { SttEvent } from "@pva/core"
import { Stt } from "@pva/core"
import { Effect, Exit, Layer, Stream } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { defaultModelDir, missingFile, modelFiles, type PresetName, presets } from "../src/presets.ts"
import { layer } from "../src/SherpaStt.ts"
import { normalize, pacedAudio, references, silence, timeline, wavDir, wordErrors } from "./fixtures.ts"

/** `it.live`, skipped with the reason in its title when a model file or the test audio is missing. */
const withModel = (preset: PresetName) => {
  const missing = missingFile(modelFiles(presets[preset], defaultModelDir)) ??
    (existsSync(join(wavDir, "refs.json")) ? undefined : join(wavDir, "refs.json"))
  const test = it.live.skipIf(missing !== undefined)
  return (name: string, ...rest: Parameters<typeof it.live> extends [string, ...infer R] ? R : never) =>
    test(missing ? `${name} — SKIPPED: ${missing} is missing, see packages/stt-sherpa/README.md` : name, ...rest)
}

const transcribe = (audio: Stream.Stream<Uint8Array>) =>
  Effect.flatMap(Effect.service(Stt), (stt) => Stream.runCollect(stt.transcribe(audio)))

/**
 * Checks the event grammar and returns the committed turns:
 * SpeechStarted, then Interims / EagerEndOfTurn / TurnResumed, then EndOfTurn equal to the last eager text.
 */
const turns = (events: ReadonlyArray<SttEvent>) => {
  const out: Array<{ text: string; eager: string | undefined; resumed: number }> = []
  let open = false
  let eager: string | undefined
  let resumed = 0
  for (const event of events) {
    if (event._tag === "SpeechStarted") {
      // A turn whose segments had no words ends without an event.
      assert.isUndefined(eager, "SpeechStarted after EagerEndOfTurn")
      open = true
      continue
    }
    assert.isTrue(open, `${event._tag} outside a turn`)
    if (event._tag === "EagerEndOfTurn") {
      assert.isUndefined(eager, "two EagerEndOfTurn without TurnResumed")
      eager = event.text
    } else if (event._tag === "TurnResumed") {
      assert.isDefined(eager, "TurnResumed without EagerEndOfTurn")
      eager = undefined
      resumed++
    } else if (event._tag === "EndOfTurn") {
      out.push({ text: event.text, eager, resumed })
      open = false
      eager = undefined
      resumed = 0
    }
  }
  return out
}

const checkTranscripts = (events: ReadonlyArray<SttEvent>, wavs: ReadonlyArray<string>, maxWer: number) => {
  const committed = turns(events)
  const refs = references()
  assert.strictEqual(committed.length, wavs.length, JSON.stringify(committed))
  committed.forEach((turn, i) => {
    assert.isDefined(turn.eager, "EndOfTurn without a preceding EagerEndOfTurn")
    assert.strictEqual(normalize(turn.eager!), normalize(turn.text))
    const reference = refs[wavs[i]!]!
    const { errors, words } = wordErrors(reference, turn.text)
    assert.isAtMost(errors / words, maxWer, `${wavs[i]}: ${turn.text}`)
    // Nothing of one turn leaks into the next (the recogniser keeps unprocessed frames across reset).
    assert.strictEqual(normalize(turn.text).split(" ")[0], normalize(reference).split(" ")[0], `${wavs[i]}: ${turn.text}`)
  })
  return committed
}

describe("SherpaStt", () => {
  it.effect("fails with the download command when a model file is missing", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Layer.build(layer({ model: "zipformer-en", modelDir: "/nonexistent" })))
      assert.isTrue(Exit.isFailure(exit))
      const message = String(Exit.isFailure(exit) && exit.cause.toString())
      assert.include(message, "/nonexistent/sherpa-onnx-streaming-zipformer-en-2023-06-26/")
      assert.include(message, "pnpm --filter @pva/stt-sherpa download-models zipformer-en")
    }).pipe(Effect.scoped))

  withModel("nemotron-3.5")("nemotron-3.5: English and Dutch turns in real time", () =>
    Effect.gen(function*() {
      const wavs = ["0.wav", "nl2.wav"]
      const { pcm } = timeline([800, wavs[0]!, 1500, wavs[1]!, 1500])
      const events = yield* transcribe(pacedAudio(pcm))
      checkTranscripts(events, wavs, 0.15)
      assert.isTrue(events.some((e) => e._tag === "Interim"))
    }).pipe(Effect.provide(layer({ model: "nemotron-3.5" }))), 60_000)

  withModel("zipformer-en")(
    "zipformer-en: turns with mid-sentence pauses (eager, resumed, final) in real time",
    () =>
      Effect.gen(function*() {
        const wavs = ["0.wav", "1.wav"]
        const { pcm } = timeline([800, wavs[0]!, 1500, wavs[1]!, 1500])
        const events = yield* transcribe(pacedAudio(pcm))
        const committed = checkTranscripts(events, wavs, 0.15)
        // 1.wav pauses for ~320 ms twice mid-sentence: longer than the eager threshold, shorter than the final one.
        assert.isAtLeast(committed[1]!.resumed, 1)
        // Background noise only: nothing at all.
        assert.deepStrictEqual(yield* transcribe(pacedAudio(silence(2000))), [])
      }).pipe(Effect.provide(layer({ model: "zipformer-en" }))),
    60_000
  )

  withModel("zipformer-en")("a worker crash fails the stream instead of hanging", () =>
    Effect.gen(function*() {
      const { pcm } = timeline([800, "0.wav", 1500])
      const post = Worker.prototype.postMessage
      let sent = 0
      Worker.prototype.postMessage = function(this: Worker, ...args: Parameters<Worker["postMessage"]>) {
        if (++sent === 100) void this.terminate()
        return post.apply(this, args)
      }
      const exit = yield* Effect.exit(transcribe(pacedAudio(pcm, { speed: 4 }))).pipe(
        Effect.ensuring(Effect.sync(() => (Worker.prototype.postMessage = post)))
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(Exit.isFailure(exit) && exit.cause.toString()), "Speech worker exited")
    }).pipe(Effect.provide(layer({ model: "zipformer-en" }))), 30_000)
})
