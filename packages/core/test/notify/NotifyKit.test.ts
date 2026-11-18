// The notification service through the module test kit (docs/NOTIFICATIONS.md "Testing"): a tiny module's tools and
// shared code against the real service, gateway, scheduler and store, with the pages and the devices' voices recorded.
// Module lifecycle (stopped and started with a notification open, ringing, and pressed while it is down), and speech
// (after the reply, in order, stopped, waited for inside a turn, a room with no device, a device that cannot speak).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { Devices } from "../../src/Devices.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import { NOTIFY_TEXTS } from "../../src/NotifyTexts.ts"
import { makeBell } from "./bell.ts"

const idOf = (r: { readonly value: unknown }) => (r.value as { readonly id: string }).id

describe("notifications through the kit", () => {
  it.effect("a ring from a tool: a card with stop and snooze on the device that asked, ringing there; snooze reaches the module's handler", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const sent = yield* kit.tool("bell_ring", { title: "Pasta", ring: true }, { device: "kitchen-display" })
      const id = idOf(sent)
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.messages.map((m) => [m.deviceId, m.message.type]), [["kitchen-display", "notification.ring"]])
      assert.deepStrictEqual(kit.notify.decisions.map((d) => [d.deviceId, d.decision.deliver]), [["kitchen-display", true]])
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display").map((r) => r.id), [id])
      const answer = yield* kit.notify.press(id, "snooze", { device: "kitchen-display" })
      assert.deepStrictEqual(answer, { ok: true, say: "Snoozed for five minutes." })
      assert.deepStrictEqual(bell.parts.presses, [{ notificationId: id, actionId: "snooze", deviceId: "kitchen-display" }])
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.deepStrictEqual((yield* kit.notify.all).map((n) => [n.state, n.outcome]), [["resolved", "snooze"]])
    }))

  it.effect("the press runs as the notification: its CurrentPrincipal names the notification and the device it was pressed on", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const seen: Array<unknown> = []
      const { CurrentPrincipal } = yield* Effect.promise(() => import("../../src/TurnContext.ts"))
      bell.parts.answer = () => Effect.map(CurrentPrincipal, (p) => void seen.push(p))
      const id = idOf(yield* kit.tool("bell_ring", { title: "Who", ring: true, everywhere: true }, { device: "kitchen-display" }))
      yield* kit.notify.press(id, "snooze", { device: "robins-phone" })
      assert.strictEqual((seen[0] as { _tag: string })._tag, "notification")
      assert.deepStrictEqual((seen[0] as { notification: { notificationId: string; deviceId: string } }).notification.notificationId, id)
      assert.deepStrictEqual((seen[0] as { notification: { deviceId: string } }).notification.deviceId, "robins-phone")
    }))

  it.effect("the owning module stops with a notification open and ringing: stop still works, an action answers 'I can't do that right now' and changes nothing, and works again once it runs", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const a = idOf(yield* kit.tool("bell_ring", { title: "One", ring: true }, { device: "kitchen-display" }))
      yield* kit.advance(1)
      const b = idOf(yield* kit.tool("bell_ring", { title: "Two", ring: true }, { device: "kitchen-display" }))
      yield* kit.stop
      // Still open, still ringing while its module is down.
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display").map((r) => r.id), [a, b])
      assert.deepStrictEqual(yield* kit.notify.press(a, "snooze", { device: "kitchen-display" }), { ok: false, say: "I can't do that right now.", code: "not_running" })
      assert.deepStrictEqual(bell.parts.presses, [])
      assert.strictEqual((yield* kit.notify.all).find((n) => n.id === a)?.state, "open")
      assert.deepStrictEqual(yield* kit.notify.press(b, "stop", { device: "kitchen-display" }), { ok: true, say: "Done." })
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display").map((r) => r.id), [a])
      yield* kit.start
      assert.deepStrictEqual((yield* kit.notify.press(a, "snooze", { device: "kitchen-display" })).ok, true)
      assert.deepStrictEqual(bell.parts.presses.map((p) => p.notificationId), [a])
      // A restart of the module keeps it working the same way (the handler is published again with it).
      const c = idOf(yield* kit.tool("bell_ring", { title: "Three", ring: true }, { device: "kitchen-display" }))
      yield* kit.restart
      assert.strictEqual((yield* kit.notify.press(c, "snooze", { device: "kitchen-display" })).ok, true)
    }))

  it.effect("a module without the handler named: send refuses at once (invalid)", () =>
    Effect.gen(function*() {
      const bell = makeBell({ handler: false })
      const kit = yield* startTestModule(bell.definition)
      const sent = yield* bell.parts.notify!.send({ title: "No handler", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" }).pipe(Effect.flip)
      assert.strictEqual(sent.reason, "invalid")
      assert.deepStrictEqual(yield* kit.notify.all, [])
    }))

  it.effect("a dutch household: the stop button, 'I can't do that right now' and the module's refusal text are Dutch", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      const id = idOf(yield* kit.tool("bell_ring", { title: "Thee", ring: true }, { device: "kitchen-display" }))
      yield* kit.notify.settle
      const ring = kit.notify.messages[0]?.message
      assert.deepStrictEqual(ring?.type === "notification.ring" ? ring.notification.actions[0] : undefined, { id: "stop", label: NOTIFY_TEXTS.nl.stop })
      yield* kit.stop
      assert.strictEqual((yield* kit.notify.press(id, "snooze", { device: "kitchen-display" })).say, "Dat kan ik nu niet doen.")
      yield* kit.start
      for (let i = 0; i < 9; i++) yield* kit.tool("bell_ring", { title: `N${i}` }, { device: "kitchen-display" })
      assert.deepStrictEqual((yield* kit.tool("bell_ring", { title: "Te veel" }, { device: "kitchen-display" })).value, { refused: "limit", said: "Er wachten te veel meldingen." })
    }))

  it.effect("the two texts tables have the same keys, every text one line", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(Object.keys(NOTIFY_TEXTS.nl).sort(), Object.keys(NOTIFY_TEXTS.en).sort())
      for (const t of [...Object.values(NOTIFY_TEXTS.en), ...Object.values(NOTIFY_TEXTS.nl)]) assert.match(t, /^[^\n]+$/)
    }))
})

describe("speech outside a reply", () => {
  it.effect("an announcement asked for during a reply plays after it", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      yield* kit.notify.replying("kitchen-display", true)
      const h = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "The laundry is done")
      assert.deepStrictEqual(h.deliveries, [{ deviceId: "kitchen-display", queued: true }])
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced, [])
      const replyEnded = yield* kit.now
      yield* kit.notify.replying("kitchen-display", false)
      yield* kit.advance(2_000)
      assert.deepStrictEqual(kit.notify.announced.map((a) => [a.text, a.startedAt, a.outcome]), [["The laundry is done", replyEnded, "spoken"]])
      assert.deepStrictEqual(yield* h.done, [{ deviceId: "kitchen-display", outcome: "spoken" }])
    }))

  it.effect("two announcements on one device keep their order", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const first = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "First")
      const second = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "Second", { cue: true })
      yield* kit.advance(4_000)
      assert.deepStrictEqual(kit.notify.announced.map((a) => [a.text, a.cue, a.outcome]), [["First", false, "spoken"], ["Second", true, "spoken"]])
      assert.isBelow(kit.notify.announced[0]!.startedAt, kit.notify.announced[1]!.startedAt)
      assert.strictEqual((yield* first.done)[0]?.outcome, "spoken")
      assert.strictEqual((yield* second.done)[0]?.outcome, "spoken")
    }))

  it.effect("stop during one silences it at once and leaves the next one in its place", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const long = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "A long one")
      const next = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "The next one")
      yield* kit.advance(500)
      yield* long.stop
      yield* kit.notify.settle
      assert.deepStrictEqual(yield* long.done, [{ deviceId: "kitchen-display", outcome: "stopped" }])
      assert.deepStrictEqual(kit.notify.announced.map((a) => [a.text, a.outcome]), [["A long one", "stopped"], ["The next one", undefined]])
      yield* kit.advance(2_000)
      assert.deepStrictEqual(yield* next.done, [{ deviceId: "kitchen-display", outcome: "spoken" }])
      // The host's "stop" on a device (the page's Stop, P7's later) stops what is being spoken there, and only that.
      const a = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "Third")
      const b = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "Fourth")
      yield* kit.advance(100)
      assert.isTrue(yield* kit.notify.engine.stopSpeech("kitchen-display"))
      assert.strictEqual((yield* a.done)[0]?.outcome, "stopped")
      yield* kit.advance(2_000)
      assert.strictEqual((yield* b.done)[0]?.outcome, "spoken")
    }))

  it.effect("a tool inside a turn cannot wait for its announcement: a typed refusal says why, and the announcement still plays", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const r = yield* kit.tool("bell_say", { text: "Dinner is ready", device: "kitchen-display", wait: true }, { device: "kitchen-display" })
      assert.deepStrictEqual(r.value, { refused: "in-turn", said: "An announcement can't be waited for during a reply." })
      yield* kit.advance(2_000)
      assert.deepStrictEqual(kit.notify.announced.map((a) => [a.text, a.outcome]), [["Dinner is ready", "spoken"]])
    }))

  it.effect("a room with no device is refused (no-device); a device that cannot speak, and do not disturb, are skipped with why", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition, {
        household: {
          devices: [
            { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
            { id: "kitchen-screen", name: "Kitchen screen", room: "Kitchen", capabilities: { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true } } },
            { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null }
          ]
        }
      })
      const nobody = yield* kit.tool("bell_say", { text: "Hello", room: "Attic" })
      assert.deepStrictEqual(nobody.value, { refused: "no-device", said: "There is no device there to say it on." })
      const kitchen = yield* bell.parts.speech!.say({ room: "kitchen" }, "Tea is ready")
      assert.deepStrictEqual(kitchen.deliveries, [{ deviceId: "kitchen-display", queued: true }, { deviceId: "kitchen-screen", queued: false, why: "cannot-speak" }])
      yield* kit.advance(2_000)
      assert.deepStrictEqual(yield* kitchen.done, [{ deviceId: "kitchen-display", outcome: "spoken" }, { deviceId: "kitchen-screen", outcome: "skipped", why: "cannot-speak" }])
      // Personal content where the privacy rule says no; do not disturb everywhere.
      const personal = yield* bell.parts.speech!.say("everywhere", "Sam's dentist is at three", { owner: "p-sam" })
      assert.deepStrictEqual(personal.deliveries.map((d) => [d.deviceId, d.why]), [["kitchen-display", undefined], ["kitchen-screen", "private"], ["hall-screen", "private"]])
      yield* kit.advance(2_000)
      yield* bell.parts.notify!.dnd.set()
      const quiet = yield* bell.parts.speech!.say({ device: "hall-screen" }, "Shh")
      assert.deepStrictEqual(quiet.deliveries, [{ deviceId: "hall-screen", queued: false, why: "dnd" }])
    }))

  it.effect("do not disturb that begins while one waits behind a reply: decided again when it is about to play, so it is skipped", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      yield* kit.notify.replying("kitchen-display", true)
      const h = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "Later")
      yield* bell.parts.notify!.dnd.set()
      yield* kit.notify.replying("kitchen-display", false)
      yield* kit.advance(100)
      assert.deepStrictEqual(yield* h.done, [{ deviceId: "kitchen-display", outcome: "skipped", why: "dnd" }])
      assert.deepStrictEqual(kit.notify.announced, [])
    }))

  it.effect("a queue is bounded: the ninth waiting on one device is not queued (busy)", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      yield* kit.notify.replying("kitchen-display", true)
      const handles = []
      for (let i = 0; i < 9; i++) handles.push(yield* bell.parts.speech!.say({ device: "kitchen-display" }, `Line ${i}`))
      assert.deepStrictEqual(handles.map((h) => h.deliveries[0]?.queued), [true, true, true, true, true, true, true, true, false])
      assert.strictEqual(handles[8]!.deliveries[0]?.why, "busy")
      const bad = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "x".repeat(301)).pipe(Effect.flip)
      assert.strictEqual(bad.reason, "invalid")
    }))

  it.effect("a18: the waiting bound counts the announcement still waiting for quiet: eight on a device, the ninth is not queued, with yields between", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      yield* kit.notify.replying("kitchen-display", true)
      const queued: Array<boolean | undefined> = []
      for (let i = 0; i < 10; i++) {
        queued.push((yield* bell.parts.speech!.say({ device: "kitchen-display" }, `Line ${i}`)).deliveries[0]?.queued)
        yield* kit.notify.settle
      }
      assert.deepStrictEqual(queued, [true, true, true, true, true, true, true, true, false, false])
      assert.deepStrictEqual(kit.notify.announced, [])
    }))

  it.effect("a19: a reply that starts while an announcement plays cuts it (stopped, a reply), as serve mode's lease does; the reply is left alone", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const h = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "The laundry is done")
      yield* kit.advance(500)
      yield* kit.notify.replying("kitchen-display", true)
      assert.deepStrictEqual(yield* h.done, [{ deviceId: "kitchen-display", outcome: "stopped", why: "a reply" }])
      assert.strictEqual(kit.notify.announced[0]?.outcome, "stopped")
      // The next one waits for the reply to end, then plays.
      const next = yield* bell.parts.speech!.say({ device: "kitchen-display" }, "After the reply")
      yield* kit.advance(3_000)
      assert.strictEqual(kit.notify.announced.length, 1)
      yield* kit.notify.replying("kitchen-display", false)
      yield* kit.advance(2_000)
      assert.strictEqual((yield* next.done)[0]?.outcome, "spoken")
    }))

  it.effect("a20: the kit's Devices service and the notification service read one connection state", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      yield* kit.notify.disconnect("kitchen-display")
      assert.isFalse(kit.service(Devices)!.get("kitchen-display")!.connected)
      assert.deepStrictEqual((yield* bell.parts.speech!.say({ device: "kitchen-display" }, "Hello")).deliveries, [{ deviceId: "kitchen-display", queued: false, why: "offline" }])
      yield* kit.notify.connect("kitchen-display")
      assert.isTrue(kit.service(Devices)!.get("kitchen-display")!.connected)
      assert.isTrue((yield* bell.parts.speech!.say({ device: "kitchen-display" }, "Hello")).deliveries[0]!.queued)
    }))

  it.effect("a8: stop stops every device's announcement in one step, without its caller waiting for any of them", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      const h = yield* bell.parts.speech!.say("everywhere", "Everyone, dinner")
      yield* kit.advance(100)
      assert.strictEqual(kit.notify.announced.length, 3)
      // The caller is interrupted right after it asked: the stop was one synchronous step, so it is whole.
      const caller = yield* Effect.forkChild(Effect.andThen(h.stop, Effect.never))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(caller)
      yield* kit.notify.settle
      assert.deepStrictEqual((yield* h.done).map((o) => o.outcome), ["stopped", "stopped", "stopped"])
      assert.deepStrictEqual(kit.notify.announced.map((a) => a.outcome), ["stopped", "stopped", "stopped"])
    }))

  it.effect("a23: what a module says passes the page boundary before it is spoken (a secret of the module is replaced)", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition, { secrets: { token: "t0ken-for-tests" } })
      yield* bell.parts.speech!.say({ device: "kitchen-display" }, "The token is t0ken-for-tests")
      yield* kit.advance(100)
      assert.strictEqual(kit.notify.announced[0]?.text, "The token is [secret]")
    }))
})

describe("the kit's own promises", () => {
  it.effect("a24: all is oldest first; a25: press drives the test clock while the module's handler runs", () =>
    Effect.gen(function*() {
      const bell = makeBell()
      const kit = yield* startTestModule(bell.definition)
      yield* kit.tool("bell_ring", { title: "First", ring: true }, { device: "kitchen-display" })
      yield* kit.advance(1)
      const second = yield* kit.tool("bell_ring", { title: "Second", ring: true }, { device: "kitchen-display" })
      assert.deepStrictEqual((yield* kit.notify.all).map((n) => n.title), ["First", "Second"])
      bell.parts.answer = () => Effect.as(Effect.sleep(1_000), { say: "Slow but done." })
      assert.deepStrictEqual(yield* kit.notify.press(idOf(second), "snooze", { device: "kitchen-display" }), { ok: true, say: "Slow but done." })
    }))
})
