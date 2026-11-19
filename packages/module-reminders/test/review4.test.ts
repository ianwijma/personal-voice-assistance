import { assert, describe, it, vi } from "@effect/vitest"
import { type ActionRunResult, Devices, Privacy } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Deferred, Effect, Fiber } from "effect"
import { remindersModule } from "../src/index.ts"
import { assertJob, DAY, faulty, forModel, MIN, nofaults, openNotes, SAM, spoken, theRow, type Kit } from "./helpers.ts"

vi.setConfig({ testTimeout: 180_000 })
const as = { device: SAM }
const actionSay = (r: ActionRunResult) => r.ok ? r.say ?? "" : r.message
const deliver = (k: Kit, text = "pills", when = "in a minute", personal = false) => Effect.gen(function*() {
  yield* k.tool("reminders_set", { text, when, ...(personal ? {} : { scope: "household" }) }, as)
  yield* k.advance((yield* theRow(k)).value.dueAt! - (yield* k.now) + 1_000)
  yield* k.present.settle
  return (yield* openNotes(k))[0]!
})
const crash = (f: ReturnType<typeof nofaults>) => { f.afterSend = () => { f.afterSend = undefined; f.failTransactions = 1 } }
const overlapping = (k: Kit, f: ReturnType<typeof nofaults>, fail: "write" | "send") => Effect.gen(function*() {
  yield* k.tool("reminders_set", { text: "pills", when: "every day at 11 am", scope: "household" }, as)
  const first = (yield* theRow(k)).value.dueAt!
  yield* k.stop
  yield* k.advance(first - (yield* k.now) + 60 * MIN)
  yield* k.start
  yield* k.advance(1_000)
  const old = (yield* openNotes(k))[0]!
  if (fail === "write") crash(f)
  else f.sendFails = 1
  yield* k.advance(first + DAY - (yield* k.now) + 1_000)
  yield* k.present.settle
  return { old, at: first + DAY, fresh: (yield* openNotes(k)).find(n => n.key?.endsWith(`:${first + DAY}`)) }
})

describe("GPT review Round 2", () => {
  for (const button of ["notification", "card"]) for (const stage of ["admission", "confirmation"]) {
    it.effect(`1: ${button} Done checks real privacy at ${stage}`, () => Effect.gen(function*() {
      let change: (() => void) | undefined
      let device: any, privacy: any
      const mod = { ...remindersModule, shared: (ctx: any) => {
        device = ctx.host.service(Devices).get(SAM)
        privacy = ctx.host.service(Privacy)
        const store = ctx.store
        return remindersModule.shared!({ ...ctx, store: { ...store,
          collection: (c: any) => { const h = store.collection(c); return { ...h,
            get: (...args: any[]) => Effect.tap(h.get(...args), () => Effect.sync(() => { if (stage === "admission") change?.() }))
          } },
          transaction: (f: any) => Effect.tap(store.transaction(f), () => Effect.sync(() => { if (stage === "confirmation") change?.() }))
        } })
      } }
      const k = yield* startTestModule(mod)
      const note = yield* deliver(k, "dentist", "every Wednesday at 11 am", true)
      assert.isTrue(privacy.mayReveal("p-sam", SAM))
      change = () => { device.place.defaultPerson = "p-robin"; change = undefined }
      const result = button === "notification" ? yield* k.notify.press(note.id, "done", as) : yield* k.present.press(k.present.shown(SAM)[0]!.id, "done", as)
      assert.isFalse(privacy.mayReveal("p-sam", SAM))
      assert.notInclude(result.say ?? "", "next one")
      if (stage === "admission") {
        assert.strictEqual(result.say, "Personal reminders are not read out or changed here.")
        assert.isDefined((yield* theRow(k)).value.ring)
        assert.strictEqual((yield* openNotes(k)).length, 1)
      } else assert.strictEqual(result.say, "Done.")
    }))
  }
  it.effect("2: runnable cleanup at named Done admission cannot skip tomorrow", () => Effect.gen(function*() {
    const f = nofaults(), base = faulty(f)
    const entered = yield* Deferred.make<void>(), gate = yield* Deferred.make<void>()
    let hold = false
    const mod = { ...base, shared: (ctx: any) => base.shared!({ ...ctx, scheduler: { ...ctx.scheduler,
      handle: (name: string, h: any) => ctx.scheduler.handle(name, name !== "due" ? h : { ...h, run: (args: any) => Effect.gen(function*() {
        if (hold) { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(gate) }
        return yield* h.run(args)
      }) })
    } }) }
    const k = yield* startTestModule(mod)
    yield* deliver(k, "pills", "every day at 11 am")
    const next = (yield* theRow(k)).value.dueAt
    f.resolveFails = 1
    yield* k.tool("reminders_done", { which: "pills" }, as)
    hold = true
    const advancing = yield* Effect.forkChild(k.advance(5_100))
    yield* Deferred.await(entered)
    const reply = spoken(yield* k.tool("reminders_done", { which: "pills" }, as))
    const after = yield* theRow(k)
    hold = false
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.join(advancing)
    assert.notInclude(reply, "skip")
    assert.strictEqual(after.value.dueAt, next)
    assert.deepStrictEqual(yield* openNotes(k), [])
    yield* assertJob(k, after.id, { future: true })
  }))
  for (const entry of ["ringing_snooze", "ringing_done", "tool"]) {
    it.effect(`3: stale ${entry} cannot overwrite a card Snooze`, () => Effect.gen(function*() {
      const f = nofaults(), k = yield* startTestModule(faulty(f))
      yield* deliver(k)
      f.listGate = yield* Deferred.make<void>(); f.listEntered = yield* Deferred.make<void>()
      const voice = yield* Effect.forkChild(entry === "tool" ? Effect.map(k.tool("reminders_done", {}, as), spoken) : Effect.map(k.action(entry, entry === "ringing_snooze" ? { for: "one hour" } : {}, as), actionSay))
      yield* Deferred.await(f.listEntered)
      assert.strictEqual((yield* k.present.press(k.present.shown(SAM)[0]!.id, "snooze", as)).say, "I'll remind you again in 10 minutes.")
      const until = (yield* theRow(k)).value.ring!.snoozeUntil
      assert.strictEqual(until, (yield* k.now) + 10 * MIN)
      yield* Deferred.succeed(f.listGate, undefined)
      const reply = yield* Fiber.join(voice)
      assert.notInclude(reply, "one hour")
      assert.strictEqual((yield* theRow(k)).value.ring?.snoozeUntil, until)
      yield* k.advance(10 * MIN + 1)
      assert.strictEqual((yield* openNotes(k)).length, 1)
    }))
  }
  for (const answer of ["done", "snooze"]) it.effect(`4: fresh ${answer} accepts attempted occurrence and retires older ring`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" } })
    const { fresh, at } = yield* overlapping(k, f, "write")
    assert.isDefined(fresh)
    const reply = yield* k.notify.press(fresh!.id, answer, as)
    assert.notInclude(reply.say ?? "", "already")
    assert.deepStrictEqual(yield* openNotes(k), [])
    assert.isUndefined((yield* theRow(k)).value.owed)
    if (answer === "snooze") {
      assert.strictEqual((yield* theRow(k)).value.ring?.at, at)
      assert.strictEqual((yield* theRow(k)).value.ring?.snoozeUntil, (yield* k.now) + 10 * MIN)
    } else assert.isUndefined((yield* theRow(k)).value.ring)
    yield* assertJob(k, (yield* theRow(k)).id, { future: true })
    yield* k.advance(MIN)
    assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  it.effect("5: yesterday's Done preserves today's card", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" } })
    const { old, fresh } = yield* overlapping(k, f, "write")
    const card = k.present.shown(SAM)[0]!
    yield* k.notify.press(old.id, "done", as)
    yield* k.present.settle
    assert.deepStrictEqual(k.present.shown(SAM).map(c => c.id), [card.id])
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.id), [fresh!.id])
  }))
  it.effect("5: yesterday's Done preserves today's card after deferred cleanup", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" } })
    yield* k.tool("reminders_set", { text: "pills", when: "every day at 11 am", scope: "household" }, as)
    const first = (yield* theRow(k)).value.dueAt!
    yield* k.stop
    yield* k.advance(first - (yield* k.now) + 60 * MIN)
    yield* k.start
    yield* k.advance(1_000)
    yield* k.present.settle
    const old = (yield* openNotes(k))[0]!
    yield* k.advance(first + DAY - (yield* k.now) - 2_000)
    f.dismissFails = 1
    yield* k.notify.press(old.id, "done", as)
    assert.strictEqual(f.dismissFails, 0, "the dismissal failure must have been consumed")
    const pending = (yield* theRow(k)).value.stop!
    assert.isDefined(pending, "cleanup must actually be pending")
    assert.strictEqual(pending.cardAt, first)
    assert.strictEqual(pending.tryAt, (yield* k.now) + 5_000)
    yield* assertJob(k, (yield* theRow(k)).id, { future: true })
    // Today sends before the old cleanup retries; fail only its recording write so the cleanup remains pending.
    crash(f)
    yield* k.advance(4_000)
    yield* k.present.settle
    assert.strictEqual((yield* theRow(k)).value.stop?.cardAt, first)
    const card = k.present.shown(SAM)[0]!
    const fresh = (yield* openNotes(k))[0]!
    assert.strictEqual(fresh.key?.endsWith(`:${first + DAY}`), true)
    const runs = f.runs.due!
    yield* k.advance(2_000)
    yield* k.present.settle
    assert.isAbove(f.runs.due!, runs, "the scheduled cleanup must have run")
    assert.isUndefined((yield* theRow(k)).value.stop)
    assert.deepStrictEqual(k.present.shown(SAM).map(c => c.id), [card.id])
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.id), [fresh.id])
  }))
  for (const entry of ["named", "unnamed", "action"]) it.effect(`6: ${entry} preserves a privacy refusal without claiming Done`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* deliver(k, "dentist", "in a minute", true)
    const before = yield* theRow(k)
    const arm = () => { f.reveal = () => { f.reveal = () => false; return true } }
    if (entry === "named") f.onRead = q => { if (q.where?.state === "lapsed") arm() }
    else arm()
    const reply = entry === "action" ? actionSay(yield* k.action("ringing_done", {}, as)) : spoken(yield* k.tool("reminders_done", entry === "named" ? { which: "dentist" } : {}, as))
    assert.strictEqual(reply, "Personal reminders are not read out or changed here.")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.strictEqual((yield* openNotes(k)).length, 1)
  }))
  it.effect("7: Done omits next-date promise while a distinct occurrence is owed", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" } })
    const { old, at } = yield* overlapping(k, f, "send")
    const reply = yield* k.notify.press(old.id, "done", as)
    assert.notInclude(reply.say ?? "", "tomorrow")
    assert.strictEqual((yield* theRow(k)).value.owed?.at, at)
    yield* k.advance(MIN)
    assert.strictEqual((yield* openNotes(k)).length, 1)
  }))
  it.effect("8: late snooze uses its effective deadline in notification, card and both lists", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    const n = yield* deliver(k)
    yield* k.notify.press(n.id, "snooze", as)
    yield* k.stop; yield* k.advance(20 * MIN); yield* k.start; yield* k.advance(1_000); yield* k.present.settle
    assert.include((yield* openNotes(k))[0]!.text!, "ten eleven")
    const card = k.present.shown(SAM)[0]!.content as any
    assert.include(card.facts[0].value, "10:11")
    const list = forModel(yield* k.tool("reminders_list", {}, as))
    assert.include(list.reminders[0].when, "ten eleven")
    assert.include(f.results.reminders_list.present.items[0].text, "10:11")
  }))
  it.effect("9: editing a delivered attempt reports that its new words await delivery", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    crash(f)
    yield* deliver(k, "call mum")
    const reply = spoken(yield* k.tool("reminders_change", { which: "mum", text: "call dad" }, as))
    assert.include(reply, "The new words are waiting for delivery.")
    assert.deepStrictEqual(yield* openNotes(k), [])
    yield* k.advance(MIN)
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.text), ["call dad"])
  }))
})
