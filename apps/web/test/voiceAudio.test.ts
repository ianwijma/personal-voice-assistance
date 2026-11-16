import { beforeEach, describe, expect, it, vi } from "vitest"
import { analyserSize, STOP_FALLBACK_MS, VoiceAudio } from "../src/lib/audio/VoiceAudio.ts"
import { flush, installFakeAudio, tokenFor } from "./fakeAudio.ts"

let fake: ReturnType<typeof installFakeAudio>
let states: Array<string>

const newAudio = () =>
  new VoiceAudio({ onMicFrame: () => undefined, onPlayer: () => undefined, onState: (s) => void states.push(s) })

const startOptions = { micDeviceId: "", sinkId: "", outputPath: "direct" as const, prebufferMs: 60 }

/** A started `VoiceAudio` with its first microphone open. */
const started = async () => {
  const audio = newAudio()
  const ready = audio.start(startOptions)
  fake.pending[0]!.resolve()
  await ready
  return audio
}

beforeEach(() => {
  fake = installFakeAudio()
  states = []
})

describe("VoiceAudio microphone acquisitions (review finding 1)", () => {
  it("End (stop) while a microphone change is pending: the late stream is stopped, nothing stays open", async () => {
    const audio = await started()
    const change = audio.setMicDevice("usb-mic")
    await audio.stop()
    fake.pending[1]!.resolve()
    await change
    await flush()
    expect(audio.running).toBe(false)
    expect(fake.liveStreams()).toEqual([])
    expect(audio.micReport()).toBeUndefined()
  })

  it("a processing change pending during a takeover (stop) does not reopen the microphone", async () => {
    const audio = await started()
    const change = audio.setMicProcessing({ echoCancellation: false, noiseSuppression: true, autoGainControl: true })
    await audio.stop()
    fake.pending[1]!.resolve()
    await change
    expect(fake.liveStreams()).toEqual([])
  })

  it.each([["in order", [1, 2]], ["out of order", [2, 1]]] as const)(
    "overlapping device changes settling %s leave exactly the latest microphone open and connected",
    async (_label, order) => {
      const audio = await started()
      const first = audio.setMicDevice("a")
      const second = audio.setMicDevice("b")
      for (const k of order) fake.pending[k]!.resolve()
      await Promise.all([first, second])
      await flush()
      const latest = fake.pending[2]!.stream
      expect(fake.liveStreams()).toEqual([latest])
      expect(fake.connected()).toBe(latest)
      expect(audio.micReport()?.label).toBe(latest.track.label)
    }
  )

  it("a start abandoned by End, then a new Start: the first start's late microphone neither leaks nor stops the new session", async () => {
    const audio = newAudio()
    const firstStart = audio.start(startOptions)
    await audio.stop()
    const secondStart = audio.start(startOptions)
    fake.pending[1]!.resolve() // the second start's microphone
    await secondStart
    fake.pending[0]!.resolve() // the first start's, late
    await expect(firstStart).rejects.toMatchObject({ name: "AbortError" })
    await flush()
    expect(audio.running).toBe(true)
    expect(fake.liveStreams()).toEqual([fake.pending[1]!.stream])
    expect(fake.contexts[0]!.state).toBe("closed")
    expect(fake.contexts[1]!.state).toBe("running")
  })
})

describe("VoiceAudio while the context is not running (unconfirmed item: suspension)", () => {
  it("a stop while suspended asks the player to finish at once (no fade that needs rendering to complete)", async () => {
    const audio = await started()
    const player = () => (audio as any).player.port.postMessage as { mock: { calls: Array<Array<unknown>> } }
    audio.replyStop(5, true)
    // Reply 5 was never started here: no instance token (0), so the worklet answers it as another reply.
    expect(player().mock.calls.at(-1)![0]).toEqual({ type: "stop", id: 5, token: 0, report: true })
    fake.contexts[0]!.setState("interrupted")
    audio.replyStop(5, true)
    expect(player().mock.calls.at(-1)![0]).toEqual({ type: "stop", id: 5, token: 0, report: true, now: true })
  })

  it("resume from WebKit's 'interrupted' state suspends first, then resumes (the reported workaround)", async () => {
    const audio = await started()
    const ctx = fake.contexts[0]!
    const calls: Array<string> = []
    const suspend = ctx.suspend.bind(ctx)
    const resume = ctx.resume.bind(ctx)
    ctx.suspend = async () => {
      calls.push("suspend")
      await suspend()
    }
    ctx.resume = async () => {
      calls.push("resume")
      await resume()
    }
    ctx.setState("interrupted")
    await audio.resume()
    expect(calls).toEqual(["suspend", "resume"])
    expect(ctx.state).toBe("running")
  })
})

describe("VoiceAudio media-element output (unconfirmed item: audible playback)", () => {
  const elementStart = async () => {
    const audio = newAudio()
    const ready = audio.start({ ...startOptions, outputPath: "element" })
    fake.pending[0]!.resolve()
    await ready
    await flush()
    return audio
  }

  it("the element being paused by the system suspends the context, so nothing is counted as played; Resume plays it again", async () => {
    const audio = await elementStart()
    const ctx = fake.contexts[0]!
    expect(ctx.state).toBe("running")
    const el = fake.elements.at(-1)!
    el.pause() // e.g. an audio-session interruption, or the lock-screen controls
    await flush()
    expect(ctx.state).toBe("suspended")
    expect(states).toContain("suspended")
    await audio.resume()
    await flush()
    expect(el.paused).toBe(false)
    expect(ctx.state).toBe("running")
  })

  it("a rejected play() (no gesture) also suspends the context instead of rendering into a silent element", async () => {
    fake.setPlayResult(async () => {
      throw new DOMException("not allowed", "NotAllowedError")
    })
    const audio = newAudio()
    const ready = audio.start({ ...startOptions, outputPath: "element" })
    fake.pending[0]!.resolve()
    await ready
    await flush()
    expect(fake.contexts[0]!.state).toBe("suspended")
    expect(states).toContain("suspended")
  })
})

describe("VoiceAudio unconfirmed items (second review)", () => {
  it("a stop while the context is interrupted is answered from the main thread when the worklet stays silent", async () => {
    const events: Array<any> = []
    const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: (e) => void events.push(e), onState: () => undefined })
    const ready = audio.start(startOptions)
    fake.pending[0]!.resolve()
    await ready
    const port = (audio as any).player.port
    audio.replyStart(7, 24_000)
    const token = tokenFor((audio as any).player, 7)
    port.onmessage({ data: { type: "started", id: 7, token, startDelayMs: 3 } })
    port.onmessage({ data: { type: "progress", id: 7, token, playedSamples: 4800, underruns: 0 } })
    fake.contexts[0]!.setState("interrupted")
    vi.useFakeTimers()
    try {
      audio.replyStop(7, true)
      vi.advanceTimersByTime(STOP_FALLBACK_MS + 1)
    } finally {
      vi.useRealTimers()
    }
    expect(events.at(-1)).toEqual({ type: "stopped", id: 7, playedSamples: 4800, report: true, exact: false })
    // The worklet's answer arriving later is reported too, even when equal: it lets the server stop waiting.
    port.onmessage({ data: { type: "stopped", id: 7, token, playedSamples: 4800, report: true } })
    expect(events.at(-1)).toEqual({ type: "stopped", id: 7, playedSamples: 4800, report: true, exact: true })
  })

  it("the player is told when the context stops rendering, with the time it stopped at", async () => {
    const audio = await started()
    const post = (audio as any).player.port.postMessage as { mock: { calls: Array<Array<unknown>> } }
    fake.contexts[0]!.setState("interrupted")
    expect(post.mock.calls.at(-1)![0]).toEqual({ type: "suspended", at: 1.5 })
  })

  it("a worklet that answers in time is the only answer", async () => {
    const events: Array<any> = []
    const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: (e) => void events.push(e), onState: () => undefined })
    const ready = audio.start(startOptions)
    fake.pending[0]!.resolve()
    await ready
    const port = (audio as any).player.port
    audio.replyStart(8, 24_000)
    fake.contexts[0]!.setState("suspended")
    vi.useFakeTimers()
    try {
      audio.replyStop(8, true)
      port.onmessage({ data: { type: "stopped", id: 8, token: tokenFor((audio as any).player, 8), playedSamples: 10, report: true } })
      vi.advanceTimersByTime(STOP_FALLBACK_MS * 3)
    } finally {
      vi.useRealTimers()
    }
    expect(events.filter((e) => e.type === "stopped")).toEqual([{ type: "stopped", id: 8, playedSamples: 10, report: true, exact: true }])
  })

  it("Resume does not wait for the element before resuming the context (the element's data comes from the context)", async () => {
    const audio = newAudio()
    const ready = audio.start({ ...startOptions, outputPath: "element" })
    fake.pending[0]!.resolve()
    await ready
    await flush()
    const ctx = fake.contexts[0]!
    const el = fake.elements.at(-1)!
    el.pause()
    await flush()
    expect(ctx.state).toBe("suspended")
    // A WebKit that resolves play() only once fresh data flows, i.e. once the context renders.
    fake.setPlayResult(() =>
      new Promise<void>((resolve) => {
        const poll = () => (ctx.state === "running" ? resolve() : setTimeout(poll, 1))
        poll()
      })
    )
    const resumed = audio.resume()
    await expect(Promise.race([resumed.then(() => "done"), new Promise((r) => setTimeout(() => r("stuck"), 200))])).resolves.toBe("done")
    expect(ctx.state).toBe("running")
    expect(el.paused).toBe(false)
  })
})

describe("the output analyser's size (review of #12, finding 1)", () => {
  it("covers the stage's 40 ms window at the context's rate; 44.1 and 48 kHz keep 2048", () => {
    expect(analyserSize(44_100)).toBe(2048)
    expect(analyserSize(48_000)).toBe(2048)
    expect(analyserSize(16_000)).toBe(2048)
    expect(analyserSize(88_200)).toBe(4096)
    expect(analyserSize(96_000)).toBe(4096) // 3840 samples needed
    expect(analyserSize(192_000)).toBe(8192)
    expect(analyserSize(768_000)).toBe(32768)
    expect(analyserSize(Number.NaN)).toBe(2048)
    for (const rate of [22_050, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 384_000]) expect(analyserSize(rate)).toBeGreaterThanOrEqual(0.04 * rate)
  })
})
