import { assert, describe, it, vi } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { remindersModule } from "../src/index.ts"
import { assertJob, DAY, faulty, gather, H, MIN, nofaults, openNotes, SAM, spoken, theRow } from "./helpers.ts"

vi.setConfig({ testTimeout: 180_000 })
const as = { device: SAM }

describe("GPT review Round 5", () => {
  for (const action of ["done", "snooze"]) it.effect(`1: timed-out ${action} keeps the pressed notification in durable cleanup`, () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    let armed = false, slow = false
    const mod = { ...remindersModule, shared: (ctx: any) => remindersModule.shared!({ ...ctx, store: { ...ctx.store,
      transaction: (f: any) => Effect.tap(ctx.store.transaction(f), () => Effect.sync(() => { if (armed) { armed = false; slow = true } })),
      collection: (c: any) => { const h = ctx.store.collection(c); return { ...h, get: (id: string) => Effect.suspend(() => {
        if (!slow) return h.get(id)
        slow = false
        return Effect.andThen(Deferred.succeed(entered, undefined), Effect.delay(h.get(id), "7 seconds"))
      }) } }
    } }) }
    const k = yield* startTestModule(mod, { settings: { snoozeMinutes: 1 } })
    yield* k.tool("reminders_set", { text: "call mum", when: "in a minute", scope: "household" }, as)
    yield* k.advance(MIN + 1_000)
    const old = (yield* openNotes(k))[0]!
    armed = true
    const press = yield* Effect.forkChild(k.notify.press(old.id, action, as))
    yield* Deferred.await(entered)
    const committed = yield* theRow(k)
    assert.deepStrictEqual(committed.value.stop?.notes, [committed.value.ring?.at ?? Number(old.key!.split(":").at(-1))])
    yield* assertJob(k, committed.id)
    yield* TestClock.adjust("6 seconds")
    assert.include((yield* Fiber.join(press)).say, "didn't work")
    yield* k.advance(1_000)
    assert.isFalse((yield* openNotes(k)).some(n => n.id === old.id))
    yield* k.advance(MIN)
    const notes = yield* openNotes(k)
    assert.strictEqual(notes.length, action === "done" ? 0 : 1)
    if (action === "snooze") assert.notStrictEqual(notes[0]!.id, old.id)
    yield* assertJob(k, committed.id)
  }))

  for (const action of ["done", "snooze"]) it.effect(`1: successful ${action} lets the host close its active claim before durable verification`, () => Effect.gen(function*() {
    let resolves = 0
    const mod = { ...remindersModule, shared: (ctx: any) => remindersModule.shared!({ ...ctx, notify: { ...ctx.notify,
      resolve: (...args: any[]) => { resolves++; return ctx.notify.resolve(...args) }
    } }) }
    const k = yield* startTestModule(mod)
    yield* k.tool("reminders_set", { text: "call mum", when: "in a minute", scope: "household" }, as)
    yield* k.advance(MIN + 1_000)
    const old = (yield* openNotes(k))[0]!
    const reply = yield* k.notify.press(old.id, action, as)
    assert.strictEqual(reply.say, action === "done" ? "Done." : "I'll remind you again in 10 minutes.")
    assert.strictEqual(resolves, 0, "the module never resolves the host's active claim inline")
    assert.deepStrictEqual(yield* openNotes(k), [])
    const row = yield* theRow(k)
    assert.deepStrictEqual(row.value.stop?.notes, [Number(old.key!.split(":").at(-1))])
    yield* assertJob(k, row.id, { future: true })
    yield* k.advance(6_100)
    assert.strictEqual(resolves, 1)
    assert.isUndefined((yield* theRow(k)).value.stop)
    yield* assertJob(k, row.id, { future: true })
  }))

  it.effect("2: editing an open unrecorded repeat delivery renews its retry window and preserves due time", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* k.tool("reminders_set", { text: "call mum", when: "every day at 11 am", scope: "household" }, as)
    const first = (yield* theRow(k)).value.dueAt!
    yield* k.stop
    yield* k.advance(first + 6 * H - 15_000 - (yield* k.now))
    f.afterSend = () => { f.afterSend = undefined; f.failTransactions = 1 }
    yield* k.start
    yield* k.advance(1_000)
    const before = yield* theRow(k), old = (yield* openNotes(k))[0]!
    assert.isUndefined(before.value.ring)
    assert.strictEqual(before.value.owed?.attempts, 1)
    const editedAt = yield* k.now
    const reply = yield* k.tool("reminders_change", { which: "call mum", text: "call dad" }, as)
    assert.include(spoken(reply), "new words are waiting for delivery")
    const edited = yield* theRow(k)
    assert.strictEqual(edited.value.owed?.from, editedAt)
    assert.strictEqual(edited.value.owed?.attempts, 0)
    yield* assertJob(k, edited.id)
    yield* k.advance(MIN)
    const notes = yield* openNotes(k), after = yield* theRow(k)
    assert.strictEqual(notes.length, 1)
    assert.notStrictEqual(notes[0]!.id, old.id)
    assert.strictEqual(notes[0]!.text, "call dad")
    assert.strictEqual(after.value.ring?.at, first)
    assert.isUndefined(after.value.owed)
    assert.strictEqual(after.value.dueAt, first + DAY)
    yield* k.present.settle
    assert.include(JSON.stringify(k.present.shown(SAM)[0]!.content), "11:00")
    yield* assertJob(k, after.id, { future: true })
  }))

  for (const language of ["en", "nl"]) it.effect(`3: older Snooze refusal describes a newer notification already visible (${language})`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" }, household: { home: { HOME_LANGUAGE: language } } })
    yield* k.tool("reminders_set", { text: "pills", when: language === "en" ? "every day at 11 am" : "elke dag om 11 uur", scope: "household" }, as)
    const first = (yield* theRow(k)).value.dueAt!
    yield* k.stop
    yield* k.advance(first + H - (yield* k.now))
    yield* k.start
    yield* k.advance(1_000)
    const old = (yield* openNotes(k))[0]!
    f.afterSend = () => { f.afterSend = undefined; f.failTransactions = 1 }
    yield* k.advance(first + DAY + 1_000 - (yield* k.now))
    const notes = yield* openNotes(k), before = yield* theRow(k)
    assert.strictEqual(notes.length, 2)
    const reply = yield* k.notify.press(old.id, "snooze", as)
    assert.strictEqual(reply.say, language === "en" ? "Use Snooze on the newer notification once you see it." : "Gebruik Uitstellen op de nieuwere melding zodra je die ziet.")
    assert.deepStrictEqual((yield* theRow(k)).value, before.value)
    assert.deepStrictEqual(yield* openNotes(k), notes)
    yield* k.advance(MIN)
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.id), [notes[1]!.id])
  }))

  it.effect("4: three long briefing items use two complete items when those fit", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    const words = ["Return the borrowed folding chairs to the community hall now", "Collect the blue presentation folders from the print shop now", "Confirm the delivery address for the replacement office chair"].map(text => text.slice(0, 60))
    for (const text of words) yield* k.tool("reminders_set", { text, when: "today at 11:25 am", scope: "household" }, as)
    const result = yield* gather(k, SAM, { maxSentences: 1 })
    const sentence = result.sentences[0]
    assert.strictEqual(words.filter(text => sentence.includes(`${text} at twenty five past eleven`)).length, 2)
    assert.match(sentence, / and one more\.$/)
    assert.isAtMost(sentence.length, 300)
  }))
})
