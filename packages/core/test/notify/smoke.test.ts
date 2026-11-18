import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import { makeBell } from "./bell.ts"

describe("smoke", () => {
  it.effect("a ring on the kitchen display, pressed snooze", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const sent = yield* kit.tool("bell_ring", { title: "Pasta", ring: true }, { device: "kitchen-display" })
      assert.isTrue(sent.ok, sent.content)
      yield* kit.notify.settle
      console.log(JSON.stringify(kit.notify.messages), JSON.stringify(kit.notify.decisions))
      const id = (sent.value as { id: string }).id
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display").map((r) => r.id), [id])
      const answer = yield* kit.notify.press(id, "snooze", { device: "kitchen-display" })
      assert.deepStrictEqual(answer, { ok: true, say: "Snoozed for five minutes." })
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      const said = yield* kit.tool("bell_say", { text: "Dinner is ready", device: "kitchen-display", wait: true })
      console.log(said.content)
      const h = yield* bell.parts.speech!.say({ room: "Kitchen" }, "Hello there")
      yield* kit.advance(5_000)
      console.log(JSON.stringify(yield* h.done), JSON.stringify(kit.notify.announced))
    }))
})
