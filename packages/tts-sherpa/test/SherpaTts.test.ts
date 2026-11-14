import { assert, describe, it } from "@effect/vitest"
import type { TtsAudio } from "@pva/core"
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { make } from "../src/index.ts"
import { defaultJoinOptions, type JoinOptions } from "../src/Pcm.ts"
import { makeEngineTts } from "../src/SherpaTts.ts"

const RATE = 16_000
const hostScript = fileURLToPath(new URL("./fake-host.mjs", import.meta.url))
/** Raw stand-in clause length in samples: 60 ms + 10 ms per character + 150 ms (see fake-host.mjs). */
const rawSamples = (text: string) => Math.round(RATE * 0.06) + Math.round(RATE * 0.01 * text.length) + Math.round(RATE * 0.15)

const fake = (
  options: { delayMs?: number; failLoad?: boolean; jobTimeoutMs?: number; join?: Partial<JoinOptions> } = {}
) =>
  makeEngineTts(
    {
      hostScript,
      init: {
        type: "init",
        module: "fake",
        config: { sampleRate: RATE, delayMs: options.delayMs ?? 5, failLoad: options.failLoad ?? false },
        speaker: 0,
        speed: 1
      },
      ...(options.jobTimeoutMs === undefined ? {} : { jobTimeoutMs: () => options.jobTimeoutMs! })
    },
    { ...defaultJoinOptions, ...options.join }
  )

const collect = (s: Stream.Stream<TtsAudio, unknown>) => Stream.runCollect(s).pipe(Effect.map((c) => [...c]))
const bytes = (chunks: ReadonlyArray<TtsAudio>) => chunks.reduce((n, c) => n + c.audio.length, 0)
const untrimmed = { trim: false }

describe("SherpaTts with a stand-in engine", () => {
  it.live("reports the engine's sample rate and tags chunks with non-decreasing clause indexes", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake({ join: untrimmed })
      assert.strictEqual(tts.sampleRate, RATE)
      const texts = ["Hello there,", "  ", "how are you?", "Fine."]
      const chunks = yield* collect(tts.synthesize(Stream.fromIterable(texts)))
      const indexes = chunks.map((c) => c.clause)
      assert.deepStrictEqual([...new Set(indexes)], [0, 2, 3]) // the blank clause uses up index 1, no audio
      for (let i = 1; i < indexes.length; i++) assert.isAtLeast(indexes[i]!, indexes[i - 1]!)
      for (const [clause, text] of [[0, texts[0]!], [2, "how are you?"], [3, "Fine."]] as const) {
        assert.strictEqual(bytes(chunks.filter((c) => c.clause === clause)), rawSamples(text) * 2)
      }
    }).pipe(Effect.scoped))

  it.live("emits chunks of chunkMs (40 ms default), only the last of a clause's speech (and of the pause after it) shorter", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake()
      const chunks = yield* collect(tts.synthesize(Stream.make("a fairly long clause of text,", "and another one.")))
      const size = RATE * 0.04 * 2
      for (const clause of [0, 1]) {
        const mine = chunks.filter((c) => c.clause === clause)
        assert.isAbove(mine.length, 3)
        for (const c of mine) assert.isAtMost(c.audio.length, size)
        // Clause 0: its speech, then the pause after it, each ending in at most one shorter chunk. Clause 1: speech only.
        const short = mine.filter((c) => c.audio.length < size).length
        assert.isAtMost(short, clause === 0 ? 2 : 1)
      }
    }).pipe(Effect.scoped))

  it.live("the pause between clauses belongs to the clause before it: a clause's chunks start with its speech", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake()
      const texts = ["Turn on the lights.", "  ", "Which room?"]
      const chunks = yield* collect(tts.synthesize(Stream.fromIterable(texts)))
      const pcmOf = (clause: number) => {
        const mine = chunks.filter((c) => c.clause === clause)
        const out = new Int16Array(mine.reduce((n, c) => n + c.audio.length / 2, 0))
        let at = 0
        for (const c of mine) {
          out.set(new Int16Array(c.audio.buffer.slice(c.audio.byteOffset, c.audio.byteOffset + c.audio.length)), at)
          at += c.audio.length / 2
        }
        return out
      }
      const limit = defaultJoinOptions.threshold * 32767
      const leadingMs = (pcm: Int16Array) => (pcm.findIndex((x) => Math.abs(x) >= limit) * 1000) / RATE
      const trailingMs = (pcm: Int16Array) => ((pcm.length - 1 - pcm.findLastIndex((x) => Math.abs(x) >= limit)) * 1000) / RATE
      // Clause 2 (index 1 is blank) starts with at most the 20 ms pad of silence, not the 300 ms sentence pause.
      assert.isAtMost(leadingMs(pcmOf(2)), defaultJoinOptions.padMs + 1)
      // That pause is at the end of clause 0 (its pad plus the inserted gap: the full sentence pause minus the next pad).
      assert.closeTo(trailingMs(pcmOf(0)), defaultJoinOptions.sentencePauseMs - defaultJoinOptions.padMs, 2)
      // Indexes never go back.
      const indexes = chunks.map((c) => c.clause)
      for (let i = 1; i < indexes.length; i++) assert.isAtLeast(indexes[i]!, indexes[i - 1]!)
    }).pipe(Effect.scoped))

  it.live("synthesises each clause as it arrives, not at the end of the input", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake()
      const later = Stream.fromEffect(Effect.as(Effect.sleep("300 millis"), "second."))
      const start = performance.now()
      let first = -1
      yield* tts.synthesize(Stream.concat(Stream.make("first,"), later)).pipe(
        Stream.runForEach(() => Effect.sync(() => (first = first < 0 ? performance.now() - start : first)))
      )
      assert.isBelow(first, 150)
    }).pipe(Effect.scoped))

  it.live("interruption returns at once, drops queued clauses and leaks nothing into the next turn", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake({ delayMs: 100, join: untrimmed })
      // Turn 1: five clauses of 100 ms synthesis each; interrupt after the first chunk.
      const gotFirst = yield* Deferred.make<void>()
      const turn1 = yield* tts.synthesize(Stream.fromIterable(["one,", "two,", "three,", "four,", "five."])).pipe(
        Stream.runForEach(() => Deferred.succeed(gotFirst, undefined)),
        Effect.forkChild
      )
      yield* Deferred.await(gotFirst)
      yield* Effect.sleep("20 millis") // clause 1 is now in flight in the engine
      const t0 = performance.now()
      yield* Fiber.interrupt(turn1)
      const interruptMs = performance.now() - t0
      assert.isBelow(interruptMs, 20)

      // Turn 2 waits behind at most the in-flight clause (100 ms), not the three queued ones.
      const start = performance.now()
      let first = -1
      const chunks = yield* tts.synthesize(Stream.make("alpha,", "beta.")).pipe(
        Stream.tap(() => Effect.sync(() => (first = first < 0 ? performance.now() - start : first))),
        Stream.runCollect
      )
      assert.isBelow(first, 100 + 100 + 60)
      // Only turn 2's audio, attributed to turn 2's clauses.
      assert.strictEqual(bytes([...chunks]), (rawSamples("alpha,") + rawSamples("beta.")) * 2)
      assert.deepStrictEqual([...new Set([...chunks].map((c) => c.clause))], [0, 1])
    }).pipe(Effect.scoped))

  it.live("an engine crash fails the turn with TtsError and the next turn works", () =>
    Effect.gen(function*() {
      const { tts, engine } = yield* fake()
      const pid = engine.pid
      const exit = yield* Effect.exit(collect(tts.synthesize(Stream.make("fine,", "now crash."))))
      assert.isTrue(Exit.isFailure(exit))
      const error = Exit.isFailure(exit) ? String(exit.cause) : ""
      assert.include(error, "TtsError")
      assert.include(error, "engine process died (exit code 3)")
      const chunks = yield* collect(tts.synthesize(Stream.make("hello again.")))
      assert.isAbove(chunks.length, 0)
      assert.notStrictEqual(engine.pid, pid)
    }).pipe(Effect.scoped))

  it.live("a stuck synthesis is killed after the timeout and the next turn works", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake({ jobTimeoutMs: 300 })
      const exit = yield* Effect.exit(collect(tts.synthesize(Stream.make("hang"))))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(Exit.isFailure(exit) ? String(exit.cause) : "", "synthesis took longer than 300 ms")
      assert.isAbove((yield* collect(tts.synthesize(Stream.make("ok.")))).length, 0)
    }).pipe(Effect.scoped))

  it.live("an engine error for one clause fails the turn with TtsError", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake()
      const exit = yield* Effect.exit(collect(tts.synthesize(Stream.make("fail"))))
      assert.include(Exit.isFailure(exit) ? String(exit.cause) : "", "synthesis failed: bad text")
      assert.isAbove((yield* collect(tts.synthesize(Stream.make("ok.")))).length, 0)
    }).pipe(Effect.scoped))

  it.live("a failed model load fails the layer with TtsError", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(fake({ failLoad: true }))
      assert.include(Exit.isFailure(exit) ? String(exit.cause) : "", "model file is corrupt")
    }).pipe(Effect.scoped))

  it.live("closing the scope stops the engine process", () =>
    Effect.gen(function*() {
      const pid = yield* Effect.scoped(Effect.map(fake(), ({ engine }) => engine.pid!))
      yield* Effect.sleep("100 millis")
      assert.throws(() => process.kill(pid, 0)) // ESRCH: gone
    }))

  it.live("an empty clause stream ends at once", () =>
    Effect.gen(function*() {
      const { tts } = yield* fake()
      assert.deepStrictEqual(yield* collect(tts.synthesize(Stream.empty)), [])
    }).pipe(Effect.scoped))
})

describe("make", () => {
  it.live("names the missing model file and the download command", () =>
    Effect.gen(function*() {
      const modelDir = mkdtempSync(join(tmpdir(), "tts-sherpa-"))
      const exit = yield* Effect.exit(make({ modelDir }))
      const message = Exit.isFailure(exit) ? String(exit.cause) : ""
      assert.include(message, join(modelDir, "vits-piper-en_US-lessac-medium", "en_US-lessac-medium.onnx"))
      assert.include(message, "pnpm --filter @pva/tts-sherpa download en_US-lessac-medium")
    }).pipe(Effect.scoped))

  it.live("rejects an unknown preset", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(make({ preset: "nope" }))
      assert.include(Exit.isFailure(exit) ? String(exit.cause) : "", "Unknown sherpa TTS preset")
    }).pipe(Effect.scoped))
})

describe("engine host process", () => {
  it.live("survives Ctrl+C (SIGINT to the process group) and exits when the parent's channel closes", () =>
    Effect.promise(async () => {
      const { fork } = await import("node:child_process")
      const { fileURLToPath } = await import("node:url")
      const child = fork(fileURLToPath(new URL("../src/engine-host.mjs", import.meta.url)), [], {
        execArgv: [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"]
      })
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
      await new Promise((resolve) => child.once("spawn", resolve))
      await new Promise((resolve) => setTimeout(resolve, 200)) // let it install its handlers
      child.kill("SIGINT")
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.strictEqual(child.exitCode, null)
      assert.strictEqual(child.signalCode, null)
      child.disconnect()
      assert.strictEqual(await exited, 0)
    }), 10_000)
})
