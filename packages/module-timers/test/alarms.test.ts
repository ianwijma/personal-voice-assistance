// The alarms module through the real host, gateway, scheduler and notification service of the test kit: once and
// repeating alarms, "only the next" or "all" (asked when not said), an alarm's name only on its own device, ringing with
// snooze and five more minutes, a repeating alarm across an outage and a restart, store failures, paging and Dutch.
import { assert, describe, it } from "@effect/vitest"
import { type JobRow, type ModuleStore, type Row, StoreError } from "@pva/core"
import { hooked, type Hooks, makeHooks, makeRegistered } from "./support.ts"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { type Alarm, alarms, alarmsModule, MAX_ALARMS } from "../src/index.ts"

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// The kit's clock starts on Wednesday 18 November 2026, 10:00 in Amsterdam (09:00 UTC).
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 1, minute)

/** Every row of a list, page by page (10 a page). */
const allOf = (list: (q: { readonly limit: number; readonly after?: Row<Alarm> }) => Effect.Effect<ReadonlyArray<Row<Alarm>>, unknown>) =>
  Effect.gen(function*() {
    const out: Array<Row<Alarm>> = []
    let after: Row<Alarm> | undefined
    for (;;) {
      const page = yield* Effect.orDie(list({ limit: 10, ...(after !== undefined ? { after } : {}) }))
      out.push(...page)
      if (page.length < 10) return out
      after = page.at(-1)
    }
  })
const rows = (kit: { moduleStore: () => ModuleStore }) => allOf((q) => kit.moduleStore().collection(alarms).list({ orderBy: { field: "createdAt", direction: "asc" }, ...q }))
/** The set alarms, the next to ring first. */
const setRows = (kit: { moduleStore: () => ModuleStore }) =>
  Effect.map(allOf((q) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, ...q })), (rs) => [...rs].sort((a, b) => (a.value.next?.at ?? 0) - (b.value.next?.at ?? 0)))
const liveJobs = (kit: { jobs: Effect.Effect<ReadonlyArray<JobRow>> }, handler = "due") =>
  Effect.map(kit.jobs, (jobs) => jobs.filter((j) => j.handler === handler && (j.state === "scheduled" || j.state === "running")))

describe("setting alarms", () => {
  it.effect("once: a bare time is the next morning's, never the evening's; said back with the day", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      assert.strictEqual(said(yield* kit.action("set", { when: "seven" })), "Alarm set for tomorrow at seven o'clock in the morning.")
      assert.strictEqual(said(yield* kit.action("set", { when: "6:45" })), "Alarm set for tomorrow at quarter to seven in the morning.")
      assert.strictEqual(said(yield* kit.action("set", { when: "8 pm", name: "bins" })), "Bins alarm set for today at eight o'clock in the evening.")
      const [first] = yield* setRows(kit)
      assert.strictEqual(first?.value.next?.at, at(18, 20))
      const jobs = yield* liveJobs(kit)
      assert.strictEqual(jobs.length, 3)
      assert.isTrue(jobs.every((j) => j.origin.deviceId === "kitchen-display"))
    }))

  it.effect("repeating: the rule, and the first one; a time is needed; a time past is refused", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      assert.strictEqual(said(yield* kit.action("set", { when: "every weekday at 6:45" })), "Alarm set every weekday; the first one is tomorrow at quarter to seven in the morning.")
      assert.strictEqual(said(yield* kit.action("set", { when: "6:30 every day", name: "gym" })), "Gym alarm set every day; the first one is tomorrow at half past six in the morning.")
      assert.strictEqual(said(yield* kit.action("set", { when: "every Monday" })), "At what time should the alarm ring?")
      assert.strictEqual(said(yield* kit.action("set", { when: "tomorrow" })), "At what time should the alarm ring?")
      assert.strictEqual(said(yield* kit.action("set", { when: "yesterday at 7" })), "That time has passed.")
      assert.strictEqual(said(yield* kit.action("set", { when: "next Friday at 7" })), "Which time do you mean? Say it once more, with the day or morning or evening.")
      assert.strictEqual(said(yield* kit.action("set", { when: "when the cows come home" })), "When should the alarm ring? Say a time, like seven tomorrow, or every weekday at quarter to seven.")
      assert.strictEqual(said(yield* kit.action("set", { when: "7", name: "a b" })), "An alarm's name is one short line of at most 60 characters.")
      const stored = yield* setRows(kit)
      assert.strictEqual(stored.length, 2)
      assert.strictEqual(stored[0]?.value.rrule, "FREQ=DAILY")
    }))

  it.effect("at most 50 alarms; the list reads past one store page", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      for (let i = 0; i < MAX_ALARMS; i++) yield* kit.action("set", { when: `${String(5 + Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}` })
      assert.include(said(yield* kit.action("set", { when: "9:00" }))!, "already set")
      assert.strictEqual(said(yield* kit.action("set", { when: "9:10" })), "There are already 50 alarms, the most I keep. Cancel one first.")
      assert.strictEqual(said(yield* kit.action("list", {})), "50 alarms: tomorrow at five o'clock at night, tomorrow at five past five at night, tomorrow at ten past five at night and 47 more.")
      // The last one, by its time, past the first pages.
      assert.strictEqual(said(yield* kit.action("cancel", { which: "9:05" })), "The alarm for tomorrow at five past nine in the morning is cancelled.")
    }))
})

describe("an alarm's name only on its own device", () => {
  it.effect("listed elsewhere by its time and its device; matched by name only where it rings", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "every weekday at 6:45", name: "pills" }, { device: "robins-phone" })
      assert.strictEqual(said(yield* kit.action("list", {}, { device: "robins-phone" })), "One alarm: pills tomorrow at quarter to seven in the morning, every weekday.")
      for (const device of ["kitchen-display", "hall-screen"]) {
        const answer = said(yield* kit.action("list", {}, { device }))
        assert.strictEqual(answer, "One alarm: tomorrow at quarter to seven in the morning on Robin's phone, every weekday.", device)
        assert.notInclude(answer!, "pills")
      }
      // Its name does not find it elsewhere (that would tell the name is there); its time does.
      assert.strictEqual(said(yield* kit.action("cancel", { which: "pills", scope: "all" }, { device: "kitchen-display" })), "Which alarm do you mean? Say its clock time and date, or say \"named\" followed by its name.")
      assert.strictEqual(said(yield* kit.action("cancel", { which: "quarter to seven", scope: "all" }, { device: "kitchen-display" })), "The alarm every weekday is cancelled.")
      // It rang nowhere and is gone.
      assert.deepStrictEqual(yield* setRows(kit), [])
    }))

  it.effect("it rings only on its own device, with its name there", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "seven", name: "pills" }, { device: "robins-phone" })
      yield* kit.advance(at(19, 7) - (yield* kit.now))
      const [ring] = kit.notify.engine.ringingOn("robins-phone")
      assert.strictEqual(ring?.title, "Pills alarm")
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.deepStrictEqual(kit.notify.engine.ringingOn("hall-screen"), [])
      assert.isTrue(kit.notify.decisions.filter((d) => d.decision.deliver).every((d) => d.deviceId === "robins-phone"))
    }))
})

describe("which alarm, and only the next or all", () => {
  it.effect("several: a question; a repeating one without a scope: a question; with it: done", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "every weekday at 6:45" })
      yield* kit.action("set", { when: "tomorrow at 9" })
      assert.strictEqual(said(yield* kit.action("cancel", {})), "There are 2 alarms: tomorrow at quarter to seven in the morning, every weekday and tomorrow at nine o'clock in the morning. Which one?")
      assert.strictEqual(said(yield* kit.action("cancel", { which: "6:45" })), "That alarm repeats every weekday. Only the next one, or all of them?")
      assert.strictEqual((yield* setRows(kit)).length, 2)
      // Only the next: tomorrow (Thursday) is skipped; the next is Friday.
      assert.strictEqual(said(yield* kit.action("cancel", { which: "6:45", scope: "next" })), "The alarm for tomorrow at quarter to seven in the morning is skipped; the next one is Friday at quarter to seven in the morning.")
      const series = (yield* setRows(kit)).find((r) => r.value.rrule !== undefined)!
      assert.strictEqual(series.value.next?.at, at(20, 6, 45))
      assert.strictEqual(said(yield* kit.action("cancel", { which: "nine" })), "The alarm for tomorrow at nine o'clock in the morning is cancelled.")
      assert.strictEqual(said(yield* kit.action("cancel", { scope: "all" })), "The alarm every weekday is cancelled.")
      assert.strictEqual(said(yield* kit.action("cancel", {})), "No alarms are set.")
      assert.deepStrictEqual(yield* liveJobs(kit), [])
      assert.strictEqual(said(yield* kit.action("cancel", { which: "10:30" })), "There is no alarm at half past ten in the morning.")
    }))

  it.effect("an alarm is not changed (finding 1, U1): there is no alarms_change; moving one is cancel, then set", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      assert.notInclude(kit.toolNames(), "alarms_change")
      assert.includeMembers(kit.toolNames(), ["alarms_set", "alarms_cancel", "alarms_list"])
      yield* kit.action("set", { when: "tomorrow at 9", name: "dentist" })
      assert.strictEqual(said(yield* kit.action("cancel", { which: "dentist" })), "The alarm for tomorrow at nine o'clock in the morning is cancelled.")
      assert.strictEqual(said(yield* kit.action("set", { when: "tomorrow at 8", name: "dentist" })), "Dentist alarm set for tomorrow at eight o'clock in the morning.")
      const set = yield* setRows(kit)
      assert.deepStrictEqual(set.map((r) => r.value.next?.at), [at(19, 8)])
      assert.strictEqual((yield* liveJobs(kit)).length, 1)
    }))
})

describe("ringing", () => {
  it.effect("a repeating alarm rings, plans the next one, and snooze and five more minutes ring it again once each", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule, { settings: { snoozeMinutes: 9 } })
      yield* kit.action("set", { when: "every day at 7" })
      yield* kit.advance(at(19, 7) - (yield* kit.now))
      const [ring] = kit.notify.engine.ringingOn("kitchen-display")
      assert.strictEqual(ring?.title, "Alarm")
      assert.deepStrictEqual(ring?.actions.map((a) => [a.id, a.label]), [["snooze", "Snooze"], ["more", "Five more minutes"]])
      assert.strictEqual((yield* kit.notify.all).at(-1)?.text, "It is seven o'clock in the morning.")
      // The next occurrence is planned at once.
      assert.strictEqual((yield* setRows(kit))[0]?.value.next?.at, at(20, 7))
      assert.deepStrictEqual(yield* kit.notify.press(ring!.id, "snooze", { device: "kitchen-display" }), { ok: true, say: "It rings again in 9 minutes." })
      yield* kit.advance(9 * MIN)
      const [again] = kit.notify.engine.ringingOn("kitchen-display")
      assert.notStrictEqual(again?.id, ring?.id)
      assert.deepStrictEqual(yield* kit.notify.press(again!.id, "more", { device: "kitchen-display" }), { ok: true, say: "Five more minutes." })
      yield* kit.advance(5 * MIN)
      const [third] = kit.notify.engine.ringingOn("kitchen-display")
      assert.isTrue((yield* kit.notify.press(third!.id, "stop", { device: "kitchen-display" })).ok)
      // The series goes on the next day.
      yield* kit.advance(at(20, 7) - (yield* kit.now))
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
    }))

  it.effect("a once alarm ends after it rang; 'stop' without the wake phrase is the host's", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "seven" })
      yield* kit.advance(at(19, 7) - (yield* kit.now))
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      assert.deepStrictEqual(yield* setRows(kit), [])
      const stop = yield* kit.phrases.say("stop", { wake: false })
      assert.isTrue(stop.taken && stop.by === "ringing")
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.strictEqual(said(yield* kit.action("list", {})), "No alarms are set.")
    }))

  it.effect("across an outage: a late occurrence is not rung (a silent card says so), and the next is planned after now, never in the past", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "every day at 7" })
      yield* kit.stop
      // Down from Wednesday to Friday 07:40: Thursday's and Friday's occurrences were missed.
      yield* kit.advance(at(20, 7, 40) - (yield* kit.now))
      yield* kit.start
      yield* kit.advance(0)
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      const missed = (yield* kit.notify.all).filter((n) => n.key?.startsWith("alarm-missed:"))
      assert.strictEqual(missed.length, 1)
      assert.strictEqual(missed[0]!.priority, "normal")
      assert.strictEqual(missed[0]!.text, "The alarm for today at seven o'clock in the morning could not ring.")
      assert.strictEqual((yield* setRows(kit))[0]?.value.next?.at, at(21, 7))
      yield* kit.advance(at(21, 7) - (yield* kit.now))
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
    }))

  it.effect("a little late (within 15 minutes): it rings, saying how late; a restart in between keeps it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "seven" })
      yield* kit.restart
      yield* kit.stop
      yield* kit.advance(at(19, 7, 4) - (yield* kit.now))
      yield* kit.start
      yield* kit.advance(0)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      assert.strictEqual((yield* kit.notify.all).at(-1)?.text, "This alarm was for seven o'clock in the morning; it rings 4 minutes late, because I couldn't ring then.")
    }))
})

describe("a store that is busy or fails", () => {
  const registered = makeRegistered()
  const hookedAlarms = (hooks: Hooks) => hooked(alarmsModule, hooks, registered)

  it.effect("busy: the busy sentence, nothing stored; the ring retried after a failed write rings once and plans once", () =>
    Effect.gen(function*() {
      const hooks: Hooks = { ...makeHooks(), writesFail: new StoreError({ reason: "busy", message: "test: busy" }) }
      const kit = yield* startTestModule(hookedAlarms(hooks))
      assert.deepStrictEqual(yield* kit.action("set", { when: "seven" }), { ok: false, code: "failed", message: "The alarms are busy just now; try again in a moment." })
      assert.deepStrictEqual(yield* rows(kit), [])
      hooks.writesFail = undefined
      yield* kit.action("set", { when: "every day at 7" })
      hooks.failAfterSend = new StoreError({ reason: "busy", message: "test: busy" })
      yield* kit.advance(at(19, 7) - (yield* kit.now))
      yield* kit.advance(10_000)
      const rings = (yield* kit.notify.all).filter((n) => n.key?.startsWith("alarm:"))
      assert.strictEqual(rings.length, 1)
      assert.strictEqual((yield* setRows(kit))[0]?.value.next?.at, at(20, 7))
      assert.strictEqual((yield* liveJobs(kit)).length, 1)
    }))

  it.effect("the snooze handler run twice for one notification snoozes once", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(hookedAlarms(makeHooks()))
      yield* kit.action("set", { when: "seven" })
      yield* kit.advance(at(19, 7) - (yield* kit.now))
      const [ring] = kit.notify.engine.ringingOn("kitchen-display")
      const id = (yield* rows(kit))[0]!.id
      const press = { notificationId: ring!.id, actionId: "snooze", key: `alarm:${id}:1`, deviceId: "kitchen-display" }
      assert.deepStrictEqual(yield* registered.presses.get("alarm")!.run(press), { say: "It rings again in 9 minutes." })
      const once = (yield* rows(kit))[0]!
      assert.deepStrictEqual(yield* registered.presses.get("alarm")!.run(press), { say: "It rings again in 9 minutes." })
      assert.strictEqual((yield* rows(kit))[0]!.rev, once.rev)
      assert.strictEqual(once.value.ring?.again, at(19, 7, 9))
      assert.strictEqual((yield* liveJobs(kit)).length, 1)
      assert.deepStrictEqual(yield* registered.presses.get("alarm")!.run({ ...press, notificationId: "n-other" }), { say: "That ring has ended." })
      assert.strictEqual((yield* rows(kit))[0]!.rev, once.rev)
    }))
})

describe("data and settings", () => {
  it.effect("a row with every indexed field at its largest is stored", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      const note = "\"".repeat(40)
      const largest: Alarm = {
        name: "\"".repeat(60),
        deviceId: "\\".repeat(64),
        timeZone: "\"".repeat(64),
        rrule: "\"".repeat(200),
        dtstart: "\"".repeat(80),
        next: { date: "9999-12-31", time: "23:59", at: 8_640_000_000_000_000 },
        n: 1_000_000,
        owed: { n: 1_000_000, date: "9999-12-31", time: "23:59", at: 8_640_000_000_000_000, attempts: 1_000_000, retryAt: 8_640_000_000_000_000 },
        ring: { n: 1_000_000, notification: note, date: "9999-12-31", time: "23:59", at: 8_640_000_000_000_000, until: 8_640_000_000_000_000, again: 8_640_000_000_000_000, pressed: note },
        withdraw: { notification: note, date: "9999-12-31", time: "23:59", until: 8_640_000_000_000_000, retryAt: 8_640_000_000_000_000 },
        phase: "ended",
        pending: true,
        nextAt: 8_640_000_000_000_000,
        endedAt: 8_640_000_000_000_000
      }
      yield* kit.moduleStore().collection(alarms).insert(largest)
      yield* kit.moduleStore().collection(alarms).insert({ ...largest, phase: "set" })
      assert.strictEqual((yield* setRows(kit)).length, 1)
      assert.strictEqual((yield* rows(kit)).length, 2)
    }))

  it.effect("the hourly sweep removes ended alarms older than a day with nothing owed, as the job; one with something owed stays", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "seven", name: "old" })
      yield* kit.action("cancel", {})
      const owing: Alarm = { deviceId: "kitchen-display", timeZone: "Europe/Amsterdam", n: 1, withdraw: { notification: "n-x", date: "2026-11-18", time: "07:00", until: 8_640_000_000_000_000, retryAt: 8_640_000_000_000_000 }, phase: "ended", pending: true, nextAt: 8_640_000_000_000_000, endedAt: 1 }
      yield* kit.moduleStore().collection(alarms).insert(owing)
      yield* kit.advance(25 * HOUR)
      yield* kit.action("set", { when: "seven", name: "fresh" })
      const job = (yield* kit.jobs).find((j) => j.handler === "sweep" && j.key === "sweep" && j.state === "scheduled")
      assert.strictEqual(job?.cron, "23 * * * *")
      yield* kit.advance(HOUR)
      assert.deepStrictEqual((yield* rows(kit)).map((r) => r.value.name ?? "owing"), ["owing", "fresh"])
      const sweeps = new Set((yield* kit.jobs).filter((j) => j.handler === "sweep").map((j) => j.id))
      assert.isTrue(kit.events.some((e) => e.type === "alarms.alarms.changed" && e.actor?.kind === "job" && sweeps.has(e.actor.jobId)))
    }))

  it.effect("skipped from another device, it still rings on its own device", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule)
      yield* kit.action("set", { when: "every day at 7" }, { device: "robins-phone" })
      assert.strictEqual(said(yield* kit.action("cancel", { which: "7:00", scope: "next" }, { device: "hall-screen", conversationId: "c-hall" })), "The alarm for tomorrow at seven o'clock in the morning is skipped; the next one is Friday at seven o'clock in the morning.")
      assert.deepStrictEqual((yield* liveJobs(kit)).map((j) => j.origin.deviceId), ["robins-phone"])
      yield* kit.advance(at(20, 7) - (yield* kit.now))
      assert.strictEqual(kit.notify.engine.ringingOn("robins-phone").length, 1)
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
    }))

  it.effect("invalid settings: the module does not run with them", () =>
    Effect.gen(function*() {
      for (const bad of [{ snoozeMinutes: 0 }, { snoozeMinutes: 31 }, { ringMinutes: 0 }, { ringMinutes: 2.5 }]) {
        const kit = yield* startTestModule(alarmsModule, { settings: bad })
        assert.notStrictEqual(kit.info()?.state, "running", JSON.stringify(bad))
        assert.isFalse((yield* kit.action("list", {})).ok)
      }
    }))
})

describe("Dutch", () => {
  it.effect("every answer and the ringing card", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(alarmsModule, { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } })
      assert.strictEqual(said(yield* kit.action("list", {})), "Er staan geen wekkers.")
      assert.strictEqual(said(yield* kit.action("set", { when: "half acht" })), "Wekker gezet voor morgen om half acht 's ochtends.")
      assert.strictEqual(said(yield* kit.action("set", { when: "elke werkdag om kwart voor zeven", name: "sport" })), "Wekker Sport gezet elke werkdag; de eerste keer is morgen om kwart voor zeven 's ochtends.")
      assert.strictEqual(said(yield* kit.action("cancel", { which: "sport" })), "Die wekker herhaalt elke werkdag. Alleen de volgende, of allemaal?")
      assert.strictEqual(said(yield* kit.action("set", { when: "morgen" })), "Hoe laat moet de wekker gaan?")
      yield* kit.advance(at(19, 6, 45) - (yield* kit.now))
      const [ring] = kit.notify.engine.ringingOn("kitchen-display")
      assert.strictEqual(ring?.title, "Wekker Sport")
      assert.deepStrictEqual(ring?.actions.map((a) => a.label), ["Snooze", "Nog vijf minuten"])
      assert.deepStrictEqual(yield* kit.notify.press(ring!.id, "snooze", { device: "kitchen-display" }), { ok: true, say: "Hij gaat over 9 minuten weer af." })
      assert.strictEqual(said(yield* kit.action("cancel", { which: "sport", scope: "next" })), "De gesnoozede wekker is geannuleerd; de volgende is morgen om kwart voor zeven 's ochtends.")
      void DAY
    }))
})
