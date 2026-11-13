/**
 * The page's `PlaybackLink` and the real player worklet in Node, with both directions held until the test lets
 * them through, the context's clock and state under the test's control, and the rendered output kept for the
 * oracle (`contentCounts`). For the seventh review's cases (`review7.test.ts`, `playedOracle.test.ts`).
 */
import "./shim.ts"
import { PlaybackLink, SharedCounter, type Timers } from "../../src/lib/audio/playback.ts"
import type { PlayerEvent } from "../../src/lib/audio/VoiceAudio.ts"
import { PlayerProcessor } from "../../worklets/player.js"
import { setCurrentTime, setSampleRate } from "./shim.ts"
import { contentCounts, QUANTUM } from "./oracle.ts"

/** The page's link and the real worklet in Node, with both directions held until the test lets them through. */
export const linkWithWorklet = (shared: boolean) => {
  setSampleRate(48_000)
  setCurrentTime(0)
  const counter = shared ? new SharedCounter() : undefined
  const proc: any = new PlayerProcessor({ processorOptions: counter !== undefined ? { counter: counter.buffer } : {} })
  let now = 0
  let audioTime = 0
  let running = true
  proc.now = () => now
  const toWorklet: Array<unknown> = []
  const toPage: Array<unknown> = []
  proc.port.postMessage = (m: unknown) => toPage.push(m)
  for (const m of (proc.port.sent as Array<unknown>).splice(0)) toPage.push(m)
  const timers: Array<{ at: number; f: () => void; id: number }> = []
  let timerId = 0
  const fakeTimers: Timers = {
    setTimeout: (f, ms) => {
      timers.push({ at: now + ms, f, id: ++timerId })
      return timerId
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    }
  }
  const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => void toWorklet.push(m) }
  const events: Array<PlayerEvent> = []
  const link = new PlaybackLink(port, (e) => events.push(e), {
    counter,
    timers: fakeTimers
  })
  const rendered: Array<{ id: number; out: Float32Array; afterGap: boolean }> = []
  let owner = 0
  const toWorkletNow = () => {
    for (const m of toWorklet.splice(0)) {
      const message = m as { type: string; id?: number }
      if (message.type === "start" && typeof message.id === "number") owner = message.id
      proc.port.deliver(m)
    }
  }
  const toPageNow = () => {
    for (const m of toPage.splice(0)) port.onmessage?.({ data: m } as MessageEvent)
  }
  return {
    link,
    events,
    proc,
    counter,
    rendered,
    toWorkletNow,
    toPageNow,
    setRunning: (r: boolean) => {
      running = r
    },
    /** Render `quanta` (messages to the worklet first); messages to the page stay held. */
    render: (quanta: number) => {
      toWorkletNow()
      for (let q = 0; q < quanta; q++) {
        const out = new Float32Array(QUANTUM)
        proc.process([], [[out]])
        rendered.push({ id: owner, out, afterGap: false })
        audioTime += QUANTUM / 48_000
        setCurrentTime(audioTime)
        now += (QUANTUM / 48_000) * 1000
      }
    },
    /**
     * Page time passes without rendering. The audio clock advances while `running` (a processor that failed while
     * the context runs on for the microphone), or when `clock` says so (WebKit's "interrupted" state, whose clock
     * the page does not trust). Due timers fire unless `busy` (a busy main thread runs nothing; whatever was
     * queued before them, such as a `processorerror`, runs first): then they fire at the next `idle`.
     */
    idle: (ms: number, options: { readonly clock?: boolean; readonly busy?: boolean } = {}) => {
      now += ms
      if (options.clock ?? running) {
        audioTime += ms / 1000
        setCurrentTime(audioTime)
      }
      if (options.busy === true) return
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at > now) break
        timers.splice(timers.indexOf(t), 1)
        t.f()
      }
    },
    oracle: () => contentCounts(rendered)
  }
}

