/**
 * SherpaStt's main-thread logic against a stand-in worker (test/fake-worker.mjs): no model is loaded.
 */
import { assert, describe, it } from "@effect/vitest"
import type { SttEvent } from "@pva/core"
import { Effect, Fiber, Stream } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { modelFiles, type PresetName, presets } from "../src/presets.ts"
import { acquire, check, makeWithWorker, orphans, whenNoOrphans, workerKey, workers } from "../src/SherpaStt.ts"

const fakeWorker = new URL("./fake-worker.mjs", import.meta.url)
const fakeStreamingWorker = new URL("./fake-streaming-worker.mjs", import.meta.url)

/** A model directory with empty stand-ins for every file the preset needs (the fake worker reads none of them). */
const fakeModelDir = (preset: PresetName = "parakeet-v2") => {
  const dir = mkdtempSync(join(tmpdir(), "pva-fake-models-"))
  const files = modelFiles(presets[preset], dir)
  const all = [files.vad, ...Object.values(files.offline ?? {}), ...Object.values(files.streaming ?? {})]
  for (const file of all) {
    if (typeof file !== "string" || !file.startsWith(dir)) continue
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "")
  }
  return dir
}

/**
 * `ms` of loud (speech, for the fake) or silent 16 kHz audio, in 20 ms chunks. A number instead of a boolean is
 * the amplitude in thousands: the streaming stand-in names that audio's word after it (`5` → "w5").
 */
const audio = (pattern: ReadonlyArray<[boolean | number, number]>) => {
  const chunks: Array<Uint8Array> = []
  for (const [loud, ms] of pattern) {
    const amplitude = loud === true ? 8000 : loud === false ? 0 : loud * 1000
    for (let t = 0; t < ms; t += 20) chunks.push(new Uint8Array(new Int16Array(320).fill(amplitude).buffer))
  }
  return Stream.fromIterable(chunks)
}

const transcribe = (
  stream: Stream.Stream<Uint8Array>,
  worker: { frameDelayMs?: number; decodeMs?: number; text?: string; stallMs?: number; maxQueuedDecodeMs?: number }
) =>
  Effect.gen(function*() {
    const stt = yield* makeWithWorker({ model: "parakeet-v2", modelDir: fakeModelDir(), agc: false }, { url: fakeWorker, data: worker })
    const events = yield* Stream.runCollect(stt.transcribe(stream))
    return [...events] as Array<SttEvent>
  }).pipe(Effect.scoped)

describe("SherpaStt (stand-in worker): end of a finite input", () => {
  it.live("a short unpaced input whose frames the worker has not processed yet still gets its transcript", () =>
    Effect.gen(function*() {
      // 400 ms of speech, no pause after it, sent at once; the worker needs 2 ms per frame.
      const events = yield* transcribe(audio([[true, 400]]), { frameDelayMs: 2, text: "Turn on the light." })
      assert.deepStrictEqual(events.map((e) => e._tag), ["SpeechStarted", "EndOfTurn"])
      assert.deepStrictEqual(events.at(-1), { _tag: "EndOfTurn", text: "Turn on the light." })
    }))

  it.live("frames still queued at the end are not ignored: speech, a pause, more speech, all at once", () =>
    Effect.gen(function*() {
      const events = yield* transcribe(audio([[true, 300], [false, 700], [true, 300]]), { frameDelayMs: 1, text: "t" })
      // Two turns: the second one only exists in frames the worker processes after the input ended.
      assert.strictEqual(events.filter((e) => e._tag === "EndOfTurn").length, 2)
    }))

  it.live("the stream ends only after a slow final decode has answered", () =>
    Effect.gen(function*() {
      const events = yield* transcribe(audio([[true, 300], [false, 100]]), { decodeMs: 300, text: "Slow." })
      assert.deepStrictEqual(events.at(-1), { _tag: "EndOfTurn", text: "Slow." })
    }))
})

describe("SherpaStt (stand-in worker): every utterance that started ends with EndOfTurn", () => {
  it.live("a turn dropped by an overload (its finalise queued behind a stalled decode) ends with an empty EndOfTurn; the next utterance and the end of input still work", () =>
    Effect.gen(function*() {
      // 36 s of speech (a 35 s piece goes to the stalled decoder), a pause (the finalise queues behind it), speech
      // that no longer fits the queue (the turn is dropped), a pause, a short sentence, the end of the input.
      const events = yield* transcribe(
        audio([[true, 36_000], [false, 400], [true, 45_000], [false, 1_500], [true, 600], [false, 1_000]]),
        { stallMs: 300, maxQueuedDecodeMs: 40_000, text: "words" }
      ).pipe(Effect.timeout("20 seconds"))
      const tags = events.map((e) => (e._tag === "EndOfTurn" || e._tag === "EagerEndOfTurn" ? `${e._tag}(${e.text})` : e._tag))
      assert.strictEqual(tags.filter((t) => t === "SpeechStarted").length, tags.filter((t) => t.startsWith("EndOfTurn")).length, tags.join(" "))
      assert.include(tags, "EndOfTurn()", "the dropped turn is closed, with no text")
      assert.strictEqual(tags.at(-1), "EndOfTurn(words)", "the next utterance is decoded normally")
      assert.notInclude(tags, "EagerEndOfTurn()")
    }), { timeout: 30_000 })

  it.live("noise that opened an utterance but got no words: an empty EndOfTurn", () =>
    Effect.gen(function*() {
      const events = yield* transcribe(audio([[true, 300], [false, 1_000]]), { text: "" })
      assert.deepStrictEqual(events, [{ _tag: "SpeechStarted" }, { _tag: "EndOfTurn", text: "" }])
      // A click (under minSpeechMs) opens nothing and ends with nothing.
      assert.deepStrictEqual(yield* transcribe(audio([[true, 40], [false, 1_000]]), { text: "" }), [])
    }))
})

const transcribeStreaming = (
  stream: Stream.Stream<Uint8Array>,
  worker: { frameDelayMs?: number; decodeMs?: number; partials?: boolean }
) =>
  Effect.gen(function*() {
    const stt = yield* makeWithWorker({ model: "nemotron-560", modelDir: fakeModelDir("nemotron-560"), agc: false }, {
      url: fakeStreamingWorker,
      data: worker
    })
    const events = yield* Stream.runCollect(stt.transcribe(stream))
    return [...events] as Array<SttEvent>
  }).pipe(Effect.scoped)

const turns = (events: ReadonlyArray<SttEvent>) => events.flatMap((e) => (e._tag === "EndOfTurn" ? [e.text] : []))

describe("SherpaStt (stand-in streaming worker): the final boundary", () => {
  // 300 ms of a word, then silence: eager at 250 ms, final at 600 ms of silence (the defaults).
  const cases: ReadonlyArray<{ name: string; input: ReadonlyArray<[boolean | number, number]>; turns: ReadonlyArray<string> }> = [
    { name: "one sentence", input: [[8, 300], [false, 700]], turns: ["w8"] },
    { name: "resumed before the boundary (the eager finalise is cancelled)", input: [[8, 300], [false, 300], [5, 300], [false, 700]], turns: ["w8 w5"] },
    { name: "the next sentence after the boundary", input: [[8, 300], [false, 700], [5, 300], [false, 700]], turns: ["w8", "w5"] },
    {
      name: "resumed before and the next sentence after the boundary",
      input: [[8, 300], [false, 300], [5, 300], [false, 700], [3, 300], [false, 700]],
      turns: ["w8 w5", "w3"]
    },
    { name: "the next sentence after the boundary, input ending right after it", input: [[8, 300], [false, 700], [5, 300]], turns: ["w8", "w5"] },
    { name: "resumed before the boundary, input ending right after it", input: [[8, 300], [false, 300], [5, 300]], turns: ["w8 w5"] },
    { name: "cancelled by a short resumption, input ending right after it", input: [[8, 300], [false, 260], [5, 120]], turns: ["w8 w5"] }
  ]
  const workers: ReadonlyArray<{ label: string; worker: { frameDelayMs?: number; decodeMs?: number; partials?: boolean } }> = [
    { label: "worker behind (all input at once)", worker: { frameDelayMs: 1 } },
    { label: "slow finalisation", worker: { decodeMs: 250 } },
    { label: "slow finalisation, no partials", worker: { decodeMs: 250, partials: false } },
    { label: "worker behind and slow finalisation", worker: { frameDelayMs: 1, decodeMs: 150 } }
  ]
  for (const w of workers) {
    for (const c of cases) {
      it.live(`${w.label}: ${c.name}`, () =>
        Effect.gen(function*() {
          const events = yield* transcribeStreaming(audio(c.input), w.worker)
          assert.deepStrictEqual(turns(events), c.turns, events.map((e) => ("text" in e ? `${e._tag}(${e.text})` : e._tag)).join(" "))
          // Every turn that ends was started.
          assert.strictEqual(events.filter((e) => e._tag === "SpeechStarted").length >= c.turns.length, true)
        }))
    }
  }
})

describe("SherpaStt (stand-in streaming worker, production boundary code): segments past the retention limit", () => {
  // 40 s of talking with 200 ms pauses (shorter than the 250 ms eager silence: one open segment), then the boundary.
  const long: Array<[boolean | number, number]> = []
  for (let i = 0; i < 40; i++) long.push([8, 800], [false, 200])
  for (const w of [{ label: "worker behind (all input at once)", worker: { frameDelayMs: 1 } }, { label: "slow finalisation", worker: { decodeMs: 250 } }]) {
    it.live(`${w.label}: the next sentence after a 40 s segment's boundary is its own turn`, () =>
      Effect.gen(function*() {
        const events = yield* transcribeStreaming(audio([...long, [7, 300], [false, 700], [5, 300], [false, 700]]), w.worker)
        const t = turns(events)
        assert.strictEqual(t.length, 2, t.join(" | "))
        assert.isTrue(t[0]!.endsWith("w7"), t[0])
        assert.strictEqual(t[1], "w5")
      }), { timeout: 30_000 })
  }
})

describe("SherpaStt (stand-in worker): a worker that does not answer close", () => {
  it.live("is left behind once, and no second worker of its key is loaded beside it until it has gone; another key loads", () =>
    Effect.gen(function*() {
      const options = { model: "parakeet-v2" as const, modelDir: fakeModelDir(), agc: false }
      // A native decode that takes 600 ms to settle; the close waits only 100 ms.
      const data = { closeDelayMs: 600 }
      const stuck = { url: fakeWorker, data, closeWaitMs: 100 }
      const key = workerKey(options, stuck)
      yield* Effect.scoped(makeWithWorker(options, stuck))
      assert.strictEqual(orphans(key), 1, "left running")
      assert.strictEqual(orphans(), 1)
      // A reload's preflight (`check`) refuses too, before the running engines are stopped.
      assert.strictEqual((yield* Effect.result(check(options, stuck)))._tag, "Failure", "check")
      const refused = yield* Effect.result(Effect.scoped(makeWithWorker(options, { url: fakeWorker, data })))
      assert.strictEqual(refused._tag, "Failure", "refused")
      if (refused._tag === "Failure") assert.include(refused.failure.message, "has not shut down")
      // The rule is per key: another model (here another model directory) loads beside the orphan.
      const other = { ...options, modelDir: fakeModelDir() }
      assert.strictEqual((yield* Effect.result(check(other, { url: fakeWorker, data })))._tag, "Success")
      yield* Effect.scoped(makeWithWorker(other, { url: fakeWorker, data }))
      // Once it answers it is terminated and counted out; loading works again.
      yield* Effect.promise(() => whenNoOrphans(key))
      assert.strictEqual(orphans(), 0)
      yield* Effect.scoped(makeWithWorker(options, { url: fakeWorker, data }))
      assert.strictEqual(orphans(), 0)
    }))

  it.live("a worker that crashed is not counted as left behind, and closing it does not wait", () =>
    Effect.gen(function*() {
      const options = { model: "parakeet-v2" as const, modelDir: fakeModelDir(), agc: false }
      const t0 = Date.now()
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
        const stt = yield* makeWithWorker(options, { url: fakeWorker, data: { exitOnAudio: true }, closeWaitMs: 2_000 })
        return yield* Stream.runDrain(stt.transcribe(audio([[true, 200]])))
      })))
      assert.strictEqual(exit._tag, "Failure")
      assert.isBelow(Date.now() - t0, 1_500, "closed without waiting for an answer from a dead thread")
      assert.strictEqual(orphans(), 0)
      yield* Effect.scoped(makeWithWorker(options, { url: fakeWorker }))
    }))
})

describe("SherpaStt (stand-in worker): one worker per key, per-stream options (docs/ASSISTANTS.md §3.2)", () => {
  const tagsOf = (events: ReadonlyArray<SttEvent>) => events.map((e) => ("text" in e ? `${e._tag}(${e.text})` : e._tag)).join(" ")

  it.live("two hearers on one model with different end pauses share one worker, and each gets its own end of turn", () =>
    Effect.gen(function*() {
      const dir = fakeModelDir()
      const script = { url: fakeWorker, data: { wordsOfAudio: true, decodeMs: 5 } }
      const before = workers()
      const quick = yield* makeWithWorker({ model: "parakeet-v2", modelDir: dir, agc: false, eagerSilenceMs: 150, finalSilenceMs: 300 }, script)
      const patient = yield* makeWithWorker({ model: "parakeet-v2", modelDir: dir, agc: false, eagerSilenceMs: 250, finalSilenceMs: 900, vadThreshold: 0.6 }, script)
      assert.strictEqual(workers() - before, 1, "one worker for both")
      // Speech, a 500 ms pause, more speech, a long pause: the quick hearer ends a turn in the pause, the patient one
      // waits it out and hears one turn.
      const spoken = () => audio([[8, 300], [false, 500], [6, 300], [false, 1_200]])
      const [a, b] = yield* Effect.all([Stream.runCollect(quick.transcribe(spoken())), Stream.runCollect(patient.transcribe(spoken()))], {
        concurrency: "unbounded"
      })
      assert.deepStrictEqual(turns([...a]), ["w8", "w6"], tagsOf([...a]))
      assert.deepStrictEqual(turns([...b]), ["w8 w6"], tagsOf([...b]))
    }).pipe(Effect.scoped))

  it.live("two models are two workers; a worker is stopped with its last user", () =>
    Effect.gen(function*() {
      const before = workers()
      yield* Effect.scoped(Effect.gen(function*() {
        const a = yield* acquire({ model: "parakeet-v2", modelDir: fakeModelDir(), agc: false }, { url: fakeWorker, data: { text: "a" } })
        const b = yield* acquire({ model: "parakeet-v2", modelDir: fakeModelDir(), agc: false }, { url: fakeWorker, data: { text: "b" } })
        assert.notStrictEqual(a.key, b.key)
        assert.strictEqual(workers() - before, 2)
        const heard = yield* Effect.all([
          Stream.runCollect(a.forStream({ agc: false }).transcribe(audio([[true, 300], [false, 700]]))),
          Stream.runCollect(b.forStream({ agc: false }).transcribe(audio([[true, 300], [false, 700]])))
        ], { concurrency: "unbounded" })
        assert.deepStrictEqual(heard.map((events) => turns([...events])), [["a"], ["b"]])
      }))
      assert.strictEqual(workers(), before, "both stopped")
    }))

  it.live("the language is part of the key only for a model that takes one", () =>
    Effect.sync(() => {
      assert.strictEqual(workerKey({ model: "parakeet-v2", language: "en" }), workerKey({ model: "parakeet-v2", language: "nl" }))
      assert.notStrictEqual(workerKey({ model: "whisper-turbo", language: "en" }), workerKey({ model: "whisper-turbo", language: "nl" }))
      assert.notStrictEqual(workerKey({ model: "parakeet-v2" }), workerKey({ model: "parakeet-v2", threads: 7 }))
      assert.strictEqual(workerKey({ model: "parakeet-v2", finalSilenceMs: 100 }), workerKey({ model: "parakeet-v2", finalSilenceMs: 900, vadThreshold: 0.3, agc: false }))
    }))

  it.live("a worker that died is not reused: its users are told, and the next caller loads a new one", () =>
    Effect.gen(function*() {
      const options = { model: "parakeet-v2" as const, modelDir: fakeModelDir(), agc: false }
      const script = { url: fakeWorker, data: { exitOnAudioOf: 1 } }
      const first = yield* acquire(options, script)
      let told: string | undefined
      first.onFailure((e) => {
        told = e.message
      })
      const exit = yield* Effect.exit(Stream.runDrain(first.forStream().transcribe(audio([[true, 200]]))))
      assert.strictEqual(exit._tag, "Failure")
      assert.include(told ?? "", "exited", String(exit))
      assert.isDefined(first.failure())
      const second = yield* acquire(options, script)
      assert.notStrictEqual(second, first)
      assert.isUndefined(second.failure())
    }).pipe(Effect.scoped))
})

describe("SherpaStt (stand-in worker): several transcriptions at once on one worker", () => {
  const options = { model: "parakeet-v2" as const, agc: false }
  const tags = (events: ReadonlyArray<SttEvent>) => events.map((e) => ("text" in e ? `${e._tag}(${e.text})` : e._tag)).join(" ")

  it.live("two concurrent transcriptions each get their own turns", () =>
    Effect.gen(function*() {
      const stt = yield* makeWithWorker({ ...options, modelDir: fakeModelDir() }, { url: fakeWorker, data: { wordsOfAudio: true, frameDelayMs: 1, decodeMs: 30 } })
      const [a, b] = yield* Effect.all([
        Stream.runCollect(stt.transcribe(audio([[8, 300], [false, 700], [6, 300], [false, 700]]))),
        Stream.runCollect(stt.transcribe(audio([[false, 200], [5, 400], [false, 700]])))
      ], { concurrency: "unbounded" })
      assert.deepStrictEqual(turns([...a]), ["w8", "w6"], tags([...a]))
      assert.deepStrictEqual(turns([...b]), ["w5"], tags([...b]))
    }).pipe(Effect.scoped))

  it.live("two concurrent streaming transcriptions each get their own turns", () =>
    Effect.gen(function*() {
      const stt = yield* makeWithWorker({ model: "nemotron-560", modelDir: fakeModelDir("nemotron-560"), agc: false }, {
        url: fakeStreamingWorker,
        data: { frameDelayMs: 1 }
      })
      const [a, b] = yield* Effect.all([
        Stream.runCollect(stt.transcribe(audio([[8, 300], [false, 700], [6, 300], [false, 700]]))),
        Stream.runCollect(stt.transcribe(audio([[5, 300], [false, 300], [3, 300], [false, 700]])))
      ], { concurrency: "unbounded" })
      assert.deepStrictEqual(turns([...a]), ["w8", "w6"], tags([...a]))
      assert.deepStrictEqual(turns([...b]), ["w5 w3"], tags([...b]))
    }).pipe(Effect.scoped))

  it.live("closing one transcription leaves the other running, and a new one can start beside it", () =>
    Effect.gen(function*() {
      const stt = yield* makeWithWorker({ ...options, modelDir: fakeModelDir() }, { url: fakeWorker, data: { wordsOfAudio: true, frameDelayMs: 1, decodeMs: 30 } })
      const [a, b] = yield* Effect.all([
        Stream.runCollect(stt.transcribe(audio([[9, 300], [false, 700], [8, 300], [false, 700]]))),
        // Closed after its first event, while the first one still has most of its audio to go.
        Stream.runCollect(stt.transcribe(audio([[3, 2_000], [false, 700]])).pipe(Stream.take(1)))
      ], { concurrency: "unbounded" })
      assert.deepStrictEqual(turns([...a]), ["w9", "w8"], tags([...a]))
      assert.deepStrictEqual([...b], [{ _tag: "SpeechStarted" }])
      // The worker still serves a new transcription.
      const c = yield* Stream.runCollect(stt.transcribe(audio([[2, 300], [false, 700]])))
      assert.deepStrictEqual(turns([...c]), ["w2"])
    }).pipe(Effect.scoped))

  it.live("a worker crash fails every open transcription", () =>
    Effect.gen(function*() {
      // Session 2's first audio kills the thread while session 1 is still waiting for its frames.
      const stt = yield* makeWithWorker({ ...options, modelDir: fakeModelDir() }, { url: fakeWorker, data: { exitOnAudioOf: 2, frameDelayMs: 2 } })
      const first = yield* Effect.forkChild(Effect.exit(Stream.runDrain(stt.transcribe(audio([[true, 3_000], [false, 700]])))))
      yield* Effect.sleep(20)
      const second = yield* Effect.exit(Stream.runDrain(stt.transcribe(audio([[true, 300], [false, 700]]))))
      const a = yield* Fiber.join(first)
      assert.strictEqual(a._tag, "Failure")
      assert.strictEqual(second._tag, "Failure")
      // A later transcription fails at once with the same error.
      const third = yield* Effect.exit(Stream.runDrain(stt.transcribe(audio([[true, 100]]))))
      assert.strictEqual(third._tag, "Failure")
    }).pipe(Effect.scoped))
})
