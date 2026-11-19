// How long a timer's ring takes to leave the server once its job runs (docs/modules/timers.md, "How long a ring takes").
// A latency test: it imports latencyBound.ts, so CI runs it alone after the rest. Through the kit's real scheduler engine,
// notification service and page connection on the in-memory store, ten timers due at the same instant (the most rings
// one module may have open), five rounds. It measures, in real time:
//
// - from the row's job handler being entered to the `notification.ring` message being handed to the device's page
//   connection (the page boundary: the kit's connection records it there), per ring;
// - from that handler being entered to its completion (the ring recorded in the row, the countdown taken down, the next
//   plan written), per ring;
// - from the first handler entered to the last of the ten messages.
//
// It does not measure the scheduler waking at the due instant: the kit's clock is a test clock (moved by the test), so
// the time between the due instant and the handler being entered is not real time here.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { timersModule } from "../src/index.ts"
import { hooked, makeHooks } from "./support.ts"

const MIN = 60_000
const RINGS = 10

interface Marks {
  readonly entered: Array<number>
  readonly finished: Array<number>
  readonly frames: Array<number>
}

/** The module with the real time of each `due` handler's entry and completion recorded (a test's own wrapper). */
const timed = (marks: Marks, busyMs?: number): typeof timersModule => {
  const hooks = makeHooks()
  if (busyMs !== undefined) hooks.sendBusyMs = busyMs
  const inner = hooked(timersModule, hooks)
  return {
    ...inner,
    shared: (ctx) =>
      inner.shared!({
        ...ctx,
        scheduler: {
          ...ctx.scheduler,
          handle: (name, handler) =>
            ctx.scheduler.handle(name, name !== "due" ? handler : {
              ...handler,
              run: (payload, due) =>
                Effect.andThen(
                  Effect.sync(() => void marks.entered.push(performance.now())),
                  Effect.tap(handler.run(payload, due), () => Effect.sync(() => void marks.finished.push(performance.now())))
                )
            })
        }
      })
  }
}

/** Ten timers due together; the page's `notification.ring` frames timed where the kit's connection receives them. */
const round = (busyMs?: number) =>
  Effect.gen(function*() {
    const marks: Marks = { entered: [], finished: [], frames: [] }
    const kit = yield* startTestModule(timed(marks, busyMs))
    for (let i = 0; i < RINGS; i++) yield* kit.action("start", { duration: "1 minute", name: `t${i}` })
    // The page boundary: the kit's page connection appends each message it is handed to this list.
    const messages = kit.notify.messages as unknown as Array<{ readonly message: { readonly type?: string } }>
    const push = messages.push.bind(messages)
    Object.defineProperty(messages, "push", {
      value: (...items: Array<{ readonly message: { readonly type?: string } }>) => {
        for (const item of items) if (item.message.type === "notification.ring") marks.frames.push(performance.now())
        return push(...items)
      }
    })
    marks.entered.length = 0
    marks.finished.length = 0
    yield* kit.advance(MIN)
    yield* kit.notify.settle
    assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, RINGS)
    // Each ring's handler entry is followed by its frame (the handlers run one after another, under the module's lock).
    const entered = marks.entered.filter((_, i) => marks.finished[i] !== undefined).slice(-RINGS)
    assert.strictEqual(marks.frames.length, RINGS)
    assert.strictEqual(entered.length, RINGS)
    const toFrame = marks.frames.map((f, i) => f - entered[i]!)
    const toFinish = marks.finished.slice(-RINGS).map((f, i) => f - entered[i]!)
    return { toFrame: Math.max(...toFrame), toFinish: Math.max(...toFinish), all: marks.frames.at(-1)! - entered[0]! }
  })

describe("how long a timer's ring takes to leave the server", () => {
  it.effect("handler entered → ring frame handed to the page; → handler finished; first entered → tenth frame", () =>
    Effect.gen(function*() {
      const rounds: Array<{ readonly toFrame: number; readonly toFinish: number; readonly all: number }> = []
      for (let r = 0; r < 5; r++) rounds.push(yield* round())
      const worst = (k: "toFrame" | "toFinish" | "all") => Math.max(...rounds.map((x) => x[k]))
      console.log(
        `timers: due handler entered → notification.ring at the page, worst of ${RINGS} × 5: ${worst("toFrame").toFixed(2)} ms; → handler finished: ${worst("toFinish").toFixed(2)} ms; first entered → tenth frame, worst of 5: ${worst("all").toFixed(2)} ms`
      )
      assert.isBelow(worst("toFrame"), bound(10))
      assert.isBelow(worst("toFinish"), bound(15))
      assert.isBelow(worst("all"), bound(80))
    }))

  it.effect("the measurement sees work before the page boundary: 5 ms of busy work in the send shows up in it", () =>
    Effect.gen(function*() {
      const slow = yield* round(5)
      console.log(`timers: with 5 ms of busy work in each send: handler entered → frame, worst: ${slow.toFrame.toFixed(2)} ms`)
      assert.isAtLeast(slow.toFrame, 5)
    }))
})
