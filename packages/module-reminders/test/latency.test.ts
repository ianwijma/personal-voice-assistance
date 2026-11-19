// What the module costs the main thread (which also frames audio) at its stated maximum: 204 open reminders (the most one
// answer reads, 17 pages of 12) with every text at its bound with the costliest characters. The longest gap of a 1 ms timer
// while a list, a change and the briefing's section run is asserted with the shared `bound(10)`. It runs on the kit's
// in-memory store (this package has no SQLite dependency); the store's own latency is `packages/store-sqlite/test/listLatency.test.ts`.
import { assert, describe, it, vi } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { BriefingSections } from "@pva/module-contracts"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { reminders, remindersModule, SCAN_ROWS } from "../src/index.ts"

vi.setConfig({ testTimeout: 60_000 })

/** The longest gap between ticks of a 1 ms timer while `effect` runs (what audio framing would see). */
const longestStop = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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

describe("reminders at the stated maximum", () => {
  it.effect("reading 204 open reminders, changing one among them and gathering the briefing hold the main thread under the bound", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      const quotes = "\"".repeat(140)
      for (let i = 0; i < SCAN_ROWS + 20; i++) {
        yield* store.insert({ text: `item${i} ${quotes}`, whose: i % 2 === 0 ? "household" : "personal", ...(i % 2 === 0 ? {} : { owner: "p-sam" }), state: "open", dueAt: now + 3_600_000 + i * 60_000, deviceId: "kitchen-display" })
      }
      // Warm up once: the first call decodes the schemas.
      yield* kit.tool("reminders_list", {}, { device: "kitchen-display" })
      const list = yield* longestStop(kit.tool("reminders_list", {}, { device: "kitchen-display" }))
      const change = yield* longestStop(kit.tool("reminders_cancel", { which: `item150` }, { device: "kitchen-display" }))
      const sections = yield* kit.contributions(BriefingSections, { device: "kitchen-display" })
      const gather = yield* longestStop(sections[0]!.gather({ turn: kit.turn({ device: "kitchen-display" }), kind: "morning", length: "normal", maxSentences: 2, language: "en", now }))
      console.log(`reminders at ${SCAN_ROWS} rows: list longest stop ${list.worst.toFixed(2)} ms, cancel ${change.worst.toFixed(2)} ms, briefing ${gather.worst.toFixed(2)} ms`)
      assert.isBelow(list.worst, bound(10))
      assert.isBelow(change.worst, bound(10))
      assert.strictEqual(JSON.stringify(change.value).includes("Cancelled"), true)
      assert.isBelow(gather.worst, bound(10))
    }))
})
