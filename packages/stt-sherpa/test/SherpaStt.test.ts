/**
 * The real models on real audio, fed at real-time pace. Skipped (with a
 * message) when the model files or test WAVs are not in `models/`.
 */
import { assert, describe, it } from "@effect/vitest"
import type { SttEvent } from "@pva/core"
import { Stt } from "@pva/core"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { defaultModelDir, missingFile, modelFiles, type PresetName, presets } from "../src/presets.ts"
import { layer, make } from "../src/SherpaStt.ts"
import { normalize, pacedAudio, readWav, references, silence, timeline, wavDir, wordErrors } from "./fixtures.ts"

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
      // Every SpeechStarted is closed by an EndOfTurn (empty when no words were recognised) before the next.
      assert.isFalse(open, "SpeechStarted inside an utterance")
      assert.isUndefined(eager, "SpeechStarted after EagerEndOfTurn")
      open = true
      continue
    }
    assert.isTrue(open, `${event._tag} outside a turn`)
    if (event._tag === "EagerEndOfTurn") {
      assert.notStrictEqual(event.text, "", "an empty EagerEndOfTurn")
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

const checkTranscripts = (events: ReadonlyArray<SttEvent>, wavs: ReadonlyArray<string>, maxWer: number, eagerRequired = true) => {
  // Utterances with no words (noise that opened one) end with an empty EndOfTurn: not turns of the clips.
  const committed = turns(events).filter((t) => t.text !== "")
  const refs = references()
  assert.strictEqual(committed.length, wavs.length, JSON.stringify(committed))
  committed.forEach((turn, i) => {
    // A whole-turn model may answer after the final threshold for a long turn: EndOfTurn without an eager.
    if (eagerRequired) assert.isDefined(turn.eager, "EndOfTurn without a preceding EagerEndOfTurn")
    if (turn.eager !== undefined) assert.strictEqual(normalize(turn.eager), normalize(turn.text))
    const reference = refs[wavs[i]!]!
    const { errors, words } = wordErrors(reference, turn.text)
    assert.isAtMost(errors / words, maxWer, `${wavs[i]}: ${turn.text}`)
    // Nothing of one turn leaks into the next (the recogniser keeps unprocessed frames across reset).
    assert.strictEqual(normalize(turn.text).split(" ")[0], normalize(reference).split(" ")[0], `${wavs[i]}: ${turn.text}`)
  })
  return committed
}

/** `pcm` (s16le) scaled by `db`. */
const scaled = (pcm: Uint8Array, db: number) => {
  const s = new Int16Array(pcm.slice().buffer)
  const gain = 10 ** (db / 20)
  for (let i = 0; i < s.length; i++) s[i] = Math.round(s[i]! * gain)
  return new Uint8Array(s.buffer)
}

/** Pink-ish noise (white noise through a one-pole low-pass) at about `dbfs` RMS, deterministic. */
const noise = (ms: number, dbfs: number) => {
  const s = new Int16Array(Math.round(ms * 16))
  let seed = 7
  let y = 0
  const target = 32768 * 10 ** (dbfs / 20)
  for (let i = 0; i < s.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    y = 0.95 * y + 0.05 * ((seed / 2 ** 32) * 2 - 1)
    s[i] = Math.round(y * target * 5.5)
  }
  return new Uint8Array(s.buffer)
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

  withModel("nemotron-320")("nemotron-320: English and Dutch turns in real time", () =>
    Effect.gen(function*() {
      const wavs = ["0.wav", "nl2.wav"]
      const { pcm } = timeline([800, wavs[0]!, 1500, wavs[1]!, 1500])
      const events = yield* transcribe(pacedAudio(pcm))
      checkTranscripts(events, wavs, 0.15)
      assert.isTrue(events.some((e) => e._tag === "Interim"))
    }).pipe(Effect.provide(layer({ model: "nemotron-320" }))), 60_000)

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

  withModel("parakeet-v2")(
    "parakeet-v2 (whole turn): one turn per sentence despite mid-sentence pauses, eager text = final text, interims while speaking",
    () =>
      Effect.gen(function*() {
        const wavs = ["0.wav", "1.wav"]
        const { pcm } = timeline([800, wavs[0]!, 1500, wavs[1]!, 1500])
        const events = yield* transcribe(pacedAudio(pcm))
        const committed = checkTranscripts(events, wavs, 0.05, false)
        assert.isDefined(committed[0]!.eager) // a short turn is decoded before the final threshold
        // Interims come from re-decoding the turn so far about once a second while the user speaks.
        assert.isAtLeast(events.filter((e) => e._tag === "Interim").length, 3)
        // Background noise only: nothing at all.
        assert.deepStrictEqual(yield* transcribe(pacedAudio(silence(2000))), [])
      }).pipe(Effect.provide(layer({ model: "parakeet-v2" }))),
    90_000
  )

  withModel("parakeet-v2")("quiet input (peaks near -40 dBFS) is recognised with the gain control on", () =>
    Effect.gen(function*() {
      const { pcm } = timeline([800, "0.wav", 1500])
      // timeline() puts the loudest 20 ms frame at -18 dBFS RMS; -24 dB more puts the peaks near -40 dBFS.
      const events = yield* transcribe(pacedAudio(scaled(pcm, -24), { speed: 2 }))
      const committed = turns(events)
      assert.strictEqual(committed.length, 1, JSON.stringify(committed))
      const { errors, words } = wordErrors(references()["0.wav"]!, committed[0]!.text)
      assert.isAtMost(errors / words, 0.1, committed[0]!.text)
    }).pipe(Effect.provide(layer({ model: "parakeet-v2", maxBacklogMs: 5000 }))), 60_000)

  withModel("parakeet-v2")("steady noise does not become speech, with the gain control on", () =>
    Effect.gen(function*() {
      for (const level of [-60, -50, -40]) {
        const events = yield* transcribe(pacedAudio(noise(8000, level), { speed: 4 }))
        assert.isFalse(events.some((e) => e._tag === "EndOfTurn"), `noise at ${level} dBFS: ${JSON.stringify(events)}`)
      }
    }).pipe(Effect.provide(layer({ model: "parakeet-v2", maxBacklogMs: 10_000 }))), 60_000)

  withModel("hybrid-nemotron-parakeet")("hybrid: live words from the streaming model, the answer from Parakeet", () =>
    Effect.gen(function*() {
      const { pcm } = timeline([800, "0.wav", 1500])
      const events = yield* transcribe(pacedAudio(pcm))
      const committed = checkTranscripts(events, ["0.wav"], 0.05)
      const interims = events.filter((e) => e._tag === "Interim")
      assert.isAtLeast(interims.length, 3)
      // The answer is Parakeet's (punctuated "light up, here and there,"), not the streaming model's last words.
      assert.include(committed[0]!.text, "light up, here and there")
      assert.isFalse(events.some((e) => e._tag === "TurnResumed"))
    }).pipe(Effect.provide(layer({ model: "hybrid-nemotron-parakeet" }))), 60_000)

  withModel("whisper-turbo")("whisper-turbo: Dutch with the language set", () =>
    Effect.gen(function*() {
      const { pcm } = timeline([800, "nl2.wav", 2500])
      const events = yield* transcribe(pacedAudio(pcm, { speed: 2 }))
      checkTranscripts(events, ["nl2.wav"], 0.35, false)
    }).pipe(Effect.provide(layer({ model: "whisper-turbo", language: "nl", maxBacklogMs: 10_000 }))), 90_000)

  withModel("nemotron-560")("nemotron-560 (streaming, fresh stream per segment): turns with pauses, nothing leaks across turns", () =>
    Effect.gen(function*() {
      const wavs = ["1.wav", "0.wav"]
      const { pcm } = timeline([800, wavs[0]!, 1500, wavs[1]!, 1500])
      const events = yield* transcribe(pacedAudio(pcm))
      checkTranscripts(events, wavs, 0.15)
      assert.isTrue(events.some((e) => e._tag === "Interim"))
    }).pipe(Effect.provide(layer({ model: "nemotron-560" }))), 90_000)

  withModel("zipformer-en")("streaming, two sentences arriving in one burst: cut at the final boundary, two turns", () =>
    Effect.gen(function*() {
      const wavs = ["0.wav", "1.wav"]
      const { pcm } = timeline([800, wavs[0]!, 1500, wavs[1]!, 1500])
      // All at once (a network stall delivering everything): the worker has fed the second sentence to the
      // open segment before the detector, far behind, decides that the first turn ended.
      const events = yield* transcribe(Stream.make(pcm))
      checkTranscripts(events, wavs, 0.15, false)
    }).pipe(Effect.provide(layer({ model: "zipformer-en", maxBacklogMs: 60_000 }))), 60_000)

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

  withModel("parakeet-v2")("closing the recogniser while native decodes run does not abort the process", () =>
    Effect.gen(function*() {
      // Terminating the worker thread during `decodeAsync` used to abort the whole process (SIGABRT).
      const pcm = readWav(join(wavDir, "0.wav"))
      const chunks: Array<Uint8Array> = []
      for (let r = 0; r < 6; r++) for (let o = 0; o + 640 <= pcm.length; o += 640) chunks.push(pcm.subarray(o, o + 640))
      for (const afterMs of [150, 400, 800, 1500]) {
        yield* Effect.gen(function*() {
          const stt = yield* make({ model: "parakeet-v2" })
          const fiber = yield* Effect.forkChild(Stream.runDrain(stt.transcribe(Stream.fromIterable(chunks))))
          yield* Effect.sleep(afterMs)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.scoped) // closes the recogniser mid-decode
      }
      assert.isTrue(true, "the process is still running")
    }), 120_000)
})
