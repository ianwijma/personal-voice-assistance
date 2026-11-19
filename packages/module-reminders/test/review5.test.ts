import { assert, describe, it, vi } from "@effect/vitest"
import { type ActionRunResult, Devices, Privacy, StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { remindersModule } from "../src/index.ts"
import { allRows, faulty, forModel, jobOf, MIN, nofaults, openNotes, SAM, spoken, theRow, type Kit } from "./helpers.ts"

vi.setConfig({ testTimeout: 180_000 })
const as = { device: SAM }
const actionSay = (r: ActionRunResult) => r.ok ? r.say ?? "" : r.message
const due = (k: Kit, when = "in a minute", personal = false) => Effect.gen(function*() {
  yield* k.tool("reminders_set", { text: "dentist", when, ...(personal ? {} : { scope: "household" }) }, as)
  const at = (yield* theRow(k)).value.dueAt!
  yield* k.advance(at - (yield* k.now) + 1_000)
  yield* k.present.settle
  return (yield* openNotes(k))[0]!
})

describe("GPT review Round 3", () => {
  for (const entry of ["named", "unnamed", "action"]) it.effect(`1: ${entry} Done rechecks privacy after the inner answer returns`, () => Effect.gen(function*() {
    let device: any, privacy: any, armed = false
    const mod = { ...remindersModule,
      shared: (ctx: any) => { device = ctx.host.service(Devices).get(SAM); privacy = ctx.host.service(Privacy); return remindersModule.shared!(ctx) },
      start: (ctx: any) => {
        const shared = { ...ctx.shared }
        for (const key of ["answer", "answerLocked"]) shared[key] = (...args: any[]) => Effect.tap(ctx.shared[key](...args), () => Effect.sync(() => {
          if (armed) { armed = false; device.place.defaultPerson = "p-robin" }
        }))
        return remindersModule.start!({ ...ctx, shared })
      }
    }
    const k = yield* startTestModule(mod)
    yield* due(k, "every Wednesday at 11 am", true)
    armed = true
    const result = entry === "action" ? yield* k.action("ringing_done", {}, as) : yield* k.tool("reminders_done", entry === "named" ? { which: "dentist" } : {}, as)
    assert.isFalse(privacy.mayReveal("p-sam", SAM))
    assert.strictEqual(entry === "action" ? actionSay(result as ActionRunResult) : spoken(result as any), "Done.")
    if (entry !== "action") assert.isUndefined((result as any).value.owner)
    assert.isUndefined((yield* theRow(k)).value.ring)
  }))
  for (const stopped of [false, true]) it.effect(`2: personal text edit refuses permission lost during ${stopped ? "stopped" : "open"} notification lookup`, () => Effect.gen(function*() {
    let device: any, armed = false
    const mod = { ...remindersModule, shared: (ctx: any) => {
      device = ctx.host.service(Devices).get(SAM)
      return remindersModule.shared!({ ...ctx, notify: { ...ctx.notify, list: () => Effect.tap(ctx.notify.list(), () => Effect.sync(() => {
        if (armed) { armed = false; device.place.defaultPerson = "p-robin" }
      })) } })
    } }
    const k = yield* startTestModule(mod)
    const note = yield* due(k, "in a minute", true)
    if (stopped) yield* k.notify.press(note.id, "stop", as)
    const before = yield* theRow(k), jobs = yield* jobOf(k, before.id), notes = yield* openNotes(k)
    armed = true
    assert.strictEqual(spoken(yield* k.tool("reminders_change", { which: "dentist", text: "replacement" }, as)), "Personal reminders are not read out or changed here.")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.deepStrictEqual(yield* jobOf(k, before.id), jobs)
    assert.deepStrictEqual(yield* openNotes(k), notes)
  }))
  for (const operation of ["change", "cancel", "done"]) it.effect(`2: ${operation} refuses permission lost while preparing its write`, () => Effect.gen(function*() {
    let device: any, armed = false
    const mod = { ...remindersModule, shared: (ctx: any) => {
      device = ctx.host.service(Devices).get(SAM)
      return remindersModule.shared!({ ...ctx, scheduler: { ...ctx.scheduler, prepare: (...args: any[]) => Effect.tap(ctx.scheduler.prepare(...args), () => Effect.sync(() => {
        if (armed) { armed = false; device.place.defaultPerson = "p-robin" }
      })) } })
    } }
    const k = yield* startTestModule(mod)
    yield* k.tool("reminders_set", { text: "dentist", when: "every Wednesday at 11 am" }, as)
    const before = yield* theRow(k), jobs = yield* jobOf(k, before.id)
    armed = true
    const result = yield* k.tool(`reminders_${operation}`, { which: "dentist", ...(operation === "change" ? { when: "tomorrow at 6 pm" } : {}) }, as)
    assert.strictEqual(spoken(result), "Personal reminders are not read out or changed here.")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.deepStrictEqual(yield* jobOf(k, before.id), jobs)
  }))
  for (const entry of ["notification", "card", "action"]) for (const kind of ["done", "snooze"]) {
    it.effect(`2: ${entry} ${kind} refuses permission lost at transaction admission`, () => Effect.gen(function*() {
      let device: any, armed = false
      const mod = { ...remindersModule, shared: (ctx: any) => {
        device = ctx.host.service(Devices).get(SAM)
        return remindersModule.shared!({ ...ctx, store: { ...ctx.store,
          transaction: (f: any) => Effect.suspend(() => {
            if (armed) { armed = false; device.place.defaultPerson = "p-robin" }
            return ctx.store.transaction(f)
          })
        } })
      } }
      const k = yield* startTestModule(mod)
      const note = yield* due(k, "every Wednesday at 11 am", true)
      const before = yield* theRow(k), jobs = yield* jobOf(k, before.id)
      armed = true
      const reply = entry === "action"
        ? actionSay(yield* k.action(`ringing_${kind}`, {}, as))
        : (yield* (entry === "notification" ? k.notify.press(note.id, kind, as) : k.present.press(k.present.shown(SAM)[0]!.id, kind, as))).say
      assert.strictEqual(reply, "Personal reminders are not read out or changed here.")
      assert.deepStrictEqual((yield* theRow(k)).value, before.value)
      assert.deepStrictEqual(yield* jobOf(k, before.id), jobs)
      assert.deepStrictEqual((yield* openNotes(k)).map(n => n.id), [note.id])
    }))
  }
  for (const button of ["done", "snooze"]) it.effect(`3: committed ${button} resolves the pressed notification after one cleanup read failure`, () => Effect.gen(function*() {
    let armed = false, failRead = false, failures = 0
    const mod = { ...remindersModule, shared: (ctx: any) => remindersModule.shared!({ ...ctx, store: { ...ctx.store,
      transaction: (f: any) => Effect.tap(ctx.store.transaction(f), () => Effect.sync(() => { if (armed) { armed = false; failRead = true } })),
      collection: (c: any) => { const h = ctx.store.collection(c); return { ...h, get: (id: string) => Effect.suspend(() => {
        if (failRead) { failRead = false; failures++; return Effect.fail(new StoreError({ reason: "busy", message: "one post-commit read" })) }
        return h.get(id)
      }) } }
    } }) }
    const k = yield* startTestModule(mod)
    const note = yield* due(k)
    armed = true
    const reply = yield* k.notify.press(note.id, button, as)
    assert.notInclude(reply.say ?? "", "didn't work")
    assert.strictEqual(failures, 1)
    assert.deepStrictEqual(yield* openNotes(k), [])
    yield* k.advance(6_000)
    assert.deepStrictEqual(yield* openNotes(k), [])
    yield* k.advance(10 * MIN)
    if (button === "snooze") {
      const fresh = (yield* openNotes(k))[0]!
      assert.isDefined(fresh)
      assert.notStrictEqual(fresh.id, note.id)
    } else assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  it.effect("4: padded Home zone gives the same saved time and answers as its trimmed zone", () => Effect.gen(function*() {
    const results: unknown[] = []
    for (const zone of ["Europe/Amsterdam", " Europe/Amsterdam "]) {
      const k = yield* startTestModule(remindersModule, { household: { home: { HOME_LANGUAGE: "en-GB", HOME_TIME_ZONE: zone } } })
      const set = spoken(yield* k.tool("reminders_set", { text: "bins", when: "tomorrow at 6 pm", scope: "household" }, as))
      assert.include(set, "bins")
      results.push({ set, at: (yield* theRow(k)).value.dueAt, list: forModel(yield* k.tool("reminders_list", {}, as)) })
    }
    assert.deepStrictEqual(results[1], results[0])
  }))
  it.effect("5: a snooze overtaken by the next regular occurrence is declined without changing the ring", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    yield* due(k, "every day at 11 am")
    yield* k.advance(10 * MIN - 1_000)
    const before = yield* theRow(k), notes = yield* openNotes(k)
    const reply = actionSay(yield* k.action("ringing_snooze", { for: "24 hours" }, as))
    assert.include(reply, "next regular reminder")
    assert.notInclude(reply, "again in 1 day")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.deepStrictEqual(yield* openNotes(k), notes)
    yield* k.advance(before.value.dueAt! - (yield* k.now) + 1_000)
    assert.strictEqual((yield* openNotes(k)).length, 1)
    yield* k.notify.press((yield* openNotes(k))[0]!.id, "done", as)
    yield* k.advance(10 * MIN)
    assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  it.effect("5: a snooze-overlap refusal rechecks privacy before mentioning the next occurrence", () => Effect.gen(function*() {
    let device: any, armed = false
    const mod = { ...remindersModule,
      shared: (ctx: any) => { device = ctx.host.service(Devices).get(SAM); return remindersModule.shared!(ctx) },
      start: (ctx: any) => remindersModule.start!({ ...ctx, shared: { ...ctx.shared,
        answer: (...args: any[]) => Effect.tap(ctx.shared.answer(...args), () => Effect.sync(() => {
          if (armed) { armed = false; device.place.defaultPerson = "p-robin" }
        }))
      } })
    }
    const k = yield* startTestModule(mod)
    yield* due(k, "every day at 11 am", true)
    const before = yield* theRow(k)
    armed = true
    const reply = actionSay(yield* k.action("ringing_snooze", { for: "24 hours" }, as))
    assert.strictEqual(reply, "Personal reminders are not read out or changed here.")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.strictEqual((yield* openNotes(k)).length, 1)
  }))
  for (const state of ["ordinary", "snoozed", "stopped snooze"]) it.effect(`6: text edit preserves the effective due time (${state})`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    let note = yield* due(k)
    const original = (yield* theRow(k)).value.ring!.at
    let effective = original
    if (state !== "ordinary") {
      yield* k.notify.press(note.id, "snooze", as)
      effective = (yield* theRow(k)).value.ring!.snoozeUntil!
      yield* k.advance(10 * MIN + 1)
      note = (yield* openNotes(k))[0]!
    }
    if (state === "stopped snooze") yield* k.notify.press(note.id, "stop", as)
    yield* k.advance(2 * MIN)
    const before = forModel(yield* k.tool("reminders_list", {}, as)).reminders[0].when
    const reply = spoken(yield* k.tool("reminders_change", { which: "dentist", text: "replacement" }, as))
    if (state === "stopped snooze") assert.include(reply, before)
    yield* k.advance(1_000)
    yield* k.present.settle
    const after = forModel(yield* k.tool("reminders_list", {}, as)).reminders[0].when
    assert.strictEqual(after, before)
    const r = (yield* theRow(k)).value
    assert.strictEqual(r.ring?.from ?? r.ring?.at, effective)
    if (state !== "stopped snooze") {
      const content = k.present.shown(SAM)[0]!.content as any
      assert.include(content.facts[0].value, state === "ordinary" ? "10:01" : "10:11")
      assert.strictEqual((yield* openNotes(k))[0]?.text, "replacement")
    }
  }))
  it.effect("6: failed text redelivery retires the retained ring after its last try", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* due(k)
    f.sendFails = 5
    yield* k.tool("reminders_change", { which: "dentist", text: "replacement" }, as)
    yield* k.advance(20 * MIN)
    const r = (yield* theRow(k)).value
    assert.strictEqual(r.state, "lapsed")
    assert.isUndefined(r.ring)
    assert.isUndefined(r.owed)
    assert.strictEqual(r.dropped?.why, "failed")
    assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  it.effect("6: a text resend found beyond the repeat's late window retires the retained ring", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    yield* due(k, "every day at 11 am")
    yield* k.tool("reminders_change", { which: "dentist", text: "replacement" }, as)
    yield* k.stop
    yield* k.advance(7 * 60 * MIN)
    yield* k.start
    yield* k.advance(1_000)
    const r = (yield* theRow(k)).value
    assert.strictEqual(r.state, "open")
    assert.isUndefined(r.ring)
    assert.isUndefined(r.owed)
    assert.strictEqual(r.dropped?.why, "late")
    assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  it.effect("6: a one-off text resend retains its due time across a week-long outage", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    yield* due(k)
    const effective = (yield* theRow(k)).value.ring!.at
    yield* k.advance(2 * MIN)
    yield* k.tool("reminders_change", { which: "dentist", text: "replacement" }, as)
    yield* k.stop
    yield* k.advance(8 * 24 * 60 * MIN)
    yield* k.start
    yield* k.advance(1_000)
    const r = (yield* theRow(k)).value
    assert.strictEqual(r.ring?.from ?? r.ring?.at, effective)
    assert.strictEqual((yield* openNotes(k))[0]?.text?.startsWith("replacement"), true)
  }))
  for (const text of ["", "  "]) for (const entry of ["set", "change", "remind_in"]) it.effect(`7: ${entry} asks for meaningful words for ${JSON.stringify(text)}`, () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    if (entry === "change") yield* k.tool("reminders_set", { text: "pills", when: "in a minute", scope: "household" }, as)
    const rows = yield* allRows(k), jobs = yield* k.jobs
    const reply = entry === "remind_in" ? actionSay(yield* k.action("remind_in", { delay: "one minute", text }, as)) : spoken(yield* k.tool(`reminders_${entry}`, entry === "set" ? { text, when: "in a minute", scope: "household" } : { which: "pills", text }, as))
    assert.strictEqual(reply, "What should I remind you about?")
    assert.deepStrictEqual(yield* allRows(k), rows)
    assert.deepStrictEqual(yield* k.jobs, jobs)
  }))
})
