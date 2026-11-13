// @vitest-environment node
/**
 * The played-sample count against an independent oracle (third review, family 2; fourth review,
 * finding 3). Random sequences drive the real player worklet through the page's `PlaybackLink`: replies
 * starting (also replacing one that plays), frames, end, rendering, suspensions whose notice arrives at
 * once, late or never, messages to the worklet held while the context is suspended (unverified on iOS)
 * and delivered before or after the first quantum once it renders again, messages back delayed, stops
 * (server and Stop button), a busy main thread (the audio renders while the page reads nothing, then
 * the page is hidden or a stop comes), and the ways a session ends: drained, a takeover right after
 * `reply.stop`, End, and page unload.
 *
 * What is checked, per reply, is what the server would do with it (fourth review):
 *
 * - **The accepted count** (fifth review, finding 5; sixth review, finding 4): the count the **real server**
 *   accepts. Each reply's traffic is replayed through `makeWebAudio` from `packages/audio-web` (the code the
 *   assistant runs, a dev dependency of the web app) with Effect's `TestClock` (`../serverRule.ts`): the audio
 *   the server sent (every frame the page was given, until the end or the stop), the end of its audio, when it
 *   stopped the reply, every report the page sent, and when the owner went away, all on the page's clock (the
 *   hop is taken as instant). Its count is what the server passes to `PlaybackObserver.final` (else its last
 *   progress), so its clamp to the samples sent, provisional and exact finals, stop wait, progress handling and
 *   `finished` check are the server's own: a hand-copied model with a source-text tripwire drifted twice and
 *   is gone. When the server would have stopped each reply: the page's own stop, the Stop button (the
 *   server's `reply.stop` follows the interrupt, so not earlier), a newer reply replacing it, a takeover. The
 *   messages are produced by the client's own mapping (`playbackReport` in `client.ts`) from the link's
 *   events, so report attribution comes from what is sent to the server, not from the worklet's state. The
 *   accepted count must match the oracle, and every reply that sent a final must have one of its finals
 *   accepted within the server's wait (none may miss the deadline).
 * - **Never above what played**: no count sent may exceed the oracle (a count above what played would put
 *   unheard words in history).
 * - **Attribution of the output**: each rendered quantum belongs to the reply of the last `start` message
 *   the page delivered to the worklet (the page's messages, not the worklet's own id).
 * - **Rates**: the context's own rate (alternating content, counted sample by sample: `contentCounts`)
 *   and four resampled pairs (a tone at a quarter of the source rate, counted by windowed energy:
 *   `toneCounts`).
 *
 * Tolerance: one render quantum, plus for resampled replies the resampler's delay (the count includes
 * samples still inside its kernel, ~13 source samples), the quiet part of the fades the tone oracle does
 * not see (~0.9 ms per fade) and a period of the tone at each edge. One case may be short by the 4 ms fade on top: a stop asked for while
 * rendering, then a suspension whose notice the page gets late or never, so the page answers before the
 * fade it asked for renders (when the notice comes in time, the page cuts the fade instead: `suspended`).
 * Each such reply is counted and reported. And (after the final review, which removed the page's use of the
 * context's clock) an accepted provisional count on the message route may be short by the reply's count messages
 * that were still in flight to the page when it answered: one render quantum each, measured per answer from the
 * worklet's messages not yet delivered (`inFlight`). In this generator that is at most the longest busy spell
 * (20 quanta rendered with nothing read) plus the back delay (up to 20 ms, 8 quanta at 48 kHz); the largest seen
 * is printed. Counted and reported; never above what played (checked for every count sent).
 *
 * The generator starts a reply only once the server would: after an exact final for the previous one, or the
 * end of the server's stop wait after its `reply.stop` (seventh review, finding 4; a provisional final is not
 * enough). And (seventh review, finding 1) a separate set of cases checks "never above what rendered" where the
 * context's clock says nothing about the player: a failed processor (also mid-fade), a suspended or interrupted
 * context whose clock runs on, an underrun, and a reply whose stop the worklet already answered.
 */
import "./shim.ts"
import type { ClientMessage } from "@pva/protocol"
import { describe, expect, it } from "vitest"
import { PlaybackLink, SERVER_STOP_WAIT_MS, SharedCounter, STOP_ANSWER_MS, type Timers } from "../../src/lib/audio/playback.ts"
import type { PlayerEvent } from "../../src/lib/audio/VoiceAudio.ts"
import { playbackReport } from "../../src/lib/client.ts"
import { PlayerProcessor } from "../../worklets/player.js"
import { replayOnServer, type ServerEvent } from "../serverRule.ts"
import { linkWithWorklet } from "./linkHarness.ts"
import { setCurrentTime, setSampleRate } from "./shim.ts"
import { alternating, contentCounts, type Owned, QUANTUM, replyFrame, tone, toneCounts } from "./oracle.ts"

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

interface Outcome {
  readonly replies: number
  readonly accepted: number
  readonly acceptedBest: number
  /** Replies where the accepted count is not the first final (an exact one replaced a provisional one). */
  readonly differsFromFirst: number
  readonly corrected: number
  readonly fadeAllowance: number
  readonly maxError: number
  /** Accepted provisional counts on the message route that were short by count messages still in flight. */
  readonly shortInFlight: number
  /** The most render quanta of count messages in flight behind an accepted provisional count. */
  readonly maxInFlight: number
}

type Final = {
  readonly type: "playback.finished" | "playback.stopped"
  readonly turnId: number
  readonly playedSamples: number
  readonly exact?: boolean
  readonly at: number
  readonly route: "shared" | "messages"
  readonly inFlight: number
}

/** The page's side of how long the server waits after `reply.stop` (`playback.ts`; the server's own wait runs in the replay). */
const SERVER_STOP_WAIT = SERVER_STOP_WAIT_MS

/** A message as sent (the timestamp is the test's own). */
const stripAt = (m: { readonly at: number } & Record<string, unknown>): ClientMessage => {
  const { at: _at, ...message } = m
  return message as unknown as ClientMessage
}

const runSequence = async (seed: number, shared: boolean, srcRate: number, ctxRate: number, steps: number): Promise<Outcome> => {
  const random = rng(seed)
  const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(random() * xs.length)]!
  const quantumMs = (QUANTUM / ctxRate) * 1000
  setSampleRate(ctxRate)
  setCurrentTime(0)
  const counter = shared ? new SharedCounter() : undefined
  const proc: any = new PlayerProcessor({ processorOptions: counter !== undefined ? { counter: counter.buffer } : {} })
  const fadeLen = proc.fadeLen as number
  const log: Array<string> = []
  const fail = (what: string): never => {
    throw new Error(`seed ${seed} (${shared ? "shared" : "messages"}, ${srcRate}→${ctxRate}): ${what}\n${log.slice(-60).join("\n")}`)
  }

  // Time and timers (the page's): advanced by rendering and by idle time.
  let now = 0
  let audioTime = 0
  const timers: Array<{ at: number; f: () => void; id: number }> = []
  let timerId = 0
  const fakeTimers: Timers = {
    setTimeout: (f, ms) => {
      const id = ++timerId
      timers.push({ at: now + ms, f, id })
      return id
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    }
  }
  proc.now = () => now

  // Main thread → worklet: delivered before the next quantum, or held while suspended. The reply a
  // quantum belongs to is the last `start` the page delivered.
  const holdWhileSuspended = random() < 0.5
  const toWorklet: Array<unknown> = []
  let running = true
  let owner = 0
  const deliverOne = (m: unknown) => {
    const message = m as { type: string; id?: number }
    if (message.type === "start" && typeof message.id === "number") owner = message.id
    proc.port.deliver(m)
  }
  const deliverToWorklet = () => {
    while (toWorklet.length > 0) deliverOne(toWorklet.shift())
  }
  // Worklet → page: after a random small delay, in order.
  const toMain: Array<{ at: number; m: unknown }> = []
  const port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (m: unknown) => {
      log.push(`→ ${JSON.stringify((m as { type: string }).type === "frame" ? { type: "frame" } : m)}`)
      toWorklet.push(m)
      if (!running && !holdWhileSuspended) deliverToWorklet()
    }
  }
  const backDelay = pick([0, 0, 1, 5, 20])
  proc.port.postMessage = (m: unknown) => toMain.push({ at: now + backDelay, m })
  // The worklet's `ready` (posted while it was constructed) reaches the page like any other message.
  for (const m of (proc.port.sent as Array<unknown>).splice(0)) proc.port.postMessage(m)

  // What the server receives: the client's own mapping of the link's events.
  /**
   * `route`: the link's route when the page sent it; `inFlight`: the reply's count messages the worklet had sent that
   * had not reached the page yet (one per render quantum while audio played): what a provisional count on the
   * message route may be short by (`playback.ts`, header).
   */
  const toServer: Array<{
    readonly type: string
    readonly turnId?: number
    readonly playedSamples?: number
    readonly exact?: boolean
    readonly at: number
    readonly route: "shared" | "messages"
    readonly inFlight: number
  }> = []
  const link = new PlaybackLink(port, (e: PlayerEvent) => {
    log.push(`← ${JSON.stringify(e)}`)
    const message = playbackReport(e, 0)
    if (message === undefined) return
    const inFlight = "id" in e ? toMain.filter((q) => (q.m as { type: string; id?: number }).type === "count" && (q.m as { id?: number }).id === e.id).length : 0
    toServer.push({ ...message, at: now, route: link.route.route, inFlight })
  }, { counter, timers: fakeTimers })
  /** What the server sent each reply, when (page clock): its start, its audio (samples per frame) and its end. */
  const wire = new Map<number, { start: number; frames: Array<{ at: number; samples: number }>; end: number | undefined }>()
  {
    const replyStart = link.replyStart.bind(link)
    const frame = link.frame.bind(link)
    const end = link.end.bind(link)
    link.replyStart = (id, rate) => {
      wire.set(id, { start: now, frames: [], end: undefined })
      replyStart(id, rate)
    }
    link.frame = (buffer) => {
      const w = wire.get(new DataView(buffer).getUint32(4, true))
      if (w !== undefined && w.end === undefined) w.frames.push({ at: now, samples: (buffer.byteLength - 8) >> 1 })
      frame(buffer)
    }
    link.end = (id) => {
      const w = wire.get(id)
      if (w !== undefined && w.end === undefined) w.end = now
      end(id)
    }
  }
  /** When the server would have sent each reply `reply.stop` (the earliest), and when it stopped listening to the page at all. */
  const stopAt = new Map<number, number>()
  const stopped = (id: number | undefined) => {
    if (id !== undefined && !stopAt.has(id)) stopAt.set(id, now)
  }
  let goneAt = Number.POSITIVE_INFINITY
  /** The server's play of reply `id` has an exact final (`finished`, or `stopped` not marked provisional). */
  const exactFinal = (id: number) =>
    toServer.some((m) => m.turnId === id && (m.type === "playback.finished" || (m.type === "playback.stopped" && m.exact !== false)))
  /**
   * The server would still be waiting for reply `id`'s play to end (seventh review, finding 4): no exact final yet,
   * and either it never stopped the reply or its stop wait (`SERVER_STOP_WAIT` after `reply.stop`) has not run
   * out. A provisional final does not end the wait.
   */
  const serverStillWaiting = (id: number) => !exactFinal(id) && (!stopAt.has(id) || now < stopAt.get(id)! + SERVER_STOP_WAIT)

  /** Let the page run: deliver due messages from the worklet, fire due timers. */
  const tick = () => {
    for (;;) {
      const message = toMain[0]
      const timer = [...timers].sort((a, b) => a.at - b.at)[0]
      if (message !== undefined && message.at <= now && (timer === undefined || message.at <= timer.at)) {
        toMain.shift()
        port.onmessage?.({ data: message.m } as MessageEvent)
      } else if (timer !== undefined && timer.at <= now) {
        timers.splice(timers.indexOf(timer), 1)
        timer.f()
      } else break
    }
  }
  const idle = (ms: number) => {
    const end = now + ms
    while (now < end) {
      now = Math.min(end, now + 1)
      tick()
    }
  }

  const rendered: Array<Owned> = []
  let gap = false
  /** `busy`: the page's main thread is busy, so nothing reaches it (messages, timers) while the audio renders. */
  const render = (quanta: number, busy = false) => {
    for (let q = 0; q < quanta; q++) {
      if (!running) return
      deliverToWorklet()
      const out = new Float32Array(QUANTUM)
      proc.process([], [[out]])
      rendered.push({ owner, out, afterGap: gap })
      gap = false
      audioTime += QUANTUM / ctxRate
      setCurrentTime(audioTime)
      now += quantumMs
      if (!busy) tick()
    }
  }

  const replies = new Map<number, { sent: number }>()
  /** Replies whose stop was asked for while rendering, then a suspension the page heard of late or never. */
  const fadeAfterAnswer = new Set<number>()
  let nextId = 1
  let current: number | undefined
  let ended = false
  const content = srcRate === ctxRate ? alternating : tone

  const stopsUnheard = (): Array<number> => {
    const out: Array<number> = []
    for (const [id, r] of (link as unknown as { replies: Map<number, { cutAt?: number; exact?: number }> }).replies) {
      if (r.cutAt !== undefined && r.exact === undefined) out.push(id)
    }
    return out
  }

  const suspend = (ms: number) => {
    running = false
    gap = true
    const notice = pick(["now", "now", "late", "lost"] as const)
    log.push(`suspend ${ms} ms, notice ${notice}`)
    if (notice === "now") link.suspended(audioTime)
    else for (const id of stopsUnheard()) fadeAfterAnswer.add(id)
    idle(ms / 2)
    if (random() < 0.5 && current !== undefined) {
      log.push("stop while suspended")
      stopped(current)
      link.stop(pick([current, undefined]), true, true)
    }
    idle(ms / 2)
    running = true
    if (holdWhileSuspended && random() < 0.5) {
      // Rendering resumes before the held messages are delivered (one quantum, then them).
      const held = toWorklet.splice(0)
      render(1)
      for (const m of held) deliverOne(m)
    }
    if (notice === "late") link.suspended(audioTime - 1)
  }

  for (let step = 0; step < steps && !ended; step++) {
    const action = pick(["start", "frames", "frames", "end", "render", "render", "render", "busy", "busy", "suspend", "stop", "stop-button", "teardown"] as const)
    switch (action) {
      case "start": {
        // The server starts a reply only once the previous one's play has ended: an exact final, or, after its
        // `reply.stop`, the end of its stop wait (seventh review, finding 4: a provisional final, such as the page's
        // answer for a suspended player, does not end it; the server keeps waiting for the exact one). A reply still
        // playing with no stop yet is sent `reply.stop` first (barge-in). The reply the worklet still plays is then
        // cut hard by the new start. Without this the simulation would start replies the real server never starts.
        if (current !== undefined && serverStillWaiting(current)) {
          const previous = current
          if (!stopAt.has(previous)) {
            log.push(`server: reply.stop ${previous} before the next reply`)
            stopped(previous)
            link.stop(previous, true, !running)
          }
          while (serverStillWaiting(previous)) {
            if (running) render(1)
            else idle(1)
          }
        }
        if (current !== undefined && serverStillWaiting(current)) fail(`reply ${current}: the next reply starts while the server still waits for its exact count`)
        const id = nextId++
        replies.set(id, { sent: 0 })
        current = id
        link.replyStart(id, srcRate)
        break
      }
      case "frames": {
        if (current === undefined) break
        const reply = replies.get(current)!
        for (let k = pick([1, 2, 5]); k > 0; k--) {
          const n = pick([480, 960, 2400])
          link.frame(replyFrame(current, content(reply.sent, n)))
          reply.sent += n
        }
        break
      }
      case "end":
        if (current !== undefined) link.end(current)
        break
      case "render":
        render(pick([1, 3, 10, 40, 100]))
        break
      case "busy": {
        // The fourth review's case: the main thread is busy while the audio renders (count messages pile
        // up unread), then the page is hidden, or a stop comes, before it has read them. Usually with a
        // reply well buffered and its counts read just before (as in a long answer); sometimes not.
        if (current !== undefined && random() < 0.7) {
          const reply = replies.get(current)!
          for (let k = 0; k < 4; k++) {
            link.frame(replyFrame(current, content(reply.sent, 2400)))
            reply.sent += 2400
          }
          render(2)
          idle(25)
        }
        render(pick([3, 10, 20]), true)
        const then = pick(["pagehide", "stop", "nothing"] as const)
        log.push(`busy, then ${then}`)
        if (then === "pagehide") {
          link.unload(!running)
          link.detach()
          goneAt = now // the page is gone: the server commits what it has
          ended = true
        } else if (then === "stop" && current !== undefined) {
          stopped(current)
          link.stop(current, true, !running)
        }
        break
      }
      case "suspend":
        suspend(pick([10, 100, 300, 1000]))
        break
      case "stop":
        // The server's reply.stop.
        stopped(current)
        if (current !== undefined) link.stop(current, true, !running)
        break
      case "stop-button":
        stopped(current) // the interrupt reaches the server, which then sends reply.stop: not earlier than now
        link.stop(current, true, !running)
        break
      case "teardown": {
        const how = pick(["takeover", "takeover-after-stop", "end", "unload"] as const)
        log.push(`teardown ${how}`)
        if (how === "unload") {
          link.unload(!running)
          goneAt = now
        } else {
          if (how !== "end") stopped(current) // a takeover: the server sends the previous owner reply.stop
          if (how === "takeover-after-stop" && current !== undefined) link.stop(current, true, !running) // reply.stop, then the session message
          let done = false
          void link.finalise(!running).then(() => (done = true))
          // The context keeps rendering (it is open) until the counts are in; bounded.
          for (let i = 0; i < 400 && !done; i++) {
            if (running) render(1)
            else idle(quantumMs)
            for (let k = 0; k < 3; k++) tick()
            for (let k = 0; k < 4; k++) await Promise.resolve() // the promise chain's microtasks
          }
          if (!done) fail(`finalise did not settle within ${400 * quantumMs} ms`)
          // End: the release follows the final counts; the server then commits what it has (owner gone).
          if (how === "end") goneAt = now
        }
        link.detach() // the context closes: nothing more renders
        ended = true
        break
      }
    }
  }
  if (!ended) {
    // Drain: end what plays and let it finish.
    if (current !== undefined) link.end(current)
    running = true
    render(Math.ceil((40 * ctxRate) / QUANTUM))
    idle(STOP_ANSWER_MS * 4)
  }

  const rates = new Map([...replies.keys()].map((id) => [id, srcRate] as const))
  const oracle = srcRate === ctxRate
    ? contentCounts(rendered.map((q) => ({ id: q.owner, out: q.out, afterGap: q.afterGap })))
    : toneCounts(rendered, ctxRate, rates)
  const ratio = srcRate / ctxRate
  // Resampled: a quantum, the quiet parts of two fades the tone oracle misses (0.22 of each), a period of
  // the tone at each of two edges (4 source samples each), and the resampler's kernel (~13 source samples).
  const tolerance = srcRate === ctxRate ? QUANTUM : Math.ceil((QUANTUM + 2 * 0.22 * fadeLen) * ratio) + 8 + 16
  const fadeAllowance = Math.ceil((fadeLen + QUANTUM) * ratio)
  let accepted = 0
  let acceptedBest = 0
  let differsFromFirst = 0
  let corrected = 0
  let allowed = 0
  let maxError = 0
  let shortInFlight = 0
  let maxInFlight = 0
  for (const [id] of replies) {
    const played = oracle.get(id) ?? 0
    const sent = toServer.filter((m) => m.turnId === id)
    for (const m of sent) {
      if (m.playedSamples !== undefined && m.playedSamples > played + tolerance) {
        fail(`reply ${id}: sent ${m.type} ${m.playedSamples}, only ${played.toFixed(0)} reached the device`)
      }
    }
    const finals = sent.filter((m): m is Final => m.type === "playback.finished" || m.type === "playback.stopped")
    if (finals.length === 0) {
      // A reply cut with the socket gone (report: false) sends nothing; one that played and was answered must have been.
      continue
    }
    // The real server's answer for this reply (see the header and `../serverRule.ts`).
    const w = wire.get(id)!
    const events: Array<ServerEvent> = []
    const stopTime = stopAt.get(id)
    let transmitted = 0
    for (const f of w.frames) {
      // The server sends no audio after it stopped the reply or its owner went away.
      if ((stopTime !== undefined && f.at > stopTime) || f.at > goneAt) continue
      events.push({ at: f.at - w.start, kind: "frames", samples: f.samples })
      transmitted += f.samples
    }
    if (w.end !== undefined && (stopTime === undefined || w.end <= stopTime) && w.end <= goneAt) events.push({ at: w.end - w.start, kind: "end" })
    if (stopTime !== undefined) events.push({ at: Math.max(0, stopTime - w.start), kind: "stop" })
    for (const m of sent) events.push({ at: m.at - w.start, kind: "report", message: stripAt(m) })
    if (Number.isFinite(goneAt)) events.push({ at: Math.max(0, goneAt - w.start), kind: "gone" })
    const server = await replayOnServer(id, srcRate, events)
    // Which final it took (each count clamped as the server clamps it): none means every final missed its wait.
    const deadline = Math.min(goneAt, (stopTime ?? Number.POSITIVE_INFINITY) + SERVER_STOP_WAIT)
    const clamped = (f: Final) => Math.min(Math.floor(f.playedSamples), transmitted)
    const inTime = finals.filter((f) => f.at <= deadline)
    const first: Final | undefined = inTime.find((f) => f.exact !== false && clamped(f) === server.accepted) ?? inTime.find((f) => clamped(f) === server.accepted)
    if (first === undefined || !server.decided) {
      fail(
        `reply ${id}: no final count reached the server in time (the server took ${server.accepted}${server.decided ? "" : ", undecided"}; ` +
          `deadline ${deadline.toFixed(1)} ms; sent ${finals.map((f) => `${f.playedSamples}${f.exact === false ? "?" : ""} at ${f.at.toFixed(1)}`).join(", ")} ms)`
      )
    }
    accepted++
    if (first!.exact === false) acceptedBest++
    if (first !== finals[0]) differsFromFirst++
    if (finals.length > 1 && finals.at(-1)!.playedSamples !== finals[0]!.playedSamples) corrected++
    const error = played - server.accepted
    // A provisional count on the message route may be short by the count messages still in flight when the page
    // answered (`playback.ts`, header: the accepted cost of never using the clock), one render quantum each.
    const inFlight = first!.exact === false && first!.route === "messages" ? first!.inFlight : 0
    const inFlightAllowance = Math.ceil(inFlight * QUANTUM * ratio)
    if (inFlight > 0 && error > tolerance) {
      shortInFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
    }
    const limit = tolerance + inFlightAllowance + (fadeAfterAnswer.has(id) && error > tolerance ? fadeAllowance : 0)
    if (Math.abs(error) > limit) {
      fail(`reply ${id}: the server accepts ${server.accepted} (${first!.type}), the oracle says ${played.toFixed(0)} (sent: ${finals.map((f) => f.playedSamples).join(", ")})`)
    }
    if (Math.abs(error) > tolerance + inFlightAllowance) allowed++
    if (!(inFlight > 0 && error > tolerance)) maxError = Math.max(maxError, Math.abs(error))
  }
  return { replies: replies.size, accepted, acceptedBest, differsFromFirst, corrected, fadeAllowance: allowed, maxError, shortInFlight, maxInFlight }
}

const RATES: ReadonlyArray<readonly [number, number]> = [[48_000, 48_000], [24_000, 48_000], [16_000, 48_000], [22_050, 48_000], [48_000, 44_100]]

describe.each([false, true])("the count the server accepts vs. an independent oracle (shared counter: %s)", (shared) => {
  it.each(RATES)("random sequences, %i Hz replies at %i Hz: the count the server accepts matches what reached the device", async (srcRate, ctxRate) => {
    const total = { replies: 0, accepted: 0, acceptedBest: 0, differsFromFirst: 0, corrected: 0, fadeAllowance: 0, maxError: 0, shortInFlight: 0, maxInFlight: 0 }
    const seeds = Number(process.env.PLAYER_SEEDS ?? (srcRate === ctxRate ? 200 : 120))
    for (let seed = 1; seed <= seeds; seed++) {
      const o = await runSequence(seed * 7919 + (shared ? 1 : 0) + srcRate, shared, srcRate, ctxRate, Number(process.env.PLAYER_STEPS ?? 60))
      total.replies += o.replies
      total.accepted += o.accepted
      total.acceptedBest += o.acceptedBest
      total.differsFromFirst += o.differsFromFirst
      total.corrected += o.corrected
      total.fadeAllowance += o.fadeAllowance
      total.shortInFlight += o.shortInFlight
      total.maxInFlight = Math.max(total.maxInFlight, o.maxInFlight)
      total.maxError = Math.max(total.maxError, o.maxError)
    }
    expect(total.accepted).toBeGreaterThan(30)
    // The fourth review's case really ran: answers after a busy spell, with count messages unread, checked against
    // the count messages in flight.
    if (!shared) expect(total.shortInFlight).toBeGreaterThanOrEqual(3)
    // For the record (the report quotes these).
    console.info(
      `shared=${shared} ${srcRate}→${ctxRate}: ${total.replies} replies, ${total.accepted} with a final count; accepted count was the page's best (provisional) count for ${total.acceptedBest}, an exact count replacing the first (provisional) final for ${total.differsFromFirst}, a later final differing from the first for ${total.corrected}; ${total.fadeAllowance} short by the fade after a late or lost suspension notice; ${total.shortInFlight} provisional counts on the message route short by count messages in flight (at most ${total.maxInFlight} quanta); largest error otherwise ${total.maxError.toFixed(0)} samples`
    )
  }, 120_000)
})

describe("the oracles themselves", () => {
  it("count exactly the content of a plain reply (and see an undercount), at the context's rate and resampled", () => {
    for (const [srcRate, ctxRate] of RATES) {
      setSampleRate(ctxRate)
      setCurrentTime(0)
      const proc: any = new PlayerProcessor()
      proc.now = () => 0
      const content = srcRate === ctxRate ? alternating : tone
      const n = srcRate / 10 // 100 ms
      proc.port.deliver({ type: "start", id: 1, rate: srcRate, prebufferMs: 0 })
      proc.port.deliver({ type: "frame", buffer: replyFrame(1, content(0, n)) })
      proc.port.deliver({ type: "end", id: 1 })
      const rendered: Array<Owned> = []
      for (let q = 0; q < Math.ceil((0.15 * ctxRate) / QUANTUM); q++) {
        const out = new Float32Array(QUANTUM)
        proc.process([], [[out]])
        rendered.push({ owner: 1, out, afterGap: false })
      }
      const counted = srcRate === ctxRate
        ? contentCounts(rendered.map((q) => ({ id: q.owner, out: q.out, afterGap: false }))).get(1) ?? 0
        : toneCounts(rendered, ctxRate, new Map([[1, srcRate]])).get(1) ?? 0
      expect(Math.abs(counted - n), `${srcRate}→${ctxRate}: ${counted}`).toBeLessThan(srcRate === ctxRate ? 16 : 0.05 * n)
      // A count of the old fallback's kind (0, or ten quanta short) is far outside the tolerance.
      expect(Math.abs(n - 10 * QUANTUM * (srcRate / ctxRate) - counted)).toBeGreaterThan(QUANTUM * (srcRate / ctxRate))
    }
  })
})

/**
 * Seventh review, finding 1: no count the page reports may exceed what rendered, in each situation where the
 * context's clock says nothing about the player (`playback.ts`, header: the clock is never used). Each case renders some of
 * a reply, lets the clock run on without the player rendering, and then has the page answer: the oracle counts
 * the rendered output. The slack covers the oracle's own miss at the reply's first samples (they fade in from 0).
 */
describe("never above what rendered, where the clock says nothing about the player (seventh review, finding 1)", () => {
  const SLACK = 4
  const neverAbove = (h: ReturnType<typeof linkWithWorklet>, id: number) => {
    const played = h.oracle().get(id) ?? 0
    const counts = h.events.filter((e) => e.id === id && "playedSamples" in e).map((e) => (e as { playedSamples: number }).playedSamples)
    expect(counts.length).toBeGreaterThan(0)
    for (const c of counts) expect(c, `reported ${c}, rendered ${played}`).toBeLessThanOrEqual(played + SLACK)
    return { played, counts }
  }
  /** Reply 5 with `samples` queued: one quantum rendered and its count read, then `quanta` more rendered unread (a busy page). */
  const playing = (shared: boolean, samples: number, quanta: number) => {
    const h = linkWithWorklet(shared)
    h.link.replyStart(5, 48_000)
    for (let off = 0; off < samples; off += 960) h.link.frame(replyFrame(5, alternating(off, Math.min(960, samples - off))))
    h.render(1)
    h.toPageNow()
    h.render(quanta)
    return h
  }

  describe.each([false, true])("shared counter: %s", (shared) => {
    it("a failed processor: the context runs on for the microphone, the page hears of the failure 100 ms later", () => {
      const h = playing(shared, 9600, 29)
      h.idle(100, { busy: true }) // nothing renders: the processor is dead; the clock runs on
      const records = h.link.retire(false)
      const { played } = neverAbove(h, 5)
      expect(records.get(5)!.count).toBeLessThanOrEqual(played + SLACK)
    })

    it("a failed processor with its counts read: the published count, not the queue", () => {
      const h = playing(shared, 9600, 29)
      h.toPageNow()
      h.idle(100)
      h.link.retire(false)
      const { played, counts } = neverAbove(h, 5)
      expect(counts.at(-1)).toBeGreaterThanOrEqual(played - QUANTUM) // and not needlessly short
    })

    it("a processor that fails during the fade of a stop: the rest of the fade is not assumed", () => {
      const h = playing(shared, 9600, 9)
      h.toPageNow()
      h.link.stop(5, true, false)
      h.render(1) // 128 of the 192-sample fade
      h.idle(100, { busy: true }) // the stop's deadline comes due, but the failure was queued first
      h.link.retire(false)
      h.idle(0) // the deadline's timer: settled by the retirement, it answers nothing more
      neverAbove(h, 5)
    })

    it("a suspended or interrupted context whose clock runs on: unload uses what was read", () => {
      const h = playing(shared, 9600, 29)
      h.setRunning(false)
      h.idle(100, { clock: true }) // WebKit's "interrupted": the clock is not trusted
      h.link.unload(true)
      neverAbove(h, 5)
    })

    it("a suspended or interrupted context whose clock runs on: the stop deadline uses what was read", () => {
      const h = playing(shared, 9600, 29)
      h.setRunning(false)
      h.link.stop(5, true, true)
      h.idle(STOP_ANSWER_MS + 1, { clock: true })
      neverAbove(h, 5)
    })

    it("an underrun: the queue ran dry, more audio arrives below the refill threshold, the page unloads 100 ms later", () => {
      const h = playing(shared, 1920, 30)
      h.toPageNow() // the counts and the underrun
      h.link.frame(replyFrame(5, alternating(1920, 960)))
      h.render(5) // buffering: nothing plays
      h.idle(100)
      h.link.unload(false)
      neverAbove(h, 5)
    })

    it("a stop the worklet already answered: its exact count, whatever the clock says later", () => {
      const h = playing(shared, 9600, 9)
      h.toPageNow()
      h.link.stop(5, true, false)
      h.render(5)
      h.toPageNow() // the exact answer
      h.idle(100)
      h.link.unload(false)
      h.link.retire(false)
      neverAbove(h, 5)
    })

    it("a stop whose answer is still on its way: the deadline's count stops at the cut and its fade", () => {
      const h = playing(shared, 9600, 9)
      h.toPageNow()
      h.link.stop(5, true, false)
      h.render(5) // the fade ends; the answer waits behind a busy main thread
      h.idle(STOP_ANSWER_MS + 1)
      neverAbove(h, 5)
    })
  })
})
