import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeWav } from "@pva/audio-file"
import { exampleTrace } from "@pva/protocol/examples"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { fileCapture, inputFiles } from "../src/audio.ts"
import { parseConfig, readConfig, webSocketUrl, writeConfig } from "../src/config.ts"
import { closeAction, reconnectDelay } from "../src/connection.ts"
import { applyGain, PlaybackClock, volumeGain } from "../src/playback.ts"
import { formatTraceInfo } from "../src/session.ts"
import { identifySound, testTone, TONE_RATE, wakeCue } from "../src/tones.ts"

describe("PlaybackClock", () => {
  it("counts real time after the latency, clamped to what was written, never decreasing", () => {
    const clock = new PlaybackClock(16_000, 20)
    clock.write(1600, 0) // 100 ms
    expect(clock.played(10)).toBe(0) // still in the device's latency
    expect(clock.played(70)).toBe(800) // 50 ms after the latency
    expect(clock.played(500)).toBe(1600) // clamped to written
    expect(clock.played(100)).toBe(1600) // never decreases
    expect(clock.underruns).toBe(0)
  })

  it("restarts the estimate after an underrun instead of counting the idle time", () => {
    const clock = new PlaybackClock(16_000, 0)
    clock.write(1600, 0) // plays 0..100 ms
    clock.write(1600, 50) // in time: no underrun
    expect(clock.underruns).toBe(0)
    clock.write(1600, 1000) // ran dry at 200 ms: underrun, the new audio plays from 1000 ms
    expect(clock.underruns).toBe(1)
    expect(clock.played(1000)).toBe(3200)
    expect(clock.played(1050)).toBe(4000)
    expect(clock.played(5000)).toBe(4800)
  })
})

describe("volume", () => {
  it("is (volume/100)², clamped", () => {
    expect(volumeGain(100)).toBe(1)
    expect(volumeGain(50)).toBe(0.25)
    expect(volumeGain(0)).toBe(0)
    expect(volumeGain(150)).toBe(1)
    expect(volumeGain(-3)).toBe(0)
  })

  it("scales samples on a typed array and clips", () => {
    const pcm = new Uint8Array(new Int16Array([1000, -1000, 32767, -32768]).buffer)
    expect(Array.from(new Int16Array(applyGain(pcm, 0.5).buffer))).toEqual([500, -500, 16384, -16384])
    expect(Array.from(new Int16Array(applyGain(pcm, 2).buffer))).toEqual([2000, -2000, 32767, -32768])
    expect(applyGain(pcm, 1)).toBe(pcm)
  })
})

describe("reconnect policy", () => {
  const timing = { backoffBaseMs: 500, backoffMaxMs: 30_000 }
  it("doubles from 0.5 s to 30 s with equal jitter", () => {
    expect([1, 2, 3, 7, 8, 20].map((n) => reconnectDelay(n, timing, () => 1))).toEqual([500, 1000, 2000, 30_000, 30_000, 30_000])
    expect(reconnectDelay(1, timing, () => 0)).toBe(250)
    expect(reconnectDelay(20, timing, () => 0)).toBe(15_000)
  })

  it("maps close codes", () => {
    expect(closeAction(4400)).toBe("outdated")
    expect(closeAction(4403)).toBe("unauthorized")
    for (const code of [0, 1000, 1001, 1006, 4401, 4402, 4408, 4429]) expect(closeAction(code)).toBe("retry")
  })
})

describe("config", () => {
  it("reads and writes node.json with mode 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-node-"))
    try {
      const path = join(dir, "node.json")
      const config = { server: "http://assistant.lan:8787", deviceId: "abcdefgh12", credential: "x".repeat(43) }
      await Effect.runPromise(writeConfig(path, config))
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(await Effect.runPromise(readConfig(path))).toEqual(config)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a config that is not one", async () => {
    const bad = await Effect.runPromise(Effect.flip(parseConfig(JSON.stringify({ server: "assistant.lan", deviceId: "abcdefgh" }))))
    expect(bad.message).toContain("not a valid node config")
    const notJson = await Effect.runPromise(Effect.flip(parseConfig("{")))
    expect(notJson.message).toContain("not valid JSON")
  })

  it("derives the WebSocket URL", () => {
    expect(webSocketUrl("http://assistant.lan:8787")).toBe("ws://assistant.lan:8787/ws")
    expect(webSocketUrl("https://assistant.lan/")).toBe("wss://assistant.lan/ws")
    expect(webSocketUrl("ws://10.0.0.2:8787/ws")).toBe("ws://10.0.0.2:8787/ws")
  })
})

describe("session helpers", () => {
  it("formats the latency line from a turn.end trace", () => {
    const line = formatTraceInfo({ ...exampleTrace, client: { outputLatencyMs: 20, startDelayMs: 4 } })
    expect(line).toMatch(new RegExp(`^turn #${exampleTrace.turnId} voice`))
    if (exampleTrace.marks.playbackStart !== undefined) {
      expect(line).toContain(`audible=${Math.round(exampleTrace.marks.playbackStart + 20)}ms`)
    }
  })
})

describe("tones", () => {
  it("stay at or below −20 dBFS and have the documented lengths", () => {
    const peak = (s: Int16Array) => s.reduce((m, x) => Math.max(m, Math.abs(x)), 0) / 32768
    for (const s of [wakeCue(), identifySound(), testTone(1000)]) expect(peak(s)).toBeLessThanOrEqual(0.1001)
    expect(testTone(1000).length).toBe(TONE_RATE)
    expect(wakeCue().length / TONE_RATE).toBeCloseTo(0.18, 2)
    expect(identifySound().length / TONE_RATE).toBeCloseTo(1.2, 1)
  })
})

describe("--input-wav", () => {
  it("replays a directory of WAVs in name order as 20 ms frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-node-wav-"))
    try {
      const wav = (value: number) => encodeWav({ sampleRate: 16_000, channels: 1, data: new Uint8Array(new Int16Array(320).fill(value).buffer) })
      writeFileSync(join(dir, "b.wav"), wav(2000))
      writeFileSync(join(dir, "a.wav"), wav(1000))
      writeFileSync(join(dir, "notes.txt"), "ignored")
      const files = inputFiles(dir)
      expect(files.map((f) => f.slice(dir.length + 1))).toEqual(["a.wav", "b.wav"])
      // 500 ms lead (25 frames) + 1 frame + 0 gap, then the next file's lead.
      const frames = await Effect.runPromise(Stream.runCollect(Stream.take(fileCapture(files, 0), 52)))
      const first = (f: Uint8Array) => new Int16Array(f.buffer, f.byteOffset, 1)[0]
      expect(frames.every((f) => f.length === 640)).toBe(true)
      expect(first(frames[25]!)).toBe(1000)
      expect(first(frames[51]!)).toBe(2000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})
