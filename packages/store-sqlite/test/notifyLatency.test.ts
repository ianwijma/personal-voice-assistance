// What the notification service costs the main thread (which also frames audio) on SQLite, at its stated maximum
// (docs/NOTIFICATIONS.md "Latency" quotes the printed numbers): every text at its bound with the costliest characters
// JSON has for it, two actions with labels at their bound, 300-character announcements, 64 devices with a page each,
// and the host's real page boundary (`ModuleHost.pageText`, which every card's texts pass):
//
// - `send` as a tool calls it (as a turn, through the module host's guard): one transaction and an enqueue.
// - `say` as a tool calls it: the decision per device and an enqueue; to one device and to every device (64).
// - Reconciliation at the bound: 64 open rings sent everywhere, to 64 devices, every card encoded as the hub encodes a
//   frame: the passes do not disturb starts (every device, every card), and one page saying hello (64 cards). A pass
//   reads, decides and sends a page of 12 rows in one step and yields between steps.
//
// The longest stop of a 1 ms timer while each runs is asserted with the shared `bound(10)`.
import { assert, describe, it } from "@effect/vitest"
import { contractDevice, notifyWorld } from "@pva/core/notify-contract"
import { CurrentTurn, MAX_NOTIFICATION_LABEL_CHARS, MAX_NOTIFICATION_TEXT_CHARS, MAX_NOTIFICATION_TITLE_CHARS, MAX_OPEN_PER_MODULE, MAX_OPEN_TOTAL, MAX_SPEECH_CHARS, type NotifyMessage, notifyStorage, schedulerStorage } from "@pva/core"
import { encodeServerMessage } from "@pva/protocol"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"
import { bound } from "./latencyBound.ts"

/** The longest gap between ticks of a 1 ms timer while `effect` runs (what audio framing would see). */
const longestStop = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    try {
      const value = yield* effect
      return { value, worst: Math.max(worst, performance.now() - last) }
    } finally {
      clearInterval(timer)
    }
  })

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!
const ms = (x: number) => `${x.toFixed(3)} ms`

const DEVICES = Array.from({ length: 64 }, (_, i) => contractDevice(`device-${String(i).padStart(2, "0")}-xxxxxxxx`, `Device ${i}`, `Room ${i % 8}`, i % 3 === 0 ? "private" : "shared", null))
const MODULES = Array.from({ length: Math.ceil(MAX_OPEN_TOTAL / MAX_OPEN_PER_MODULE) }, (_, i) => `mod${i}`)
const turnOn = (deviceId: string) => ({ turnId: 1, conversationId: "c1", source: "voice" as const, assistantId: "jeff", deviceId })
const Q = "\""
/** The stated maximum of one notification. */
const MAX_SEND = (i: number) => ({
  title: Q.repeat(MAX_NOTIFICATION_TITLE_CHARS),
  text: Q.repeat(MAX_NOTIFICATION_TEXT_CHARS),
  priority: "ring" as const,
  key: `k${i}`.padStart(64, "k"),
  actions: [{ id: "a".repeat(32), label: Q.repeat(MAX_NOTIFICATION_LABEL_CHARS) }, { id: "b".repeat(32), label: Q.repeat(MAX_NOTIFICATION_LABEL_CHARS) }],
  handler: "answer"
})
const LINE = Q.repeat(MAX_SPEECH_CHARS)

describe("notification latency on SQLite at the stated maximum", () => {
  it.live("send and say inside a tool call are short; reconciling 64 rings on 64 devices holds the main thread under the bound", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: join(mkdtempSync(join(tmpdir(), "pva-notify-latency-")), "household.db") })
      yield* store.prepare([], [schedulerStorage, notifyStorage])
      let frames = 0
      let bytes = 0
      const steps: Array<number> = []
      const world = yield* notifyWorld(store, {
        modules: MODULES,
        devices: DEVICES,
        unrecorded: true,
        // As the hub: every message encoded for the connection.
        outlet: (_d, message: NotifyMessage) => {
          frames++
          bytes += encodeServerMessage(message).length
        },
        observe: (e) => void steps.push(e.ms),
        // Never quiet: announcements wait, so `say` measures the call alone.
        speech: () => ({ speak: () => Effect.never })
      })
      yield* world.settle

      // ---- send, as a turn on a device: warm up, then timed (resolved again to stay within the bounds)
      const sendTimes: Array<number> = []
      const sendOne = (i: number) =>
        Effect.gen(function*() {
          const m = MODULES[i % MODULES.length]!
          const t0 = performance.now()
          const r = yield* world.bell(m).send(MAX_SEND(i)).pipe(Effect.provideService(CurrentTurn, turnOn(DEVICES[i % 64]!.id)))
          sendTimes.push(performance.now() - t0)
          yield* world.bell(m).resolve(r.notification.id)
          yield* world.settle
        })
      for (let i = 0; i < 30; i++) yield* sendOne(i)
      sendTimes.length = 0
      const sending = yield* longestStop(Effect.gen(function*() {
        for (let i = 30; i < 230; i++) yield* sendOne(i)
      }))

      // ---- say, as a turn: one device, and every device (64 decisions)
      const sayOne: Array<number> = []
      const sayAll: Array<number> = []
      const speech = world.speakers.get(MODULES[0]!)!
      const saying = yield* longestStop(Effect.gen(function*() {
        for (let i = 0; i < 64; i++) {
          let t0 = performance.now()
          const one = yield* speech.say({ device: DEVICES[i]!.id }, LINE).pipe(Effect.provideService(CurrentTurn, turnOn(DEVICES[i]!.id)))
          sayOne.push(performance.now() - t0)
          yield* one.stop
          t0 = performance.now()
          const all = yield* speech.say("everywhere", LINE).pipe(Effect.provideService(CurrentTurn, turnOn(DEVICES[i]!.id)))
          sayAll.push(performance.now() - t0)
          yield* all.stop
          yield* Effect.yieldNow
        }
      }))

      // ---- 64 open rings sent everywhere (the total bound), then the passes
      for (let i = 0; i < MAX_OPEN_TOTAL; i++) yield* world.bell(MODULES[Math.floor(i / MAX_OPEN_PER_MODULE)]!).send({ ...MAX_SEND(i + 1_000), target: "everywhere" })
      yield* world.settle
      steps.length = 0
      frames = 0
      bytes = 0
      const all = yield* longestStop(Effect.gen(function*() {
        yield* world.bell(MODULES[0]!).dnd.set()
        yield* world.settle
      }))
      const allSteps = [...steps]
      const allFrames = frames
      const allBytes = bytes
      steps.length = 0
      frames = 0
      const hello = yield* longestStop(Effect.andThen(world.open(DEVICES[0]!.id), world.settle))
      const helloFrames = frames

      console.log([
        `send (as a tool, ${sendTimes.length} calls): median ${ms(median(sendTimes))}, p95 ${ms(p95(sendTimes))}, worst ${ms(Math.max(...sendTimes))}; longest stop ${ms(sending.worst)}`,
        `say a ${MAX_SPEECH_CHARS}-character line to one device (${sayOne.length}): median ${ms(median(sayOne))}, worst ${ms(Math.max(...sayOne))}; everywhere (64 devices): median ${ms(median(sayAll))}, worst ${ms(Math.max(...sayAll))}; longest stop ${ms(saying.worst)}`,
        `reconciling every device when do not disturb starts (64 rings x 64 devices, ${allFrames} frames, ${(allBytes / 1024).toFixed(0)} KiB): ${allSteps.length} steps, ${ms(allSteps.reduce((a, b) => a + b, 0))} in all, the longest step ${ms(Math.max(...allSteps))}; longest stop ${ms(all.worst)}`,
        `one page saying hello (${helloFrames} cards): longest stop ${ms(hello.worst)}`
      ].join("\n"))
      assert.strictEqual(allFrames, MAX_OPEN_TOTAL * 64)
      assert.strictEqual(helloFrames, MAX_OPEN_TOTAL)
      for (const stop of [sending.worst, saying.worst, all.worst, hello.worst]) assert.isBelow(stop, bound(10))
    })), 180_000)
})
