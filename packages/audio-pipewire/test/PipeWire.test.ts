import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import {
  captureBufferFrames,
  captureCommand,
  captureStream,
  defaultOptions,
  makeReframer,
  playbackCommand,
  playThrough,
  type Command
} from "../src/index.ts"

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const node = (script: string, ...args: Array<string | number>): Command => ({
  command: process.execPath,
  args: [fixture(script), ...args.map(String)]
})
const tmp = () => mkdtempSync(join(tmpdir(), "pva-pw-"))
const isAlive = (pidFile: string) => {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 0)
    return true
  } catch {
    return false
  }
}
const pattern = (n: number, from = 0) => new Uint8Array(n).map((_, i) => (from + i) % 256)
const concat = (chunks: ReadonlyArray<Uint8Array>) => Buffer.concat(chunks)
const now = Effect.sync(() => performance.now())
/** The most a child's stdout channel can hold unread: the kernel's default socket send buffer (256 KiB if unknown). */
const channelBytes = () => {
  try {
    return Number(readFileSync("/proc/sys/net/core/wmem_default", "utf8")) || 262_144
  } catch {
    return 262_144
  }
}

describe("commands", () => {
  it("builds pw-record / pw-cat arguments", () => {
    assert.deepStrictEqual(captureCommand({ ...defaultOptions, captureTarget: "echo-cancel-source" }), {
      command: "pw-record",
      args: [
        "--raw", "--format", "s16", "--rate", "16000", "--channels", "1", "--latency", "20ms",
        "--target", "echo-cancel-source", "-", "--media-role", "Communication"
      ]
    })
    assert.deepStrictEqual(playbackCommand(defaultOptions, 24_000).args, [
      "--playback", "--raw", "--format", "s16", "--rate", "24000", "--channels", "1", "--latency", "20ms",
      "-", "--media-role", "Communication"
    ])
  })
})

describe("makeReframer", () => {
  it("cuts arbitrary pieces into exact frames, keeping the remainder", () => {
    const reframe = makeReframer(4)
    assert.deepStrictEqual(reframe(Uint8Array.of(0, 1, 2)), [])
    assert.deepStrictEqual(reframe(Uint8Array.of(3, 4, 5, 6, 7, 8, 9)), [Uint8Array.of(0, 1, 2, 3), Uint8Array.of(4, 5, 6, 7)])
    assert.deepStrictEqual(reframe(Uint8Array.of(10, 11)), [Uint8Array.of(8, 9, 10, 11)])
  })
})

describe("capture", () => {
  it.live("emits 640-byte frames in order and kills the process when the consumer stops", () =>
    Effect.gen(function*() {
      const pidFile = join(tmp(), "pid")
      const frames = yield* captureStream(node("capture.mjs", pidFile, 640 * 5 + 100, "hang")).pipe(
        Stream.take(5),
        Stream.runCollect
      )
      assert.deepStrictEqual(frames.map((f) => f.length), [640, 640, 640, 640, 640])
      assert.deepStrictEqual(concat(frames), Buffer.from(pattern(640 * 5)))
      assert.isFalse(isAlive(pidFile), "capture process still running after the stream ended")
    }))

  it.live("a consumer that falls behind gets at most the newest 3 s, not everything the process wrote", () =>
    Effect.gen(function*() {
      const pidFile = join(tmp(), "pid")
      const written = `${pidFile}.written`
      // The consumer stalls on the first batch it pulls. That batch is whatever was queued at the
      // first pull (1 frame on a quiet machine, 50+ on a loaded one), and it is already in the
      // consumer's hands, so it is counted apart from what the stall lets through.
      let firstBatch = 0
      const afterStall: Array<Uint8Array> = []
      const stall = Effect.gen(function*() {
        const start = yield* now
        // Stall until the stand-in has written all 2000 frames, so the sliding buffer has
        // certainly overflowed, then a little longer for the parent to read the channel's tail.
        while (!existsSync(written)) yield* Effect.sleep(10)
        yield* Effect.sleep(Math.max(100, 700 - ((yield* now) - start)))
      })
      const total = 2000
      const error = yield* captureStream(node("capture.mjs", pidFile, 640 * total, "exit")).pipe(
        Stream.runForEachArray((frames) => {
          if (firstBatch === 0) {
            firstBatch = frames.length
            return stall
          }
          afterStall.push(...frames)
          return Effect.void
        }),
        Effect.flip
      )
      assert.strictEqual(error._tag, "AudioError")
      assert.isAtLeast(firstBatch, 1)
      const told = `${afterStall.length} frames after the stall (first batch ${firstBatch})`
      // Everything was queued while the consumer stalled; only the newest 3 s survive.
      assert.isAtLeast(afterStall.length, captureBufferFrames, told)
      // When the stall ends, the stand-in has handed everything to the kernel, but this process
      // may not have read all of it yet. What it reads late is extra, and is at most what the
      // channel (a socketpair) holds, so that is the honest upper bound: far below the 2000 written.
      assert.isAtMost(afterStall.length, captureBufferFrames + Math.ceil(channelBytes() / 640) + 1, told)
      // Whatever arrived late, the buffer drops the oldest: the last 3 s delivered are the last 3 s written.
      assert.deepStrictEqual(
        concat(afterStall.slice(-captureBufferFrames)),
        Buffer.from(pattern(640 * captureBufferFrames, 640 * (total - captureBufferFrames)))
      )
    }))

  it.live("an unexpected exit fails the stream with AudioError carrying stderr, after the audio", () =>
    Effect.gen(function*() {
      const frames: Array<Uint8Array> = []
      const error = yield* captureStream(node("capture.mjs", join(tmp(), "pid"), 640 * 3, "exit")).pipe(
        Stream.runForEach((f) => Effect.sync(() => frames.push(f))),
        Effect.flip
      )
      assert.strictEqual(error._tag, "AudioError")
      assert.include(error.message, "exited with code 3")
      assert.include(error.message, "no such target node")
      assert.strictEqual(frames.length, 3)
    }))

  it.live("a missing program fails with AudioError", () =>
    Effect.gen(function*() {
      const error = yield* captureStream({ command: "/nonexistent/pw-record", args: [] }).pipe(Stream.runDrain, Effect.flip)
      assert.include(error.message, "failed to start")
    }))
})

describe("playback", () => {
  const chunks = (count: number, size: number) =>
    Stream.fromIterable(Array.from({ length: count }, (_, i) => pattern(size, i * size)))

  it.live("writes everything and returns only after the player has finished draining", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const start = yield* now
      yield* playThrough(node("player.mjs", join(dir, "pid"), join(dir, "out"), 300, "play"), chunks(10, 960))
      const elapsed = (yield* now) - start
      assert.deepStrictEqual(readFileSync(join(dir, "out")), Buffer.from(pattern(9600)))
      assert.isAtLeast(elapsed, 300)
    }))

  it.live("interruption kills the player promptly, even while it is draining", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const pidFile = join(dir, "pid")
      const fiber = yield* Effect.forkChild(
        playThrough(node("player.mjs", pidFile, join(dir, "out"), 10_000, "play"), chunks(5, 960))
      )
      yield* Effect.sleep(300)
      assert.isTrue(isAlive(pidFile))
      const start = yield* now
      yield* Fiber.interrupt(fiber)
      const elapsed = (yield* now) - start
      assert.isFalse(isAlive(pidFile), "player still running after interruption")
      assert.isBelow(elapsed, 100)
    }))

  it.live("respects backpressure: a player that does not read stalls the writer", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const pidFile = join(dir, "pid")
      let pulled = 0
      const endless = Stream.forever(Stream.succeed(new Uint8Array(4096))).pipe(
        Stream.tap((c) => Effect.sync(() => (pulled += c.length)))
      )
      const fiber = yield* Effect.forkChild(playThrough(node("player.mjs", pidFile, join(dir, "out"), 0, "stall"), endless))
      yield* Effect.sleep(500)
      const start = yield* now
      yield* Fiber.interrupt(fiber)
      assert.isBelow((yield* now) - start, 100)
      assert.isFalse(isAlive(pidFile))
      // Bounded by the kernel buffer of Node's stdio socketpair (~200 KiB on
      // Linux) + Node's 16 KiB highWaterMark; an unbounded writer would be at MBs.
      assert.isBelow(pulled, 512 * 1024, `pulled ${pulled} bytes into a stalled player`)
    }))

  it.live("a player that stops reading fails the playback after the stall limit, and is killed", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const pidFile = join(dir, "pid")
      const endless = Stream.forever(Stream.succeed(new Uint8Array(4096)))
      const start = yield* now
      const exit = yield* Effect.exit(playThrough(node("player.mjs", pidFile, join(dir, "out"), 0, "stall"), endless, 300))
      assert.strictEqual(exit._tag, "Failure")
      assert.include(String(exit), "stopped reading its input")
      assert.isBelow((yield* now) - start, 2_000)
      assert.isFalse(isAlive(pidFile))
    }))

  it.live("a player that never exits after the end of its input fails after the stall limit, and is killed", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const pidFile = join(dir, "pid")
      const exit = yield* Effect.exit(playThrough(node("player.mjs", pidFile, join(dir, "out"), 60_000, "play"), Stream.make(pattern(1000)), 300))
      assert.strictEqual(exit._tag, "Failure")
      assert.include(String(exit), "did not exit after the end of its input")
      assert.isFalse(isAlive(pidFile))
    }))

  it.live("a player that exits early fails with AudioError carrying stderr", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const error = yield* playThrough(
        node("player.mjs", join(dir, "pid"), join(dir, "out"), 0, "fail"),
        Stream.concat(chunks(1, 960), Stream.never)
      ).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AudioError")
      assert.include(error.message, "exited with code 2")
      assert.include(error.message, "target not found")
    }))

  it.live("an upstream failure kills the player and propagates", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const pidFile = join(dir, "pid")
      const error = yield* playThrough(
        node("player.mjs", pidFile, join(dir, "out"), 0, "play"),
        Stream.concat(chunks(1, 960), Stream.fail("tts broke" as const))
      ).pipe(Effect.flip)
      assert.strictEqual(error, "tts broke")
      assert.isFalse(isAlive(pidFile))
    }))
})

// Opt-in: PVA_PIPEWIRE_LIVE=1 pnpm --filter @pva/audio-pipewire test
describe.runIf(process.env["PVA_PIPEWIRE_LIVE"] === "1")("real pw-cat", () => {
  const second = Stream.fromIterable(Array.from({ length: 50 }, () => new Uint8Array(960))) // 1 s at 24 kHz
  const command = playbackCommand(defaultOptions, 24_000)

  it.live("plays one second of audio in about one second", () =>
    Effect.gen(function*() {
      const start = yield* now
      yield* playThrough(command, second)
      const elapsed = (yield* now) - start
      console.log(`pw-cat: 1 s of audio returned after ${elapsed.toFixed(0)} ms`)
      assert.isAtLeast(elapsed, 950)
      assert.isBelow(elapsed, 1300)
    }))

  it.live("interruption returns promptly", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(playThrough(command, second))
      yield* Effect.sleep(300)
      const start = yield* now
      yield* Fiber.interrupt(fiber)
      const elapsed = (yield* now) - start
      console.log(`pw-cat: interrupted after 300 ms, interruption took ${elapsed.toFixed(1)} ms`)
      assert.isBelow(elapsed, 100)
    }))
})
