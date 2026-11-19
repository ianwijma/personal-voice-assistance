// The timers module through the real host, gateway, scheduler, notification service and Presenter of the test kit:
// every action on its ordinary path and its refusals, which timer is meant, ringing with snooze and "five more
// minutes", the countdown on the screens of the room, phrase commands, Dutch, and a restart between two steps.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { timers, timersModule } from "../src/index.ts"

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const MIN = 60_000

/** A household with a second screen in the kitchen, so "every screen of its room" can be seen. */
const household = {
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-sam" },
    { id: "kitchen-tablet", name: "Kitchen tablet", room: "Kitchen", privacy: "shared" as const, defaultPerson: null },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: null }
  ]
}

describe("starting and asking", () => {
  it.effect("start: the echo, the row and its job in one go, the countdown on every screen of the room", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule, { household })
      assert.strictEqual(said(yield* kit.action("start", { duration: "10 minutes", name: "pasta" })), "Pasta timer, 10 minutes.")
      assert.strictEqual(said(yield* kit.action("start", { duration: "90 seconds" })), "Timer set for a minute and a half.")
      const rows = yield* kit.moduleStore().collection(timers).list({})
      assert.strictEqual(rows.length, 2)
      const jobs = (yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled")
      assert.strictEqual(jobs.length, 2)
      // The job rings on the device that asked: its origin.
      assert.isTrue(jobs.every((j) => j.origin.deviceId === "kitchen-display"))
      yield* kit.present.settle
      for (const device of ["kitchen-display", "kitchen-tablet"]) {
        const shown = kit.present.shown(device).map((p) => (p.content.kind === "timer" ? p.content.label : p.content.kind))
        assert.sameMembers(shown, ["Pasta timer", "Timer of a minute and a half"], device)
      }
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
      assert.deepStrictEqual(kit.present.shown("robins-phone"), [])
    }))

  it.effect("list: none, one, several, by name, and an unknown name", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      assert.strictEqual(said(yield* kit.action("list", {})), "No timers are running.")
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      yield* kit.advance(3 * MIN + 50_000)
      assert.strictEqual(said(yield* kit.action("list", {})), "Pasta timer: 6 minutes 10 seconds left.")
      yield* kit.action("start", { duration: "1 hour", name: "bread" })
      assert.strictEqual(said(yield* kit.action("list", {})), "2 timers: pasta timer with 6 minutes 10 seconds left and bread timer with 1 hour left.")
      assert.strictEqual(said(yield* kit.action("list", { name: "the bread timer" })), "Bread timer: 1 hour left.")
      assert.strictEqual(said(yield* kit.action("list", { name: "eggs" })), "I don't know a timer called eggs.")
      // Any device of the household may ask: timers are household data.
      assert.strictEqual(said(yield* kit.action("list", { name: "pasta" }, { device: "hall-screen" })), "Pasta timer: 6 minutes 10 seconds left.")
    }))

  it.effect("a second timer of a running name is refused, and the bounds of a name and a duration", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      assert.strictEqual(said(yield* kit.action("start", { duration: "5 minutes", name: "Pasta" })), "There is already a pasta timer, with 10 minutes left. Give the new one another name, or change that one.")
      assert.strictEqual(said(yield* kit.action("start", { duration: "5 minutes", name: "x".repeat(61) })), "A timer's name is one short line of at most 60 characters.")
      // Over a day: the duration parameter itself refuses it (the action's bounds), and nothing is stored.
      const long = yield* kit.action("start", { duration: "25 hours" })
      assert.isFalse(long.ok)
      assert.strictEqual((yield* kit.moduleStore().collection(timers).list({})).length, 1)
    }))
})

describe("which timer", () => {
  it.effect("by name, or the only one, or a question; never the first", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      assert.strictEqual(said(yield* kit.action("pause", {})), "Pasta timer paused with 10 minutes left.")
      yield* kit.advance(1_000)
      yield* kit.action("start", { duration: "6 minutes", name: "eggs" })
      assert.strictEqual(said(yield* kit.action("cancel", {})), "There are 2 timers: eggs timer with 6 minutes left and pasta timer paused with 10 minutes left. Which one?")
      // Nothing was cancelled by the question.
      assert.strictEqual((yield* kit.moduleStore().collection(timers).list({ where: { phase: "active" } })).length, 2)
      assert.strictEqual(said(yield* kit.action("cancel", { name: "eggs" })), "Eggs timer cancelled.")
      assert.strictEqual(said(yield* kit.action("resume", {})), "Pasta timer runs again: 10 minutes left.")
    }))
})

describe("adjust, pause, resume, cancel", () => {
  it.effect("adjust moves the job and the countdown; taking off too much is refused", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "5 minutes" })), "Pasta timer: a quarter of an hour left.")
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "20 minutes", change: "remove" })), "That would end it now: pasta timer has only a quarter of an hour left.")
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "3 minutes", change: "remove" })), "Pasta timer: 12 minutes left.")
      const live = (yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled")
      assert.strictEqual(live.length, 1)
      assert.strictEqual(live[0]!.dueAt, (yield* kit.now) + 12 * MIN)
      yield* kit.present.settle
      const [countdown] = kit.present.shown("kitchen-display")
      assert.strictEqual(countdown?.content.kind === "timer" ? countdown.content.endsAt : 0, (yield* kit.now) + 12 * MIN)
      // It rings at the new time, not the old one.
      yield* kit.advance(10 * MIN)
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      yield* kit.advance(2 * MIN)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
    }))

  it.effect("pause keeps what is left and takes the countdown down; resume starts it again; a paused timer never rings", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      yield* kit.advance(4 * MIN)
      assert.strictEqual(said(yield* kit.action("pause", { name: "pasta" })), "Pasta timer paused with 6 minutes left.")
      assert.strictEqual(said(yield* kit.action("pause", { name: "pasta" })), "Pasta timer is already paused, with 6 minutes left.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* kit.advance(30 * MIN)
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.strictEqual(said(yield* kit.action("list", {})), "Pasta timer: paused with 6 minutes left.")
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "1 minute" })), "Pasta timer: paused with 7 minutes left.")
      assert.strictEqual(said(yield* kit.action("resume", {})), "Pasta timer runs again: 7 minutes left.")
      assert.strictEqual(said(yield* kit.action("resume", {})), "Pasta timer is not paused; it has 7 minutes left.")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* kit.advance(7 * MIN)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
    }))

  it.effect("cancel: the job is cancelled, the countdown goes, and it never rings; cancel all", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      assert.strictEqual(said(yield* kit.action("cancel", {})), "Pasta timer cancelled.")
      assert.strictEqual(said(yield* kit.action("cancel", {})), "No timers are running.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* kit.advance(11 * MIN)
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      for (const name of ["a", "b", "c"]) yield* kit.action("start", { duration: "10 minutes", name })
      assert.strictEqual(said(yield* kit.action("cancel", { all: true })), "Cancelled 3 timers.")
      assert.strictEqual(said(yield* kit.action("cancel", { all: true })), "There were no timers to cancel.")
      assert.deepStrictEqual((yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled"), [])
    }))
})

describe("ringing", () => {
  it.effect("it rings on the device that set it, on time, with snooze and five more minutes beside stop", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule, { household })
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" }, { device: "kitchen-tablet" })
      const due = (yield* kit.now) + 10 * MIN
      yield* kit.advance(10 * MIN)
      const [ring] = kit.notify.engine.ringingOn("kitchen-tablet")
      assert.strictEqual(ring?.title, "Pasta timer is done")
      assert.deepStrictEqual(ring?.actions.map((a) => [a.id, a.label]), [["snooze", "Snooze"], ["more", "Five more minutes"]])
      // Only there: not on the other kitchen screen.
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      const sent = (yield* kit.notify.all).find((n) => n.key?.startsWith("timer:"))
      assert.strictEqual(sent?.sentAt, due)
      assert.strictEqual(sent?.text, "The 10 minutes timer has ended.")
      // The countdown is gone; the list says it rings.
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-tablet"), [])
      assert.strictEqual(said(yield* kit.action("list", {})), "Pasta timer is ringing.")
      // "Stop the timer" (cancel) stops it.
      assert.strictEqual(said(yield* kit.action("cancel", {})), "Pasta timer stopped.")
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-tablet"), [])
      assert.strictEqual(said(yield* kit.action("list", {})), "No timers are running.")
    }))

  it.effect("snooze rings again after the setting's minutes; five more minutes counts down again; each once per notification", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule, { settings: { snoozeMinutes: 3 } })
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      const [first] = kit.notify.engine.ringingOn("kitchen-display")
      assert.deepStrictEqual(yield* kit.notify.press(first!.id, "snooze", { device: "kitchen-display" }), { ok: true, say: "Tea timer rings again in 3 minutes." })
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.strictEqual(said(yield* kit.action("list", {})), "Tea timer: snoozed, it rings again in 3 minutes.")
      yield* kit.advance(3 * MIN)
      const [second] = kit.notify.engine.ringingOn("kitchen-display")
      assert.notStrictEqual(second?.id, first?.id)
      assert.deepStrictEqual(yield* kit.notify.press(second!.id, "more", { device: "kitchen-display" }), { ok: true, say: "Tea timer: five more minutes." })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* kit.advance(5 * MIN)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
    }))

  it.effect("stop is the host's: the ring ends, and the timer is done", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "1 minute" })
      yield* kit.advance(MIN)
      const [ring] = kit.notify.engine.ringingOn("kitchen-display")
      assert.isTrue((yield* kit.notify.press(ring!.id, "stop", { device: "kitchen-display" })).ok)
      assert.strictEqual(said(yield* kit.action("list", {})), "No timers are running.")
      assert.strictEqual((yield* kit.moduleStore().collection(timers).list({})).at(0)?.value.state, "done")
    }))

  it.effect("a timer given more time while it rings runs again for that long", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "1 minute", name: "eggs" })
      yield* kit.advance(MIN)
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "2 minutes" })), "Eggs timer runs again: 2 minutes.")
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      yield* kit.advance(2 * MIN)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      assert.strictEqual(said(yield* kit.action("pause", {})), "Eggs timer is ringing; say stop to end it.")
    }))
})

describe("where it rings and shows", () => {
  it.effect("changed from another device, it still rings on its own; while it rings, its button's label said without the wake phrase presses it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule, { household })
      yield* kit.action("start", { duration: "2 minutes", name: "eggs" }, { device: "kitchen-tablet" })
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "1 minute", change: "remove" }, { device: "robins-phone", conversationId: "c-robin" })), "Eggs timer: 1 minute left.")
      const jobs = (yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled")
      assert.deepStrictEqual(jobs.map((j) => j.origin.deviceId), ["kitchen-tablet"])
      yield* kit.advance(MIN)
      assert.deepStrictEqual(kit.notify.engine.ringingOn("robins-phone"), [])
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-tablet").length, 1)
      // The ringing window: "five more minutes", said on that device with no wake phrase, is the card's button.
      const taken = yield* kit.phrases.say("Five more minutes", { device: "kitchen-tablet", wake: false })
      assert.isTrue(taken.taken && taken.by === "ringing")
      assert.strictEqual(said(yield* kit.action("list", {})), "Eggs timer: 5 minutes left.")
    }))

  it.effect("a ninth running timer runs and rings without a countdown (the Presenter keeps 8 per module)", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      for (let i = 1; i <= 9; i++) yield* kit.action("start", { duration: `${i} minutes`, name: `t${i}` })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 8)
      yield* kit.advance(9 * MIN)
      assert.isTrue((yield* kit.notify.all).some((n) => n.title === "T9 timer is done"))
    }))
})

describe("phrase commands", () => {
  it.effect("set, ask and cancel without the model, with a name as text", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      assert.isTrue((yield* kit.phrases.say("Set a pasta timer for ten minutes.")).taken)
      assert.isTrue((yield* kit.phrases.say("how long is left on the pasta timer")).taken)
      assert.isTrue((yield* kit.phrases.say("set a timer for 5 minutes")).taken)
      assert.isTrue((yield* kit.phrases.say("cancel the pasta timer")).taken)
      assert.isTrue((yield* kit.phrases.say("how long is left")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [
        "Pasta timer, 10 minutes.",
        "Pasta timer: 10 minutes left.",
        "Timer set for 5 minutes.",
        "Pasta timer cancelled.",
        "Timer of 5 minutes: 5 minutes left."
      ])
      // Not one of its phrases: it goes on to the assistant.
      assert.deepStrictEqual(yield* kit.phrases.say("set a timer please for ten minutes"), { taken: false })
    }))

  it.effect("in Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule, { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } })
      assert.isTrue((yield* kit.phrases.say("zet een timer op tien minuten")).taken)
      yield* kit.advance(1_000)
      assert.isTrue((yield* kit.phrases.say("zet een eieren timer op zes minuten")).taken)
      assert.isTrue((yield* kit.phrases.say("hoe lang duurt de eieren timer nog")).taken)
      assert.isTrue((yield* kit.phrases.say("annuleer de timer")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [
        "Timer gezet op 10 minuten.",
        "Timer eieren, 6 minuten.",
        "Timer eieren: nog 6 minuten.",
        "Er zijn 2 timers: timer eieren met nog 6 minuten en timer van 10 minuten met nog 9 minuten 59 seconden. Welke bedoel je?"
      ])
    }))
})

describe("Dutch", () => {
  it.effect("every answer, the ringing card and its buttons", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule, { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } })
      assert.strictEqual(said(yield* kit.action("list", {})), "Er lopen geen timers.")
      assert.strictEqual(said(yield* kit.action("start", { duration: "10 minutes", name: "pasta" })), "Timer pasta, 10 minuten.")
      assert.strictEqual(said(yield* kit.action("pause", {})), "Timer pasta gepauzeerd, nog 10 minuten.")
      assert.strictEqual(said(yield* kit.action("resume", {})), "Timer pasta loopt weer: nog 10 minuten.")
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "5 minutes" })), "Timer pasta: nog een kwartier.")
      assert.strictEqual(said(yield* kit.action("list", { name: "eieren" })), "Ik ken geen timer die eieren heet.")
      yield* kit.advance(15 * MIN)
      const [ring] = kit.notify.engine.ringingOn("kitchen-display")
      assert.strictEqual(ring?.title, "Timer pasta is klaar")
      assert.deepStrictEqual(ring?.actions.map((a) => a.label), ["Snooze", "Nog vijf minuten"])
      assert.deepStrictEqual(yield* kit.notify.press(ring!.id, "more", { device: "kitchen-display" }), { ok: true, say: "Timer pasta: nog vijf minuten." })
      assert.strictEqual(said(yield* kit.action("cancel", { name: "pasta" })), "Timer pasta geannuleerd.")
    }))
})
