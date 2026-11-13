/**
 * The played-sample count at the edges (third review, findings 4 and 5) and microphone recovery
 * (finding 6), with the real player worklet behind the page's audio and an independent oracle
 * (`worklets/oracle.ts`) for what was rendered.
 */
import "./worklets/shim.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MUTED_REOPEN_EVERY_MS, MUTED_REOPEN_MS, type PlayerEvent, VoiceAudio } from "../src/lib/audio/VoiceAudio.ts"
import { PlayerProcessor } from "../worklets/player.js"
import { flush, installFakeAudio } from "./fakeAudio.ts"
import { alternating, contentCounts, QUANTUM, replyFrame } from "./worklets/oracle.ts"

let fake: ReturnType<typeof installFakeAudio>
let events: Array<PlayerEvent>
let states: Array<string>

const startOptions = { micDeviceId: "", sinkId: "", outputPath: "direct" as const, prebufferMs: 60 }

const startAudio = async (holdWhileSuspended = true) => {
  fake = installFakeAudio({ realPlayer: { Processor: PlayerProcessor, holdWhileSuspended } })
  const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: (e) => void events.push(e), onState: (s, d) => void states.push(d === undefined ? s : `${s}: ${d}`) })
  const ready = audio.start(startOptions)
  fake.pending[0]!.resolve()
  await ready
  return { audio, ctx: fake.contexts[0]! }
}

/** A reply at the context's rate (48 kHz), `ms` of alternating content, sent in 20 ms frames. */
const sendReply = (audio: VoiceAudio, id: number, ms: number) => {
  audio.replyStart(id, 48_000)
  const total = (48_000 * ms) / 1000
  for (let off = 0; off < total; off += 960) audio.replyFrame(replyFrame(id, alternating(off, Math.min(960, total - off))))
}

const reported = (id: number) => events.filter((e): e is Extract<PlayerEvent, { type: "stopped" }> => e.type === "stopped" && e.id === id && e.report)

beforeEach(() => {
  events = []
  states = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe("finding 5: a stop the worklet cannot answer reports what was rendered", () => {
  it("200 ms rendered, then the context stops rendering and the worklet gets no messages: the count is the rendered one, not 0", async () => {
    const { audio, ctx } = await startAudio(true)
    sendReply(audio, 7, 600)
    ctx.render(75) // 200 ms at 48 kHz: before the first 250 ms progress report
    ctx.setState("interrupted")
    vi.useFakeTimers()
    audio.replyStop(7, true)
    vi.advanceTimersByTime(1_000)
    vi.useRealTimers()
    const oracle = contentCounts(fake.bridges[0]!.rendered).get(7) ?? 0
    expect(oracle).toBeGreaterThan(9_000)
    const first = reported(7)[0]
    expect(first).toBeDefined()
    expect(Math.abs(first!.playedSamples - oracle)).toBeLessThanOrEqual(QUANTUM)
  })

  it("when the worklet's exact answer arrives later and differs, the page sends it as a correction (never suppressed)", async () => {
    const { audio, ctx } = await startAudio(true)
    sendReply(audio, 8, 600)
    ctx.render(30)
    ctx.setState("interrupted")
    vi.useFakeTimers()
    audio.replyStop(8, true)
    vi.advanceTimersByTime(1_000)
    vi.useRealTimers()
    // Rendering resumes before the held stop reaches the worklet: it plays one more quantum.
    ctx.state = "running"
    const bridge = fake.bridges[0]!
    const held = bridge.toWorklet.splice(0)
    ctx.render(1)
    for (const m of held) bridge.processor.port.deliver(m)
    ctx.render(4)
    const oracle = contentCounts(bridge.rendered).get(8) ?? 0
    const all = reported(8)
    expect(all.length).toBeGreaterThanOrEqual(1)
    expect(Math.abs(all.at(-1)!.playedSamples - oracle)).toBeLessThanOrEqual(QUANTUM)
  })
})

describe("finding 4: a takeover never closes the player before its final count", () => {
  it("reply.stop and the takeover in the same task: the fade finishes and its count is reported before the context closes", async () => {
    const { audio, ctx } = await startAudio(false)
    sendReply(audio, 9, 600)
    ctx.render(20)
    audio.replyStop(9, true)
    const stopping = audio.stop("takeover")
    for (let i = 0; i < 40 && ctx.state !== "closed"; i++) {
      ctx.render(1)
      await flush()
    }
    await stopping
    expect(ctx.state).toBe("closed")
    const oracle = contentCounts(fake.bridges[0]!.rendered).get(9) ?? 0
    const all = reported(9)
    expect(all.length).toBeGreaterThanOrEqual(1)
    expect(Math.abs(all.at(-1)!.playedSamples - oracle)).toBeLessThanOrEqual(QUANTUM)
    expect(fake.liveStreams()).toEqual([]) // capture released
  })

  it("End with a reply playing (no reply.stop): the reply is stopped and counted before the context closes; capture is released at once", async () => {
    const { audio, ctx } = await startAudio(false)
    sendReply(audio, 10, 600)
    ctx.render(20)
    const stopping = audio.stop("end")
    expect(fake.liveStreams()).toEqual([])
    for (let i = 0; i < 40 && ctx.state !== "closed"; i++) {
      ctx.render(1)
      await flush()
    }
    await stopping
    const oracle = contentCounts(fake.bridges[0]!.rendered).get(10) ?? 0
    expect(Math.abs((reported(10).at(-1)?.playedSamples ?? -1_000) - oracle)).toBeLessThanOrEqual(QUANTUM)
  })
})

describe("finding 6: a microphone muted again after a recovery is checked again", () => {
  it("second interruption within the cooldown: a check runs when the cooldown ends", async () => {
    fake = installFakeAudio()
    vi.useFakeTimers()
    const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: () => undefined, onState: (s, d) => void states.push(d === undefined ? s : `${s}: ${d}`) })
    const ready = audio.start(startOptions)
    fake.pending[0]!.resolve()
    await ready
    fake.pending[0]!.stream.track.setMuted(true)
    vi.advanceTimersByTime(MUTED_REOPEN_MS + 1)
    await flush()
    expect(fake.pending.length).toBe(2) // reopened once
    fake.pending[1]!.resolve()
    await flush()
    vi.advanceTimersByTime(2_000)
    fake.pending[1]!.stream.track.setMuted(true) // muted again, inside the cooldown
    vi.advanceTimersByTime(MUTED_REOPEN_MS + 1)
    await flush()
    expect(fake.pending.length).toBe(2) // cooldown
    vi.advanceTimersByTime(MUTED_REOPEN_EVERY_MS)
    await flush()
    expect(fake.pending.length).toBe(3) // checked again when the cooldown ended
  })

  it("a microphone muted for good (hardware switch): a bounded number of reopens, then a recoverable notice; unmute recovers", async () => {
    fake = installFakeAudio()
    vi.useFakeTimers()
    const notices: Array<string | undefined> = []
    const audio = new VoiceAudio({
      onMicFrame: () => undefined,
      onPlayer: () => undefined,
      onState: (s, d) => void states.push(d === undefined ? s : `${s}: ${d}`),
      onMicMuted: (message) => void notices.push(message)
    })
    const ready = audio.start(startOptions)
    fake.pending[0]!.resolve()
    await ready
    fake.pending[0]!.stream.track.setMuted(true)
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(MUTED_REOPEN_EVERY_MS + MUTED_REOPEN_MS)
      await flush()
      const last = fake.pending.at(-1)!
      if (last.stream.track.readyState === "live" && !last.stream.track.muted && fake.pending.length > 1) {
        last.resolve()
        await flush()
        last.stream.track.setMuted(true)
      }
    }
    expect(fake.pending.length).toBeLessThanOrEqual(4)
    expect(notices.filter((n) => n !== undefined).at(-1)).toMatch(/muted/i)
    expect(states.some((s) => s.startsWith("error"))).toBe(false)
    expect(audio.running).toBe(true)
    fake.pending.at(-1)!.stream.track.setMuted(false)
    expect(notices.at(-1)).toBeUndefined()
  })
})

describe("tearing down never loses the count", () => {
  it("End: the final count is reported before afterFinal (where the client gives the audio back)", async () => {
    const { audio, ctx } = await startAudio(false)
    sendReply(audio, 11, 600)
    ctx.render(20)
    const order: Array<string> = []
    const onPlayer = events.push.bind(events)
    events.push = (...e: Array<PlayerEvent>) => {
      for (const x of e) if (x.type === "stopped" && x.report) order.push(`stopped ${x.id}`)
      return onPlayer(...e)
    }
    const stopping = audio.stop("end", () => order.push("release"))
    for (let i = 0; i < 40 && ctx.state !== "closed"; i++) {
      ctx.render(1)
      await flush()
    }
    await stopping
    expect(order).toEqual(["stopped 11", "release"])
  })

  it("nothing playing: afterFinal runs without waiting", async () => {
    const { audio } = await startAudio(false)
    const order: Array<string> = []
    const stopping = audio.stop("end", () => order.push("release"))
    await flush()
    expect(order).toEqual(["release"])
    await stopping
  })

  it("a Start pressed while the old session is still finishing its count: the new session is untouched", async () => {
    const { audio, ctx } = await startAudio(false)
    sendReply(audio, 12, 600)
    ctx.render(10)
    audio.replyStop(12, true)
    const stopping = audio.stop("takeover")
    const second = audio.start(startOptions)
    fake.pending[1]!.resolve()
    await second
    const newCtx = fake.contexts[1]!
    expect(newCtx.state).toBe("running")
    for (let i = 0; i < 40 && ctx.state !== "closed"; i++) {
      ctx.render(1)
      await flush()
    }
    await stopping
    expect(ctx.state).toBe("closed")
    expect(newCtx.state).toBe("running")
    expect(audio.running).toBe(true)
    expect(audio.state).toBe("running")
    expect(fake.liveStreams()).toEqual([fake.pending[1]!.stream])
    expect(reported(12).length).toBeGreaterThanOrEqual(1)
  })

  it("a fatal stop while suspended (the worklet hears nothing): the best count is reported within the deadline, then the context closes", async () => {
    const { audio, ctx } = await startAudio(true)
    sendReply(audio, 13, 600)
    ctx.render(50)
    ctx.setState("interrupted")
    const stopping = audio.stop("end")
    await stopping // bounded by STOP_ANSWER_MS (real timers)
    expect(ctx.state).toBe("closed")
    const oracle = contentCounts(fake.bridges[0]!.rendered).get(13) ?? 0
    expect(Math.abs((reported(13)[0]?.playedSamples ?? -1_000) - oracle)).toBeLessThanOrEqual(QUANTUM)
  })

  it("page unload: the reply is answered at once with the best count", async () => {
    const { audio, ctx } = await startAudio(false)
    sendReply(audio, 14, 600)
    ctx.render(40)
    audio.unload()
    const oracle = contentCounts(fake.bridges[0]!.rendered).get(14) ?? 0
    expect(Math.abs((reported(14)[0]?.playedSamples ?? -1_000) - oracle)).toBeLessThanOrEqual(QUANTUM)
  })
})

describe("reviewer notes", () => {
  it("WebKit 'interrupted': suspend() and resume() are both called inside the tap, before any await", async () => {
    const { audio, ctx } = await startAudio(false)
    const calls: Array<string> = []
    ctx.suspend = () => {
      calls.push("suspend")
      return new Promise<void>(() => undefined) // a suspend that takes its time
    }
    const resume = ctx.resume.bind(ctx)
    ctx.resume = async () => {
      calls.push("resume")
      await resume()
    }
    ctx.setState("interrupted")
    void audio.resume()
    expect(calls).toEqual(["suspend", "resume"]) // synchronously, in the tap
  })

  it("the gap clock is monotonic where the scope has performance.now; a wall clock stepping back is never a gap", () => {
    const proc: any = new PlayerProcessor()
    const before = performance.now()
    expect(Math.abs(proc.now() - before)).toBeLessThan(1_000) // performance.now, not Date.now (epoch ms)
    proc.now = () => 10_000
    proc.process([], [[new Float32Array(128)]])
    const silenced = vi.spyOn(proc, "silenced")
    proc.now = () => 10_000 - 3_600_000 // the wall clock set back an hour
    proc.process([], [[new Float32Array(128)]])
    expect(silenced).not.toHaveBeenCalled()
  })
})
