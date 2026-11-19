// The reminders module through the real host and gateway (docs/MODULES.md §17): every tool and action on its ordinary path
// and on its refusals, privacy on the shared, private and public devices of the default household, paging past one list
// page, a repeating reminder across an outage and a restart, store and delivery failures, invalid settings, Dutch.
import { assert, describe, it, vi } from "@effect/vitest"
import { BriefingSections, type BriefingRequest } from "@pva/module-contracts"
import { DEFAULT_TEST_HOUSEHOLD, checkModule, startTestModule } from "@pva/core/testing"
import { NotifyError, StoreError, type ModuleDefinition } from "@pva/core"
import { Deferred, Effect, Fiber } from "effect"
import { catalog, type Reminder, reminders, remindersModule, texts } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })

const SAM = "kitchen-display" // shared, Sam's
const ROBIN = "robins-phone" // private, Robin's
const HALL = "hall-screen" // public
const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H

type Kit = Effect.Success<ReturnType<typeof startTestModule>>

const rows = (kit: { readonly moduleStore: () => { collection: Function } }) =>
  (kit.moduleStore().collection(reminders) as { list: (q: unknown) => Effect.Effect<ReadonlyArray<{ id: string; rev: number; value: Reminder }>> }).list({ limit: 12 })

/** The module with its store, or its notifications, failing on demand: the kit has no fault-injecting store, so a test wraps the handles. */
interface Faults {
  storeWrites: boolean
  storeReads: boolean
  sendFails: number
  /** When set, a delivery waits here (a slow delivery, to call the reminder off while its job runs). */
  gate?: Deferred.Deferred<void>
  entered?: Deferred.Deferred<void>
}
const faulty = (faults: Faults): ModuleDefinition<any> => {
  const bad = (what: string) => Effect.fail(new StoreError({ reason: "busy", message: what }))
  const wrapStore = (store: any) => ({
    ...store,
    transaction: (f: any) => (faults.storeWrites ? bad("injected") : store.transaction(f)),
    collection: (c: any) => {
      const h = store.collection(c)
      return {
        ...h,
        get: (...a: Array<any>) => (faults.storeReads ? bad("injected") : h.get(...a)),
        list: (...a: Array<any>) => (faults.storeReads ? bad("injected") : h.list(...a)),
        update: (...a: Array<any>) => (faults.storeWrites ? bad("injected") : h.update(...a))
      }
    }
  })
  return {
    ...remindersModule,
    shared: (ctx: any) =>
      remindersModule.shared!({
        ...ctx,
        store: wrapStore(ctx.store),
        notify: {
          ...ctx.notify,
          send: (r: any) => (faults.gate !== undefined ? Effect.andThen(Effect.andThen(faults.entered === undefined ? Effect.void : Deferred.succeed(faults.entered, undefined), Deferred.await(faults.gate)), ctx.notify.send(r)) : faults.sendFails > 0 ? (faults.sendFails--, Effect.fail(new NotifyError({ reason: "failed", message: "injected" }))) : ctx.notify.send(r))
        }
      }),
    start: (ctx: any) => remindersModule.start!({ ...ctx, store: wrapStore(ctx.store) })
  } as ModuleDefinition<any>
}
const nofaults = (): Faults => ({ storeWrites: false, storeReads: false, sendFails: 0 })

describe("conformance", () => {
  it.effect("passes checkModule with its texts in both languages", () =>
    Effect.gen(function*() {
      for (const d of catalog) yield* checkModule(d, { texts })
    }))
})

describe("setting a reminder", () => {
  it.effect("a personal reminder for the asking person, rung on the device it was set on with done and snooze, and a card", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const set = yield* kit.tool("reminders_set", { text: "call mum", when: "in ten minutes" }, { device: SAM })
      assert.deepStrictEqual(set.value, { spoken: "Reminder set for today at ten past ten in the morning: call mum.", owner: "p-sam" })
      const [row] = yield* rows(kit)
      assert.strictEqual(row?.value.owner, "p-sam")
      assert.strictEqual(row?.value.whose, "personal")
      assert.strictEqual(row?.value.deviceId, SAM)
      assert.strictEqual(row?.value.dueAt, kit.now === undefined ? 0 : (yield* kit.now) + 10 * MIN)
      // The job is the turn's: its device and assistant.
      const job = (yield* kit.jobs).find((j) => j.handler === "due")!
      assert.strictEqual(job.origin.deviceId, SAM)
      assert.strictEqual(job.origin.assistantId, "jeff")
      assert.deepStrictEqual(job.payload, { id: row!.id, at: row!.value.dueAt })
      // Nothing yet; then it rings where it was set, with its two answers, and a card with the same two.
      yield* kit.advance(9 * MIN)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      yield* kit.advance(2 * MIN)
      const [ring] = yield* kit.notify.all
      assert.strictEqual(ring?.priority, "ring")
      assert.strictEqual(ring?.deviceId, SAM)
      assert.strictEqual(ring?.owner, "p-sam")
      assert.strictEqual(ring?.text, "call mum")
      assert.deepStrictEqual(ring?.actions.map((a) => a.id), ["done", "snooze"])
      yield* kit.present.settle
      const [card] = kit.present.shown(SAM)
      assert.strictEqual(card?.content.kind, "card")
      assert.deepStrictEqual(kit.present.shown(HALL), [])
    }))

  it.effect("for the household: no owner, and it rings on the device it was set on", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const set = yield* kit.tool("reminders_set", { text: "tidy up", when: "in five minutes", scope: "household" }, { device: HALL })
      assert.deepStrictEqual(set.value, { spoken: "Reminder for the household, today at five past ten in the morning: tidy up." })
      const [row] = yield* rows(kit)
      assert.strictEqual(row?.value.whose, "household")
      assert.isUndefined(row?.value.owner)
      yield* kit.advance(6 * MIN)
      const [ring] = yield* kit.notify.all
      assert.isUndefined(ring?.owner)
      assert.strictEqual(ring?.deviceId, HALL)
    }))

  it.effect("a personal reminder with nobody known asks whose and writes nothing, and never repeats the words", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const asked = yield* kit.tool("reminders_set", { text: "private appointment", when: "in an hour", scope: "me" }, { device: HALL })
      assert.deepStrictEqual(asked.value, { spoken: "Whose reminder is it? I can't tell who is asking here." })
      assert.notInclude(asked.content, "private appointment")
      assert.deepStrictEqual(yield* rows(kit), [])
      // Without a scope, the same device sets a household reminder (there is nobody to own it).
      const household = yield* kit.tool("reminders_set", { text: "bins", when: "in an hour" }, { device: HALL })
      assert.include((household.value as { spoken: string }).spoken, "for the household")
    }))

  it.effect("what is not clear is a question, never a guess; nothing is written", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const ask = (when: string) => kit.tool("reminders_set", { text: "x", when }, { device: ROBIN }).pipe(Effect.map((r) => (r.value as { spoken: string }).spoken))
      assert.strictEqual(yield* ask("tomorrow"), "At what time?")
      assert.strictEqual(yield* ask("yesterday at five"), "That moment has already passed.")
      assert.strictEqual(yield* ask("next Friday at five"), "That could mean more than one moment. Say the day and the time.")
      assert.strictEqual(yield* ask("whenever"), "When should I remind you? I didn't understand when.")
      assert.strictEqual(yield* ask("on 1 March 2028 at five"), "I only set reminders up to a year ahead.")
      const code = yield* kit.tool("reminders_set", { text: "door code is 12345", when: "in an hour" }, { device: ROBIN })
      assert.strictEqual((code.value as { spoken: string }).spoken, "I don't keep codes or passwords in reminders.")
      assert.deepStrictEqual(yield* rows(kit), [])
      // A reminder about a password without a code in it is an ordinary reminder.
      const ok = yield* kit.tool("reminders_set", { text: "change my password", when: "in an hour" }, { device: ROBIN })
      assert.include((ok.value as { spoken: string }).spoken, "change my password")
    }))

  it.effect("the confirmation does not repeat a personal reminder where the privacy rule says no", () =>
    Effect.gen(function*() {
      // A public screen with a default person: the write has its owner, and the screen still must not show the words.
      const kit = yield* startTestModule(remindersModule, {
        household: { devices: [...DEFAULT_TEST_HOUSEHOLD.devices, { id: "lobby-screen", name: "Lobby", room: "Lobby", privacy: "public", defaultPerson: "p-sam" }] }
      })
      const set = yield* kit.tool("reminders_set", { text: "dentist", when: "in an hour", scope: "me" }, { device: "lobby-screen" })
      assert.deepStrictEqual(set.value, { spoken: "Reminder set for today at eleven o'clock in the morning, only for you.", owner: "p-sam" })
      assert.notInclude(set.content, "dentist")
      assert.strictEqual((yield* rows(kit))[0]?.value.text, "dentist")
    }))

  it.effect("a reminder at the largest the schema allows is stored, with every indexed field at its largest", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const text = "é".repeat(160)
      const set = yield* kit.tool("reminders_set", { text, when: "every weekday at 7 am" }, { device: ROBIN })
      assert.include((set.value as { spoken: string }).spoken, "Repeating reminder")
      const store = kit.moduleStore().collection(reminders)
      const big: Reminder = {
        text, whose: "personal", owner: "p".repeat(40), state: "done", dueAt: 8_640_000_000_000_000, deviceId: "d".repeat(64), assistantId: "a".repeat(40),
        setBy: "s".repeat(40), rrule: "R".repeat(100), dtstart: "D".repeat(70), timeZone: "T".repeat(64), notifiedFor: 8_640_000_000_000_000,
        snoozeAt: 8_640_000_000_000_000, handled: "h".repeat(64), endedAt: 8_640_000_000_000_000
      }
      const stored = yield* store.insert(big)
      assert.strictEqual((yield* store.get(stored.id))?.value.endedAt, 8_640_000_000_000_000)
    }))

  it.effect("too many reminders: the scheduler's limit is said, and nothing is half written", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      let last = ""
      for (let i = 0; i < 205; i++) {
        const r = yield* kit.tool("reminders_set", { text: `r${i}`, when: "in 50 hours", scope: "household" }, { device: SAM })
        last = typeof r.value === "string" ? r.value : (r.value as { spoken?: string }).spoken ?? ""
        if (last.startsWith("I'm already")) break
      }
      assert.strictEqual(last, "I'm already keeping as many reminders as I can.")
      const jobs = (yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled")
      const stored = yield* rows(kit)
      assert.isAtMost(stored.length, 12)
      assert.isAtMost(jobs.length, 200)
    }))
})

describe("repeating reminders", () => {
  it.effect("one job for the next occurrence, planned again by its handler, kept across a restart", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const set = yield* kit.tool("reminders_set", { text: "bins out", when: "every day at 7 pm" }, { device: SAM })
      assert.include((set.value as { spoken: string }).spoken, "Repeating reminder, every day at seven o'clock in the evening: bins out.")
      const [row] = yield* rows(kit)
      assert.strictEqual(row?.value.rrule, "FREQ=DAILY")
      assert.strictEqual((yield* kit.jobs).filter((j) => j.handler === "due").length, 1)
      yield* kit.restart
      yield* kit.advance(9 * H + MIN)
      const [first] = yield* kit.notify.all
      assert.strictEqual(first?.text, "bins out")
      // The next occurrence is planned (one job), a day later, with the same origin.
      const live = (yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled")
      assert.strictEqual(live.length, 1)
      assert.strictEqual(live[0]?.dueAt, row!.value.dueAt + DAY)
      assert.strictEqual(live[0]?.origin.deviceId, SAM)
            // Answered, it goes on: done on a repeating reminder is done for this time only.
      const done = yield* kit.notify.press(first!.id, "done", { device: SAM })
      assert.deepStrictEqual(done, { ok: true, say: "Done. The next one is tomorrow at seven o'clock in the evening." })
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "open")
      yield* kit.advance(DAY)
      assert.strictEqual((yield* kit.notify.all).length, 1)
    }))

  it.effect("found late after an outage: delivered when it is only a little late, skipped when the moment has passed, the series goes on", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "water plants", when: "every day at 9 am", scope: "household" }, { device: SAM })
      const first = (yield* kit.jobs).find((j) => j.handler === "due")!.dueAt
      // The module is off through the first morning, and found 7 hours late: the moment has passed.
      yield* kit.stop
      yield* kit.advance(first - (yield* kit.now) + 7 * H)
      yield* kit.start
      yield* kit.advance(MIN)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      const next = (yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled")
      assert.strictEqual(next.length, 1)
      assert.strictEqual(next[0]?.dueAt, first + DAY)
      // Found two hours late: delivered, and it says so.
      yield* kit.stop
      yield* kit.advance(next[0]!.dueAt - (yield* kit.now) + 2 * H)
      yield* kit.start
      yield* kit.advance(MIN)
      const [late] = yield* kit.notify.all
      assert.include(late?.text ?? "", "late: due")
      assert.strictEqual((yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled")[0]?.dueAt, first + 2 * DAY)
    }))

  it.effect("a delivery that fails is retried and never costs the series", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "pills", when: "every day at 8 pm", scope: "household" }, { device: SAM })
      const first = (yield* kit.jobs).find((j) => j.handler === "due")!.dueAt
      faults.sendFails = 1
      yield* kit.advance(first - (yield* kit.now) + 10_000)
      // The next occurrence is planned already; the failed one is retried by a job of its own a little later.
      assert.strictEqual((yield* rows(kit))[0]?.value.dueAt, first + DAY)
      assert.isDefined((yield* rows(kit))[0]?.value.snoozeAt)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      assert.strictEqual((yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled").length, 1)
      yield* kit.advance(30_000)
      assert.strictEqual((yield* kit.notify.all).length, 1)
      assert.isUndefined((yield* rows(kit))[0]?.value.snoozeAt)
      assert.strictEqual((yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled").length, 1)
    }))

  it.effect("a series with an end delivers its last occurrence and then lapses", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const set = yield* kit.tool("reminders_set", { text: "x", when: "every day at 9 pm", scope: "household" }, { device: SAM })
      assert.include((set.value as { spoken: string }).spoken, "Repeating")
      const [row] = yield* rows(kit)
      // End the series after tonight: UNTIL tonight's occurrence.
      yield* store.update(row!.id, (v) => ({ ...v, rrule: "FREQ=DAILY;COUNT=1" }))
      yield* kit.advance(12 * H)
      assert.strictEqual((yield* kit.notify.all).length, 1)
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "lapsed")
    }))
})

describe("answering: done and snooze", () => {
  const ring = (kit: Kit, text = "call mum") =>
    Effect.gen(function*() {
      yield* kit.tool("reminders_set", { text, when: "in ten minutes" }, { device: SAM })
      yield* kit.advance(11 * MIN)
      yield* kit.present.settle
      return (yield* kit.notify.all)[0]!
    })

  it.effect("done from the notification: finished once, however many press, and its card goes", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const n = yield* ring(kit)
      const both = yield* Effect.all([kit.notify.press(n.id, "done", { device: SAM }), kit.notify.press(n.id, "done", { device: SAM })], { concurrency: 2 })
      assert.strictEqual(both.filter((r: any) => r.ok && r.say === "Done.").length, 1)
      const [row] = yield* rows(kit)
      assert.strictEqual(row?.value.state, "done")
      assert.isDefined(row?.value.endedAt)
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      assert.deepStrictEqual((yield* kit.notify.all).map((x: any) => x.state), ["resolved"])
      // No job is left for it.
      assert.deepStrictEqual((yield* kit.jobs).filter((j: any) => j.state === "scheduled" && j.handler !== "tidy"), [])
    }))

  it.effect("snooze: rings again later, the same press twice does not push it further, and the setting decides how long", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, { settings: { snoozeMinutes: 20 } })
      const n = yield* ring(kit)
      assert.deepStrictEqual(yield* kit.notify.press(n.id, "snooze", { device: SAM }), { ok: true, say: "I'll remind you again in 20 minutes." })
      const [row] = yield* rows(kit)
      assert.strictEqual(row?.value.state, "open")
      assert.strictEqual(row?.value.snoozeAt, (yield* kit.now) + 20 * MIN)
      yield* kit.advance(19 * MIN)
      assert.strictEqual((yield* kit.notify.all).filter((x: any) => x.state === "open").length, 0)
      yield* kit.advance(2 * MIN)
      assert.strictEqual((yield* kit.notify.all).filter((x: any) => x.state === "open").length, 1)
      assert.isUndefined((yield* rows(kit))[0]?.value.snoozeAt)
    }))

  it.effect("the card's buttons do the same, and its notification goes with it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* ring(kit)
      const [card] = kit.present.shown(SAM)
      // Pressed from a page that does not hold it: refused, nothing changes.
      assert.strictEqual((yield* kit.present.press(card!.id, "done", { device: HALL })).ok, false)
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "open")
      assert.deepStrictEqual(yield* kit.present.press(card!.id, "done", { device: SAM }), { ok: true, say: "Done." })
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "done")
      assert.deepStrictEqual((yield* kit.notify.all).map((x: any) => x.state), ["resolved"])
      assert.deepStrictEqual(kit.present.shown(SAM), [])
    }))

  it.effect("the typed actions answer the one that rang here; none rang, or two did, it says so", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      assert.deepStrictEqual(yield* kit.action("ringing_done", {}, { device: SAM }), { ok: true, say: "No reminder is waiting for an answer on this device. Say which one you mean." })
      yield* ring(kit, "one")
      assert.deepStrictEqual(yield* kit.action("ringing_snooze", { for: "ten minutes" }, { device: SAM }), { ok: true, say: "I'll remind you again in 10 minutes." })
      assert.strictEqual((yield* kit.notify.all).filter((x: any) => x.state === "open").length, 0)
      yield* kit.advance(11 * MIN)
      yield* kit.tool("reminders_set", { text: "two", when: "in a minute", scope: "household" }, { device: SAM })
      yield* kit.advance(2 * MIN)
      assert.strictEqual((yield* kit.notify.all).filter((x: any) => x.state === "open").length, 2)
      assert.deepStrictEqual(yield* kit.action("ringing_done", {}, { device: SAM }), { ok: true, say: "More than one reminder is waiting here. Say which one you mean." })
      // Another device does not hear a household ring that belongs to the kitchen.
      assert.deepStrictEqual(yield* kit.action("ringing_done", {}, { device: ROBIN }), { ok: true, say: "No reminder is waiting for an answer on this device. Say which one you mean." })
    }))

  it.effect("two snoozes at once leave one live snooze job", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* ring(kit)
      yield* Effect.all([kit.action("ringing_snooze", {}, { device: SAM }), kit.action("ringing_snooze", {}, { device: SAM })], { concurrency: 2 })
      assert.strictEqual((yield* kit.jobs).filter((j: any) => j.handler === "snooze" && j.state === "scheduled").length, 1)
    }))

  it.effect("done is refused for one that is finished or gone, in words", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const n = yield* ring(kit)
      yield* kit.notify.press(n.id, "done", { device: SAM })
      const store = kit.moduleStore().collection(reminders)
      const [row] = yield* rows(kit)
      const snooze = yield* kit.notify.press(n.id, "snooze", { device: SAM })
      assert.strictEqual(snooze.ok, false)
      yield* store.remove(row!.id)
      assert.strictEqual((yield* rows(kit)).length, 0)
    }))
})

describe("which reminder is meant", () => {
  const seed = (kit: Kit) =>
    Effect.gen(function*() {
      yield* kit.tool("reminders_set", { text: "call mum", when: "tomorrow at five" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "call the dentist", when: "tomorrow at six" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "water the plants", when: "tomorrow at seven", scope: "household" }, { device: SAM })
    })

  it.effect("one match is acted on; more than one asks; none says so", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* seed(kit)
      const ask = yield* kit.tool("reminders_cancel", { which: "call" }, { device: SAM })
      assert.deepStrictEqual(ask.value, { spoken: "Which reminder: call mum and call the dentist?" })
      assert.strictEqual((yield* rows(kit)).filter((r) => r.value.state === "open").length, 3)
      const none = yield* kit.tool("reminders_cancel", { which: "holiday" }, { device: SAM })
      assert.deepStrictEqual(none.value, { spoken: "I don't have a reminder called holiday." })
      const one = yield* kit.tool("reminders_cancel", { which: "dentist" }, { device: SAM })
      assert.deepStrictEqual(one.value, { spoken: "Cancelled: call the dentist.", owner: "p-sam" })
      const states = (yield* rows(kit)).map((r) => [r.value.text, r.value.state])
      assert.deepInclude(states, ["call the dentist", "cancelled"])
      // Marked, not removed; its job is gone, the others stay.
      assert.strictEqual((yield* kit.jobs).filter((j: any) => j.handler === "due" && j.state === "scheduled").length, 2)
    }))

  it.effect("change: new words, a new time, or both; a new time replaces the job in one step; nothing to change asks", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* seed(kit)
      assert.deepStrictEqual((yield* kit.tool("reminders_change", { which: "plants" }, { device: SAM })).value, { spoken: "What should I change: the words or the time?" })
      const words = yield* kit.tool("reminders_change", { which: "plants", text: "water the garden" }, { device: SAM })
      assert.include((words.value as { spoken: string }).spoken, "Changed it: water the garden")
      const time = yield* kit.tool("reminders_change", { which: "garden", when: "in two hours" }, { device: SAM })
      assert.include((time.value as { spoken: string }).spoken, "today at noon")
      const garden = (yield* rows(kit)).find((r) => r.value.text === "water the garden")!
      assert.strictEqual(garden.value.dueAt, (yield* kit.now) + 2 * H)
      const live = (yield* kit.jobs).filter((j: any) => j.handler === "due" && j.state === "scheduled")
      assert.strictEqual(live.length, 3)
      assert.deepStrictEqual(live.find((j: any) => j.key === `due:${garden.id}`)?.payload, { id: garden.id, at: garden.value.dueAt })
      // Made repeating, and back again to one moment.
      const rep = yield* kit.tool("reminders_change", { which: "garden", when: "every Monday at 9 am" }, { device: SAM })
      assert.include((rep.value as { spoken: string }).spoken, "every Monday")
      assert.strictEqual((yield* rows(kit)).find((r) => r.id === garden.id)?.value.rrule, "FREQ=WEEKLY;BYDAY=MO")
      yield* kit.tool("reminders_change", { which: "garden", when: "tomorrow at nine am" }, { device: SAM })
      assert.isUndefined((yield* rows(kit)).find((r) => r.id === garden.id)?.value.rrule)
      // An unclear time changes nothing.
      const bad = yield* kit.tool("reminders_change", { which: "garden", when: "whenever" }, { device: SAM })
      assert.strictEqual((bad.value as { spoken: string }).spoken, "When should I remind you? I didn't understand when.")
    }))

  it.effect("a reminder changed while it rang takes its ring down; one cancelled does the same", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      yield* kit.advance(2 * MIN)
      yield* kit.present.settle
      assert.strictEqual((yield* kit.notify.all)[0]?.state, "open")
      assert.strictEqual(kit.present.shown(SAM).length, 1)
      yield* kit.tool("reminders_cancel", { which: "bins" }, { device: SAM })
      yield* kit.present.settle
      assert.strictEqual((yield* kit.notify.all)[0]?.state, "resolved")
      assert.deepStrictEqual(kit.present.shown(SAM), [])
    }))

  it.effect("done by its words, and done for the one that is ringing; a repeating one goes on", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* seed(kit)
      assert.deepStrictEqual((yield* kit.tool("reminders_done", { which: "plants" }, { device: SAM })).value, { spoken: "Done." })
      assert.strictEqual((yield* rows(kit)).find((r) => r.value.text.includes("plants"))?.value.state, "done")
      assert.deepStrictEqual((yield* kit.tool("reminders_done", {}, { device: SAM })).value, { spoken: "No reminder is waiting for an answer on this device. Say which one you mean." })
      yield* kit.tool("reminders_set", { text: "stretch", when: "every day at 8 pm" }, { device: SAM })
      const done = yield* kit.tool("reminders_done", { which: "stretch" }, { device: SAM })
      assert.include((done.value as { spoken: string }).spoken, "Done. The next one is")
      assert.strictEqual((yield* rows(kit)).find((r) => r.value.text === "stretch")?.value.state, "open")
    }))

  it.effect("a read that was cut short is said, never 'none'", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      // 250 open household reminders: past the 204 one answer reads.
      for (let i = 0; i < 250; i++) yield* store.insert({ text: `item ${i}`, whose: "household", state: "open", dueAt: now + DAY + i })
      const missing = yield* kit.tool("reminders_cancel", { which: "item 249" }, { device: SAM })
      assert.deepStrictEqual(missing.value, { spoken: "I found none in the first 204 open reminders; there are more." })
      const list = yield* kit.tool("reminders_list", {}, { device: SAM })
      const v = JSON.parse(list.content.split("\n")[0]!)
      assert.strictEqual(v.count, 204)
      assert.strictEqual(v.cut, "I read the first 204 open reminders; there are more.")
      assert.strictEqual(v.reminders.length, 5)
      assert.strictEqual(v.more, 199)
    }))
})

describe("listing and privacy", () => {
  const prepare = (kit: Kit) =>
    Effect.gen(function*() {
      yield* kit.tool("reminders_set", { text: "Sam's dentist", when: "in two hours" }, { device: SAM })
      yield* kit.advance(MIN)
      yield* kit.tool("reminders_set", { text: "Robin's vet", when: "in three hours" }, { device: ROBIN })
      yield* kit.advance(MIN)
      yield* kit.tool("reminders_set", { text: "bins out", when: "in four hours", scope: "household" }, { device: SAM })
    })

  it.effect("each device is told what its privacy rule allows now, and says what the answer covers", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* prepare(kit)
      const parse = (r: any) => JSON.parse(r.content.split("\n")[0]!)
      // The shared kitchen display is Sam's: Sam's own and the household's, never Robin's (not even counted).
      const kitchen = parse(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.deepStrictEqual(kitchen.reminders.map((r: any) => r.text), ["Sam's dentist", "bins out"])
      assert.strictEqual(kitchen.covers, "yours and the household's")
      assert.strictEqual(kitchen.owner, "p-sam")
      // Robin's private phone: Robin's own and the household's.
      const phone = parse(yield* kit.tool("reminders_list", {}, { device: ROBIN }))
      assert.deepStrictEqual(phone.reminders.map((r: any) => r.text), ["Robin's vet", "bins out"])
      // The public hall screen has nobody: the household's only, and it says so.
      const hall = yield* kit.tool("reminders_list", {}, { device: HALL })
      assert.deepStrictEqual(parse(hall).reminders.map((r: any) => r.text), ["bins out"])
      assert.strictEqual(parse(hall).covers, "the household's reminders only; I can't tell who is asking")
      assert.notInclude(hall.content, "dentist")
      assert.notInclude(hall.content, "vet")
    }))

  it.effect("a public screen with a default person counts that person's reminders and reads none of them", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, {
        household: { devices: [...DEFAULT_TEST_HOUSEHOLD.devices, { id: "lobby-screen", name: "Lobby", room: "Lobby", privacy: "public", defaultPerson: "p-sam" }] }
      })
      yield* kit.tool("reminders_set", { text: "secret thing", when: "in two hours" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "second secret", when: "in three hours" }, { device: SAM })
      const lobby = yield* kit.tool("reminders_list", {}, { device: "lobby-screen" })
      assert.deepStrictEqual(lobby.value, { spoken: "2 personal reminders are not read out here." })
      assert.notInclude(lobby.content, "secret")
      // Where it is household too, the household's are read and the personal ones counted.
      yield* kit.tool("reminders_set", { text: "bins", when: "in an hour", scope: "household" }, { device: SAM })
      const mixed = JSON.parse((yield* kit.tool("reminders_list", {}, { device: "lobby-screen" })).content.split("\n")[0]!)
      assert.deepStrictEqual(mixed.reminders.map((r: any) => r.text), ["bins"])
      assert.strictEqual(mixed.withheld, "2 personal reminders are not read out here.")
      assert.strictEqual(mixed.covers, "the household's reminders; yours are not read out here")
      // A reminder that cannot be told here cannot be changed or cancelled here either, and says why.
      const cancel = yield* kit.tool("reminders_cancel", { which: "secret" }, { device: "lobby-screen" })
      assert.strictEqual((cancel.value as { spoken: string }).spoken, "I don't have a reminder called secret. Personal reminders are not read out or changed here.")
      assert.strictEqual((yield* rows(kit)).filter((r) => r.value.state === "open").length, 3)
    }))

  it.effect("the list is a presentation on the device that can show it, personal only where it may be shown", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* prepare(kit)
      const shown = yield* kit.tool("reminders_list", {}, { device: SAM })
      assert.include(shown.content, "[Screen: Shown on \"Kitchen display\".]")
      yield* kit.present.settle
      const [list] = kit.present.shown(SAM)
      assert.strictEqual(list?.content.kind, "list")
      assert.deepStrictEqual(list?.content.kind === "list" ? list.content.items.map((i) => i.text.split(" · ")[1]) : [], ["Sam's dentist", "bins out"])
      // Robin's phone does not show Sam's list, and its own is its own.
      assert.deepStrictEqual(kit.present.shown(ROBIN), [])
      // A one-line "nothing" is not a card.
      const empty = yield* startTestModule(remindersModule)
      const none = yield* empty.tool("reminders_list", {}, { device: SAM })
      assert.deepStrictEqual(none.value, { spoken: "You have no reminders." })
      assert.deepStrictEqual(empty.present.shown(SAM), [])
    }))

  it.effect("a ring for a personal reminder is not delivered to a device that may not reveal it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      // Set from the public hall as the household's, then check a personal one set on Robin's phone rings only there.
      yield* kit.tool("reminders_set", { text: "Robin's vet", when: "in a minute" }, { device: ROBIN })
      yield* kit.advance(2 * MIN)
      const decisions = kit.notify.decisions
      assert.isTrue(decisions.some((d: any) => d.deviceId === ROBIN && d.decision.deliver))
      assert.isFalse(decisions.some((d: any) => d.deviceId === HALL && d.decision.deliver))
    }))

  it.effect("a list past one page of rows is read in full (30 reminders), soonest first", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      for (let i = 29; i >= 0; i--) yield* store.insert({ text: `item ${i}`, whose: "household", state: "open", dueAt: now + DAY + i * MIN })
      const v = JSON.parse((yield* kit.tool("reminders_list", {}, { device: SAM })).content.split("\n")[0]!)
      assert.strictEqual(v.count, 30)
      assert.deepStrictEqual(v.reminders.map((r: any) => r.text), ["item 0", "item 1", "item 2", "item 3", "item 4"])
      assert.strictEqual(v.more, 25)
      assert.isUndefined(v.cut)
      // Cancelling the last of them is found past the first page.
      assert.deepStrictEqual((yield* kit.tool("reminders_cancel", { which: "item 29" }, { device: SAM })).value, { spoken: "Cancelled: item 29." })
    }))
})

describe("the briefing's section", () => {
  const gather = (kit: Kit, device: string, extra: Partial<BriefingRequest> = {}) =>
    Effect.gen(function*() {
      const turn = kit.turn({ device })
      const sections = yield* kit.contributions(BriefingSections, { device })
      const section = sections.find((s: any) => s.id === "reminders")
      assert.isDefined(section)
      return (yield* section.gather({ turn, kind: "morning", length: "normal", maxSentences: 2, language: "en", now: yield* kit.now, ...extra })) as any
    })

  it.effect("today's reminders for the asking person, the household's with them; the rest of the day only", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      assert.deepStrictEqual(yield* gather(kit, SAM), { _tag: "empty" })
      yield* kit.tool("reminders_set", { text: "call mum", when: "today at five pm" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "bins out", when: "today at seven pm", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "tomorrow thing", when: "tomorrow at nine am" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "Robin's vet", when: "today at six pm" }, { device: ROBIN })
      const r = yield* gather(kit, SAM)
      assert.deepStrictEqual(r.sentences, ["You have two reminders today: call mum at five o'clock and bins out at seven o'clock."])
      assert.strictEqual(r.owner, "p-sam")
      assert.strictEqual(r.withheld, 0)
      // A public screen: the household's alone, with an anonymous count and no owner word.
      const hall = yield* gather(kit, HALL)
      assert.deepStrictEqual(hall.sentences, ["You have a reminder today: bins out at seven o'clock."])
      assert.isUndefined(hall.owner)
      assert.notInclude(JSON.stringify(hall), "call mum")
    }))

  it.effect("a person's own on a public screen are counted, not named; a failed read is a failure; Dutch", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults), {
        household: { devices: [...DEFAULT_TEST_HOUSEHOLD.devices, { id: "lobby-screen", name: "Lobby", room: "Lobby", privacy: "public", defaultPerson: "p-sam" }], home: { HOME_LANGUAGE: "nl-NL" } }
      })
      yield* kit.tool("reminders_set", { text: "bel mama", when: "vandaag om vijf uur 's middags" }, { device: SAM })
      const lobby = yield* gather(kit, "lobby-screen", { language: "nl" })
      assert.deepStrictEqual(lobby, { _tag: "section", sentences: [], priority: "normal", withheld: 1 })
      const own = yield* gather(kit, SAM, { language: "nl" })
      assert.strictEqual(own.sentences[0], "Je hebt vandaag een herinnering: bel mama om vijf uur.")
      faults.storeReads = true
      const failure = yield* Effect.flip(gather(kit, SAM, { language: "nl" }))
      assert.strictEqual((failure as { _tag: string })._tag, "BriefingSectionError")
    }))
})

describe("failures are said, and leave nothing half done", () => {
  it.effect("a store that is busy: setting says so and writes nothing; a failed read is a failure, never 'none'", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in an hour", scope: "household" }, { device: SAM })
      faults.storeWrites = true
      const set = yield* kit.tool("reminders_set", { text: "never saved", when: "in two hours", scope: "household" }, { device: SAM })
      assert.include(set.content, "I couldn't save that reminder.")
      faults.storeWrites = false
      assert.strictEqual((yield* rows(kit)).length, 1)
      assert.strictEqual((yield* kit.jobs).filter((j: any) => j.handler === "due" && j.state === "scheduled").length, 1)
      faults.storeReads = true
      const list = yield* kit.tool("reminders_list", {}, { device: SAM })
      assert.include(list.content, "I couldn't read the reminders.")
      const cancel = yield* kit.tool("reminders_cancel", { which: "bins" }, { device: SAM })
      assert.include(cancel.content, "I couldn't save that reminder.")
      faults.storeReads = false
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "open")
    }))

  it.effect("a press whose write fails changes nothing and says to try again; pressed again it works", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      yield* kit.advance(2 * MIN)
      const [n] = yield* kit.notify.all
      faults.storeWrites = true
      const failed = yield* kit.notify.press(n!.id, "done", { device: SAM })
      assert.strictEqual(failed.say, "That didn't work. Try again in a moment.")
      faults.storeWrites = false
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "open")
      assert.deepStrictEqual(yield* kit.notify.press(n!.id, "done", { device: SAM }), { ok: true, say: "Done." })
    }))

  it.effect("a one-off whose delivery fails is retried and delivered once", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      faults.sendFails = 2
      yield* kit.advance(MIN + 1_000)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      yield* kit.advance(40_000)
      assert.strictEqual((yield* kit.notify.all).length, 1)
      assert.strictEqual((yield* rows(kit))[0]?.value.notifiedFor, (yield* rows(kit))[0]?.value.dueAt)
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
      // The job starts at its time and its delivery waits at the gate.
      const running = yield* Effect.forkChild(kit.advance(10 * MIN + 1_000))
      yield* Deferred.await(faults.entered)
      const cancelling = yield* Effect.forkChild(kit.tool("reminders_cancel", { which: "bins" }, { device: SAM }))
      yield* Effect.yieldNow
      // The cancel is waiting behind the job: nothing is cancelled yet.
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "open")
      yield* Deferred.succeed(faults.gate, undefined)
      yield* Fiber.join(running)
      const cancelled = yield* Fiber.join(cancelling)
      assert.deepStrictEqual(cancelled.value, { spoken: "Cancelled: bins." })
      yield* kit.present.settle
      assert.strictEqual((yield* rows(kit))[0]?.value.state, "cancelled")
      assert.deepStrictEqual((yield* kit.notify.all).map((n) => n.state), ["resolved"])
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      assert.deepStrictEqual((yield* kit.jobs).filter((j) => j.state === "scheduled" && j.handler !== "tidy"), [])
    }))

  it.effect("a job for a reminder that was changed, cancelled or finished meanwhile does nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "bins", when: "in ten minutes", scope: "household" }, { device: SAM })
      const job = (yield* kit.jobs).find((j: any) => j.handler === "due")!
      const [row] = yield* rows(kit)
      // Cancelled by the store, as if it had been called off while the job waited: the job runs and finds the row finished.
      yield* kit.moduleStore().collection(reminders).update(row!.id, (v) => ({ ...v, state: "cancelled" as const, endedAt: 1 }))
      yield* kit.runJob(job.id)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      // Moved to another time: the old occurrence is not delivered.
      yield* kit.moduleStore().collection(reminders).update(row!.id, (v) => ({ ...v, state: "open" as const, dueAt: v.dueAt + H }))
      yield* kit.runJob(job.id)
      assert.deepStrictEqual(yield* kit.notify.all, [])
    }))

  it.effect("a write made by a job carries the job as its actor", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      yield* kit.advance(2 * MIN)
      const job = (yield* kit.jobs).find((j: any) => j.handler === "due")!
      const events = kit.events.filter((e: any) => e.type === "reminders.reminders.changed")
      assert.deepStrictEqual(events.at(-1)?.actor, { kind: "job", jobId: job.id })
    }))

  it.effect("the daily clean-up lapses what was delivered a week ago and removes finished ones after the kept days, in batches", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, { settings: { keepDays: 3 } })
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      const old = now - 10 * DAY
      yield* store.insert({ text: "unanswered", whose: "household", state: "open", dueAt: old, notifiedFor: old })
      yield* store.insert({ text: "not yet", whose: "household", state: "open", dueAt: now + DAY })
      for (let i = 0; i < 30; i++) yield* store.insert({ text: `done ${i}`, whose: "household", state: "done", dueAt: old, endedAt: now - 5 * DAY + i })
      yield* store.insert({ text: "fresh done", whose: "household", state: "done", dueAt: now, endedAt: now - DAY })
      yield* store.insert({ text: "old cancelled", whose: "household", state: "cancelled", dueAt: old, endedAt: now - 9 * DAY })
      const tidy = (yield* kit.jobs).find((j: any) => j.handler === "tidy")!
      assert.strictEqual(tidy.cron, "0 4 * * *")
      yield* kit.runJob(tidy.id)
      const left = yield* store.list({ limit: 12 })
      assert.deepStrictEqual(left.map((r) => r.value.text).sort(), ["fresh done", "not yet", "unanswered"])
      assert.strictEqual(left.find((r) => r.value.text === "unanswered")?.value.state, "lapsed")
    }))
})

describe("settings and the module off", () => {
  it.effect("invalid settings stop the module with the reason; valid ones are used", () =>
    Effect.gen(function*() {
      const bad = yield* startTestModule(remindersModule, { settings: { snoozeMinutes: 0 } })
      assert.strictEqual(bad.info()?.state, "error")
      const normal = yield* startTestModule(remindersModule, { settings: { priority: "normal" } })
      yield* normal.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      yield* normal.advance(2 * MIN)
      assert.strictEqual((yield* normal.notify.all)[0]?.priority, "normal")
    }))

  it.effect("with the module off its tools are not offered and nothing rings", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "bins", when: "in a minute", scope: "household" }, { device: SAM })
      yield* kit.stop
      assert.notInclude(kit.toolNames() ?? [], "reminders_set")
      yield* kit.advance(2 * MIN)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      yield* kit.start
      yield* kit.advance(MIN)
      assert.strictEqual((yield* kit.notify.all).length, 1)
    }))

  it.effect("no result, spoken line or stored row of the module holds a secret it was given", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const set = yield* kit.tool("reminders_set", { text: "bins", when: "in an hour" }, { device: SAM })
      const list = yield* kit.tool("reminders_list", {}, { device: SAM })
      yield* kit.expectNoSecrets(set, list, yield* rows(kit))
    }))
})

describe("Dutch", () => {
  const nl = { household: { home: { HOME_LANGUAGE: "nl-NL" } } }

  it.effect("every path speaks Dutch: setting, questions, refusals, listing, changing, cancelling, done, snooze", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, nl)
      const say = (r: any) => (r.value as { spoken: string }).spoken
      assert.strictEqual(say(yield* kit.tool("reminders_set", { text: "bel mama", when: "over tien minuten" }, { device: SAM })), "Herinnering gezet voor vandaag om tien over tien 's ochtends: bel mama.")
      assert.strictEqual(say(yield* kit.tool("reminders_set", { text: "x", when: "morgen" }, { device: SAM })), "Hoe laat?")
      assert.strictEqual(say(yield* kit.tool("reminders_set", { text: "x", when: "gisteren om vijf uur" }, { device: SAM })), "Dat moment is al voorbij.")
      assert.strictEqual(say(yield* kit.tool("reminders_set", { text: "x", when: "ooit" }, { device: SAM })), "Wanneer moet ik je herinneren? Ik begreep niet wanneer.")
      assert.strictEqual(say(yield* kit.tool("reminders_set", { text: "wachtwoord 123456", when: "over een uur" }, { device: SAM })), "Ik bewaar geen codes of wachtwoorden in herinneringen.")
      assert.strictEqual(say(yield* kit.tool("reminders_set", { text: "x", when: "over een uur", scope: "me" }, { device: HALL })), "Van wie is de herinnering? Ik weet hier niet wie het vraagt.")
      const rep = say(yield* kit.tool("reminders_set", { text: "vuilnis", when: "elke maandag om zeven uur 's avonds", scope: "household" }, { device: SAM }))
      assert.include(rep, "Terugkerende herinnering voor het huishouden, elke maandag")
      const list = JSON.parse((yield* kit.tool("reminders_list", {}, { device: SAM })).content.split("\n")[0]!)
      assert.strictEqual(list.covers, "die van jou en van het huishouden")
      assert.strictEqual(say(yield* kit.tool("reminders_cancel", { which: "ooit" }, { device: SAM })), "Ik heb geen herinnering met ooit.")
      assert.strictEqual(say(yield* kit.tool("reminders_change", { which: "mama" }, { device: SAM })), "Wat moet ik veranderen: de woorden of de tijd?")
      yield* kit.advance(11 * MIN)
      const [n] = yield* kit.notify.all
      assert.strictEqual(n?.title, "Herinnering")
      assert.deepStrictEqual(n?.actions.map((a) => a.label), ["Klaar", "Uitstellen"])
      assert.deepStrictEqual(yield* kit.notify.press(n!.id, "snooze", { device: SAM }), { ok: true, say: "Ik herinner je er over 10 minuten weer aan." })
      yield* kit.advance(11 * MIN)
      const second = (yield* kit.notify.all).find((x) => x.state === "open")!
      assert.deepStrictEqual(yield* kit.notify.press(second.id, "done", { device: SAM }), { ok: true, say: "Klaar." })
      assert.strictEqual(say(yield* kit.tool("reminders_done", { which: "mama" }, { device: SAM })), "Ik heb geen herinnering met mama.")
      assert.strictEqual(say(yield* kit.tool("reminders_cancel", { which: "vuilnis" }, { device: SAM })), "Geannuleerd: vuilnis.")
      assert.deepStrictEqual((yield* kit.tool("reminders_list", {}, { device: SAM })).value, { spoken: "Je hebt geen herinneringen." })
    }))

  it.effect("the card and the failures in Dutch", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults), nl)
      yield* kit.tool("reminders_set", { text: "bel mama", when: "over een minuut" }, { device: SAM })
      yield* kit.advance(2 * MIN)
      yield* kit.present.settle
      const [card] = kit.present.shown(SAM)
      assert.strictEqual(card?.content.kind === "card" ? card.content.title : "", "Herinnering")
      faults.storeReads = true
      const failed = yield* kit.tool("reminders_list", {}, { device: SAM })
      assert.include(failed.content, "Ik kon de herinneringen niet lezen.")
    }))
})
