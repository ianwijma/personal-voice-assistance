import { assert, describe, it, vi } from "@effect/vitest"
import { type ActionRunResult, Devices, Privacy, StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { remindersModule } from "../src/index.ts"
import { allRows, assertJob, DAY, faulty, jobOf, MIN, nofaults, openNotes, ring, SAM, spoken, theRow } from "./helpers.ts"

vi.setConfig({ testTimeout: 180_000 })
const as = { device: SAM }
const actionSay = (r: ActionRunResult) => r.ok ? r.say ?? "" : r.message

describe("GPT review Round 4", () => {
  for (const language of ["en", "nl"]) for (const entry of ["notification", "card", "action"]) {
    it.effect(`1: ${entry} Snooze keeps its deadline private after commit (${language})`, () => Effect.gen(function*() {
      let device: any, privacy: any, armed = false
      const mod = { ...remindersModule, shared: (ctx: any) => {
        device = ctx.host.service(Devices).get(SAM)
        privacy = ctx.host.service(Privacy)
        return remindersModule.shared!({ ...ctx, store: { ...ctx.store,
          transaction: (f: any) => Effect.tap(ctx.store.transaction(f), () => Effect.sync(() => {
            if (armed) { armed = false; device.place.defaultPerson = "p-robin" }
          }))
        } })
      } }
      const k = yield* startTestModule(mod, { settings: { snoozeMinutes: 37 }, household: { home: { HOME_LANGUAGE: language } } })
      yield* k.tool("reminders_set", { text: "therapy", when: language === "en" ? "in a minute" : "over een minuut" }, as)
      yield* k.advance(MIN + 1_000)
      yield* k.present.settle
      const note = (yield* openNotes(k))[0]!
      const card = k.present.shown(SAM)[0]!
      assert.isDefined(card)
      const now = yield* k.now
      armed = true
      const reply = entry === "action"
        ? actionSay(yield* k.action("ringing_snooze", { for: language === "en" ? "forty minutes" : "veertig minuten" }, as))
        : (yield* (entry === "notification" ? k.notify.press(note.id, "snooze", as) : k.present.press(card.id, "snooze", as))).say
      assert.isFalse(privacy.mayReveal("p-sam", SAM))
      assert.strictEqual(reply, language === "en" ? "Snoozed." : "Uitgesteld.")
      assert.strictEqual((yield* theRow(k)).value.ring?.snoozeUntil, now + (entry === "action" ? 40 : 37) * MIN)
      assert.deepStrictEqual(yield* openNotes(k), [])
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown(SAM), [])
    }))
  }

  for (const entry of ["notification", "action"]) it.effect(`2: ${entry} refuses an older Snooze while a newer delivery is owed`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" } })
    yield* k.tool("reminders_set", { text: "pills", when: "every day at 11 am", scope: "household" }, as)
    const first = (yield* theRow(k)).value.dueAt!
    yield* k.stop
    yield* k.advance(first - (yield* k.now) + 60 * MIN)
    yield* k.start
    yield* k.advance(1_000)
    yield* k.present.settle
    const old = (yield* openNotes(k))[0]!
    f.sendFails = 1
    yield* k.advance(first + DAY - (yield* k.now) + 1_000)
    assert.strictEqual(f.sendFails, 0)
    const before = yield* theRow(k), jobs = yield* jobOf(k, before.id)
    assert.strictEqual(before.value.ring?.at, first)
    assert.strictEqual(before.value.owed?.at, first + DAY)
    const reply = entry === "action"
      ? actionSay(yield* k.action("ringing_snooze", {}, as))
      : (yield* k.notify.press(old.id, "snooze", as)).say
    assert.strictEqual(reply, "A newer reminder is waiting for delivery. Snooze that one when it arrives.")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.deepStrictEqual(yield* jobOf(k, before.id), jobs)
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.id), [old.id])
    yield* k.advance(MIN)
    const fresh = (yield* openNotes(k))[0]!
    assert.notStrictEqual(fresh.id, old.id)
    yield* k.notify.press(fresh.id, "done", as)
    yield* k.advance(10 * MIN)
    assert.deepStrictEqual(yield* openNotes(k), [])
    assert.strictEqual((yield* theRow(k)).value.dueAt, first + 2 * DAY)
    yield* assertJob(k, before.id, { future: true })
  }))

  for (const operation of ["change", "cancel"]) it.effect(`3: committed ${operation} confirms success after one cleanup read failure`, () => Effect.gen(function*() {
    let armed = false, failRead = false, failures = 0
    const mod = { ...remindersModule, shared: (ctx: any) => remindersModule.shared!({ ...ctx, store: { ...ctx.store,
      transaction: (f: any) => Effect.tap(ctx.store.transaction(f), () => Effect.sync(() => { if (armed) { armed = false; failRead = true } })),
      collection: (c: any) => { const h = ctx.store.collection(c); return { ...h, get: (id: string) => Effect.suspend(() => {
        if (failRead) { failRead = false; failures++; return Effect.fail(new StoreError({ reason: "busy", message: "one cleanup read failed" })) }
        return h.get(id)
      }) } }
    } }) }
    const k = yield* startTestModule(mod)
    yield* ring(k, "call mum", "in a minute", "household")
    armed = true
    const result = yield* k.tool(`reminders_${operation}`, { which: "call mum", ...(operation === "change" ? { text: "call dad" } : {}) }, as)
    assert.strictEqual(failures, 1)
    assert.isTrue(result.ok)
    assert.strictEqual(spoken(result), `${operation === "change" ? "Changed it: call dad. The new words are waiting for delivery." : "Cancelled: call mum."} Its ring is still being taken down; I'll keep trying.`)
    const saved = yield* theRow(k)
    assert.isDefined(saved.value.stop)
    assert.strictEqual(saved.value.state, operation === "change" ? "open" : "cancelled")
    assert.strictEqual(saved.value.text, operation === "change" ? "call dad" : "call mum")
    yield* assertJob(k, saved.id)
    yield* k.advance(6_100)
    const after = (yield* theRow(k)).value
    assert.isUndefined(after.stop)
    const notes = yield* openNotes(k)
    if (operation === "change") assert.strictEqual(notes[0]?.text, "call dad")
    else assert.deepStrictEqual(notes, [])
  }))

  for (const operation of ["change", "cancel"]) it.effect(`3: ${operation} still reports a genuine failed write`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* ring(k, "call mum", "in a minute", "household")
    const before = yield* theRow(k), jobs = yield* jobOf(k, before.id), notes = yield* openNotes(k)
    f.failTransactions = 1
    const reply = yield* k.tool(`reminders_${operation}`, { which: "call mum", ...(operation === "change" ? { text: "call dad" } : {}) }, as)
    assert.isFalse(reply.ok)
    assert.include(reply.content, "I couldn't save that reminder")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.deepStrictEqual(yield* jobOf(k, before.id), jobs)
    assert.deepStrictEqual(yield* openNotes(k), notes)
  }))

  for (const language of ["en", "nl"]) for (const count of [0, 2]) it.effect(`4: Snooze gives a usable reply for ${count} reminders (${language})`, () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule, { household: { home: { HOME_LANGUAGE: language } } })
    const phrase = language === "en" ? "snooze the reminder" : "stel de herinnering uit"
    const none = language === "en" ? "No reminder is waiting for an answer on this device." : "Op dit apparaat wacht geen herinnering op een antwoord."
    const several = language === "en" ? "More than one reminder is waiting here. Use the Snooze button on the notification you mean." : "Hier wachten meer herinneringen op een antwoord. Gebruik de knop Uitstellen op de bedoelde melding."
    for (const text of ["bins", "pills"].slice(0, count)) yield* k.tool("reminders_set", { text, when: language === "en" ? "in a minute" : "over een minuut", scope: "household" }, as)
    yield* k.advance(MIN + 1_000)
    const rows = yield* allRows(k), jobs = yield* k.jobs, notes = yield* openNotes(k)
    assert.strictEqual(notes.length, count)
    yield* k.phrases.say(phrase, as)
    assert.strictEqual(k.phrases.spoken.at(-1)?.text, count === 0 ? none : several)
    assert.strictEqual((yield* k.tool("reminders_ringing_snooze", {}, as)).value, count === 0 ? none : several)
    assert.include(spoken(yield* k.tool("reminders_done", {}, as)), language === "en" ? "Say which one you mean" : "Zeg welke je bedoelt")
    assert.deepStrictEqual(yield* allRows(k), rows)
    assert.deepStrictEqual(yield* k.jobs, jobs)
    assert.deepStrictEqual(yield* openNotes(k), notes)
    if (count > 0) {
      yield* k.notify.press(notes[0]!.id, "snooze", as)
      assert.strictEqual((yield* openNotes(k)).length, 1)
    }
  }))
})
