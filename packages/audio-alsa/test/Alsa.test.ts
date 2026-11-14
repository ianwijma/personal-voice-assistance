import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { captureBufferFrames, captureStream, playThrough, type Command } from "@pva/audio-pipewire"
import { Effect, Fiber, Stream } from "effect"
import {
  captureCommand,
  defaultOptions,
  listAlsaDevices,
  parseAlsaList,
  playbackCommand
} from "../src/index.ts"

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const sample = (name: string) => readFileSync(fixture(`devices/${name}`), "utf8")
const node = (script: string, ...args: Array<string | number>): Command => ({
  command: process.execPath,
  args: [fixture(script), ...args.map(String)]
})
const tmp = () => mkdtempSync(join(tmpdir(), "pva-alsa-"))
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

describe("commands", () => {
  it("builds arecord / aplay arguments", () => {
    assert.deepStrictEqual(captureCommand({ ...defaultOptions, captureDevice: "plughw:CARD=Speaker,DEV=0" }), {
      command: "arecord",
      args: [
        "-q", "-D", "plughw:CARD=Speaker,DEV=0", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1",
        "--buffer-time=20000", "--period-time=5000", "-"
      ]
    })
    assert.deepStrictEqual(playbackCommand({ ...defaultOptions, playbackLatencyMs: 100 }, 24_000), {
      command: "aplay",
      args: [
        "-q", "-D", "default", "-t", "raw", "-f", "S16_LE", "-r", "24000", "-c", "1",
        "--buffer-time=100000", "--period-time=25000", "-"
      ]
    })
  })
})

describe("parseAlsaList", () => {
  const ids = (text: string) => parseAlsaList(text).map((d) => d.id)

  it("keeps default and plughw: from a Raspberry Pi with HDMI, headphones and a USB speakerphone", () => {
    assert.deepStrictEqual(parseAlsaList(sample("aplay-L.pi.txt")), [
      { id: "default", name: "Default Audio Device", isDefault: true },
      { id: "plughw:CARD=Headphones,DEV=0", name: "bcm2835 Headphones, bcm2835 Headphones", isDefault: false },
      { id: "plughw:CARD=Speaker,DEV=0", name: "Jabra SPEAK 410 USB, USB Audio", isDefault: false }
    ])
    assert.deepStrictEqual(parseAlsaList(sample("arecord-L.pi.txt")), [
      { id: "default", name: "Default Audio Device", isDefault: true },
      { id: "plughw:CARD=Speaker,DEV=0", name: "Jabra SPEAK 410 USB, USB Audio", isDefault: false }
    ])
  })

  it("a minimal Debian VM has no bare `default`: only the plughw device, none marked default", () => {
    assert.deepStrictEqual(parseAlsaList(sample("arecord-L.debian-vm.txt")), [
      { id: "plughw:CARD=Intel,DEV=0", name: "HDA Intel, ICH6 Analog", isDefault: false }
    ])
    assert.deepStrictEqual(ids(sample("aplay-L.debian-vm.txt")), ["plughw:CARD=Intel,DEV=0"])
  })

  it("a real listing from a machine whose only entries are generic yields just `default`", () => {
    assert.deepStrictEqual(parseAlsaList(sample("arecord-L.dev-machine.txt")), [
      { id: "default", name: "Default ALSA Output (currently PipeWire Media Server)", isDefault: true }
    ])
    assert.deepStrictEqual(ids(sample("aplay-L.dev-machine.txt")), ["default"])
  })

  it("tells devices of one card apart, and copes with CRLF, blank lines and junk", () => {
    const text = "plughw:CARD=HDMI,DEV=3\r\n    HDA Intel HDMI, HDMI 0\r\n    Hardware device\r\n\r\n    stray indented line\r\n"
    assert.deepStrictEqual(parseAlsaList("    orphan description first\n" + text), [
      { id: "plughw:CARD=HDMI,DEV=3", name: "HDA Intel HDMI, HDMI 0 (device 3)", isDefault: false }
    ])
    assert.deepStrictEqual(parseAlsaList(""), [])
    assert.deepStrictEqual(parseAlsaList("plughw:CARD=X,DEV=0\n"), [{ id: "plughw:CARD=X,DEV=0", name: "plughw:CARD=X,DEV=0", isDefault: false }])
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
      let received = 0
      const fiber = yield* captureStream(node("capture.mjs", pidFile, 640 * 2000, "hang")).pipe(
        Stream.runForEach(() => Effect.andThen(Effect.sync(() => void received++), received === 0 ? Effect.sleep(700) : Effect.void)),
        Effect.forkChild
      )
      // Long enough for the stand-in process to start when the whole suite is loading the machine.
      yield* Effect.sleep(2_500)
      yield* Fiber.interrupt(fiber)
      assert.isAtMost(received, 1 + captureBufferFrames + 100, `received ${received} of 2000 frames`)
      assert.isAbove(received, 1)
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
      const error = yield* captureStream({ command: "/nonexistent/arecord", args: [] }).pipe(Stream.runDrain, Effect.flip)
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


describe("listAlsaDevices", () => {
  it.live("fails with AudioError when alsa-utils is not installed", () =>
    Effect.gen(function*() {
      // PATH is only changed for this lookup: the listing commands are found through it.
      const saved = process.env["PATH"]
      process.env["PATH"] = "/nonexistent"
      const error = yield* listAlsaDevices.pipe(Effect.flip, Effect.ensuring(Effect.sync(() => void (process.env["PATH"] = saved))))
      assert.strictEqual(error._tag, "AudioError")
    }))
})

// Opt-in: PVA_ALSA_LIVE=1 pnpm --filter @pva/audio-alsa test (uses ALSA's `null` PCM, which needs no sound card)
describe.runIf(process.env["PVA_ALSA_LIVE"] === "1")("real aplay / arecord on the null PCM", () => {
  const options = { ...defaultOptions, captureDevice: "null", playbackDevice: "null" }

  // The null PCM discards samples as fast as they come, so this proves the arguments are accepted and the
  // process drains and exits 0, not the pacing.
  it.live("aplay accepts our arguments, drains and exits", () =>
    Effect.gen(function*() {
      const second = Stream.fromIterable(Array.from({ length: 50 }, () => new Uint8Array(960))) // 1 s at 24 kHz
      const start = yield* now
      yield* playThrough(playbackCommand(options, 24_000), second)
      const elapsed = (yield* now) - start
      console.log(`aplay: 1 s of audio returned after ${elapsed.toFixed(0)} ms`)
    }))

  it.live("arecord accepts our arguments and delivers 20 ms frames", () =>
    Effect.gen(function*() {
      const frames = yield* captureStream(captureCommand(options)).pipe(Stream.take(10), Stream.runCollect)
      assert.deepStrictEqual(frames.map((f) => f.length), Array(10).fill(640))
    }))

  it.live("listAlsaDevices runs the real arecord -L / aplay -L", () =>
    Effect.gen(function*() {
      const devices = yield* listAlsaDevices
      console.log(JSON.stringify(devices))
      assert.isArray(devices.inputs)
    }))
})
