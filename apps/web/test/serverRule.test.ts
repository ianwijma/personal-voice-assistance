// @vitest-environment node
/**
 * The replay of a reply through the real server (`serverRule.ts`, sixth review, finding 4), on cases whose
 * answer is known: each would come out differently if the server's clamp, stop wait, provisional rule,
 * progress fallback or `finished` check were changed (the reviewer's mutation, the clamp returning 0
 * instead of the samples sent, fails the first case). The played-count oracle (`worklets/playedOracle.test.ts`)
 * uses the same replay for every reply of its random sequences.
 */
import type { ClientMessage } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { replayOnServer, type ServerEvent } from "./serverRule.ts"

const report = (at: number, message: ClientMessage): ServerEvent => ({ at, kind: "report", message })
const stopped = (at: number, playedSamples: number, exact?: boolean) =>
  report(at, { type: "playback.stopped", turnId: 7, playedSamples, ...(exact !== undefined ? { exact } : {}) })
const progress = (at: number, playedSamples: number) => report(at, { type: "playback.progress", turnId: 7, playedSamples, underruns: 0 })
const finished = (at: number, playedSamples: number) => report(at, { type: "playback.finished", turnId: 7, playedSamples })
const frames = (at: number, samples: number): ServerEvent => ({ at, kind: "frames", samples })

describe("the real server's acceptance rule, replayed (sixth review, finding 4)", () => {
  it("clamps an exact count to the samples sent (100 sent, 200 reported: 100)", async () => {
    const o = await replayOnServer(7, 24_000, [frames(0, 100), { at: 10, kind: "stop" }, stopped(20, 200, true)])
    expect(o).toMatchObject({ accepted: 100, decided: true })
  })

  it("an exact count after a provisional one wins within the stop wait, lower or higher", async () => {
    const lower = await replayOnServer(7, 24_000, [frames(0, 1000), { at: 10, kind: "stop" }, stopped(20, 500, false), stopped(60, 400, true)])
    expect(lower.accepted).toBe(400)
    const higher = await replayOnServer(7, 24_000, [frames(0, 1000), { at: 10, kind: "stop" }, stopped(20, 500, false), stopped(60, 600)])
    expect(higher.accepted).toBe(600)
  })

  it("after the stop wait, the provisional count is final and a late exact one is ignored", async () => {
    const o = await replayOnServer(7, 24_000, [frames(0, 1000), { at: 10, kind: "stop" }, stopped(20, 500, false), stopped(320, 600, true)])
    expect(o.accepted).toBe(500)
  })

  it("an exact count first: a provisional one after it changes nothing; a second provisional is ignored", async () => {
    expect((await replayOnServer(7, 24_000, [frames(0, 1000), { at: 10, kind: "stop" }, stopped(20, 300), stopped(30, 500, false)])).accepted).toBe(300)
    expect((await replayOnServer(7, 24_000, [frames(0, 1000), { at: 10, kind: "stop" }, stopped(20, 300, false), stopped(30, 500, false)])).accepted).toBe(300)
  })

  it("no final at all: the last progress count (the progress floor of a reply that never answered)", async () => {
    const o = await replayOnServer(7, 24_000, [frames(0, 1000), progress(5, 800), { at: 10, kind: "stop" }])
    expect(o).toMatchObject({ accepted: 800, decided: true })
  })

  it("a finished report before the server sent the end is not taken; the one after it is", async () => {
    const early = await replayOnServer(7, 24_000, [frames(0, 1000), finished(5, 1000), progress(6, 700), { at: 10, kind: "stop" }])
    expect(early.accepted).toBe(700)
    const due = await replayOnServer(7, 24_000, [frames(0, 1000), { at: 5, kind: "end" }, finished(6, 1000)])
    expect(due).toMatchObject({ accepted: 1000, decided: true })
  })

  it("the owner goes away after a provisional count: the provisional count is final", async () => {
    const o = await replayOnServer(7, 24_000, [frames(0, 1000), stopped(10, 450, false), { at: 10, kind: "gone" }])
    expect(o).toMatchObject({ accepted: 450, decided: true })
  })

  it("a provisional count with nothing after it, while the reply is still being sent: final when the stall watchdog stops the reply", async () => {
    const o = await replayOnServer(7, 24_000, [frames(0, 1000), stopped(10, 450, false), frames(500, 1000), { at: 900, kind: "end" }])
    expect(o.decided).toBe(false) // no stop wait was running: nothing decided 300 ms after the last event
    expect(o.accepted).toBe(450) // the watchdog (2 s without a report) committed it
    expect(o.sent).toContain("reply.stop")
  })
})
