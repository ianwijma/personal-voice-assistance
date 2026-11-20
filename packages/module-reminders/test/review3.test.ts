import { assert, describe, it, vi } from "@effect/vitest"
import { type ActionRunResult } from "@pva/core"
import { DEFAULT_TEST_HOUSEHOLD, startTestModule } from "@pva/core/testing"
import { Deferred, Effect, Fiber } from "effect"
import { reminders, remindersModule } from "../src/index.ts"
import { allRows, assertJob, DAY, faulty, gather, H, MIN, nofaults, openNotes, ring, SAM, spoken, theRow } from "./helpers.ts"

vi.setConfig({ testTimeout: 180_000 })
const as = { device: SAM }
const actionSay = (r: ActionRunResult) => r.ok ? r.say ?? "" : r.message
const attemptedRing = (k: Parameters<typeof ring>[0], text = "call mum", when = "in a minute") => Effect.gen(function*() {
  yield* k.tool("reminders_set", { text, when, scope: "household" }, as)
  yield* k.advance((yield* theRow(k)).value.dueAt! - (yield* k.now) + 1_000)
  yield* k.present.settle
  return (yield* openNotes(k))[0]!
})
const crash = (f: ReturnType<typeof nofaults>) => { f.afterSend = () => { f.afterSend = undefined; f.failTransactions = 1 } }

// The correctness review's numbered sequences. These assertions were run against the unchanged source first.
describe("review round 3", () => {
  for (const tool of ["cancel", "change", "done"]) for (const which of ["appointment", "appointment therapy"]) {
    it.effect(`1: ${tool} rechecks privacy after finished-row reads (${which})`, () => Effect.gen(function*() {
      const f = nofaults(), k = yield* startTestModule(faulty(f))
      for (const text of ["appointment therapy", "appointment oncology"]) yield* k.tool("reminders_set", { text, when: "every Monday at 9 am" }, as)
      const before = yield* allRows(k)
      f.onRead = (q) => { if (q.where?.state === "done") f.reveal = () => false }
      const r = yield* k.tool(`reminders_${tool}`, { which, ...(tool === "change" ? { text: "new words" } : {}) }, as)
      assert.notInclude(r.content, "therapy")
      assert.notInclude(r.content, "oncology")
      assert.deepStrictEqual(yield* allRows(k), before)
    }))
  }
  it.effect("1: personal disambiguation and named Done carry the owner", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    for (const text of ["appointment therapy", "appointment oncology"]) yield* k.tool("reminders_set", { text, when: "every Monday at 9 am" }, as)
    yield* k.tool("reminders_cancel", { which: "appointment" }, as)
    assert.strictEqual(f.results.reminders_cancel.owner, "p-sam")
    yield* k.tool("reminders_done", { which: "therapy" }, as)
    assert.strictEqual(f.results.reminders_done.owner, "p-sam")
  }))
  it.effect("2: public creation confirmations disclose neither title nor schedule", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule, { household: { devices: [...DEFAULT_TEST_HOUSEHOLD.devices, { id: "lobby-screen", name: "Lobby", privacy: "public", defaultPerson: "p-sam" }] } })
    for (const when of ["every Tuesday at 9 am", "tomorrow at 8 pm"]) {
      assert.strictEqual(spoken(yield* k.tool("reminders_set", { text: "appointment", when }, { device: "lobby-screen" })), "Reminder set, only for you. This device does not ring with your personal reminders.")
    }
    assert.strictEqual(actionSay(yield* k.action("remind_in", { text: "appointment", delay: "an hour" }, { device: "lobby-screen" })), "Reminder set, only for you. This device does not ring with your personal reminders.")
  }))
  for (const text of ["door code １２３４", "door code ٤٢٤٢", "PIN 42"]) {
    it.effect(`3: refuses credential value ${text} on all entry points`, () => Effect.gen(function*() {
      const k = yield* startTestModule(remindersModule)
      yield* k.tool("reminders_set", { text: "plain", when: "in an hour" }, as)
      for (const [tool, input] of [["set", { text, when: "in an hour" }], ["change", { which: "plain", text }], ["cancel", { which: text }], ["done", { which: text }]] as const) {
        assert.strictEqual(spoken(yield* k.tool(`reminders_${tool}`, input, as)), "I don't keep codes or passwords in reminders.")
      }
      assert.strictEqual(actionSay(yield* k.action("remind_in", { text, delay: "an hour" }, as)), "I don't keep codes or passwords in reminders.")
      assert.deepStrictEqual((yield* allRows(k)).map(r => r.value.text), ["plain"])
    }))
  }
  it.effect("3: a lookup never repeats an explicitly stated PIN", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    assert.strictEqual(spoken(yield* k.tool("reminders_cancel", { which: "my PIN is 1234" }, as)), "I don't keep codes or passwords in reminders.")
  }))
  for (const edit of [false, true]) it.effect(`4: ${edit ? "editing" : "answering"} yesterday preserves today's pending occurrence`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" } })
    yield* k.tool("reminders_set", { text: "pills", when: "every day at 11 am", scope: "household" }, as)
    const first = (yield* theRow(k)).value.dueAt!
    yield* k.stop
    yield* k.advance(first - (yield* k.now) + H)
    yield* k.start
    yield* k.advance(1_000)
    const [old] = yield* openNotes(k)
    f.sendFails = 1
    yield* k.advance(first + DAY - (yield* k.now) + 1_000)
    if (edit) yield* k.tool("reminders_change", { which: "pills", text: "vitamins" }, as)
    else yield* k.notify.press(old!.id, "done", as)
    assert.strictEqual((yield* theRow(k)).value.owed?.at, first + DAY)
    yield* assertJob(k, (yield* theRow(k)).id, { future: true })
    yield* k.advance(MIN)
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.text), [edit ? "vitamins" : "pills"])
    assert.strictEqual((yield* theRow(k)).value.ring?.at, first + DAY)
  }))
  it.effect("5: a voice answer selected before card Done cannot skip tomorrow", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* attemptedRing(k, "daily", "every day at 11 am")
    const next = (yield* theRow(k)).value.dueAt
    f.listGate = yield* Deferred.make<void>(); f.listEntered = yield* Deferred.make<void>()
    const voice = yield* Effect.forkChild(k.action("ringing_done", {}, as))
    yield* Deferred.await(f.listEntered)
    yield* k.present.press(k.present.shown(SAM)[0]!.id, "done", as)
    yield* Deferred.succeed(f.listGate, undefined)
    const answer = yield* Fiber.join(voice)
    assert.notInclude(actionSay(answer), "skip")
    assert.strictEqual((yield* theRow(k)).value.dueAt, next)
  }))
  it.effect("5: repeating named Done retries outstanding cleanup before skipping", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* attemptedRing(k, "daily", "every day at 11 am")
    const next = (yield* theRow(k)).value.dueAt
    f.resolveFails = 1
    yield* k.tool("reminders_done", { which: "daily" }, as)
    assert.notInclude(spoken(yield* k.tool("reminders_done", { which: "daily" }, as)), "skip")
    assert.strictEqual((yield* theRow(k)).value.dueAt, next)
    assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  for (const cancel of [true, false]) it.effect(`7: admission reserves ringing reminders' cleanup capacity for ${cancel ? "cancel" : "Done"}`, () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    const n = yield* ring(k, "pills", "in a minute", "household")
    for (let i = 0; i < 199; i++) yield* k.tool("reminders_set", { text: `later ${i}`, when: "in five hours", scope: "household" }, as)
    const r = cancel ? yield* k.tool("reminders_cancel", { which: "pills" }, as) : yield* k.notify.press(n.id, "done", as)
    assert.isTrue(cancel ? spoken(r as any).startsWith("Cancelled:") : (r as any).say === "Done.")
    assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  it.effect("8: editing an attempted delivery cleans up its old words before retry", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    crash(f)
    yield* attemptedRing(k)
    yield* k.tool("reminders_change", { which: "mum", text: "call dad" }, as)
    yield* k.advance(MIN)
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.text), ["call dad"])
  }))
  it.effect("9: Snooze accepts a delivered attempt whose ring write failed", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    crash(f)
    const n = yield* attemptedRing(k)
    assert.strictEqual((yield* k.notify.press(n.id, "snooze", as)).say, "I'll remind you again in 10 minutes.")
    const until = (yield* k.now) + 10 * MIN
    assert.strictEqual((yield* theRow(k)).value.ring?.snoozeUntil, until)
    assert.isUndefined((yield* theRow(k)).value.owed)
    yield* k.advance(MIN)
    assert.deepStrictEqual(yield* openNotes(k), [])
    yield* k.advance(9 * MIN)
    assert.strictEqual((yield* openNotes(k)).length, 1)
  }))
  it.effect("10: old Snooze replay cannot silence a fresh delivery; its own card works", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* attemptedRing(k, "pills")
    const row = yield* theRow(k), old = k.present.shown(SAM)[0]!
    const input = { presentationId: old.id, key: `due:${row.id}:${row.value.ring!.at}`, deviceId: SAM, action: "snooze" }
    yield* k.present.press(old.id, "snooze", as)
    yield* k.advance(10 * MIN + 1)
    yield* k.present.settle
    const fresh = k.present.shown(SAM)[0]!
    yield* (f.handlers["present:reminders"].run(input) as Effect.Effect<unknown>)
    assert.strictEqual((yield* openNotes(k)).length, 1)
    assert.isUndefined((yield* theRow(k)).value.ring?.snoozeUntil)
    assert.strictEqual((yield* k.present.press(fresh.id, "snooze", as)).say, "I'll remind you again in 10 minutes.")
  }))
  it.effect("13: failed notification read after Stop refuses edit without redelivery", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    const n = yield* ring(k, "call mum", "in a minute", "household")
    yield* k.notify.press(n.id, "stop", as)
    f.listFails = 1
    const changed = yield* k.tool("reminders_change", { which: "mum", text: "call dad" }, as)
    assert.include(changed.content, "couldn't")
    assert.strictEqual((yield* theRow(k)).value.text, "call mum")
    yield* k.advance(MIN)
    assert.deepStrictEqual(yield* openNotes(k), [])
  }))
  it.effect("14: spoken list and briefing retain full count and remainder past 100", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    const now = yield* k.now, s = k.moduleStore().collection(reminders)
    for (let i = 0; i < 101; i++) yield* s.insert({ text: `task ${i}`, whose: "household", state: "open", dueAt: now + H + i * 1_000, nextAt: now + H + i * 1_000 })
    yield* k.tool("reminders_list", {}, as)
    assert.strictEqual(f.results.reminders_list.present.spoken, "101 reminders.")
    assert.match((yield* gather(k, SAM)).sentences[0], /and 99 more\.$/)
    for (let i = 101; i < 205; i++) yield* s.insert({ text: `task ${i}`, whose: "household", state: "open", dueAt: now + H + i * 1_000, nextAt: now + H + i * 1_000 })
    yield* k.tool("reminders_list", {}, as)
    assert.include(f.results.reminders_list.present.spoken, "there are more")
  }))
  it.effect("15: exact emoji matches are actionable and duplicates stay ambiguous", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    yield* k.tool("reminders_set", { text: "💊", when: "in an hour", scope: "household" }, as)
    assert.strictEqual(spoken(yield* k.tool("reminders_cancel", { which: "💊" }, as)), "Cancelled: 💊.")
    for (let i = 0; i < 2; i++) yield* k.tool("reminders_set", { text: "💊", when: "in an hour", scope: "household" }, as)
    assert.include(spoken(yield* k.tool("reminders_cancel", { which: "💊" }, as)), "Which reminder")
  }))
  it.effect("16: late snooze speaks the effective deadline", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    const n = yield* ring(k, "pills", "in a minute", "household")
    yield* k.notify.press(n.id, "snooze", as)
    yield* k.stop; yield* k.advance(20 * MIN); yield* k.start; yield* k.advance(1)
    assert.include((yield* openNotes(k))[0]!.text!, "ten twenty one")
  }))
  it.effect("16: editing a stopped final repeat never claims a next occurrence", () => Effect.gen(function*() {
    const k = yield* startTestModule(remindersModule)
    yield* k.tool("reminders_set", { text: "call mum", when: "every day at 11 am", scope: "household" }, as)
    const r = yield* theRow(k)
    yield* k.moduleStore().collection(reminders).update(r.id, v => ({ ...v, rrule: "FREQ=DAILY;COUNT=1" }))
    yield* k.advance(H + MIN)
    yield* k.notify.press((yield* openNotes(k))[0]!.id, "stop", as)
    const answer = spoken(yield* k.tool("reminders_change", { which: "mum", text: "call dad" }, as))
    assert.notInclude(answer, "next one")
    assert.include(answer, "was due")
  }))
})
