import { describe, expect, it } from "vitest"
import { createDiagnosticsStore, formatDiagnostics } from "../src/lib/audio/diagnostics.ts"
import { micConstraints } from "../src/lib/audio/VoiceAudio.ts"

const reply = (id: number, underruns: number, gapMs: number, clicks: number, minQueueMs: number) =>
  ({ id, underruns, gapMs, clicks, minQueueMs, srcRate: 22_050, ctxRate: 48_000, prebufferMs: 60 })

describe("audio diagnostics", () => {
  it("adds up the player's per-reply stats and resets", () => {
    const store = createDiagnosticsStore()
    store.dispatch({ type: "reply", stats: reply(1, 0, 0, 0, 180) })
    store.dispatch({ type: "reply", stats: reply(2, 3, 240, 3, 0) })
    expect(store.get().playback).toMatchObject({ replies: 2, repliesWithUnderruns: 1, underruns: 3, gapMs: 240, clicks: 3, minQueueMs: 0 })
    const text = formatDiagnostics(store.get(), { userAgent: "test", outputPath: "direct", prebufferMs: 60 })
    expect(text).toContain("3 underruns in 1 replies")
    expect(text).toContain("22050 Hz → 48000 Hz")
    store.dispatch({ type: "reset" })
    expect(store.get().playback).toMatchObject({ replies: 0, underruns: 0, minQueueMs: undefined })
  })

  it("reports what the browser says next to what was asked", () => {
    const store = createDiagnosticsStore()
    store.dispatch({
      type: "mic",
      report: {
        requested: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
        echoCancellation: false,
        sampleRate: 48_000,
        label: "iPhone Microphone",
        contextSampleRate: 48_000
      }
    })
    const text = formatDiagnostics(store.get(), { userAgent: "test", outputPath: "element", prebufferMs: 250 })
    expect(text).toContain("Processing requested: echo cancellation off, noise suppression on, auto gain on")
    expect(text).toContain("Processing reported:  echo cancellation off, noise suppression not reported, auto gain not reported")
    expect(text).toContain("element output, prebuffer 250 ms")
  })
})

describe("microphone constraints", () => {
  it("asks for each processing switch as set, and the exact device when one is chosen", () => {
    expect(micConstraints("", { echoCancellation: false, noiseSuppression: true, autoGainControl: false })).toEqual({
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false
    })
    expect(micConstraints("abc", { echoCancellation: true, noiseSuppression: true, autoGainControl: true })).toMatchObject({ deviceId: { exact: "abc" } })
  })
})
