// The reminders module through the real host and gateway (docs/MODULES.md §17): every tool and action on its ordinary path
// and on its refusals, privacy on the shared, private and public devices of the default household, paging past one list
// page, the briefing's section, invalid settings, Dutch. Delivery, the row's state and its one job: delivery.test.ts.
import { assert, describe, it, vi } from "@effect/vitest"
import { DEFAULT_TEST_HOUSEHOLD, checkModule, startTestModule } from "@pva/core/testing"
import { speakTime } from "@pva/language"
import { Effect } from "effect"
import { catalog, holdsSecret, type Reminder, reminders, remindersModule, texts } from "../src/index.ts"
import {
  type Kit, allRows, DAY, faulty, forModel, gather, H, HALL, jobOf, liveJobs, MIN, nofaults, openNotes, ring, ROBIN, rowByText, SAM, spoken, theRow
} from "./helpers.ts"

vi.setConfig({ testTimeout: 30_000 })

const lobby = { household: { devices: [...DEFAULT_TEST_HOUSEHOLD.devices, { id: "lobby-screen", name: "Lobby", room: "Lobby", privacy: "public" as const, defaultPerson: "p-sam" }] } }

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
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.owner, "p-sam")
      assert.strictEqual(row.value.whose, "personal")
      assert.strictEqual(row.value.deviceId, SAM)
      assert.strictEqual(row.value.dueAt, (yield* kit.now) + 10 * MIN)
      assert.strictEqual(row.value.nextAt, row.value.dueAt)
      // One job, for the row's next moment, with the turn's device and assistant.
      const [job] = yield* jobOf(kit, row.id)
      assert.strictEqual(job?.origin.deviceId, SAM)
      assert.strictEqual(job?.origin.assistantId, "jeff")
      assert.strictEqual(job?.dueAt, row.value.dueAt)
      assert.deepStrictEqual(job?.payload, { id: row.id })
      yield* kit.advance(9 * MIN)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      yield* kit.advance(2 * MIN)
      const [n] = yield* kit.notify.all
      assert.strictEqual(n?.priority, "ring")
      assert.strictEqual(n?.deviceId, SAM)
      assert.strictEqual(n?.owner, "p-sam")
      assert.strictEqual(n?.text, "call mum")
      assert.strictEqual(n?.key, `rem:${row.id}:${row.value.dueAt}`)
      assert.deepStrictEqual(n?.actions.map((a) => a.id), ["done", "snooze"])
      yield* kit.present.settle
      const [card] = kit.present.shown(SAM)
      assert.strictEqual(card?.content.kind, "card")
      assert.deepStrictEqual(kit.present.shown(HALL), [])
      // Delivered and waiting: the row holds the ring, and no job is left (nothing more is planned for it).
      const after = yield* theRow(kit)
      assert.deepStrictEqual(after.value.ring, { at: row.value.dueAt!, deliveredAt: row.value.dueAt! })
      assert.isUndefined(after.value.dueAt)
      assert.isUndefined(after.value.nextAt)
      assert.deepStrictEqual(yield* jobOf(kit, row.id), [])
    }))

  it.effect("for the household: no owner, and it rings on the device it was set on", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const set = yield* kit.tool("reminders_set", { text: "tidy up", when: "in five minutes", scope: "household" }, { device: HALL })
      assert.deepStrictEqual(set.value, { spoken: "Reminder for the household, today at five past ten in the morning: tidy up." })
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.whose, "household")
      assert.isUndefined(row.value.owner)
      yield* kit.advance(6 * MIN)
      const [n] = yield* kit.notify.all
      assert.isUndefined(n?.owner)
      assert.strictEqual(n?.deviceId, HALL)
    }))

  it.effect("a personal reminder with nobody known asks whose and writes nothing, and never repeats the words", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const asked = yield* kit.tool("reminders_set", { text: "private appointment", when: "in an hour", scope: "me" }, { device: HALL })
      assert.deepStrictEqual(asked.value, { spoken: "Whose reminder is it? I can't tell who is asking here." })
      assert.notInclude(asked.content, "private appointment")
      assert.deepStrictEqual(yield* allRows(kit), [])
      const household = yield* kit.tool("reminders_set", { text: "bins", when: "in an hour" }, { device: HALL })
      assert.include(spoken(household), "for the household")
    }))

  it.effect("what is not clear is a question, never a guess; nothing is written", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const ask = (when: string) => kit.tool("reminders_set", { text: "x", when }, { device: ROBIN }).pipe(Effect.map(spoken))
      assert.strictEqual(yield* ask("tomorrow"), "At what time?")
      assert.strictEqual(yield* ask("yesterday at five"), "That moment has already passed.")
      assert.strictEqual(yield* ask("next Friday at five"), "That could mean more than one moment. Say the day and the time.")
      assert.strictEqual(yield* ask("whenever"), "When should I remind you? I didn't understand when.")
      assert.strictEqual(yield* ask("on 1 March 2028 at five"), "I only set reminders up to a year ahead.")
      assert.deepStrictEqual(yield* allRows(kit), [])
      assert.deepStrictEqual((yield* liveJobs(kit)).filter((j) => j.handler === "due"), [])
    }))

  it.effect("a repeat without a clock time asks at what time, in both languages, and stores nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text: "call mum", when: "every Monday" }, { device: SAM })), "At what time?")
      assert.strictEqual(spoken(yield* kit.tool("reminders_change", { which: "x", when: "every Monday" }, { device: SAM })), "At what time?")
      // With the time said, it is set.
      assert.include(spoken(yield* kit.tool("reminders_set", { text: "call mum", when: "every Monday at 9 am" }, { device: SAM })), "Repeating reminder")
      assert.strictEqual((yield* allRows(kit)).length, 1)
      const nl = yield* startTestModule(remindersModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(spoken(yield* nl.tool("reminders_set", { text: "bel mama", when: "elke maandag" }, { device: SAM })), "Hoe laat?")
      assert.deepStrictEqual(yield* allRows(nl), [])
    }))

  it.effect("a text that holds a password, a PIN or a code is refused on set, change and remind_in, without repeating it, and nothing is stored", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const secrets = ["my password is violet-badger", "my PIN is 1234", "door code is 12 34", "door code 12 34", "wifi password: hunter2", "alarm code = 4711", "enter password 123456"]
      for (const text of secrets) {
        const set = yield* kit.tool("reminders_set", { text, when: "in an hour" }, { device: SAM })
        assert.strictEqual(spoken(set), "I don't keep codes or passwords in reminders.", text)
        assert.notInclude(set.content, text.split(/\s+/).at(-1)!)
      }
      assert.deepStrictEqual(yield* allRows(kit), [])
      // Through the phrase's action too.
      const viaAction = yield* kit.action("remind_in", { delay: "five minutes", text: "my PIN is 1234" }, { device: SAM })
      assert.deepStrictEqual(viaAction, { ok: true, say: "I don't keep codes or passwords in reminders." })
      assert.deepStrictEqual(yield* allRows(kit), [])
      // A reminder about a password, without one, is an ordinary reminder; a change cannot put a secret into it.
      const ok = yield* kit.tool("reminders_set", { text: "change my password", when: "in an hour" }, { device: SAM })
      assert.include(spoken(ok), "change my password")
      const change = yield* kit.tool("reminders_change", { which: "password", text: "the new password is violet-badger" }, { device: SAM })
      assert.strictEqual(spoken(change), "I don't keep codes or passwords in reminders.")
      assert.notInclude(change.content, "violet-badger")
      const rows = yield* allRows(kit)
      assert.deepStrictEqual(rows.map((r) => r.value.text), ["change my password"])
      assert.notInclude(JSON.stringify(rows), "violet")
      // Dutch forms.
      for (const text of ["mijn wachtwoord is geheim", "de pincode: 1234", "deurcode 12 34"]) assert.isTrue(holdsSecret(text), text)
      for (const text of ["change my password", "call the PIN-free bank", "nieuw wachtwoord aanvragen", "pin the poster up"]) assert.isFalse(holdsSecret(text), text)
    }))

  it.effect("the confirmation does not repeat a personal reminder where the privacy rule says no, and says that device does not ring with it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, lobby)
      const set = yield* kit.tool("reminders_set", { text: "dentist", when: "in an hour", scope: "me" }, { device: "lobby-screen" })
      assert.deepStrictEqual(set.value, { spoken: "Reminder set for today at eleven o'clock in the morning, only for you. This device does not ring with your personal reminders.", owner: "p-sam" })
      assert.notInclude(set.content, "dentist")
      assert.strictEqual((yield* theRow(kit)).value.text, "dentist")
    }))

  it.effect("a reminder at the largest the schema allows is stored, with every field at its largest", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const text = "\"".repeat(160)
      const set = yield* kit.tool("reminders_set", { text: "é".repeat(160), when: "every weekday at 7 am" }, { device: ROBIN })
      assert.include(spoken(set), "Repeating reminder")
      const store = kit.moduleStore().collection(reminders)
      const E = 8_640_000_000_000_000
      const big: Reminder = {
        text, whose: "personal", owner: "p".repeat(40), state: "done", dueAt: E, owed: { at: E, from: E, attempts: 20, tryAt: E },
        ring: { at: E, deliveredAt: E, snoozeUntil: E }, stop: { notes: [E, E, E, E], card: true, attempts: 20, tryAt: E }, nextAt: E,
        deviceId: "\"".repeat(64), assistantId: "\"".repeat(40), setBy: "\"".repeat(40), rrule: "\"".repeat(100), dtstart: "\"".repeat(70),
        timeZone: "\"".repeat(64), handled: "\"".repeat(64), dropped: { at: E, why: "superseded", when: E }, endedAt: E
      }
      const stored = yield* store.insert(big)
      assert.strictEqual((yield* store.get(stored.id))?.value.endedAt, E)
    }))

  it.effect("too many reminders: the scheduler's limit is said, and nothing of the refused one is written", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      let last = ""
      let i = 0
      for (; i < 205; i++) {
        last = (yield* kit.tool("reminders_set", { text: `r${i}`, when: "in 50 hours", scope: "household" }, { device: SAM })).content
        if (last.startsWith("I'm already")) break
      }
      assert.include(last, "I'm already keeping as many reminders as I can.")
      // The refused one: no row, no job; everything before it is whole (one row and one job each).
      const rows = yield* allRows(kit)
      const jobs = yield* liveJobs(kit)
      assert.strictEqual(rows.length, i)
      assert.isUndefined(rows.find((r) => r.value.text === `r${i}`))
      assert.deepStrictEqual(new Set(jobs.filter((j) => j.handler === "due").map((j) => j.key)), new Set(rows.map((r) => `reminder:${r.id}`)))
      // Asking again changes nothing either.
      yield* kit.tool("reminders_set", { text: "one more", when: "in 50 hours", scope: "household" }, { device: SAM })
      assert.strictEqual((yield* allRows(kit)).length, i)
      assert.strictEqual((yield* liveJobs(kit)).length, jobs.length)
    }))
})

describe("phrase commands", () => {
  const ringOne = (kit: Kit) =>
    Effect.gen(function*() {
      yield* kit.tool("reminders_set", { text: "call mum", when: "in ten minutes" }, { device: SAM })
      yield* kit.advance(11 * MIN)
      yield* kit.present.settle
    })

  it.effect("done and snooze are said without the model, with the duration as the only slot", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* ringOne(kit)
      const snoozed = yield* kit.phrases.say("Snooze the reminder for twenty minutes", { device: SAM })
      assert.isTrue(snoozed.taken && snoozed.by === "command")
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["I'll remind you again in 20 minutes."])
      assert.strictEqual((yield* theRow(kit)).value.ring?.snoozeUntil, (yield* kit.now) + 20 * MIN)
      yield* kit.advance(21 * MIN)
      const plain = yield* kit.phrases.say("snooze the reminder", { device: SAM })
      assert.isTrue(plain.taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "I'll remind you again in 10 minutes.")
      yield* kit.advance(11 * MIN)
      const done = yield* kit.phrases.say("reminder done", { device: SAM })
      assert.isTrue(done.taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Done.")
      assert.strictEqual((yield* theRow(kit)).value.state, "done")
      assert.deepStrictEqual(yield* kit.phrases.say("done", { device: SAM }), { taken: false })
    }))

  it.effect("'remind me in … to …' is said without the model: a duration and the words, nothing guessed", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const said = yield* kit.phrases.say("Remind me in ten minutes to take the pizza out", { device: SAM })
      assert.isTrue(said.taken && said.by === "command")
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Reminder set for today at ten past ten in the morning: take the pizza out.")
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.text, "take the pizza out")
      assert.strictEqual(row.value.owner, "p-sam")
      yield* kit.phrases.say("remind me in an hour to water the plants", { device: HALL })
      assert.strictEqual((yield* rowByText(kit, "water the plants"))?.value.whose, "household")
      assert.deepStrictEqual(yield* kit.phrases.say("remind me at five to call mum", { device: SAM }), { taken: false })
      yield* kit.phrases.say("remind me in an hour to enter password 123456", { device: SAM })
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "I don't keep codes or passwords in reminders.")
      assert.strictEqual((yield* allRows(kit)).length, 2)
      const viaAction = yield* kit.action("remind_in", { delay: "five minutes", text: "stretch" }, { device: ROBIN })
      assert.deepStrictEqual(viaAction, { ok: true, say: "Reminder set for today at five past ten in the morning: stretch." })
    }))

  it.effect("while it rings, the label of a button is said without the wake phrase; nothing ringing, nothing taken", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      assert.deepStrictEqual(yield* kit.phrases.say("Done", { device: SAM, wake: false }), { taken: false })
      yield* ringOne(kit)
      const said = yield* kit.phrases.say("Done", { device: SAM, wake: false })
      assert.isTrue(said.taken && said.by === "ringing")
      assert.strictEqual((yield* theRow(kit)).value.state, "done")
    }))

  it.effect("in Dutch, and with nothing waiting it says so", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.isTrue((yield* kit.phrases.say("herinnering klaar", { device: SAM })).taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Op dit apparaat wacht geen herinnering op een antwoord. Zeg welke je bedoelt.")
      assert.isTrue((yield* kit.phrases.say("herinner me over tien minuten om te bellen", { device: SAM })).taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Herinnering gezet voor vandaag om tien over tien 's ochtends: te bellen.")
      yield* kit.advance(11 * MIN)
      assert.isTrue((yield* kit.phrases.say("stel de herinnering vijf minuten uit", { device: SAM })).taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Ik herinner je er over 5 minuten weer aan.")
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
      assert.deepStrictEqual((yield* kit.tool("reminders_cancel", { which: "call" }, { device: SAM })).value, { spoken: "Which reminder: call mum and call the dentist?" })
      assert.strictEqual((yield* allRows(kit)).filter((r) => r.value.state === "open").length, 3)
      assert.deepStrictEqual((yield* kit.tool("reminders_cancel", { which: "holiday" }, { device: SAM })).value, { spoken: "I don't have a reminder called holiday." })
      assert.deepStrictEqual((yield* kit.tool("reminders_cancel", { which: "dentist" }, { device: SAM })).value, { spoken: "Cancelled: call the dentist.", owner: "p-sam" })
      const dentist = (yield* rowByText(kit, "call the dentist"))!
      assert.strictEqual(dentist.value.state, "cancelled")
      // Marked, not removed; its job is gone, the others stay.
      assert.deepStrictEqual(yield* jobOf(kit, dentist.id), [])
      assert.strictEqual((yield* liveJobs(kit)).filter((j) => j.handler === "due").length, 2)
    }))

  it.effect("change: new words, a new time, or both; a new time replaces the job in one step; nothing to change asks", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* seed(kit)
      assert.deepStrictEqual((yield* kit.tool("reminders_change", { which: "plants" }, { device: SAM })).value, { spoken: "What should I change: the words or the time?" })
      const words = yield* kit.tool("reminders_change", { which: "plants", text: "water the garden" }, { device: SAM })
      assert.strictEqual(spoken(words), "Changed it: water the garden, tomorrow at seven o'clock in the morning.")
      const time = yield* kit.tool("reminders_change", { which: "garden", when: "in two hours" }, { device: SAM })
      assert.strictEqual(spoken(time), "Changed it: water the garden, today at noon.")
      const garden = (yield* rowByText(kit, "water the garden"))!
      assert.strictEqual(garden.value.dueAt, (yield* kit.now) + 2 * H)
      const [job] = yield* jobOf(kit, garden.id)
      assert.strictEqual(job?.dueAt, garden.value.dueAt)
      assert.strictEqual((yield* liveJobs(kit)).filter((j) => j.handler === "due").length, 3)
      const rep = yield* kit.tool("reminders_change", { which: "garden", when: "every Monday at 9 am" }, { device: SAM })
      assert.include(spoken(rep), "every Monday")
      assert.strictEqual((yield* rowByText(kit, "water the garden"))?.value.rrule, "FREQ=WEEKLY;BYDAY=MO")
      yield* kit.tool("reminders_change", { which: "garden", when: "tomorrow at nine am" }, { device: SAM })
      assert.isUndefined((yield* rowByText(kit, "water the garden"))?.value.rrule)
      const bad = yield* kit.tool("reminders_change", { which: "garden", when: "whenever" }, { device: SAM })
      assert.strictEqual(spoken(bad), "When should I remind you? I didn't understand when.")
    }))

  it.effect("new words while it rings: the old ring and card go, and it rings again with the new words for the same occurrence", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const first = yield* ring(kit, "call dad", "in ten minutes", "household")
      const row = yield* theRow(kit)
      const changed = yield* kit.tool("reminders_change", { which: "dad", text: "call sister" }, { device: SAM })
      assert.strictEqual(spoken(changed), "Changed it: call sister. It rings again now with the new words.")
      yield* kit.advance(1_000)
      yield* kit.present.settle
      const all = yield* kit.notify.all
      assert.strictEqual(all.find((n) => n.id === first.id)?.state, "resolved")
      const open = all.filter((n) => n.state === "open")
      assert.strictEqual(open.length, 1)
      assert.strictEqual(open[0]?.text, "call sister")
      assert.strictEqual(open[0]?.key, first.key)
      const [card] = kit.present.shown(SAM)
      assert.strictEqual(card?.content.kind === "card" ? card.content.text : "", "call sister")
      assert.strictEqual((yield* theRow(kit)).value.ring?.at, row.value.ring?.at)
    }))

  it.effect("a new time while it rings ends the ring: notification and card go, the new time is planned", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* ring(kit, "call dad", "in ten minutes", "household")
      const changed = yield* kit.tool("reminders_change", { which: "dad", when: "in two hours" }, { device: SAM })
      assert.strictEqual(spoken(changed), "Changed it: call dad, today at twelve eleven in the afternoon.")
      yield* kit.present.settle
      assert.deepStrictEqual(yield* openNotes(kit), [])
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      const row = yield* theRow(kit)
      assert.isUndefined(row.value.ring)
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, row.value.dueAt)
    }))

  it.effect("new words while it is snoozed: the confirmation says the snooze's time, which is kept", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const n = yield* ring(kit, "call dad", "in a minute", "household")
      assert.strictEqual((yield* kit.notify.press(n.id, "snooze", { device: SAM })).say, "I'll remind you again in 10 minutes.")
      const until = (yield* theRow(kit)).value.ring?.snoozeUntil
      const changed = yield* kit.tool("reminders_change", { which: "dad", text: "call sister" }, { device: SAM })
      // Snoozed at 10:11 for ten minutes: 10:21, not the occurrence's 10:01.
      assert.strictEqual(spoken(changed), "Changed it: call sister, today at ten twenty one in the morning.")
      assert.strictEqual((yield* theRow(kit)).value.ring?.snoozeUntil, until)
      yield* kit.advance(11 * MIN)
      assert.strictEqual((yield* openNotes(kit))[0]?.text, "call sister")
    }))

  it.effect("done by its words, and done for the one that is ringing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* seed(kit)
      assert.deepStrictEqual((yield* kit.tool("reminders_done", { which: "plants" }, { device: SAM })).value, { spoken: "Done." })
      assert.strictEqual((yield* rowByText(kit, "water the plants"))?.value.state, "done")
      assert.deepStrictEqual((yield* kit.tool("reminders_done", {}, { device: SAM })).value, { spoken: "No reminder is waiting for an answer on this device. Say which one you mean." })
    }))

  it.effect("done on a repeat that is not ringing skips its next occurrence, which does not ring; the one after does", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "stretch", when: "every day at 8 pm" }, { device: SAM })
      const tonight = (yield* theRow(kit)).value.dueAt!
      const done = yield* kit.tool("reminders_done", { which: "stretch" }, { device: SAM })
      assert.strictEqual(spoken(done), "Done: I'll skip the one today at eight o'clock in the evening. The next one is tomorrow at eight o'clock in the evening.")
      const row = yield* theRow(kit)
      assert.strictEqual(row.value.state, "open")
      assert.strictEqual(row.value.dueAt, tonight + DAY)
      assert.strictEqual((yield* jobOf(kit, row.id))[0]?.dueAt, tonight + DAY)
      yield* kit.advance(tonight - (yield* kit.now) + MIN)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      yield* kit.advance(DAY)
      assert.strictEqual((yield* openNotes(kit)).length, 1)
      // Done while it rings answers the ring, and the series goes on.
      assert.strictEqual(spoken(yield* kit.tool("reminders_done", { which: "stretch" }, { device: SAM })), "Done. The next one is tomorrow at eight o'clock in the evening.")
      assert.deepStrictEqual(yield* openNotes(kit), [])
    }))

  it.effect("a read that was cut short is said, never 'none'", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      for (let i = 0; i < 250; i++) yield* store.insert({ text: `item ${i}`, whose: "household", state: "open", dueAt: now + DAY + i, nextAt: now + DAY + i })
      const missing = yield* kit.tool("reminders_cancel", { which: "item 249" }, { device: SAM })
      assert.deepStrictEqual(missing.value, { spoken: "I found none in the first 204 open reminders; there are more." })
      const v = forModel(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.strictEqual(v.count, 204)
      assert.strictEqual(v.cut, "I read the first 204 open reminders; there are more.")
      assert.strictEqual(v.reminders.length, 5)
      assert.strictEqual(v.more, 199)
    }))

  it.effect("a cut read never treats a partial match as the only one: it asks and changes nothing; the exact words still work", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      // "call mum today" is read; "call mum today again" lies beyond the 204 rows one answer reads.
      yield* store.insert({ text: "call mum today", whose: "household", state: "open", dueAt: now + DAY, nextAt: now + DAY })
      for (let i = 1; i < 204; i++) yield* store.insert({ text: `other ${i}`, whose: "household", state: "open", dueAt: now + DAY + i, nextAt: now + DAY + i })
      yield* store.insert({ text: "call mum today again", whose: "household", state: "open", dueAt: now + 2 * DAY, nextAt: now + 2 * DAY })
      const before = yield* allRows(kit)
      const ask = "I read only the first 204 open reminders, so I can't be sure that is the only one. Say its exact words."
      // A partial match that is single in what was read.
      assert.strictEqual(spoken(yield* kit.tool("reminders_cancel", { which: "mum today" }, { device: SAM })), ask)
      assert.strictEqual(spoken(yield* kit.tool("reminders_change", { which: "mum today", text: "x" }, { device: SAM })), ask)
      assert.strictEqual(spoken(yield* kit.tool("reminders_done", { which: "mum today" }, { device: SAM })), ask)
      assert.deepStrictEqual(yield* allRows(kit), before)
      assert.strictEqual(spoken(yield* kit.tool("reminders_cancel", { which: "call mum today" }, { device: SAM })), "Cancelled: call mum today.")
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
      const kitchen = forModel(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.deepStrictEqual(kitchen.reminders.map((r: any) => r.text), ["Sam's dentist", "bins out"])
      assert.strictEqual(kitchen.covers, "yours and the household's")
      assert.strictEqual(kitchen.owner, "p-sam")
      const phone = forModel(yield* kit.tool("reminders_list", {}, { device: ROBIN }))
      assert.deepStrictEqual(phone.reminders.map((r: any) => r.text), ["Robin's vet", "bins out"])
      const hall = yield* kit.tool("reminders_list", {}, { device: HALL })
      assert.deepStrictEqual(forModel(hall).reminders.map((r: any) => r.text), ["bins out"])
      assert.strictEqual(forModel(hall).covers, "the household's reminders only; I can't tell who is asking")
      assert.notInclude(hall.content, "dentist")
      assert.notInclude(hall.content, "vet")
    }))

  it.effect("a public screen with a default person counts that person's reminders and reads none of them", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, lobby)
      yield* kit.tool("reminders_set", { text: "secret thing", when: "in two hours" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "second secret", when: "in three hours" }, { device: SAM })
      const l = yield* kit.tool("reminders_list", {}, { device: "lobby-screen" })
      assert.deepStrictEqual(l.value, { spoken: "2 personal reminders are not read out here." })
      assert.notInclude(l.content, "secret")
      yield* kit.tool("reminders_set", { text: "bins", when: "in an hour", scope: "household" }, { device: SAM })
      const mixed = forModel(yield* kit.tool("reminders_list", {}, { device: "lobby-screen" }))
      assert.deepStrictEqual(mixed.reminders.map((r: any) => r.text), ["bins"])
      assert.strictEqual(mixed.withheld, "2 personal reminders are not read out here.")
      assert.strictEqual(mixed.covers, "the household's reminders; yours are not read out here")
      const cancel = yield* kit.tool("reminders_cancel", { which: "secret" }, { device: "lobby-screen" })
      assert.strictEqual(spoken(cancel), "I don't have a reminder called secret. Personal reminders are not read out or changed here.")
      assert.strictEqual((yield* allRows(kit)).filter((r) => r.value.state === "open").length, 3)
    }))

  it.effect("the list is a presentation on the device that can show it, personal only where it may be shown", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* prepare(kit)
      const shown = forModel(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.isString(shown.screen)
      yield* kit.present.settle
      const [list] = kit.present.shown(SAM)
      assert.strictEqual(list?.content.kind, "list")
      assert.deepStrictEqual(list?.content.kind === "list" ? list.content.items.map((i) => i.text.split(" · ")[1]) : [], ["Sam's dentist", "bins out"])
      assert.deepStrictEqual(kit.present.shown(ROBIN), [])
      const empty = yield* startTestModule(remindersModule)
      const none = yield* empty.tool("reminders_list", {}, { device: SAM })
      assert.deepStrictEqual(none.value, { spoken: "You have no reminders." })
      assert.deepStrictEqual(empty.present.shown(SAM), [])
    }))

  it.effect("a list on the screen follows the reminders: replaced after a change, dismissed when none is left or the answer is empty", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      yield* kit.tool("reminders_set", { text: "dentist", when: "tomorrow at nine am", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "bins", when: "tomorrow at ten am", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_list", {}, { device: SAM })
      yield* kit.present.settle
      const items = () => kit.present.shown(SAM).flatMap((p) => (p.content.kind === "list" ? p.content.items.map((i) => i.text.split(" · ")[1]) : []))
      assert.deepStrictEqual(items(), ["dentist", "bins"])
      yield* kit.tool("reminders_cancel", { which: "dentist" }, { device: SAM })
      yield* kit.present.settle
      assert.deepStrictEqual(items(), ["bins"])
      yield* kit.tool("reminders_done", { which: "bins" }, { device: SAM })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(SAM), [])
      // Shown again, then an empty answer on the same page takes it down.
      yield* kit.tool("reminders_set", { text: "cake", when: "tomorrow at eleven am", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_list", {}, { device: SAM })
      yield* kit.present.settle
      assert.deepStrictEqual(items(), ["cake"])
      yield* kit.moduleStore().collection(reminders).update((yield* rowByText(kit, "cake"))!.id, (v) => ({ ...v, state: "cancelled" as const, endedAt: 1 }))
      assert.deepStrictEqual((yield* kit.tool("reminders_list", {}, { device: SAM })).value, { spoken: "You have no reminders." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(SAM), [])
    }))

  it.effect("a shown personal list that may no longer be shown there loses that person's reminders at its next change", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      yield* kit.tool("reminders_set", { text: "Sam's dentist", when: "tomorrow at nine am" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "bins", when: "tomorrow at ten am", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "cake", when: "tomorrow at eleven am", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_list", {}, { device: SAM })
      yield* kit.present.settle
      const items = () => kit.present.shown(SAM).flatMap((p) => (p.content.kind === "list" ? p.content.items.map((i) => i.text.split(" · ")[1]) : []))
      assert.deepStrictEqual(items(), ["Sam's dentist", "bins", "cake"])
      // The kitchen display's default person changed: Sam's reminders may not be shown there any more.
      faults.reveal = (owner) => (owner === "p-sam" ? false : undefined)
      yield* kit.tool("reminders_cancel", { which: "cake" }, { device: SAM })
      yield* kit.present.settle
      assert.notInclude(items(), "Sam's dentist")
    }))

  it.effect("a list item at the text's limit in characters outside the basic plane is shown whole or cut at a character, never split", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const pills = "💊".repeat(80)
      assert.include(spoken(yield* kit.tool("reminders_set", { text: pills, when: "tomorrow at nine am", scope: "household" }, { device: SAM })), "Reminder for the household")
      const v = forModel(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.notInclude(v.screen, "Not shown")
      yield* kit.present.settle
      const [list] = kit.present.shown(SAM)
      const text = list?.content.kind === "list" ? list.content.items[0]!.text : ""
      assert.isAtMost(text.length, 80)
      assert.isFalse(/[\ud800-\udbff](?![\udc00-\udfff])/.test(text))
      assert.isTrue(text.endsWith("💊…"))
    }))

  it.effect("soonest first by the moment each next speaks: a snoozed one is ordered by its snooze", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      // "first" rings at 10:01 and is snoozed at 10:11 for an hour (11:11); then one for 10:30 and one for noon.
      yield* ring(kit, "first", "in a minute", "household")
      assert.strictEqual(((yield* kit.action("ringing_snooze", { for: "an hour" }, { device: SAM })) as any).say, "I'll remind you again in 1 hour.")
      yield* kit.tool("reminders_set", { text: "second", when: "today at 10:30", scope: "household" }, { device: SAM })
      yield* kit.tool("reminders_set", { text: "third", when: "today at noon", scope: "household" }, { device: SAM })
      const v = forModel(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.deepStrictEqual(v.reminders.map((r: any) => r.text), ["second", "first", "third"])
      yield* kit.present.settle
      const [list] = kit.present.shown(SAM)
      assert.deepStrictEqual(list?.content.kind === "list" ? list.content.items.map((i) => i.text.split(" · ")[1]) : [], ["second", "first", "third"])
      // The briefing's order is the same.
      assert.deepStrictEqual((yield* gather(kit, HALL)).sentences, ["You have three reminders today: second at half past ten, first at eleven eleven and third at noon."])
    }))

  it.effect("a list past one page of rows is read in full (30 reminders), soonest first", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      for (let i = 29; i >= 0; i--) yield* store.insert({ text: `item ${i}`, whose: "household", state: "open", dueAt: now + DAY + i * MIN, nextAt: now + DAY + i * MIN })
      const v = forModel(yield* kit.tool("reminders_list", {}, { device: SAM }))
      assert.strictEqual(v.count, 30)
      assert.deepStrictEqual(v.reminders.map((r: any) => r.text), ["item 0", "item 1", "item 2", "item 3", "item 4"])
      assert.strictEqual(v.more, 25)
      assert.isUndefined(v.cut)
      assert.deepStrictEqual((yield* kit.tool("reminders_cancel", { which: "item 29" }, { device: SAM })).value, { spoken: "Cancelled: item 29." })
    }))
})

describe("the briefing's section", () => {
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
      const hall = yield* gather(kit, HALL)
      assert.deepStrictEqual(hall.sentences, ["You have a reminder today: bins out at seven o'clock."])
      assert.isUndefined(hall.owner)
      assert.notInclude(JSON.stringify(hall), "call mum")
    }))

  it.effect("a person's own on a public screen are counted, not named, and only those of today; a failed read is a failure; Dutch", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults), { household: { ...lobby.household, home: { HOME_LANGUAGE: "nl-NL" } } })
      // Tomorrow only: nothing today, so nothing is counted.
      yield* kit.tool("reminders_set", { text: "morgen iets", when: "morgen om negen uur 's ochtends" }, { device: SAM })
      assert.deepStrictEqual(yield* gather(kit, "lobby-screen", { language: "nl" }), { _tag: "empty" })
      // An unanswered one from before today is not today's either.
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      yield* store.insert({ text: "oud", whose: "personal", owner: "p-sam", state: "open", ring: { at: now - 2 * DAY, deliveredAt: now - 2 * DAY } })
      assert.deepStrictEqual(yield* gather(kit, "lobby-screen", { language: "nl" }), { _tag: "empty" })
      yield* kit.tool("reminders_set", { text: "bel mama", when: "vandaag om vijf uur 's middags" }, { device: SAM })
      assert.deepStrictEqual(yield* gather(kit, "lobby-screen", { language: "nl" }), { _tag: "section", sentences: [], priority: "normal", withheld: 1 })
      const own = yield* gather(kit, SAM, { language: "nl" })
      assert.strictEqual(own.sentences[0], "Je hebt vandaag een herinnering: bel mama om vijf uur.")
      faults.storeReads = true
      const failure = yield* Effect.flip(gather(kit, SAM, { language: "nl" }))
      assert.strictEqual((failure as { _tag: string })._tag, "BriefingSectionError")
    }))

  it.effect("a cut read is said in every shape: none found today, and the one-sentence count", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule)
      const store = kit.moduleStore().collection(reminders)
      const now = yield* kit.now
      // 204 old unanswered reminders come first (no next moment), then one due today.
      for (let i = 0; i < 204; i++) yield* store.insert({ text: `old ${i}`, whose: "household", state: "open", ring: { at: now - DAY, deliveredAt: now - DAY } })
      yield* store.insert({ text: "today", whose: "household", state: "open", dueAt: now + H, nextAt: now + H })
      const none = yield* gather(kit, SAM, { maxSentences: 1 })
      assert.deepStrictEqual(none, { _tag: "section", sentences: ["I couldn't read all the reminders; there may be some today."], priority: "normal", withheld: 0 })
      // With one of today's inside what is read, the one sentence says "at least".
      const kit2 = yield* startTestModule(remindersModule)
      const s2 = kit2.moduleStore().collection(reminders)
      for (let i = 0; i < 230; i++) yield* s2.insert({ text: `item ${i}`, whose: "household", state: "open", dueAt: now + H + i * 1000, nextAt: now + H + i * 1000 })
      const some = yield* gather(kit2, SAM, { maxSentences: 1 })
      assert.strictEqual(some.sentences.length, 1)
      assert.match(some.sentences[0], /^You have at least two hundred and four reminders today: .*; there may be more\.$/)
    }))

  it.effect("long items fit whole into one sentence at the limit, with an honest remainder, in English and Dutch", () =>
    Effect.gen(function*() {
      for (const [lang, home] of [["en", "en-GB"], ["nl", "nl-NL"]] as const) {
        for (const letters of [["a", "b", "c"], ["a", "b", "c", "d"]]) {
          const kit = yield* startTestModule(remindersModule, { household: { home: { HOME_LANGUAGE: home } } })
          const store = kit.moduleStore().collection(reminders)
          const now = yield* kit.now
          const at = now + H + 25 * MIN // 11:25
          for (const c of letters) yield* store.insert({ text: c.repeat(60), whose: "household", state: "open", dueAt: at, nextAt: at })
          const r = yield* gather(kit, SAM, { language: lang, maxSentences: 1 })
          const s: string = r.sentences[0]
          assert.isAtMost(s.length, 300, s)
          const time = speakTime({ hour: 11, minute: 25 }, lang)!
          // Three whole items in English are 300 characters and more: one item fewer, and the rest counted ("… and two more.").
          // Three fit in Dutch; four fit in neither.
          if (lang === "nl" && letters.length === 3) assert.isTrue(s.endsWith(` om ${time}.`), s)
          else assert.match(s, new RegExp(lang === "en" ? ` at ${time} and two more\\.$` : ` om ${time} en nog twee\\.$`))
          // Every item named is whole: its 60 letters and its time.
          for (const run of s.match(/([a-d])\1{9,}/g) ?? []) assert.strictEqual(run.length, 60, s)
        }
      }
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
      assert.strictEqual((yield* allRows(kit)).length, 1)
      assert.strictEqual((yield* liveJobs(kit)).filter((j) => j.handler === "due").length, 1)
      faults.storeReads = true
      assert.include((yield* kit.tool("reminders_list", {}, { device: SAM })).content, "I couldn't read the reminders.")
      assert.include((yield* kit.tool("reminders_cancel", { which: "bins" }, { device: SAM })).content, "I couldn't save that reminder.")
      faults.storeReads = false
      assert.strictEqual((yield* theRow(kit)).value.state, "open")
    }))

  it.effect("a press whose write fails changes nothing and says to try again; pressed again it works", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults))
      const n = yield* ring(kit, "bins", "in a minute", "household")
      faults.storeWrites = true
      assert.strictEqual((yield* kit.notify.press(n.id, "done", { device: SAM })).say, "That didn't work. Try again in a moment.")
      faults.storeWrites = false
      assert.strictEqual((yield* theRow(kit)).value.state, "open")
      assert.deepStrictEqual(yield* kit.notify.press(n.id, "done", { device: SAM }), { ok: true, say: "Done." })
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
})

describe("Dutch", () => {
  const nl = { household: { home: { HOME_LANGUAGE: "nl-NL" } } }

  it.effect("every path speaks Dutch: setting, questions, refusals, listing, changing, cancelling, done, snooze", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(remindersModule, nl)
      assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text: "bel mama", when: "over tien minuten" }, { device: SAM })), "Herinnering gezet voor vandaag om tien over tien 's ochtends: bel mama.")
      assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text: "x", when: "morgen" }, { device: SAM })), "Hoe laat?")
      assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text: "x", when: "gisteren om vijf uur" }, { device: SAM })), "Dat moment is al voorbij.")
      assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text: "x", when: "ooit" }, { device: SAM })), "Wanneer moet ik je herinneren? Ik begreep niet wanneer.")
      assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text: "wachtwoord 123456", when: "over een uur" }, { device: SAM })), "Ik bewaar geen codes of wachtwoorden in herinneringen.")
      assert.strictEqual(spoken(yield* kit.tool("reminders_set", { text: "x", when: "over een uur", scope: "me" }, { device: HALL })), "Van wie is de herinnering? Ik weet hier niet wie het vraagt.")
      const rep = spoken(yield* kit.tool("reminders_set", { text: "vuilnis", when: "elke maandag om zeven uur 's avonds", scope: "household" }, { device: SAM }))
      assert.include(rep, "Terugkerende herinnering voor het huishouden, elke maandag")
      assert.strictEqual(forModel(yield* kit.tool("reminders_list", {}, { device: SAM })).covers, "die van jou en van het huishouden")
      assert.strictEqual(spoken(yield* kit.tool("reminders_cancel", { which: "ooit" }, { device: SAM })), "Ik heb geen herinnering met ooit.")
      assert.strictEqual(spoken(yield* kit.tool("reminders_change", { which: "mama" }, { device: SAM })), "Wat moet ik veranderen: de woorden of de tijd?")
      const skip = spoken(yield* kit.tool("reminders_done", { which: "vuilnis" }, { device: SAM }))
      assert.match(skip, /^Klaar: ik sla die van .* over\. De volgende is .*\.$/)
      yield* kit.advance(11 * MIN)
      const [n] = yield* kit.notify.all
      assert.strictEqual(n?.title, "Herinnering")
      assert.deepStrictEqual(n?.actions.map((a) => a.label), ["Klaar", "Uitstellen"])
      assert.deepStrictEqual(yield* kit.notify.press(n!.id, "snooze", { device: SAM }), { ok: true, say: "Ik herinner je er over 10 minuten weer aan." })
      yield* kit.advance(11 * MIN)
      const second = (yield* openNotes(kit))[0]!
      assert.deepStrictEqual(yield* kit.notify.press(second.id, "done", { device: SAM }), { ok: true, say: "Klaar." })
      assert.strictEqual(spoken(yield* kit.tool("reminders_done", { which: "mama" }, { device: SAM })), "Ik heb geen herinnering met mama.")
      assert.strictEqual(spoken(yield* kit.tool("reminders_cancel", { which: "vuilnis" }, { device: SAM })), "Geannuleerd: vuilnis.")
      assert.deepStrictEqual((yield* kit.tool("reminders_list", {}, { device: SAM })).value, { spoken: "Je hebt geen herinneringen." })
    }))

  it.effect("the card, a change while it rings, a cleanup still owed and the failures in Dutch", () =>
    Effect.gen(function*() {
      const faults = nofaults()
      const kit = yield* startTestModule(faulty(faults), nl)
      yield* kit.tool("reminders_set", { text: "bel mama", when: "over een minuut" }, { device: SAM })
      yield* kit.advance(2 * MIN)
      yield* kit.present.settle
      const [card] = kit.present.shown(SAM)
      assert.strictEqual(card?.content.kind === "card" ? card.content.title : "", "Herinnering")
      assert.strictEqual(spoken(yield* kit.tool("reminders_change", { which: "mama", text: "bel papa" }, { device: SAM })), "Veranderd: bel papa. Hij gaat nu opnieuw af met de nieuwe woorden.")
      yield* kit.advance(1_000)
      faults.resolveFails = 1
      assert.strictEqual(spoken(yield* kit.tool("reminders_cancel", { which: "papa" }, { device: SAM })), "Geannuleerd: bel papa. De melding wordt nog weggehaald; ik blijf het proberen.")
      faults.storeReads = true
      assert.include((yield* kit.tool("reminders_list", {}, { device: SAM })).content, "Ik kon de herinneringen niet lezen.")
    }))
})
