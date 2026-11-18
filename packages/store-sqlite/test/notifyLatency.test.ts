// What the notification service costs the main thread (which also frames audio) on SQLite, at its stated bounds
// (docs/NOTIFICATIONS.md "Latency" quotes the printed numbers):
//
// - `send` as a tool calls it (as a turn, through the module host's guard): one transaction (the dedupe read, two
//   counters, the row, its expiry job) and an enqueue. Its wall time per call, and the longest stop of a 1 ms timer.
// - `say` as a tool calls it: the decision per device and an enqueue; to one device and to every device (64).
// - A delivery pass at the bounds: 64 live ring notifications sent everywhere, to 64 connected devices, every card
//   encoded as the hub encodes a frame. The pass do not disturb starts (every notification on every device: 4,096
//   decisions and frames, a page of 12 rows at a time with a yield between), and the pass of one device saying hello
//   (64 cards). The longest stop of a 1 ms timer while each runs is asserted with `bound()`.
import { assert, describe, it } from "@effect/vitest"
import { contractDevice, notifyWorld } from "@pva/core/notify-contract"
import { MAX_OPEN_PER_MODULE, MAX_OPEN_TOTAL, notifyStorage, schedulerStorage, CurrentTurn, type NotifyMessage } from "@pva/core"
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
const TITLE = "\"".repeat(60)
const TEXT = "\"".repeat(200)

describe("notification latency on SQLite at the bounds", () => {
  it.live("send and say inside a tool call are short; a delivery pass over 64 rings × 64 devices holds the main thread briefly", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: join(mkdtempSync(join(tmpdir(), "pva-notify-latency-")), "household.db") })
      yield* store.prepare([], [schedulerStorage, notifyStorage])
      let frames = 0
      let bytes = 0
      const passes: Array<{ ms: number; notifications: number; devices: number }> = []
      const world = yield* notifyWorld(store, {
        modules: MODULES,
        devices: DEVICES,
        unrecorded: true,
        // As the hub: every message encoded for each connection of the device (one each here).
        outlet: (_d, message: NotifyMessage) => {
          frames++
          bytes += encodeServerMessage(message).length
        },
        observe: (e) => void passes.push(e),
        // Never quiet: announcements wait, so `say` measures the call alone.
        speech: () => ({ quiet: () => Effect.never, play: () => Effect.void })
      })

      // ---- send, as a turn on a device: warm up, then timed (resolved again to stay within the bounds)
      const sendTimes: Array<number> = []
      const sendOne = (i: number) =>
        Effect.gen(function*() {
          const m = MODULES[i % MODULES.length]!
          const t0 = performance.now()
          const r = yield* world.bell(m).send({ title: TITLE, text: TEXT, priority: "ring", key: `k${i}`.padStart(64, "k"), actions: [{ id: "snooze", label: "\"".repeat(20) }], handler: "answer" }).pipe(
            Effect.provideService(CurrentTurn, turnOn(DEVICES[i % 64]!.id))
          )
          sendTimes.push(performance.now() - t0)
          yield* world.bell(m).resolve(r.notification.id)
          yield* Effect.yieldNow
        })
      for (let i = 0; i < 30; i++) yield* sendOne(i)
      sendTimes.length = 0
      const sending = yield* longestStop(Effect.gen(function*() {
        for (let i = 30; i < 330; i++) yield* sendOne(i)
      }))
      yield* world.settle

      // ---- say, as a turn: one device, and every device (64 decisions)
      const sayOne: Array<number> = []
      const sayAll: Array<number> = []
      const speech = world.speakers.get(MODULES[0]!)!
      const sayingTimed = yield* longestStop(Effect.gen(function*() {
        for (let i = 0; i < 64; i++) {
          let t0 = performance.now()
          const one = yield* speech.say({ device: DEVICES[i]!.id }, TEXT).pipe(Effect.provideService(CurrentTurn, turnOn(DEVICES[i]!.id)))
          sayOne.push(performance.now() - t0)
          yield* one.stop
          t0 = performance.now()
          const all = yield* speech.say("everywhere", TEXT).pipe(Effect.provideService(CurrentTurn, turnOn(DEVICES[i]!.id)))
          sayAll.push(performance.now() - t0)
          yield* all.stop
          yield* Effect.yieldNow
        }
      }))

      // ---- 64 live rings sent everywhere (the total bound), then the passes
      for (let i = 0; i < MAX_OPEN_TOTAL; i++) {
        yield* world.bell(MODULES[Math.floor(i / MAX_OPEN_PER_MODULE)]!).send({ title: TITLE, text: TEXT, priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "\"".repeat(20) }], handler: "answer" })
      }
      yield* world.settle
      passes.length = 0
      frames = 0
      bytes = 0
      const all = yield* longestStop(Effect.gen(function*() {
        yield* world.bell(MODULES[0]!).dnd.set()
        yield* world.settle
      }))
      const allPass = passes.find((p) => p.notifications === MAX_OPEN_TOTAL)
      const allFrames = frames
      const allBytes = bytes
      passes.length = 0
      const hello = yield* longestStop(Effect.gen(function*() {
        world.notify.connected(DEVICES[0]!.id)
        yield* world.settle
      }))
      const helloPass = passes.find((p) => p.devices === 1)

      console.log([
        `send (as a tool, ${sendTimes.length} calls): median ${ms(median(sendTimes))}, p95 ${ms(p95(sendTimes))}, worst ${ms(Math.max(...sendTimes))}; longest stop ${ms(sending.worst)}`,
        `say to one device (${sayOne.length}): median ${ms(median(sayOne))}, worst ${ms(Math.max(...sayOne))}; say everywhere (64 devices): median ${ms(median(sayAll))}, worst ${ms(Math.max(...sayAll))}; longest stop ${ms(sayingTimed.worst)}`,
        `delivery pass, every notification on every device (${allPass?.notifications} × ${allPass?.devices}, ${allFrames} frames, ${(allBytes / 1024).toFixed(0)} KiB): decisions and sends ${ms(allPass?.ms ?? NaN)}; longest stop ${ms(all.worst)}`,
        `delivery pass, one device says hello (${helloPass?.notifications} cards): ${ms(helloPass?.ms ?? NaN)}; longest stop ${ms(hello.worst)}`
      ].join("\n"))
      assert.strictEqual(allPass?.devices, 64)
      assert.strictEqual(allFrames, MAX_OPEN_TOTAL * 64)
      assert.strictEqual(helloPass?.notifications, MAX_OPEN_TOTAL)
      assert.isBelow(median(sendTimes), bound(2))
      assert.isBelow(sending.worst, bound(30))
      assert.isBelow(sayingTimed.worst, bound(20))
      assert.isBelow(all.worst, bound(30))
      assert.isBelow(hello.worst, bound(15))
    })), 120_000)
})
