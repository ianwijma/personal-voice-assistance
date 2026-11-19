// The deciding review's nine findings of round 2 (docs/modules/reminders.md): each test fails without its fix.
import { assert, describe, it, vi } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Deferred, Effect, Fiber } from "effect"
import { holdsSecret, MAX_STOP_TRIES, remindersModule } from "../src/index.ts"
import { allRows, assertJob, DAY, faulty, H, jobOf, MIN, nofaults, openNotes, ring, SAM, spoken, theRow } from "./helpers.ts"

vi.setConfig({ testTimeout: 60_000 })

const press = (faults: ReturnType<typeof nofaults>, card: { readonly id: string }, key: string, action = "done") =>
  faults.handlers["present:reminders"].run({ presentationId: card.id, key, deviceId: SAM, action }) as Effect.Effect<{ readonly say: string }>

/** A daily reminder set on the kitchen display that has rung once: its id and the occurrence. */
const dailyRung = (kit: any, text = "call mum") =>
  Effect.gen(function*() {
    yield* kit.tool("reminders_set", { text, when: "every day at 8 pm", scope: "household" }, { device: SAM })
    const row = yield* theRow(kit)
    const first = row.value.dueAt!
    yield* kit.advance(first - (yield* kit.now) + 1_000)
    yield* kit.present.settle
    return { id: row.id as string, first: first as number }
  })

describe("finding 1: privacy is asked at the moment of answering", () => {
  const sequences = [
    ["reminders_set", (kit: any) => kit.tool("reminders_set", { text: "private appointment", when: "in an hour", scope: "me" }, { device: SAM }).pipe(Effect.map((r: any) => r.value.spoken as string))],
    ["remind_in", (kit: any) => kit.action("remind_in", { delay: "an hour", text: "private appointment" }, { device: SAM }).pipe(Effect.map((r: any) => r.say as string))]
  ] as const
  for (const [name, start] of sequences) {
    it.effect(`${name}: the device's person changes while the creation waits for the lock: the confirmation does not tell the words`, () =>
      Effect.gen(function*() {
        const faults = nofaults()
        const kit = yield* startTestModule(faulty(faults))
        yield* kit.tool("reminders_set", { text: "bins", when: "in ten minutes", scope: "household" }, { device: SAM })
        faults.gate = yield* Deferred.make<void>()
        faults.entered = yield* Deferred.make<void>()
        const delivering = yield* Effect.forkChild(kit.advance(10 * MIN + 1_000))
        yield* Deferred.await(faults.entered)
        const creating = yield* Effect.forkChild(start(kit))
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow
        // Sam's content may no longer be told on this device.
        faults.reveal = (owner) => (owner === "p-sam" ? false : undefined)
        yield* Deferred.succeed(faults.gate, undefined)
        yield* Fiber.join(delivering)
        const said = yield* Fiber.join(creating)
        assert.include(said, "only for you")
        assert.notInclude(said, "private appointment")
      }))
  }
})

describe("finding 2: a row with work owed always has a job that can do it", () => {
  it.effect("words changed while ringing, one clean-up failure, the retry, a restart: the one job is planned for the retry and the new ring comes", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* ring(kit, "call mum", "in ten minutes", "household")
      const id = (yield* theRow(kit)).id
      yield* assertJob(kit, id)
      faults.resolveFails = 1
      const changed = yield* kit.tool("reminders_change", { which: "mum", text: "call dad" }, { device: SAM })
      assert.include(spoken(changed), "It rings again now with the new words.")
      assert.include(spoken(changed), "still being taken down")
      const row = (yield* theRow(kit)).value
      assert.isDefined(row.owed)
      assert.deepStrictEqual(row.stop?.notes.length, 1)
      // The owed delivery waits for the take-down of its own key: the one job is planned for that retry, a future moment.
      yield* assertJob(kit, id, { future: true })
      assert.strictEqual(row.nextAt, row.stop!.tryAt)
      yield* kit.restart
      yield* assertJob(kit, id, { future: true })
      yield* kit.advance(6_000)
      yield* kit.present.settle
      const after = (yield* theRow(kit)).value
      assert.isUndefined(after.stop)
      assert.isUndefined(after.owed)
      assert.isDefined(after.ring)
      assert.deepStrictEqual((yield* openNotes(kit)).map((n) => n.text), ["call dad"])
      yield* assertJob(kit, id)
      yield* kit.restart
      yield* kit.advance(10 * MIN)
      assert.deepStrictEqual((yield* openNotes(kit)).map((n) => n.text), ["call dad"])
    }))
})

describe("finding 3: a card's button belongs to its occurrence", () => {
  it.effect("Done pressed twice on a repeating reminder's card does not skip the next occurrence", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      const { id, first } = yield* dailyRung(kit)
      const [card] = kit.present.shown(SAM)
      const key = `due:${id}:${first}`
      assert.include((yield* press(faults, card!, key)).say, "Done. The next one is")
      const next = (yield* theRow(kit)).value.dueAt
      assert.strictEqual(next, first + DAY)
      assert.deepStrictEqual(yield* press(faults, card!, key), { say: "That one was already answered." })
      assert.strictEqual((yield* theRow(kit)).value.dueAt, first + DAY)
      assert.deepStrictEqual(yield* press(faults, card!, key, "snooze"), { say: "That one was already answered." })
      assert.strictEqual((yield* theRow(kit)).value.dueAt, first + DAY)
      yield* kit.advance(DAY)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
    }))

  it.effect("…with a failed dismissal in between: the card is still on the screen and pressed again", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      const { first } = yield* dailyRung(kit)
      const [card] = kit.present.shown(SAM)
      faults.dismissFails = 1
      const one = yield* kit.present.press(card!.id, "done", { device: SAM })
      assert.include((one as any).say, "Done. The next one is")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(SAM).length, 1)
      const two = yield* kit.present.press(card!.id, "done", { device: SAM })
      assert.strictEqual((two as any).say, "That one was already answered.")
      assert.strictEqual((yield* theRow(kit)).value.dueAt, first + DAY)
    }))

  it.effect("a press on an old card after a newer occurrence rang answers that it was answered, and changes nothing", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      const { id, first } = yield* dailyRung(kit)
      const [old] = kit.present.shown(SAM)
      yield* kit.advance(DAY)
      yield* kit.present.settle
      const row = (yield* theRow(kit)).value
      assert.strictEqual(row.ring?.at, first + DAY)
      const before = yield* allRows(kit)
      assert.deepStrictEqual(yield* press(faults, old!, `due:${id}:${first}`), { say: "That one was already answered." })
      assert.deepStrictEqual(yield* press(faults, old!, `due:${id}:${first}`, "snooze"), { say: "That one was already answered." })
      assert.deepStrictEqual(yield* allRows(kit), before)
      // The newer card's own button still works.
      assert.include((yield* press(faults, old!, `due:${id}:${first + DAY}`)).say, "Done.")
    }))
})

describe("finding 4: a late delivery that is dropped keeps what may be open", () => {
  it.effect("sent, the ring write failed, an outage beyond six hours: the notification is owed a take-down, and a cancel takes it away", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults), { settings: { priority: "normal" } })
      yield* kit.tool("reminders_set", { text: "pills", when: "every day at 8 pm", scope: "household" }, { device: SAM })
      const first = (yield* theRow(kit)).value.dueAt!
      faults.afterSend = () => {
        faults.afterSend = undefined
        faults.failTransactions = 1
      }
      yield* kit.advance(first - (yield* kit.now) + 1_000)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      assert.strictEqual((yield* theRow(kit)).value.owed?.attempts, 1)
      yield* kit.stop
      yield* kit.advance(7 * H)
      faults.resolveFails = 1
      yield* kit.start
      yield* kit.advance(1_000)
      const row = (yield* theRow(kit)).value
      assert.isUndefined(row.owed)
      assert.strictEqual(row.dropped?.why, "late")
      assert.deepStrictEqual(row.stop?.notes, [first])
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      const cancelled = yield* kit.tool("reminders_cancel", { which: "pills" }, { device: SAM })
      assert.strictEqual(spoken(cancelled), "Cancelled: pills.")
      assert.deepStrictEqual(yield* openNotes(kit), [])
      assert.isUndefined((yield* theRow(kit)).value.stop)
    }))
})

describe("findings 5 and 6: the list is a snapshot returned with the answer", () => {
  it.effect("a speculative run of the list shows, replaces and dismisses nothing itself: what it returns is data, as the structured result", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in an hour", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_list", {}, { device: SAM })
      const result = faults.results.reminders_list
      assert.strictEqual(faults.shows, 0)
      assert.deepStrictEqual(Object.keys(result).sort(), ["forModel", "present", "show"])
      assert.deepStrictEqual(result.show, { lifetime: "transient", expiresInMs: 30_000 })
      assert.strictEqual(result.present.kind, "list")
      // A reminder changed afterwards does not change what was returned, and nothing is refreshed on a screen.
      const items = JSON.stringify(result.present.items)
      yield* kit.tool("reminders_cancel", { which: "bins" }, { device: SAM })
      yield* kit.present.settle
      assert.strictEqual(JSON.stringify(result.present.items), items)
      assert.strictEqual(faults.shows, 0)
      assert.isFalse(kit.present.messages.some((m) => m.message.type === "present.update" || m.message.type === "present.dismiss"))
      // Empty now: a plain answer, no presentation, nothing dismissed.
      assert.deepStrictEqual((yield* kit.tool("reminders_list", {}, { device: SAM })).value, { spoken: "You have no reminders." })
      assert.isFalse(kit.present.messages.some((m) => m.message.type === "present.dismiss"))
    }))
})

describe("finding 7: the last failed attempt says what is true", () => {
  it.effect("the fifth inline attempt says stopping failed and that the notification ends by itself, never an unconditional cancellation or more tries", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* ring(kit)
      faults.resolveFails = 100
      const answers: Array<string> = []
      for (let i = 0; i < MAX_STOP_TRIES; i++) answers.push(spoken(yield* kit.tool("reminders_cancel", { which: "mum" }, { device: SAM })))
      for (const a of answers.slice(0, -1)) assert.strictEqual(a, "Cancelled: call mum. Its ring is still being taken down; I'll keep trying.")
      assert.strictEqual(answers.at(-1), "Cancelled: call mum. Stopping its ring failed, and I've stopped trying; it ends by itself when it expires.")
      const full = yield* theRow(kit)
      assert.isUndefined(full.value.stop)
      assert.strictEqual(full.value.stopFailed, true)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      // Every sentence after it says so, and no job is left.
      const [n] = yield* kit.notify.all
      const again = yield* kit.notify.press(n!.id, "done", { device: SAM })
      assert.strictEqual((again as any).say, "That one was already done. Stopping its ring failed, and I've stopped trying; it ends by itself when it expires.")
      assert.deepStrictEqual(yield* jobOf(kit, full.id), [])
    }))
})

describe("finding 8: changed words reach the card too", () => {
  it.effect("Stop on the notification, then a text edit: the old card is withdrawn and nothing rings again", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const n = yield* ring(kit, "call mum", "in ten minutes", "household")
      assert.strictEqual((yield* kit.notify.press(n.id, "stop", { device: SAM })).ok, true)
      yield* kit.present.settle
      const [card] = kit.present.shown(SAM)
      assert.strictEqual(card?.content.kind === "card" ? card.content.text : "", "call mum")
      const changed = yield* kit.tool("reminders_change", { which: "mum", text: "call dad" }, { device: SAM })
      assert.strictEqual(spoken(changed), "Changed it: call dad, was due today at ten past ten in the morning.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      assert.deepStrictEqual((yield* kit.notify.all).map((x: any) => x.state), ["resolved"])
      assert.strictEqual((yield* theRow(kit)).value.text, "call dad")
      assert.isUndefined((yield* theRow(kit)).value.stop)
    }))
})

describe("finding 9: the secret rule refuses values, not years", () => {
  it.effect("a credential word beside a year is an ordinary reminder on set, change and remind_in; the values are still refused", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const ordinary = ["change my password for the 2027 account", "learn to code in Python 2027"]
      for (const text of ordinary) {
        assert.isFalse(holdsSecret(text), text)
        const set = yield* kit.tool("reminders_set", { text, when: "in an hour", scope: "household" }, { device: SAM })
        assert.include(spoken(set), text)
      }
      yield* kit.tool("reminders_set", { text: "plain", when: "in two hours", scope: "household" }, { device: SAM })
      const changed = yield* kit.tool("reminders_change", { which: "plain", text: "renew my PIN card before 2027" }, { device: SAM })
      assert.include(spoken(changed), "renew my PIN card before 2027")
      const viaAction = yield* kit.action("remind_in", { delay: "an hour", text: "change my password for the 2027 account" }, { device: SAM })
      assert.include((viaAction as any).say, "change my password for the 2027 account")
      const refused = ["my PIN is 1234", "door code 12 34", "my password is violet-badger"]
      const before = (yield* allRows(kit)).length
      for (const text of refused) {
        assert.isTrue(holdsSecret(text), text)
        assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text, when: "in an hour", scope: "household" }, { device: SAM })), "I don't keep codes or passwords in reminders.")
        assert.strictEqual(spoken(yield* kit.tool("reminders_change", { which: "plain", text }, { device: SAM })), "I don't keep codes or passwords in reminders.")
        assert.deepStrictEqual(yield* kit.action("remind_in", { delay: "an hour", text }, { device: SAM }), { ok: true, say: "I don't keep codes or passwords in reminders." })
      }
      assert.strictEqual((yield* allRows(kit)).length, before)
    }))
})
