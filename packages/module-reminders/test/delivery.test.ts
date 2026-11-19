// A reminder's state and its one job (docs/modules/reminders.md "The state of a reminder"): the series, an owed delivery,
// an outstanding ring and cleanup owed, all done by reconciling the row. Delivery at least once, never zero times; the
// late rules; retries and their limits; cleanup that failed; the daily clean-up; real dates across the clock changes; the
// job limit through the real scheduler; and every handler run again.
import { assert, describe, it, vi } from "@effect/vitest"
import { DEFAULT_TEST_HOUSEHOLD, startTestModule } from "@pva/core/testing"
import { Deferred, Effect, Fiber } from "effect"
import { MAX_STOP_TRIES, MAX_TRIES, reminders, remindersModule } from "../src/index.ts"
import {
  type Kit, allRows, DAY, faulty, forModel, gather, H, jobOf, liveJobs, MIN, nofaults, openNotes, ring, ROBIN, rowByText, SAM, spoken, theRow
} from "./helpers.ts"

// The tests that move the clock by months take 37 s alone on a 16-core machine (every simulated hour runs the host's
// hourly jobs) and passed 60 s on the two-core CI machine.
vi.setConfig({ testTimeout: 180_000 })

/** 18 November 2026, the kit's day; Amsterdam is UTC+1 then. */
const at = (iso: string) => Date.parse(iso)

describe("repeating reminders", () => {
  it.effect("one job for the next occurrence, planned with every write, kept across a restart", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const set = yield* kit.tool("reminders_set", { text: "bins out", when: "every day at 7 pm" }, { device: SAM })
      assert.include(spoken(set), "Repeating reminder, every day at seven o'clock in the evening: bins out.")
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.rrule, "FREQ=DAILY")
      assert.strictEqual((yield* jobOf(kit, row.id)).length, 1)
      yield* kit.restart
      yield* kit.advance(9 * H + MIN)
      const [first] = yield* kit.notify.all
      assert.strictEqual(first?.text, "bins out")
      const live = yield* jobOf(kit, row.id)
      assert.strictEqual(live.length, 1)
      assert.strictEqual(live[0]?.dueAt, row.value.dueAt! + DAY)
      assert.strictEqual(live[0]?.origin.deviceId, SAM)
      const done = yield* kit.notify.press(first!.id, "done", { device: SAM })
      assert.deepStrictEqual(done, { ok: true, say: "Done. The next one is tomorrow at seven o'clock in the evening." })
      assert.strictEqual((yield* theRow(kit)).value.state, "open")
      yield* kit.advance(DAY)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
    }))

  it.effect("found late after an outage: delivered when it is only a little late, skipped when the moment has passed, the series goes on", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "water plants", when: "every day at 9 am", scope: "household" }, { device: SAM })
      const row = yield* theRow(kit)
      const first = row.value.dueAt!
      yield* kit.stop
      yield* kit.advance(first - (yield* kit.now) + 7 * H)
      yield* kit.start
      yield* kit.advance(MIN)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      assert.strictEqual((yield* theRow(kit)).value.dropped?.why, "late")
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, first + DAY)
      yield* kit.stop
      yield* kit.advance(first + DAY - (yield* kit.now) + 2 * H)
      yield* kit.start
      yield* kit.advance(MIN)
      const [late] = yield* kit.notify.all
      assert.include(late?.text ?? "", "late: due")
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, first + 2 * DAY)
    }))

  it.effect("a delivery that fails is owed and tried again by the same job; the series has moved on already", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "pills", when: "every day at 8 pm", scope: "household" }, { device: SAM })
      const row = yield* theRow(kit)
      const first = row.value.dueAt!
      faults.sendFails = 1
      yield* kit.advance(first - (yield* kit.now) + 1_000)
      const owed = (yield* theRow(kit)).value
      assert.strictEqual(owed.dueAt, first + DAY)
      assert.deepStrictEqual(owed.owed, { at: first, from: first, attempts: 1, tryAt: first + 30_000 })
      assert.deepStrictEqual(yield* kit.notify.all, [])
      // One job, for the next try (the earlier of the try and tomorrow).
      const jobs = yield* jobOf(kit, row.id)
      assert.strictEqual(jobs.length, 1)
      assert.strictEqual(jobs[0]?.dueAt, first + 30_000)
      yield* kit.advance(30_000)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      const after = (yield* theRow(kit)).value
      assert.isUndefined(after.owed)
      assert.strictEqual(after.ring?.at, first)
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, first + DAY)
    }))

  it.effect("an outage across a pending retry: the old occurrence is not delivered two days late, and the series goes on", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "pills", when: "every day at 8 pm", scope: "household" }, { device: SAM })
      const first = (yield* theRow(kit)).value.dueAt!
      faults.sendFails = 1
      yield* kit.advance(first - (yield* kit.now) + 1_000)
      assert.strictEqual((yield* theRow(kit)).value.owed?.attempts, 1)
      // Stopped before the retry, back two days later at 19:00.
      yield* kit.stop
      yield* kit.advance(first + 2 * DAY - H - (yield* kit.now))
      yield* kit.start
      yield* kit.advance(MIN)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      const row = yield* theRow(kit)
      assert.isUndefined(row.value.owed)
      assert.strictEqual(row.value.dueAt, first + 2 * DAY)
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, first + 2 * DAY)
      yield* kit.advance(H)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
    }))

  it.effect("tries used up: given up with a Health issue; the next day rings, and lists and the briefing see the right time", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "pills", when: "every day at 8 pm", scope: "household" }, { device: SAM })
      const first = (yield* theRow(kit)).value.dueAt!
      faults.sendFails = MAX_TRIES
      yield* kit.advance(first - (yield* kit.now) + H)
      const row = yield* theRow(kit)
      assert.isUndefined(row.value.owed)
      assert.deepStrictEqual(row.value.dropped, { at: first, why: "failed", when: row.value.dropped!.when })
      assert.strictEqual(row.value.nextAt, first + DAY)
      const problem = (yield* kit.jobs).find((j) => j.handler === "problem")
      assert.strictEqual(problem?.state, "failed")
      assert.include(problem?.lastError ?? "", "could not be delivered after 5 tries")
      assert.notInclude(problem?.lastError ?? "", "pills")
      assert.isTrue(kit.issues().length > 0)
      // The next morning: the list and the briefing say tonight's time; tonight it rings.
      yield* kit.advance(first + DAY - 11 * H - (yield* kit.now))
      const v = forModel(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.strictEqual(v.reminders[0].when, "today at eight o'clock in the evening")
      assert.deepStrictEqual((yield* gather(kit, SAM)).sentences, ["You have a reminder today: pills at eight o'clock."])
      yield* kit.advance(11 * H + MIN)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
    }))

  it.effect("a series with an end: its last occurrence stays open while it rings; snooze and done work on it; it is not delivered too late", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      yield* kit.tool("reminders_set", { text: "last", when: "every day at 9 pm", scope: "household" }, { device: SAM })
      const row = yield* theRow(kit)
      yield* store.update(row.id, (v) => ({ ...v, rrule: "FREQ=DAILY;COUNT=1" }))
      yield* kit.advance(11 * H + MIN)
      const [n] = yield* kit.notify.all
      const open = yield* theRow(kit)
      assert.strictEqual(open.value.state, "open")
      assert.isUndefined(open.value.dueAt)
      assert.deepStrictEqual(yield* kit.notify.press(n!.id, "snooze", { device: SAM }), { ok: true, say: "I'll remind you again in 10 minutes." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      yield* kit.advance(11 * MIN)
      const again = (yield* openNotes(kit))[0]!
      assert.strictEqual(again.key, n!.key)
      assert.deepStrictEqual(yield* kit.notify.press(again.id, "done", { device: SAM }), { ok: true, say: "Done." })
      assert.strictEqual((yield* theRow(kit)).value.state, "done")
      // The same last occurrence found seven hours late: given up, and finished.
      const late = yield* startTestModule(remindersModule)
      yield* late.tool("reminders_set", { text: "last", when: "every day at 9 pm", scope: "household" }, { device: SAM })
      const r2 = yield* theRow(late)
      yield* late.moduleStore().collection(reminders).update(r2.id, (v) => ({ ...v, rrule: "FREQ=DAILY;COUNT=1" }))
      yield* late.stop
      yield* late.advance(r2.value.dueAt! - (yield* late.now) + 7 * H)
      yield* late.start
      yield* late.advance(MIN)
      assert.deepStrictEqual(yield* late.notify.all, [])
      assert.strictEqual((yield* theRow(late)).value.state, "lapsed")
    }))
})

describe("real dates in Europe/Amsterdam", () => {
  const nextJob = (kit: Kit, id: string) => Effect.map(jobOf(kit, id), (js) => js[0]?.dueAt)

  it.effect("a daily 02:30 across the spring change: 01:30Z, then 03:30 local in the gap (01:30Z), then 00:30Z", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, { startAt: at("2027-03-26T11:00:00Z") })
      yield* kit.tool("reminders_set", { text: "night", when: "every day at 2:30 am", scope: "household" }, { device: SAM })
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.dueAt, at("2027-03-27T01:30:00Z"))
      assert.strictEqual(yield* nextJob(kit, row.id), at("2027-03-27T01:30:00Z"))
      yield* kit.advance(at("2027-03-27T01:31:00Z") - (yield* kit.now))
      assert.strictEqual((yield* theRow(kit)).value.dueAt, at("2027-03-28T01:30:00Z"))
      assert.strictEqual(yield* nextJob(kit, row.id), at("2027-03-28T01:30:00Z"))
      yield* kit.advance(DAY)
      assert.strictEqual((yield* theRow(kit)).value.dueAt, at("2027-03-29T00:30:00Z"))
      assert.strictEqual(yield* nextJob(kit, row.id), at("2027-03-29T00:30:00Z"))
    }))

  it.effect("a daily 02:30 across the autumn change: 00:30Z twice (the first 02:30), then 01:30Z", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, { startAt: at("2027-10-29T11:00:00Z") })
      yield* kit.tool("reminders_set", { text: "night", when: "every day at 2:30 am", scope: "household" }, { device: SAM })
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.dueAt, at("2027-10-30T00:30:00Z"))
      yield* kit.advance(at("2027-10-30T00:31:00Z") - (yield* kit.now))
      assert.strictEqual(yield* nextJob(kit, row.id), at("2027-10-31T00:30:00Z"))
      yield* kit.advance(DAY)
      assert.strictEqual(yield* nextJob(kit, row.id), at("2027-11-01T01:30:00Z"))
      assert.strictEqual((yield* kit.notify.all).length, 2)
    }))

  it.effect("the 31st of every month skips the months without one; the 29th of February comes back in 2032", () =>
    Effect.gen(function*() {
      // Rows as stored, given their first job by a change of words (every write plans the row's job).
      const kit = yield* startTestModule(remindersModule, { startAt: at("2027-01-30T11:00:00Z") })
      const store = kit.moduleStore().collection(reminders)
      const first = at("2027-01-31T08:00:00Z")
      yield* store.insert({ text: "month end", whose: "household", state: "open", deviceId: SAM, dueAt: first, nextAt: first, rrule: "FREQ=MONTHLY;BYMONTHDAY=31", dtstart: "DTSTART;TZID=Europe/Amsterdam:20270131T090000", timeZone: "Europe/Amsterdam" })
      yield* kit.tool("reminders_change", { which: "month end", text: "month end" }, { device: SAM })
      const row = (yield* rowByText(kit, "month end"))!
      assert.strictEqual(yield* nextJob(kit, row.id), first)
      yield* kit.advance(first - (yield* kit.now) + MIN)
      assert.strictEqual(yield* nextJob(kit, row.id), at("2027-03-31T07:00:00Z"))
      yield* kit.advance(at("2027-03-31T07:01:00Z") - (yield* kit.now))
      assert.strictEqual(yield* nextJob(kit, row.id), at("2027-05-31T07:00:00Z"))

      const leap = yield* startTestModule(remindersModule, { startAt: at("2028-02-28T11:00:00Z") })
      const day = at("2028-02-29T08:00:00Z")
      yield* leap.moduleStore().collection(reminders).insert({ text: "leap", whose: "household", state: "open", deviceId: SAM, dueAt: day, nextAt: day, rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", dtstart: "DTSTART;TZID=Europe/Amsterdam:20280229T090000", timeZone: "Europe/Amsterdam" })
      yield* leap.tool("reminders_change", { which: "leap", text: "leap" }, { device: SAM })
      const lr = (yield* rowByText(leap, "leap"))!
      yield* leap.advance(day - (yield* leap.now) + MIN)
      assert.strictEqual((yield* leap.notify.all).length, 1)
      assert.strictEqual(yield* nextJob(leap, lr.id), at("2032-02-29T08:00:00Z"))
    }))
})

describe("delivery is at least once, never zero times", () => {
  const crashAfterSend = (faults: ReturnType<typeof nofaults>) => {
    faults.afterSend = () => {
      faults.afterSend = undefined
      faults.failTransactions = 1
    }
  }

  it.effect("the server fails between the send and the write of the ring: a notification still open is only written as the ring", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in ten minutes", scope: "household" }, { device: SAM })
      crashAfterSend(faults)
      yield* kit.advance(10 * MIN + 1_000)
      assert.strictEqual((yield* kit.notify.all).length, 1)
      assert.strictEqual((yield* theRow(kit)).value.owed?.attempts, 1)
      yield* kit.advance(30_000)
      // Still one notification: the second send found it open under the same key.
      assert.strictEqual((yield* kit.notify.all).length, 1)
      const row = yield* theRow(kit)
      assert.isUndefined(row.value.owed)
      assert.isDefined(row.value.ring)
    }))

  it.effect("…and when it was stopped meanwhile, it rings a second time (once more, never zero times)", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in ten minutes", scope: "household" }, { device: SAM })
      crashAfterSend(faults)
      yield* kit.advance(10 * MIN + 1_000)
      const [first] = yield* kit.notify.all
      assert.strictEqual((yield* kit.notify.press(first!.id, "stop", { device: SAM })).ok, true)
      yield* kit.advance(30_000)
      const all = yield* kit.notify.all
      assert.strictEqual(all.length, 2)
      assert.strictEqual(all[1]?.state, "open")
      assert.strictEqual(all[1]?.key, first!.key)
      assert.isDefined((yield* theRow(kit)).value.ring)
    }))

  it.effect("a one-off whose delivery fails is tried again and delivered once", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      const due = (yield* theRow(kit)).value.dueAt!
      faults.sendFails = 2
      yield* kit.advance(MIN + 1_000)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      yield* kit.advance(30_000 + 60_000)
      assert.strictEqual((yield* kit.notify.all).length, 1)
      // The ring is the occurrence that was due, however late the third try was.
      assert.strictEqual((yield* theRow(kit)).value.ring?.at, due)
      yield* kit.advance(H)
      assert.strictEqual((yield* kit.notify.all).length, 1)
    }))

  it.effect("a one-off found eight days late at 03:58 is delivered, and the 04:00 clean-up does not end it: a week is counted from delivery", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults), { startAt: at("2026-11-18T02:58:00Z") })
      yield* kit.tool("reminders_set", { text: "early", when: "in a minute", scope: "household" }, { device: SAM })
      yield* kit.stop
      yield* kit.advance(8 * DAY)
      yield* kit.start
      yield* kit.advance(1_000)
      const [n] = yield* kit.notify.all
      assert.include(n?.text ?? "", "late: due")
      const tidied = faults.runs.tidy ?? 0
      yield* kit.advance(2 * MIN + 1_000)
      // The 04:00 (Amsterdam) clean-up ran in this step, and the week is counted from the delivery.
      assert.strictEqual(faults.runs.tidy, tidied + 1)
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.state, "open")
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      assert.deepStrictEqual(yield* kit.notify.press(n!.id, "done", { device: SAM }), { ok: true, say: "Done." })
    }))
})

describe("answering: done and snooze", () => {
  it.effect("done from the notification: finished once, however many press, and its card and job go", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const n = yield* ring(kit)
      const both = yield* Effect.all([kit.notify.press(n.id, "done", { device: SAM }), kit.notify.press(n.id, "done", { device: SAM })], { concurrency: 2 })
      assert.strictEqual(both.filter((r: any) => r.ok && r.say === "Done.").length, 1)
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.state, "done")
      assert.isDefined(row.value.endedAt)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      assert.deepStrictEqual((yield* kit.notify.all).map((x: any) => x.state), ["resolved"])
      assert.deepStrictEqual(row.value.stop?.notes, [Number(n.key!.split(":").at(-1))])
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, (yield* kit.now) + 5_000)
      // The button's write names the device it was pressed on.
      const changed = kit.events.filter((e: any) => e.type === "reminders.reminders.changed")
      assert.deepStrictEqual((changed.at(-1) as any)?.actor, { kind: "ui", deviceId: SAM })
      yield* kit.advance(6_100)
      assert.isUndefined((yield* theRow(kit)).value.stop)
      assert.deepStrictEqual((yield* liveJobs(kit)).filter((j) => j.handler !== "tidy"), [])
    }))

  it.effect("snooze: rings again later, the setting decides how long, and the same press run again does not push it further", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults), { settings: { snoozeMinutes: 20 } })
      const n = yield* ring(kit)
      assert.deepStrictEqual(yield* kit.notify.press(n.id, "snooze", { device: SAM }), { ok: true, say: "I'll remind you again in 20 minutes." })
      const until = (yield* theRow(kit)).value.ring?.snoozeUntil
      assert.strictEqual(until, (yield* kit.now) + 20 * MIN)
      // The service runs the handler again for the same notification (its outcome could not be written): same press.
      yield* kit.advance(MIN)
      const again = yield* (faults.handlers["notify:reminders"].run({ notificationId: n.id, key: n.key, actionId: "snooze", deviceId: SAM }) as Effect.Effect<unknown>)
      assert.deepStrictEqual(again, { say: "I already put that one off." })
      assert.strictEqual((yield* theRow(kit)).value.ring?.snoozeUntil, until)
      yield* kit.advance(18 * MIN)
      assert.strictEqual((yield* openNotes(kit)).length, 0)
      yield* kit.advance(2 * MIN)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      assert.isUndefined((yield* theRow(kit)).value.ring?.snoozeUntil)
    }))

  it.effect("the card's buttons do the same, its notification goes with it, and the write names the pressing device", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* ring(kit)
      const [card] = kit.present.shown(SAM)
      assert.strictEqual((yield* kit.present.press(card!.id, "done", { device: ROBIN })).ok, false)
      assert.strictEqual((yield* theRow(kit)).value.state, "open")
      assert.deepStrictEqual(yield* kit.present.press(card!.id, "done", { device: SAM }), { ok: true, say: "Done." })
      assert.strictEqual((yield* theRow(kit)).value.state, "done")
      assert.deepStrictEqual((yield* kit.notify.all).map((x: any) => x.state), ["resolved"])
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      const changed = kit.events.filter((e: any) => e.type === "reminders.reminders.changed")
      assert.deepStrictEqual((changed.at(-1) as any)?.actor, { kind: "ui", deviceId: SAM })
    }))

  it.effect("the typed actions answer the one that rang here; none rang, or two did, it says so", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      assert.deepStrictEqual(yield* kit.action("ringing_done", {}, { device: SAM }), { ok: true, say: "No reminder is waiting for an answer on this device. Say which one you mean." })
      yield* ring(kit, "one")
      assert.deepStrictEqual(yield* kit.action("ringing_snooze", { for: "ten minutes" }, { device: SAM }), { ok: true, say: "I'll remind you again in 10 minutes." })
      assert.strictEqual((yield* openNotes(kit)).length, 0)
      yield* kit.advance(11 * MIN)
      yield* kit.tool("reminders_set", { text: "two", when: "in a minute", scope: "household" }, { device: SAM })
      yield* kit.advance(2 * MIN)
      assert.strictEqual((yield* openNotes(kit)).length, 2)
      assert.deepStrictEqual(yield* kit.action("ringing_done", {}, { device: SAM }), { ok: true, say: "More than one reminder is waiting here. Say which one you mean." })
      assert.deepStrictEqual(yield* kit.action("ringing_done", {}, { device: ROBIN }), { ok: true, say: "No reminder is waiting for an answer on this device. Say which one you mean." })
    }))

  it.effect("two snoozes at once: one snooze, one job", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* ring(kit)
      const row = yield* theRow(kit)
      yield* Effect.all([kit.action("ringing_snooze", {}, { device: SAM }), kit.action("ringing_snooze", {}, { device: SAM })], { concurrency: 2 })
      assert.strictEqual((yield* jobOf(kit, row.id)).length, 1)
      assert.strictEqual((yield* liveJobs(kit)).filter((j) => j.handler === "due").length, 1)
    }))

  it.effect("done on one that is finished says so, and a press on it is refused", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const n = yield* ring(kit)
      yield* kit.notify.press(n.id, "done", { device: SAM })
      assert.strictEqual((yield* kit.notify.press(n.id, "snooze", { device: SAM })).ok, false)
      assert.strictEqual(spoken(yield* kit.tool("reminders_done", { which: "mum" }, { device: SAM })), "That one was already done.")
      assert.strictEqual(spoken(yield* kit.tool("reminders_done", { which: "mum" }, { device: SAM })), "I don't have a reminder called mum.")
    }))
})

describe("cleanup is owed work", () => {
  it.effect("a cancel whose take-down fails says so; the row keeps it owed; a second cancel finishes it", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* ring(kit)
      faults.resolveFails = 1
      const first = yield* kit.tool("reminders_cancel", { which: "mum" }, { device: SAM })
      assert.strictEqual(spoken(first), "Cancelled: call mum. Its ring is still being taken down; I'll keep trying.")
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.state, "cancelled")
      assert.strictEqual(row.value.stop?.attempts, 1)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      const second = yield* kit.tool("reminders_cancel", { which: "mum" }, { device: SAM })
      assert.strictEqual(spoken(second), "Cancelled: call mum.")
      assert.deepStrictEqual(yield* openNotes(kit), [])
      assert.isUndefined((yield* theRow(kit)).value.stop)
      assert.deepStrictEqual(yield* jobOf(kit, row.id), [])
    }))

  it.effect("…or the reminder's job takes it down a few seconds later; done and a card that would not go are retried the same way", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* ring(kit)
      faults.resolveFails = 1
      faults.dismissFails = 1
      assert.strictEqual(spoken(yield* kit.tool("reminders_done", { which: "mum" }, { device: SAM })), "Done. Its ring is still being taken down; I'll keep trying.")
      const row = yield* theRow(kit)
      assert.deepStrictEqual(row.value.stop?.card, true)
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, row.value.stop?.tryAt)
      yield* kit.advance(6_000)
      yield* kit.present.settle
      assert.deepStrictEqual(yield* openNotes(kit), [])
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      assert.isUndefined((yield* theRow(kit)).value.stop)
    }))

  it.effect("a take-down that keeps failing is given up after its tries, with a Health issue", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* ring(kit)
      faults.resolveFails = 100
      yield* kit.tool("reminders_cancel", { which: "mum" }, { device: SAM })
      yield* kit.advance(10 * MIN)
      const row = yield* theRow(kit)
      assert.isUndefined(row.value.stop)
      const problem = (yield* kit.jobs).find((j) => j.handler === "problem")
      assert.include(problem?.lastError ?? "", `after ${MAX_STOP_TRIES} tries`)
      assert.deepStrictEqual(yield* jobOf(kit, row.id), [])
    }))
})

describe("the job limit, through the real scheduler", () => {
  it.effect("one daily reminder and 198 one-offs (200 live jobs with the clean-up): failing sends never cost the series", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "daily", when: "every day at 8 pm", scope: "household" }, { device: SAM })
      for (let i = 0; i < 198; i++) yield* kit.tool("reminders_set", { text: `later ${i}`, when: "in 50 hours", scope: "household" }, { device: SAM })
      assert.strictEqual((yield* liveJobs(kit)).length, 200)
      const daily = (yield* rowByText(kit, "daily"))!
      const first = daily.value.dueAt!
      faults.sendFails = 1_000
      yield* kit.advance(first - (yield* kit.now) + H)
      const row = (yield* rowByText(kit, "daily"))!
      assert.strictEqual(row.value.dropped?.why, "failed")
      assert.strictEqual(row.value.dueAt, first + DAY)
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, first + DAY)
      assert.strictEqual((yield* liveJobs(kit)).length, 200)
      // At the limit the report of the given-up delivery cannot be added (the row records it); the series goes on.
      assert.isUndefined((yield* kit.jobs).find((j) => j.handler === "problem"))
      faults.sendFails = 0
      yield* kit.advance(DAY - H + MIN)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      assert.strictEqual((yield* rowByText(kit, "daily"))?.value.ring?.at, first + DAY)
    }))
})

describe("jobs", () => {
  it.effect("a reminder called off while its job is delivering: the call waits its turn, then takes the ring down and nothing is left", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in ten minutes", scope: "household" }, { device: SAM })
      faults.gate = yield* Deferred.make<void>()
      faults.entered = yield* Deferred.make<void>()
      const running = yield* Effect.forkChild(kit.advance(10 * MIN + 1_000))
      yield* Deferred.await(faults.entered)
      const cancelling = yield* Effect.forkChild(kit.tool("reminders_cancel", { which: "bins" }, { device: SAM }))
      yield* Effect.yieldNow
      assert.strictEqual((yield* theRow(kit)).value.state, "open")
      yield* Deferred.succeed(faults.gate, undefined)
      yield* Fiber.join(running)
      const cancelled = yield* Fiber.join(cancelling)
      assert.deepStrictEqual(cancelled.value, { spoken: "Cancelled: bins." })
      yield* kit.present.settle
      assert.strictEqual((yield* theRow(kit)).value.state, "cancelled")
      assert.deepStrictEqual((yield* kit.notify.all).map((n) => n.state), ["resolved"])
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      assert.deepStrictEqual((yield* liveJobs(kit)).filter((j) => j.handler !== "tidy"), [])
    }))

  it.effect("a job that runs for a reminder changed, cancelled or finished meanwhile is entered and does nothing", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      const store = kit.moduleStore().collection(reminders)
      const cases = [
        ["cancelled", (v: any) => ({ ...v, state: "cancelled", endedAt: 1 })],
        ["done", (v: any) => ({ ...v, state: "done", endedAt: 1 })],
        ["moved", (v: any) => ({ ...v, dueAt: v.dueAt + H })]
      ] as const
      for (const [name, change] of cases) {
        yield* kit.tool("reminders_set", { text: name, when: "in ten minutes", scope: "household" }, { device: SAM })
        const row = (yield* rowByText(kit, name))!
        const [job] = yield* jobOf(kit, row.id)
        assert.strictEqual(job?.state, "scheduled", name)
        // Changed underneath the job (as if while it waited for its turn): the job stays planned for the old moment.
        yield* store.update(row.id, change as any)
        const entered = faults.runs.due ?? 0
        yield* kit.runJob(job!.id)
        assert.strictEqual(faults.runs.due, entered + 1, name)
        assert.deepStrictEqual(yield* kit.notify.all, [], name)
        if (name === "moved") assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, row.value.dueAt! + H)
      }
    }))

  it.effect("every handler run again does only what is owed: delivery, clean-up and the buttons", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* ring(kit, "bins", "in ten minutes", "household")
      const row = yield* theRow(kit)
      const before = yield* allRows(kit)
      // The delivery's handler again, for the same row: nothing is owed, nothing is sent or written.
      yield* (faults.handlers["job:due"].run({ id: row.id }, { jobId: "replay", dueAt: row.value.ring!.at, lateMs: 0, attempt: 1 }) as Effect.Effect<unknown>)
      yield* (faults.handlers["job:due"].run({ id: row.id }, { jobId: "replay", dueAt: row.value.ring!.at, lateMs: DAY, attempt: 2 }) as Effect.Effect<unknown>)
      assert.strictEqual((yield* kit.notify.all).length, 1)
      assert.deepStrictEqual(yield* allRows(kit), before)
      // A card's done twice: done once, then "already done".
      const [card] = kit.present.shown(SAM)
      const press = { presentationId: card!.id, key: `due:${row.id}:${row.value.ring!.at}`, deviceId: SAM, action: "done" }
      assert.deepStrictEqual(yield* (faults.handlers["present:reminders"].run(press) as Effect.Effect<unknown>), { say: "Done." })
      assert.deepStrictEqual(yield* (faults.handlers["present:reminders"].run(press) as Effect.Effect<unknown>), { say: "That one was already done." })
      assert.strictEqual((yield* theRow(kit)).value.state, "done")
      // The clean-up twice: the same rows.
      const tidy = (yield* kit.jobs).find((j) => j.handler === "tidy")!
      yield* kit.runJob(tidy.id)
      const once = yield* allRows(kit)
      yield* kit.runJob((yield* kit.jobs).find((j) => j.handler === "tidy" && j.state === "scheduled")!.id)
      assert.deepStrictEqual((yield* allRows(kit)).map((r) => [r.id, r.value.state]), once.map((r) => [r.id, r.value.state]))
    }))

  it.effect("a write made by a job carries the job as its actor", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      const row = yield* theRow(kit)
      const [job] = yield* jobOf(kit, row.id)
      yield* kit.advance(2 * MIN)
      const events = kit.events.filter((e: any) => e.type === "reminders.reminders.changed")
      assert.deepStrictEqual((events.at(-1) as any)?.actor, { kind: "job", jobId: job!.id })
    }))

  it.effect("the daily clean-up ends rings unanswered for a week and removes finished rows after the kept days, paging past rows it cannot finish", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, { settings: { keepDays: 3 } })
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      const old = now - 10 * DAY
      // Fourteen open rows it cannot finish come first (rings delivered yesterday), then one delivered ten days ago.
      // (A millisecond apart: rows without a next moment are read in the order they were made.)
      for (let i = 0; i < 14; i++) {
        yield* store.insert({ text: `recent ${i}`, whose: "household", state: "open", ring: { at: old + i, deliveredAt: now - DAY } })
        yield* kit.advance(1)
      }
      yield* store.insert({ text: "unanswered", whose: "household", state: "open", ring: { at: old, deliveredAt: old } })
      yield* store.insert({ text: "not yet", whose: "household", state: "open", dueAt: now + DAY, nextAt: now + DAY })
      // Fourteen old finished rows whose cleanup is still owed come first, then 30 old ones and one fresh.
      for (let i = 0; i < 14; i++) yield* store.insert({ text: `stopping ${i}`, whose: "household", state: "done", endedAt: now - 9 * DAY + i, stop: { notes: [], card: true, attempts: 1, tryAt: now + DAY }, nextAt: now + DAY })
      for (let i = 0; i < 30; i++) yield* store.insert({ text: `done ${i}`, whose: "household", state: "done", endedAt: now - 5 * DAY + i })
      yield* store.insert({ text: "fresh done", whose: "household", state: "done", endedAt: now - DAY })
      yield* store.insert({ text: "old cancelled", whose: "household", state: "cancelled", endedAt: now - 9 * DAY })
      const tidy = (yield* kit.jobs).find((j: any) => j.handler === "tidy")!
      assert.strictEqual(tidy.cron, "0 4 * * *")
      yield* kit.runJob(tidy.id)
      const left = yield* allRows(kit)
      const names = left.map((r) => r.value.text)
      assert.strictEqual(left.find((r) => r.value.text === "unanswered")?.value.state, "lapsed")
      assert.include(names, "fresh done")
      assert.include(names, "not yet")
      assert.include(names, "recent 13")
      assert.include(names, "stopping 13")
      assert.notInclude(names, "done 29")
      assert.notInclude(names, "old cancelled")
      assert.strictEqual(left.length, 14 + 1 + 1 + 14 + 1)
    }))
})

describe("privacy at delivery", () => {
  it.effect("a personal reminder stored on a shared device whose default person changed before delivery does not ring or show there", () =>
    Effect.gen(function*() {
      const devices = [
        { id: SAM, name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-robin" },
        ...DEFAULT_TEST_HOUSEHOLD.devices.filter((d) => d.id !== SAM),
        { id: "sams-phone", name: "Sam's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-sam" }
      ]
      const kit = yield* startTestModule(remindersModule, { household: { devices } })
      const now = yield* kit.now
      // Set by Sam on the kitchen display while it was Sam's; now its default person is Robin.
      yield* kit.moduleStore().collection(reminders).insert({ text: "Sam's secret", whose: "personal", owner: "p-sam", state: "open", deviceId: SAM, dueAt: now + 10 * MIN, nextAt: now + 10 * MIN })
      yield* kit.tool("reminders_change", { which: "secret", text: "Sam's secret" }, { device: "sams-phone" })
      yield* kit.advance(11 * MIN)
      yield* kit.present.settle
      assert.isTrue(kit.notify.decisions.some((d: any) => d.deviceId === SAM && d.decision.deliver === false))
      assert.isFalse(kit.notify.decisions.some((d: any) => d.deviceId === SAM && d.decision.deliver))
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      assert.notInclude(JSON.stringify(kit.notify.messages.filter((m: any) => m.deviceId === SAM)), "secret")
    }))

  it.effect("a personal reminder set on a public screen: that screen is the target and it is refused there", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, {
        household: { devices: [...DEFAULT_TEST_HOUSEHOLD.devices, { id: "lobby-screen", name: "Lobby", room: "Lobby", privacy: "public", defaultPerson: "p-sam" }] }
      })
      yield* kit.tool("reminders_set", { text: "dentist", when: "in a minute", scope: "me" }, { device: "lobby-screen" })
      yield* kit.advance(2 * MIN)
      yield* kit.present.settle
      const decisions = kit.notify.decisions.filter((d: any) => d.deviceId === "lobby-screen")
      assert.isTrue(decisions.length > 0)
      assert.isTrue(decisions.every((d: any) => !d.decision.deliver))
      assert.deepStrictEqual(kit.present.shown("lobby-screen"), [])
      assert.isFalse(kit.notify.decisions.some((d: any) => d.decision.deliver))
    }))
})
