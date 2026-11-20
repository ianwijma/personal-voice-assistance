// R8 (docs/PRESENTING.md, "Speculative turns"): nothing a speculative turn asks for reaches a screen before the turn is
// promoted. `calendar_agenda`, `calendar_next` and `calendar.my_next` are `speculative: true` and return their presentation
// with the result; through the real host, gateway and Presenter, with the turn's commit state given as `Conversation` gives
// it: a turn that is discarded shows nothing and withdraws nothing, a promoted one shows once.
import { assert, describe, it } from "@effect/vitest"
import { CurrentTurnCommit, type TurnCommit } from "@pva/core"
import { Effect } from "effect"
import { vi } from "vitest"
import { allFixtures, answerOf, everyone } from "./fixtures.ts"
import { startShown } from "./screenKit.ts"

vi.setConfig({ testTimeout: 30_000 })

const kitchen = { device: "kitchen-display" }

/** A turn that is not committed yet: `promote()` commits it (and runs what waited), a discarded turn never calls it. */
const speculativeTurn = () => {
  let committed = false
  const waiting: Array<() => void> = []
  const commit: TurnCommit = {
    committed: () => committed,
    whenCommitted: (f) => {
      if (committed) f()
      else waiting.push(f)
    }
  }
  return {
    commit,
    promote: () => {
      committed = true
      for (const f of waiting.splice(0)) f()
    }
  }
}
const during = <A, E, R>(turn: ReturnType<typeof speculativeTurn>, effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentTurnCommit, turn.commit)


describe("calendar: a speculative turn and the screen", () => {
  const cases = [
    ["calendar_agenda", (kit: any) => answerOf(kit, "calendar_agenda", { day: "today" }, kitchen)],
    ["calendar_next for me", (kit: any) => answerOf(kit, "calendar_next", { who: "me" }, kitchen)],
    ["the my_next action", (kit: any) => kit.action("my_next", {}, kitchen)]
  ] as const

  for (const [name, call] of cases) {
    it.effect(`${name}: a discarded turn shows nothing and withdraws nothing; a promoted one shows once`, () =>
      Effect.gen(function*() {
        const { kit, asked } = yield* startShown(allFixtures, everyone)
        // What is on the kitchen display before: a committed answer for tomorrow.
        yield* answerOf(kit, "calendar_agenda", { day: "tomorrow" }, kitchen)
        yield* kit.present.settle
        const before = kit.present.shown("kitchen-display")
        assert.strictEqual(before.length, 1)
        const count = () => kit.present.messages.filter((m) => m.deviceId === "kitchen-display").length
        const messages = count()

        // A speculative turn that is discarded: the tool ran and returned its presentation, but it never reached the screen.
        const discarded = speculativeTurn()
        const asking = asked.length
        yield* during(discarded, call(kit) as Effect.Effect<unknown>)
        yield* kit.present.settle
        assert.strictEqual(asked.length, asking + 1, "the tool returned a presentation")
        assert.strictEqual(count(), messages, "no message to the page: nothing shown, nothing withdrawn")
        assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), before.map((p) => p.id))
        assert.deepStrictEqual(kit.present.shown("kitchen-display"), before)

        // The same call in a turn that is promoted: shown once, and it takes the earlier one's place.
        const promoted = speculativeTurn()
        yield* during(promoted, call(kit) as Effect.Effect<unknown>)
        yield* kit.present.settle
        assert.strictEqual(count(), messages, "not before promotion")
        promoted.promote()
        yield* kit.present.settle
        const shown = kit.present.shown("kitchen-display")
        assert.strictEqual(shown.length, 1)
        assert.notStrictEqual(shown[0]!.id, before[0]!.id)
        assert.strictEqual(kit.present.messages.slice(messages).filter((m) => m.deviceId === "kitchen-display" && m.message.type === "present.show").length, 1)
      }))
  }
})
